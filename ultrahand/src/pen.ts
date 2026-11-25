// The pen tool for the masterplan: draw streets and shapes anchor by anchor (click for a corner,
// click and drag to pull out curve handles), snapping to junctions, streets, existing roads and the red
// line; and edit anchors and handles on the map. Anchors in the same place move together, so streets
// that meet at a node stay joined.
import mapboxgl from 'mapbox-gl';
import type { Feature, FeatureCollection, Position } from 'geojson';
import { node, bezierPath, handleAt, offsetTo, samePlace, cloneNodes, nearestOnPath, splitAt, isCorner, type PenNode, type XY } from './bezier';

export interface SnapPoint { p: Position; label: string; ref?: any; dir?: number }
export interface SnapLine { coords: Position[]; label: string; ref?: any }
/** A guide: a line through p at a bearing (degrees). One way (an extension) unless both. */
export interface Guide { p: Position; bearing: number; both?: boolean; label: string }
export interface SnapSources { points: SnapPoint[]; lines: SnapLine[]; guides?: Guide[] }
/** dir: the bearing of the line snapped to, for the angle where they meet. */
export interface Snap { p: Position; label: string; kind: 'point' | 'line' | 'road' | 'guide' | 'angle' | 'none'; ref?: any; dir?: number }

const KY = 110574;
const kxAt = (lat: number) => 111320 * Math.cos((lat * Math.PI) / 180);
/** Bearing (degrees) from a to b, on a flat local frame. */
const bearingOf = (a: Position, b: Position) => (Math.atan2((b[0] - a[0]) * kxAt(a[1]), (b[1] - a[1]) * KY) * 180) / Math.PI;
const distM = (a: Position, b: Position) => Math.hypot((b[0] - a[0]) * kxAt(a[1]), (b[1] - a[1]) * KY);
const ahead = (p: Position, bearing: number, m: number): Position => {
  const r = (bearing * Math.PI) / 180;
  return [p[0] + (Math.sin(r) * m) / kxAt(p[1]), p[1] + (Math.cos(r) * m) / KY];
};
/** The direction a path arrives at anchor k (from its in-handle, or from the anchor before). */
function arriving(nodes: PenNode[], k: number, closed: boolean): number | null {
  const n = nodes[k];
  if (n.i[0] || n.i[1]) return (Math.atan2(-n.i[0], -n.i[1]) * 180) / Math.PI;
  const prev = k > 0 ? nodes[k - 1] : closed ? nodes[nodes.length - 1] : null;
  return prev && distM(prev.p, n.p) > 0.5 ? bearingOf(prev.p, n.p) : null;
}
/** Guides from an anchor: straight on from the way the path arrives, and square to it. */
export function anchorGuides(nodes: PenNode[], k: number, closed: boolean, name = 'the last point'): Guide[] {
  const b = arriving(nodes, k, closed);
  if (b == null) return [];
  return [
    { p: nodes[k].p, bearing: b, label: `Straight on from ${name}` },
    { p: nodes[k].p, bearing: b + 90, both: true, label: `Square to ${name}` },
  ];
}
const angleBetween = (a: number, b: number) => {
  const d = Math.abs((((a - b) % 360) + 540) % 360 - 180);
  return d; // 0–180
};

/** Something on the map whose anchors can be dragged. `handles`: show and edit its handles too. */
export interface Editable { id: string; nodes: PenNode[]; closed: boolean; handles: boolean; kind: string; minNodes?: number }

export interface DrawOpts {
  closed: boolean;
  exclude?: string[];
  onDone(nodes: PenNode[], snaps: (Snap | null)[]): void;
  onCancel?(): void;
}

export interface PenDeps {
  /** What can be snapped to, leaving out the things with these ids. */
  sources(exclude: string[]): SnapSources;
  /** Anchors or handles were moved (or added or removed). snap: where a dragged anchor landed. */
  onEdit(changed: Map<string, PenNode[]>, snap: Snap | null, grabbed: { id: string; index: number } | null): void;
}

const PX_POINT = 12, PX_LINE = 9, PX_HIT = 9;
const BASE_ROAD = /^(road|bridge|tunnel)-/;
const fc = (features: Feature[]): FeatureCollection => ({ type: 'FeatureCollection', features });
const pt = (p: Position, props: Record<string, unknown>): Feature => ({ type: 'Feature', geometry: { type: 'Point', coordinates: p }, properties: props });
const ln = (c: Position[], props: Record<string, unknown>): Feature => ({ type: 'Feature', geometry: { type: 'LineString', coordinates: c }, properties: props });

export function createPen(map: mapboxgl.Map, deps: PenDeps) {
  let mode: 'idle' | 'draw' = 'idle';
  let draw: { nodes: PenNode[]; snaps: (Snap | null)[]; opts: DrawOpts; dragging: null | { index: number; start: mapboxgl.Point; closing: boolean; moved: boolean }; cursor: Snap | null } | null = null;
  let editables: Editable[] = [];
  let drag: null | {
    grabbed: { id: string; index: number };
    targets: { id: string; index: number }[];
    handle: 'i' | 'o' | null;
    pull: boolean; // alt-drag on an anchor: pull out handles
    orig: Map<string, PenNode[]>;
    live: Map<string, PenNode[]>;
    start: mapboxgl.Point;
    moved: boolean;
    snap: Snap | null;
  } = null;
  let selAnchor: { id: string; index: number } | null = null;
  let space = false, shift = false, alt = false;
  let hoverCursor = false;
  let guidesOn = true, noSnap = false;
  let guideView: { a: mapboxgl.Point; d: [number, number]; t: number; both: boolean; on: boolean }[] = [];

  // ---- measurements: small labels on the map while drawing and dragging
  const measureBox = document.createElement('div');
  measureBox.className = 'pen-measures';
  map.getContainer().appendChild(measureBox);
  function showMeasures(list: { at: Position; text: string; kind: 'len' | 'ang'; dy?: number }[]) {
    while (measureBox.children.length < list.length) measureBox.appendChild(document.createElement('span'));
    [...measureBox.children].forEach((el, i) => {
      const m = list[i] as (typeof list)[number] | undefined;
      const e = el as HTMLElement;
      e.hidden = !m;
      if (!m) return;
      const q = map.project(m.at as [number, number]);
      e.className = `pen-m ${m.kind}`;
      e.textContent = m.text;
      e.style.transform = `translate(${Math.round(q.x)}px, ${Math.round(q.y + (m.dy ?? 0))}px) translate(-50%, -50%)`;
    });
  }

  // ---- the hint by the cursor
  const hint = document.createElement('div');
  hint.className = 'pen-hint';
  hint.hidden = true;
  map.getContainer().appendChild(hint);
  const showHint = (text: string | null, at?: mapboxgl.Point) => {
    hint.hidden = !text;
    if (text && at) {
      hint.textContent = text;
      hint.style.transform = `translate(${Math.round(at.x + 14)}px, ${Math.round(at.y + 14)}px)`;
    }
  };

  // ---- snapping
  let srcCache: { key: string; src: SnapSources; boxes: number[][] } | null = null;
  function sources(exclude: string[]) {
    const key = exclude.join(',');
    if (!srcCache || srcCache.key !== key) {
      const src = deps.sources(exclude);
      const boxes = src.lines.map((l) => {
        let w = Infinity, s = Infinity, e = -Infinity, n = -Infinity;
        for (const c of l.coords) ((w = Math.min(w, c[0])), (e = Math.max(e, c[0])), (s = Math.min(s, c[1])), (n = Math.max(n, c[1])));
        return [w, s, e, n];
      });
      srcCache = { key, src, boxes };
    }
    return srcCache;
  }

  function nearestOnScreenLine(coords: Position[], P: mapboxgl.Point) {
    let best = { d: Infinity, x: 0, y: 0, i: 1 };
    let a = map.project(coords[0] as [number, number]);
    for (let i = 1; i < coords.length; i++) {
      const b = map.project(coords[i] as [number, number]);
      const dx = b.x - a.x, dy = b.y - a.y, L2 = dx * dx + dy * dy || 1e-9;
      const u = Math.max(0, Math.min(1, ((P.x - a.x) * dx + (P.y - a.y) * dy) / L2));
      const x = a.x + dx * u, y = a.y + dy * u, d = Math.hypot(P.x - x, P.y - y);
      if (d < best.d) best = { d, x, y, i };
      a = b;
    }
    return best;
  }

  function snapAt(P: mapboxgl.Point, exclude: string[], prev: Position | null, extraPoints: SnapPoint[] = [], own: Guide[] = []): Snap {
    guideView = [];
    if (noSnap) {
      const ll = map.unproject(P);
      return { p: [ll.lng, ll.lat], label: 'Snapping off (Ctrl)', kind: 'none' };
    }
    const { src, boxes } = sources(exclude);
    // 1. points: junctions, ends, corners
    let best: Snap | null = null, bd = PX_POINT;
    for (const s of [...extraPoints, ...src.points]) {
      const q = map.project(s.p as [number, number]);
      const d = Math.hypot(q.x - P.x, q.y - P.y);
      if (d < bd) ((bd = d), (best = { p: s.p, label: s.label, kind: 'point', ref: s.ref, dir: s.dir }));
    }
    if (best) return best;
    // 2. lines: our streets, kerbs, the red line, edges of spaces
    const sw = map.unproject([P.x - PX_LINE, P.y + PX_LINE]), ne = map.unproject([P.x + PX_LINE, P.y - PX_LINE]);
    const [qw, qs, qe, qn] = [Math.min(sw.lng, ne.lng), Math.min(sw.lat, ne.lat), Math.max(sw.lng, ne.lng), Math.max(sw.lat, ne.lat)];
    bd = PX_LINE;
    src.lines.forEach((l, i) => {
      const b = boxes[i];
      if (b[0] > qe || b[2] < qw || b[1] > qn || b[3] < qs || l.coords.length < 2) return;
      const r = nearestOnScreenLine(l.coords, P);
      if (r.d < bd) {
        bd = r.d;
        const ll = map.unproject([r.x, r.y]);
        best = { p: [ll.lng, ll.lat], label: l.label, kind: 'line', ref: l.ref, dir: bearingOf(l.coords[r.i - 1], l.coords[r.i]) };
      }
    });
    if (best) return best;
    // 3. existing roads on the base map
    const feats = map.queryRenderedFeatures([[P.x - PX_LINE, P.y - PX_LINE], [P.x + PX_LINE, P.y + PX_LINE]]).filter((f) => BASE_ROAD.test(f.layer?.id ?? '') && /Line/.test(f.geometry.type));
    bd = PX_LINE;
    for (const f of feats) {
      const g = f.geometry as any;
      const parts: Position[][] = g.type === 'LineString' ? [g.coordinates] : g.coordinates;
      for (const part of parts) {
        if (part.length < 2) continue;
        // their ends and bends first, then anywhere along them
        for (const c of part) {
          const q = map.project(c as [number, number]);
          const d = Math.hypot(q.x - P.x, q.y - P.y);
          if (d < Math.min(bd, PX_POINT * 0.7)) ((bd = d), (best = { p: c, label: `Existing road${f.properties?.name ? `: ${f.properties.name}` : ''}`, kind: 'road' }));
        }
        const r = nearestOnScreenLine(part, P);
        if (r.d < bd) {
          bd = r.d;
          const ll = map.unproject([r.x, r.y]);
          best = { p: [ll.lng, ll.lat], label: `Existing road${f.properties?.name ? `: ${f.properties.name}` : ''}`, kind: 'road', dir: bearingOf(part[r.i - 1], part[r.i]) };
        }
      }
    }
    if (best) return best;
    // 4. guides: extensions of streets and edges, lines square to them, straight on; where two cross first
    if (guidesOn) {
      const cands: { g: Guide; a: mapboxgl.Point; d: [number, number]; t: number; dist: number }[] = [];
      for (const g of [...own, ...(src.guides ?? [])]) {
        const a = map.project(g.p as [number, number]);
        if (Math.hypot(a.x - P.x, a.y - P.y) > 900) continue;
        const b = map.project(ahead(g.p, g.bearing, 30) as [number, number]);
        const L = Math.hypot(b.x - a.x, b.y - a.y) || 1;
        const d: [number, number] = [(b.x - a.x) / L, (b.y - a.y) / L];
        const t = (P.x - a.x) * d[0] + (P.y - a.y) * d[1];
        if (!g.both && t < 6) continue;
        const dist = Math.abs((P.x - a.x) * d[1] - (P.y - a.y) * d[0]);
        if (dist < 40) cands.push({ g, a, d, t, dist });
      }
      cands.sort((x, y) => x.dist - y.dist);
      const near = cands.slice(0, 6);
      let hit: { x: number; y: number; on: number[] } | null = null, hd = 11;
      for (let i = 0; i < near.length; i++)
        for (let j = i + 1; j < near.length; j++) {
          const A = near[i], B = near[j];
          const den = A.d[0] * B.d[1] - A.d[1] * B.d[0];
          if (Math.abs(den) < 0.15) continue; // nearly parallel
          const s1 = ((B.a.x - A.a.x) * B.d[1] - (B.a.y - A.a.y) * B.d[0]) / den;
          const s2 = ((B.a.x - A.a.x) * A.d[1] - (B.a.y - A.a.y) * A.d[0]) / den;
          if ((!A.g.both && s1 < 0) || (!B.g.both && s2 < 0)) continue;
          const x = A.a.x + A.d[0] * s1, y = A.a.y + A.d[1] * s1, dd = Math.hypot(x - P.x, y - P.y);
          if (dd < hd) ((hd = dd), (hit = { x, y, on: [i, j] }));
        }
      const show = (on: number[]) => (guideView = near.filter((c) => c.dist < 40).map((c, i) => ({ a: c.a, d: c.d, t: c.t, both: !!c.g.both, on: on.includes(i) })));
      if (hit) {
        show(hit.on);
        const ll = map.unproject([hit.x, hit.y]);
        return { p: [ll.lng, ll.lat], label: hit.on.map((i) => near[i].g.label).join(' × '), kind: 'guide' };
      }
      if (near.length && near[0].dist < 8) {
        show([0]);
        const c = near[0];
        const ll = map.unproject([c.a.x + c.d[0] * c.t, c.a.y + c.d[1] * c.t]);
        return { p: [ll.lng, ll.lat], label: c.g.label, kind: 'guide', dir: c.g.bearing };
      }
      show([]);
    }
    // 5. shift: keep to 15° steps from the last anchor
    const ll = map.unproject(P);
    if (shift && prev) {
      const A = map.project(prev as [number, number]);
      const ang = Math.atan2(P.y - A.y, P.x - A.x), step = Math.PI / 12, a = Math.round(ang / step) * step;
      const len = Math.hypot(P.x - A.x, P.y - A.y);
      const q = map.unproject([A.x + Math.cos(a) * len, A.y + Math.sin(a) * len]);
      return { p: [q.lng, q.lat], label: `${Math.round(((-a * 180) / Math.PI + 450) % 360)}°`, kind: 'angle' };
    }
    return { p: [ll.lng, ll.lat], label: '', kind: 'none' };
  }

  // ---- drawing the overlay
  function render() {
    const f: Feature[] = [];
    const showNodes = (n: PenNode[], closed: boolean, opts: { handles: boolean; id: string }) => {
      n.forEach((x, i) => {
        if (opts.handles)
          for (const w of ['i', 'o'] as const) {
            if (!x[w][0] && !x[w][1]) continue;
            if (!closed && ((w === 'i' && i === 0) || (w === 'o' && i === n.length - 1))) continue;
            const h = handleAt(x, w);
            f.push(ln([x.p, h], { kind: 'hline' }), pt(h, { kind: 'handle' }));
          }
        const junction = editables.some((e) => e.id !== opts.id && e.nodes.some((o) => samePlace(o.p, x.p)));
        const sel = !!selAnchor && selAnchor.id === opts.id && selAnchor.index === i;
        f.push(pt(x.p, { kind: 'anchor', junction, sel, active: opts.handles, first: mode === 'draw' && i === 0 }));
      });
    };
    for (const e of editables) {
      const nodes = drag?.live.get(e.id) ?? e.nodes;
      if (drag?.live.has(e.id)) f.push(ln(bezierPath(nodes, e.closed), { kind: 'path' }));
      showNodes(nodes, e.closed, { handles: e.handles, id: e.id });
    }
    if (mode === 'draw' && draw) {
      const n = draw.nodes;
      if (n.length) f.push(ln(bezierPath(n, false), { kind: 'path' }));
      if (n.length && draw.cursor && !draw.dragging) {
        const last = n[n.length - 1];
        const preview = [last, node(draw.cursor.p)];
        f.push(ln(bezierPath(preview, false), { kind: 'preview' }));
        if (draw.opts.closed && n.length >= 2) f.push(ln([draw.cursor.p, n[0].p], { kind: 'preview' }));
      }
      if (draw.opts.closed && n.length >= 3 && draw.dragging?.closing) f.push(ln(bezierPath(n, true), { kind: 'path' }));
      showNodes(n, false, { handles: true, id: '__draw' });
      if (draw.cursor && draw.cursor.kind !== 'none' && draw.cursor.kind !== 'angle') f.push(pt(draw.cursor.p, { kind: 'snap' }));
    }
    if (drag?.snap && drag.snap.kind !== 'none') f.push(pt(drag.snap.p, { kind: 'snap' }));
    // guide lines near the cursor, drawn from their origin to a little past it
    if (guidesOn && (mode === 'draw' || drag) && !draw?.dragging)
      for (const g of guideView) {
        const from = g.both ? Math.min(0, g.t) - 220 : 0, to = Math.max(0, g.t) + 220;
        const A = map.unproject([g.a.x + g.d[0] * from, g.a.y + g.d[1] * from]), B = map.unproject([g.a.x + g.d[0] * to, g.a.y + g.d[1] * to]);
        f.push(ln([[A.lng, A.lat], [B.lng, B.lat]], { kind: g.on ? 'guide-on' : 'guide' }));
      }
    (map.getSource('pen') as mapboxgl.GeoJSONSource | undefined)?.setData(fc(f));
    showMeasures(guidesOn ? measures() : []);
  }

  /** Lengths and angles to show: the segment being drawn, the turn at the last point, the angle where streets meet. */
  function measures(): { at: Position; text: string; kind: 'len' | 'ang'; dy?: number }[] {
    const out: { at: Position; text: string; kind: 'len' | 'ang'; dy?: number }[] = [];
    const len = (path: Position[]) => path.slice(1).reduce((a, q, i) => a + distM(path[i], q), 0);
    /** The point halfway along a path. */
    const mid = (path: Position[]): Position => {
      let half = len(path) / 2;
      for (let i = 1; i < path.length; i++) {
        const d = distM(path[i - 1], path[i]);
        if (d >= half) {
          const t = d ? half / d : 0;
          return [path[i - 1][0] + (path[i][0] - path[i - 1][0]) * t, path[i - 1][1] + (path[i][1] - path[i - 1][1]) * t];
        }
        half -= d;
      }
      return path[path.length - 1];
    };
    const fmt = (m: number) => (m < 100 ? `${m.toFixed(1)} m` : `${Math.round(m)} m`);
    if (mode === 'draw' && draw) {
      const n = draw.nodes;
      if (!n.length || !draw.cursor) return out;
      const last = n[n.length - 1];
      if (draw.dragging) {
        if (n.length >= 2) {
          const seg = bezierPath([n[n.length - 2], last], false);
          out.push({ at: mid(seg), text: `↔ ${fmt(len(seg))}`, kind: 'len' });
        }
        return out;
      }
      const seg = bezierPath([last, node(draw.cursor.p)], false);
      const L = len(seg);
      if (L > 0.5) out.push({ at: mid(seg), text: `↔ ${fmt(L)}`, kind: 'len' });
      const out1 = seg.length > 1 ? bearingOf(seg[0], seg[1]) : null;
      const inb = arriving(n, n.length - 1, false);
      if (out1 != null && inb != null && L > 2) out.push({ at: ahead(last.p, inb + 180, 0), text: `∠ ${Math.round(180 - angleBetween(inb, out1))}°`, kind: 'ang' });
      else if (out1 != null && n.length === 1 && draw.snaps[0]?.dir != null && L > 2) {
        const a = angleBetween(draw.snaps[0].dir!, out1);
        out.push({ at: last.p, text: `∠ ${Math.round(Math.min(a, 180 - a))}°`, kind: 'ang' });
      }
      if (draw.cursor.dir != null && (draw.cursor.kind === 'line' || draw.cursor.kind === 'road' || draw.cursor.kind === 'point') && seg.length > 1 && L > 2) {
        const a = angleBetween(draw.cursor.dir, bearingOf(seg[seg.length - 2], seg[seg.length - 1]));
        out.push({ at: draw.cursor.p, text: `∠ ${Math.round(Math.min(a, 180 - a))}°`, kind: 'ang' });
      }
      const total = len(bezierPath(n, false)) + L;
      if (n.length >= 2) out.push({ at: draw.cursor.p, text: `Σ ${fmt(total)}`, kind: 'len', dy: -26 });
      return out;
    }
    if (drag && drag.moved && !drag.handle && !drag.pull) {
      for (const t of drag.targets) {
        const e = editables.find((x) => x.id === t.id);
        const ns = drag.live.get(t.id);
        if (!e || !ns) continue;
        for (const k of [t.index - 1, t.index + 1]) {
          const j = e.closed ? (k + ns.length) % ns.length : k;
          if (j < 0 || j >= ns.length || j === t.index) continue;
          const seg = bezierPath(k < t.index ? [ns[j], ns[t.index]] : [ns[t.index], ns[j]], false);
          out.push({ at: mid(seg), text: `↔ ${fmt(len(seg))}`, kind: 'len' });
        }
      }
    }
    return out;
  }

  // ---- hit testing editables
  function hitAt(P: mapboxgl.Point): { id: string; index: number; handle: 'i' | 'o' | null } | null {
    let best: { id: string; index: number; handle: 'i' | 'o' | null } | null = null, bd = PX_HIT;
    for (const e of editables) {
      e.nodes.forEach((x, i) => {
        if (e.handles)
          for (const w of ['i', 'o'] as const) {
            if (!x[w][0] && !x[w][1]) continue;
            const q = map.project(handleAt(x, w) as [number, number]);
            const d = Math.hypot(q.x - P.x, q.y - P.y);
            if (d < bd) ((bd = d), (best = { id: e.id, index: i, handle: w }));
          }
      });
    }
    if (best) return best;
    bd = PX_HIT;
    for (const e of editables)
      e.nodes.forEach((x, i) => {
        const q = map.project(x.p as [number, number]);
        const d = Math.hypot(q.x - P.x, q.y - P.y);
        if (d < bd || (d === bd && e.handles)) ((bd = d), (best = { id: e.id, index: i, handle: null }));
      });
    return best;
  }

  function finishDraw() {
    if (!draw) return;
    const d = draw;
    // a double-click adds an anchor or two on top of the last one: drop them
    const nodes: PenNode[] = [], snaps: (Snap | null)[] = [];
    d.nodes.forEach((n, i) => {
      if (nodes.length && samePlace(nodes[nodes.length - 1].p, n.p, 0.5)) {
        if (!isCorner(n)) nodes[nodes.length - 1] = n;
        return;
      }
      nodes.push(n);
      snaps.push(d.snaps[i]);
    });
    stop();
    if (nodes.length < (d.opts.closed ? 3 : 2)) return d.opts.onCancel?.();
    d.opts.onDone(nodes, snaps);
  }
  function stop() {
    mode = 'idle';
    draw = null;
    map.doubleClickZoom.enable();
    map.getCanvas().style.cursor = '';
    showHint(null);
    render();
  }

  /** Guides from what is being drawn: straight on and square from the last point; for a shape, from the first too. */
  function drawGuides(): Guide[] {
    if (!draw || !guidesOn) return [];
    const n = draw.nodes;
    const g: Guide[] = n.length ? anchorGuides(n, n.length - 1, false) : [];
    if (n.length >= 2) {
      const b0 = n[0].o[0] || n[0].o[1] ? (Math.atan2(n[0].o[0], n[0].o[1]) * 180) / Math.PI : bearingOf(n[0].p, n[1].p);
      g.push({ p: n[0].p, bearing: b0 + 180, label: 'Straight back from the first point' }, { p: n[0].p, bearing: b0 + 90, both: true, label: 'Square to the first point' });
    }
    return g;
  }
  /** Guides for a dragged point: straight on and square from its neighbours. */
  function dragGuides(): Guide[] {
    if (!drag || !guidesOn) return [];
    const g: Guide[] = [];
    for (const t of drag.targets) {
      const e = editables.find((x) => x.id === t.id);
      const ns = drag.orig.get(t.id);
      if (!e || !ns || ns.length < 2) continue;
      for (const step of [-1, 1]) {
        const j = t.index + step, far = t.index + 2 * step;
        const J = e.closed ? (j + ns.length) % ns.length : j, F = e.closed ? (far + ns.length) % ns.length : far;
        if (J < 0 || J >= ns.length || J === t.index) continue;
        if (F >= 0 && F < ns.length && F !== t.index) {
          const b = bearingOf(ns[F].p, ns[J].p);
          g.push({ p: ns[J].p, bearing: b, label: 'Straight on' }, { p: ns[J].p, bearing: b + 90, both: true, label: 'Square' });
        } else {
          const b = bearingOf(ns[J].p, ns[t.index].p);
          g.push({ p: ns[J].p, bearing: b, label: 'Same line' });
        }
      }
    }
    return g;
  }

  // ---- events
  map.on('mousedown', (e) => {
    if (e.originalEvent.button !== 0 || space) return;
    if (mode === 'draw' && draw) {
      e.preventDefault();
      const n = draw.nodes;
      if (draw.opts.closed && n.length >= 3) {
        const q = map.project(n[0].p as [number, number]);
        if (Math.hypot(q.x - e.point.x, q.y - e.point.y) < PX_POINT) {
          draw.dragging = { index: 0, start: e.point, closing: true, moved: false };
          return render();
        }
      }
      const snap = snapAt(e.point, draw.opts.exclude ?? [], n.length ? n[n.length - 1].p : null, [], drawGuides());
      n.push(node(snap.p));
      draw.snaps.push(snap.kind === 'none' || snap.kind === 'angle' ? null : snap);
      draw.dragging = { index: n.length - 1, start: e.point, closing: false, moved: false };
      return render();
    }
    const hit = editables.length ? hitAt(e.point) : null;
    if (!hit) {
      if (selAnchor) ((selAnchor = null), render());
      return;
    }
    e.preventDefault();
    const orig = new Map(editables.map((x) => [x.id, cloneNodes(x.nodes)]));
    const at = editables.find((x) => x.id === hit.id)!.nodes[hit.index].p;
    const targets = hit.handle
      ? [{ id: hit.id, index: hit.index }]
      : editables.flatMap((x) => x.nodes.map((n, i) => ({ id: x.id, index: i, p: n.p }))).filter((t) => samePlace(t.p, at)).map(({ id, index }) => ({ id, index }));
    selAnchor = hit.handle ? selAnchor : { id: hit.id, index: hit.index };
    drag = { grabbed: { id: hit.id, index: hit.index }, targets, handle: hit.handle, pull: !hit.handle && alt, orig, live: new Map(), start: e.point, moved: false, snap: null };
    render();
  });

  map.on('mousemove', (e) => {
    if (mode === 'draw' && draw) {
      const d = draw.dragging;
      if (d) {
        if (!d.moved && Math.hypot(e.point.x - d.start.x, e.point.y - d.start.y) < 3) return;
        d.moved = true;
        const n = draw.nodes[d.index];
        const o = offsetTo(n, [e.lngLat.lng, e.lngLat.lat]);
        n.o = o;
        if (!alt) n.i = [-o[0], -o[1]];
        showHint('Drag to shape the curve · Alt: one side only', e.point);
        return render();
      }
      draw.cursor = snapAt(e.point, draw.opts.exclude ?? [], draw.nodes.length ? draw.nodes[draw.nodes.length - 1].p : null, [], drawGuides());
      const closing = draw.opts.closed && draw.nodes.length >= 3 && (() => {
        const q = map.project(draw!.nodes[0].p as [number, number]);
        return Math.hypot(q.x - e.point.x, q.y - e.point.y) < PX_POINT;
      })();
      showHint(closing ? 'Close the shape' : draw.cursor.label || (draw.nodes.length ? 'Click: corner · drag: curve · double-click or Enter: finish' : 'Click to start · drag to curve'), e.point);
      return render();
    }
    if (drag) {
      if (!drag.moved && Math.hypot(e.point.x - drag.start.x, e.point.y - drag.start.y) < 3) return;
      drag.moved = true;
      const q: Position = [e.lngLat.lng, e.lngLat.lat];
      const live = (id: string) => {
        if (!drag!.live.has(id)) drag!.live.set(id, cloneNodes(drag!.orig.get(id)!));
        return drag!.live.get(id)!;
      };
      if (drag.handle) {
        const n = live(drag.grabbed.id)[drag.grabbed.index];
        const w = drag.handle, other = w === 'i' ? 'o' : 'i';
        const o = offsetTo(n, q);
        n[w] = o;
        if (!alt) {
          // smooth: the other handle turns to stay opposite, keeping its own length
          const L = Math.hypot(n[other][0], n[other][1]) || Math.hypot(o[0], o[1]);
          const M = Math.hypot(o[0], o[1]) || 1;
          n[other] = [(-o[0] / M) * L, (-o[1] / M) * L];
        }
        showHint(alt ? 'One handle only' : 'Shape the curve · Alt: break the handles', e.point);
      } else if (drag.pull) {
        const n = live(drag.grabbed.id)[drag.grabbed.index];
        const o = offsetTo(n, q);
        n.o = o;
        n.i = [-o[0], -o[1]];
        showHint('Pulling out handles', e.point);
      } else {
        const ids = [...new Set(drag.targets.map((t) => t.id))];
        drag.snap = snapAt(e.point, ids, null, [], dragGuides());
        for (const t of drag.targets) live(t.id)[t.index].p = drag.snap.p;
        showHint(drag.snap.label || (drag.targets.length > 1 ? 'Moving the junction' : 'Moving the point'), e.point);
      }
      return render();
    }
    // hover: show that anchors can be grabbed
    if (editables.length && !space) {
      const hit = hitAt(e.point);
      if (hit) {
        map.getCanvas().style.cursor = 'move';
        hoverCursor = true;
        showHint(hit.handle ? 'Drag the handle' : 'Drag to move · Alt-drag: curve · Alt-click: corner', e.point);
      } else if (hoverCursor) {
        map.getCanvas().style.cursor = '';
        hoverCursor = false;
        showHint(null);
      }
    }
  });

  map.on('mouseup', () => {
    if (mode === 'draw' && draw?.dragging) {
      const closing = draw.dragging.closing;
      draw.dragging = null;
      if (closing) return finishDraw();
      return render();
    }
    if (drag) {
      const d = drag;
      drag = null;
      showHint(null);
      if (d.moved) deps.onEdit(d.live, d.handle || d.pull ? null : d.snap, d.handle || d.pull ? null : d.grabbed);
      else if (alt && !d.handle) {
        // alt-click on an anchor: make it a corner
        const e = editables.find((x) => x.id === d.grabbed.id)!;
        const ns = cloneNodes(e.nodes);
        ns[d.grabbed.index].i = [0, 0];
        ns[d.grabbed.index].o = [0, 0];
        deps.onEdit(new Map([[e.id, ns]]), null, null);
      }
      render();
    }
  });

  map.on('dblclick', (e) => {
    if (mode === 'draw') {
      e.preventDefault();
      return finishDraw();
    }
    // double-click on a selected path adds an anchor there
    const P = e.point;
    for (const ed of editables) {
      if (!ed.handles) continue;
      const near = nearestOnPath(ed.nodes, ed.closed, [e.lngLat.lng, e.lngLat.lat]);
      const q = map.project(near.p as [number, number]);
      if (Math.hypot(q.x - P.x, q.y - P.y) > PX_HIT) continue;
      e.preventDefault();
      const r = splitAt(ed.nodes, near.seg, near.t);
      selAnchor = { id: ed.id, index: r.index };
      deps.onEdit(new Map([[ed.id, r.nodes]]), null, null);
      return;
    }
  });

  map.on('move', () => {
    if (mode === 'draw' || drag) render();
  });

  // Keys: Space pans while drawing; Enter finishes, Esc cancels, Backspace takes the last anchor back.
  window.addEventListener(
    'keydown',
    (e) => {
      shift = e.shiftKey;
      noSnap = e.ctrlKey || e.metaKey;
      alt = e.altKey;
      const typing = (e.target as HTMLElement)?.closest?.('input,select,textarea');
      if (typing) return;
      if (e.key === ' ' && mode === 'draw') {
        space = true;
        map.getCanvas().style.cursor = 'grab';
        e.preventDefault();
      }
      if (mode === 'draw' && draw) {
        if (e.key === 'Enter') return (e.preventDefault(), e.stopImmediatePropagation(), finishDraw());
        if (e.key === 'Escape') {
          e.preventDefault();
          e.stopImmediatePropagation();
          const d = draw;
          stop();
          return d.opts.onCancel?.();
        }
        if (e.key === 'Backspace' || e.key === 'Delete' || ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z')) {
          e.preventDefault();
          e.stopImmediatePropagation();
          draw.nodes.pop();
          draw.snaps.pop();
          return render();
        }
      }
      if (mode === 'idle' && selAnchor && (e.key === 'Delete' || e.key === 'Backspace')) {
        const ed = editables.find((x) => x.id === selAnchor!.id);
        if (!ed || !ed.handles) return;
        e.preventDefault();
        e.stopImmediatePropagation();
        if (ed.nodes.length <= (ed.minNodes ?? (ed.closed ? 3 : 2))) return;
        const ns = cloneNodes(ed.nodes);
        ns.splice(selAnchor.index, 1);
        selAnchor = null;
        deps.onEdit(new Map([[ed.id, ns]]), null, null);
      }
    },
    true,
  );
  window.addEventListener(
    'keyup',
    (e) => {
      shift = e.shiftKey;
      noSnap = e.ctrlKey || e.metaKey;
      alt = e.altKey;
      if (e.key === ' ' && space) {
        space = false;
        map.getCanvas().style.cursor = mode === 'draw' ? 'crosshair' : '';
      }
    },
    true,
  );
  window.addEventListener('blur', () => ((space = false), (alt = false), (shift = false)));

  return {
    /** Add the overlay layers (after the style loads, above everything else). */
    addLayers() {
      if (!map.getSource('pen')) map.addSource('pen', { type: 'geojson', data: fc([]) });
      const k = (v: string) => ['==', ['get', 'kind'], v] as any;
      map.addLayer({ id: 'pen-preview', type: 'line', source: 'pen', filter: k('preview'), paint: { 'line-color': '#2433e0', 'line-width': 1.5, 'line-dasharray': [2, 2], 'line-emissive-strength': 1 } as any });
      map.addLayer({ id: 'pen-path', type: 'line', source: 'pen', filter: k('path'), layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': '#2433e0', 'line-width': 2, 'line-emissive-strength': 1 } as any });
      map.addLayer({ id: 'pen-hline', type: 'line', source: 'pen', filter: k('hline'), paint: { 'line-color': '#2433e0', 'line-width': 1, 'line-opacity': 0.75, 'line-emissive-strength': 1 } as any });
      map.addLayer({ id: 'pen-handle', type: 'circle', source: 'pen', filter: k('handle'), paint: { 'circle-radius': 3.5, 'circle-color': '#2433e0', 'circle-stroke-color': '#fff', 'circle-stroke-width': 1, 'circle-emissive-strength': 1 } as any });
      map.addLayer({
        id: 'pen-anchor', type: 'circle', source: 'pen', filter: k('anchor'),
        paint: {
          'circle-radius': ['case', ['get', 'first'], 6, ['get', 'junction'], 5, ['get', 'active'], 4.5, 3.5],
          'circle-color': ['case', ['get', 'sel'], '#2433e0', ['get', 'junction'], '#141414', '#ffffff'],
          'circle-stroke-color': ['case', ['get', 'junction'], '#ffffff', ['get', 'active'], '#2433e0', '#6f6e6a'],
          'circle-stroke-width': ['case', ['get', 'active'], 1.6, 1.2],
          'circle-emissive-strength': 1,
        } as any,
      });
      map.addLayer({ id: 'pen-guide', type: 'line', source: 'pen', filter: k('guide'), paint: { 'line-color': '#2433e0', 'line-width': 1, 'line-opacity': 0.35, 'line-dasharray': [3, 3], 'line-emissive-strength': 1 } as any });
      map.addLayer({ id: 'pen-guide-on', type: 'line', source: 'pen', filter: k('guide-on'), paint: { 'line-color': '#f08a1c', 'line-width': 1.4, 'line-dasharray': [4, 2], 'line-emissive-strength': 1 } as any });
      map.addLayer({ id: 'pen-snap', type: 'circle', source: 'pen', filter: k('snap'), paint: { 'circle-radius': 8, 'circle-color': 'rgba(0,0,0,0)', 'circle-stroke-color': '#f08a1c', 'circle-stroke-width': 2, 'circle-emissive-strength': 1 } as any });
      render();
    },
    /** Start drawing a path (open) or shape (closed). */
    draw(opts: DrawOpts) {
      if (mode === 'draw') stop();
      mode = 'draw';
      draw = { nodes: [], snaps: [], opts, dragging: null, cursor: null };
      selAnchor = null;
      map.doubleClickZoom.disable();
      map.getCanvas().style.cursor = 'crosshair';
      render();
    },
    cancel() {
      if (mode === 'draw') {
        const d = draw;
        stop();
        d?.opts.onCancel?.();
      }
    },
    active: () => mode === 'draw' || !!drag,
    drawing: () => mode === 'draw',
    /** What can be edited on the map now. */
    setEditables(list: Editable[]) {
      editables = list;
      if (selAnchor && !list.some((e) => e.id === selAnchor!.id && e.handles)) selAnchor = null;
      srcCache = null;
      render();
    },
    /** The things to snap to have changed. */
    invalidate() {
      srcCache = null;
    },
    snapAt,
    /** Guides and measurements on or off. */
    setGuides(on: boolean) {
      guidesOn = on;
      guideView = [];
      render();
    },
  };
}
export type Pen = ReturnType<typeof createPen>;
export type { PenNode, XY };
