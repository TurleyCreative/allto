// Vector axonometric / plan renderer. Projects extruded footprints with an orthographic camera
// (or a plan-oblique axo), sorts faces back to front and writes clean, editable SVG.
import type { LocalPoly, XY } from './geo';

export interface Look { roof: string; wallLight: string; wallDark: string; stroke: string; strokeWidth?: number; roofStroke?: string; roofStrokeWidth?: number }
/** ridge: a gable roof over a rectangular footprint, from the eaves (z1) up to z at the ridge a–b. */
export interface AxoBuilding { polys: LocalPoly[]; z0: number; z1: number; look: Look; label?: string; ridge?: { a: XY; b: XY; z: number } }
export interface GroundPolys { polys: LocalPoly[]; fill: string; stroke?: string; strokeWidth?: number; dash?: string; opacity?: number }
export interface GroundLines { lines: XY[][]; stroke: string; widthM?: number; widthPx?: number; dash?: string; cap?: string }

export interface Scene {
  buildings: AxoBuilding[];
  clip?: LocalPoly[]; // study area: trims ground + forms the plinth
  ground?: (GroundPolys | GroundLines)[];
  shadows?: { toSun: XY; alt: number; opacity?: number };
  frame?: { minX: number; minY: number; maxX: number; maxY: number }; // fix bounds (local metres)
}

export interface AxoOpts {
  bearing: number; // degrees, like the map: the direction that points up the page
  mode: 'ortho' | 'oblique';
  pitch: number; // degrees from straight down (ortho only)
  heightScale?: number;
  width: number; // px
  plinth?: number; // metres of base under the study area
  groundColor?: string;
  background?: string;
  padding?: number;
  north?: boolean;
  scaleBar?: boolean;
  labels?: boolean;
  clipBuildings?: boolean;
  /** A hand-drawn look: lines wobble a little, on warm paper. */
  sketch?: boolean;
}

export const LOOK = {
  context: { roof: '#ffffff', wallLight: '#ecebe8', wallDark: '#b7b6b1', stroke: '#55534f', strokeWidth: 0.6 } as Look,
  listed: { roof: '#efe6f6', wallLight: '#e2d4ee', wallDark: '#a98bc2', stroke: '#4b2f63', strokeWidth: 0.6 } as Look,
  site: { roof: '#ffffff', wallLight: '#f3d6d7', wallDark: '#c98a8c', stroke: '#8f1a20', strokeWidth: 0.7 } as Look,
  selected: { roof: '#111111', wallLight: '#2a2a2a', wallDark: '#000000', stroke: '#111111', strokeWidth: 0.6, roofStroke: '#2433e0', roofStrokeWidth: 2.2 } as Look,
  massing: { roof: '#e6262e', wallLight: '#f0565c', wallDark: '#a3141a', stroke: '#6e0d11', strokeWidth: 0.7 } as Look,
};

function hex(c: string): number[] {
  const h = c.replace('#', '');
  return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16));
}
function mix(a: string, b: string, t: number) {
  const A = hex(a), B = hex(b);
  return '#' + A.map((v, i) => Math.round(v + (B[i] - v) * t).toString(16).padStart(2, '0')).join('');
}
const f1 = (n: number) => (Math.round(n * 100) / 100).toString();

let uid = 0;
export function renderAxo(scene: Scene, o: AxoOpts): string {
  const cid = `study${++uid}`;
  const b = (o.bearing * Math.PI) / 180;
  const cb = Math.cos(b), sb = Math.sin(b);
  const p = (o.pitch * Math.PI) / 180;
  const hs = o.heightScale ?? 1;
  const a = o.mode === 'ortho' ? Math.cos(p) : 1;
  const k = (o.mode === 'ortho' ? Math.sin(p) : 1) * hs;
  const rot = (x: number, y: number): XY => [x * cb - y * sb, x * sb + y * cb];
  const P = (x: number, y: number, z: number): XY => {
    const [xr, yr] = rot(x, y);
    return [xr, -(yr * a + z * k)];
  };

  // ---- bounds
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  const grow = (q: XY) => {
    if (q[0] < minX) minX = q[0];
    if (q[0] > maxX) maxX = q[0];
    if (q[1] < minY) minY = q[1];
    if (q[1] > maxY) maxY = q[1];
  };
  const plinth = scene.clip ? o.plinth ?? 0 : 0;
  if (scene.frame) {
    const F = scene.frame;
    for (const [x, y] of [[F.minX, F.minY], [F.maxX, F.minY], [F.maxX, F.maxY], [F.minX, F.maxY]] as XY[]) grow(P(x, y, 0));
  } else {
    if (scene.clip) for (const pl of scene.clip) for (const q of pl[0]) (grow(P(q[0], q[1], 0)), grow(P(q[0], q[1], -plinth)));
    for (const bd of scene.buildings) for (const pl of bd.polys) for (const q of pl[0]) (grow(P(q[0], q[1], bd.z0)), grow(P(q[0], q[1], bd.ridge?.z ?? bd.z1)));
  }
  if (!isFinite(minX)) return '<svg xmlns="http://www.w3.org/2000/svg"/>';
  const pad = o.padding ?? 40;
  const s = (o.width - pad * 2) / Math.max(1, maxX - minX);
  const W = o.width, H = Math.ceil((maxY - minY) * s + pad * 2 + (o.scaleBar ? 24 : 0));
  const tx = pad - minX * s, ty = pad - minY * s;

  const ringPath = (r: XY[], z: number) => r.map((q, i) => { const v = P(q[0], q[1], z); return `${i ? 'L' : 'M'}${f1(v[0])} ${f1(v[1])}`; }).join('') + 'Z';
  const polyPath = (pl: LocalPoly, z: number) => pl.map((r) => ringPath(r, z)).join('');
  const linePath = (l: XY[]) => l.map((q, i) => { const v = P(q[0], q[1], 0); return `${i ? 'L' : 'M'}${f1(v[0])} ${f1(v[1])}`; }).join('');
  const nss = 'vector-effect="non-scaling-stroke"';

  const pathOf = (pts: [XY, number][]) => `M${pts.map(([q, z]) => { const v = P(q[0], q[1], z); return `${f1(v[0])} ${f1(v[1])}`; }).join('L')}Z`;
  /** Roof slopes (farther first), then the gable ends that face the viewer. */
  function gableRoof(bd: AxoBuilding, L: Look, sw: number): string[] {
    const { a, b, z } = bd.ridge!;
    const r = bd.polys[0][0];
    const near = (q: XY) => (Math.hypot(q[0] - a[0], q[1] - a[1]) < Math.hypot(q[0] - b[0], q[1] - b[1]) ? a : b);
    const slopes: { d: number; path: string; fill: string }[] = [], gables: string[] = [];
    for (let i = 0; i < r.length; i++) {
      const A = r[i], B = r[(i + 1) % r.length];
      const RA = near(A), RB = near(B);
      const ra = rot(...A), rb = rot(...B);
      if (RA === RB) {
        // A gable end: the wall's triangle up to the ridge, when that wall faces the viewer.
        if (k > 0.001 && rb[0] - ra[0] > 1e-6) {
          const len = Math.hypot(rb[0] - ra[0], rb[1] - ra[1]);
          const fill = mix(L.wallDark, L.wallLight, (1 - (rb[1] - ra[1]) / len) / 2);
          gables.push(`<path d="${pathOf([[A, bd.z1], [B, bd.z1], [RA, z]])}" fill="${fill}" stroke="${L.stroke}" stroke-width="${sw}" ${nss}/>`);
        }
      } else {
        const len = Math.hypot(rb[0] - ra[0], rb[1] - ra[1]) || 1;
        const facing = (rb[0] - ra[0]) / len; // 1: the eave runs across the view, slope toward the viewer
        slopes.push({ d: (ra[1] + rb[1]) / 2, fill: mix(L.roof, L.wallDark, facing > 0 ? 0.08 : 0.3), path: pathOf([[A, bd.z1], [B, bd.z1], [RB, z], [RA, z]]) });
      }
    }
    slopes.sort((x, y) => y.d - x.d);
    return [...slopes.map((s) => `<path d="${s.path}" fill="${s.fill}" stroke="${L.roofStroke ?? L.stroke}" stroke-width="${L.roofStrokeWidth ?? sw}" ${nss}/>`), ...gables];
  }

  const out: string[] = [];
  out.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family="'Plus Jakarta Sans', Helvetica, Arial, sans-serif">`);
  if (o.background) out.push(`<rect width="${W}" height="${H}" fill="${o.sketch ? '#fbf8f1' : o.background}"/>`);
  const skid = `sk${uid}`;
  const skf = o.sketch ? ` filter="url(#${skid})"` : '';
  // The filter works in drawing units (metres): a wobble of about 12 px wavelength and 2.5 px reach on the page.
  if (o.sketch) out.push(`<defs><filter id="${skid}" x="-2%" y="-2%" width="104%" height="104%"><feTurbulence type="fractalNoise" baseFrequency="${f1(s / 12)}" numOctaves="2" seed="7"/><feDisplacementMap in="SourceGraphic" scale="${f1(2.5 / s)}" xChannelSelector="R" yChannelSelector="G"/></filter></defs>`);
  if (scene.clip) out.push(`<defs><clipPath id="${cid}"><path d="${scene.clip.map((pl) => polyPath(pl, 0)).join('')}" clip-rule="evenodd"/></clipPath></defs>`);
  out.push(`<g transform="matrix(${f1(s)} 0 0 ${f1(s)} ${f1(tx)} ${f1(ty)})" stroke-linejoin="round">`);

  // ---- plinth (cut-out model base)
  if (scene.clip && plinth > 0) {
    out.push('<g id="plinth">');
    for (const pl of scene.clip) {
      const r = pl[0];
      for (let i = 0; i < r.length; i++) {
        const A = r[i], B = r[(i + 1) % r.length];
        const ra = rot(...A), rb = rot(...B);
        if (rb[0] - ra[0] <= 0) continue;
        const pts = [P(A[0], A[1], 0), P(B[0], B[1], 0), P(B[0], B[1], -plinth), P(A[0], A[1], -plinth)];
        out.push(`<path d="M${pts.map((v) => `${f1(v[0])} ${f1(v[1])}`).join('L')}Z" fill="#3b3a38" stroke="#3b3a38" stroke-width="0.5" ${nss}/>`);
      }
    }
    out.push('</g>');
  }
  if (scene.clip) out.push(`<path id="ground" d="${scene.clip.map((pl) => polyPath(pl, 0)).join('')}" fill="${o.groundColor ?? '#ecebe7'}" fill-rule="evenodd"/>`);

  // ---- ground layers
  out.push(`<g${skf}><g id="ground-layers"${scene.clip ? ` clip-path="url(#${cid})"` : ''}>`);
  for (const g of scene.ground ?? []) {
    if ('polys' in g) {
      const d = g.polys.map((pl) => polyPath(pl, 0)).join('');
      if (!d) continue;
      out.push(`<path d="${d}" fill="${g.fill}" fill-rule="evenodd"${g.opacity != null ? ` fill-opacity="${g.opacity}"` : ''}${g.stroke ? ` stroke="${g.stroke}" stroke-width="${g.strokeWidth ?? 1}" ${nss}${g.dash ? ` stroke-dasharray="${g.dash}"` : ''}` : ''}/>`);
    } else {
      const d = g.lines.map(linePath).join('');
      if (!d) continue;
      const w = g.widthM != null ? `stroke-width="${g.widthM}"` : `stroke-width="${g.widthPx ?? 1}" ${nss}`;
      out.push(`<path d="${d}" fill="none" stroke="${g.stroke}" ${w} stroke-linecap="${g.cap ?? 'round'}"${g.dash ? ` stroke-dasharray="${g.dash}"` : ''}/>`);
    }
  }
  // ---- cast shadows on the ground
  if (scene.shadows && scene.shadows.alt > 2) {
    const t = 1 / Math.tan((scene.shadows.alt * Math.PI) / 180);
    const [sx, sy] = scene.shadows.toSun;
    const parts: string[] = [];
    for (const bd of scene.buildings) {
      if (bd.z0 > 0.5) continue;
      const L = Math.min(bd.z1 * t, 400);
      const dx = -sx * L, dy = -sy * L;
      for (const pl of bd.polys) {
        const r = pl[0];
        parts.push(ringPath(r.map((q) => [q[0] + dx, q[1] + dy] as XY), 0));
        for (let i = 0; i < r.length; i++) {
          const A = r[i], B = r[(i + 1) % r.length];
          parts.push(ringPath([A, B, [B[0] + dx, B[1] + dy], [A[0] + dx, A[1] + dy]], 0));
        }
      }
    }
    // One path per piece: opposite windings would cancel in a single nonzero path. Group opacity keeps overlaps even.
    out.push(`<g id="shadows" opacity="${scene.shadows.opacity ?? 0.22}" fill="#000">${parts.map((d) => `<path d="${d}"/>`).join('')}</g>`);
  }
  out.push('</g>');

  out.push('</g>');
  // ---- buildings, far to near
  const items = scene.buildings.map((bd) => {
    let cy = 0, n = 0;
    for (const pl of bd.polys) for (const q of pl[0]) ((cy += rot(q[0], q[1])[1]), n++);
    return { bd, depth: n ? cy / n : 0 };
  });
  items.sort((x, y) => y.depth - x.depth || x.bd.z1 - y.bd.z1);
  const labels: string[] = [];
  out.push(`<g id="buildings"${skf}${o.clipBuildings && scene.clip ? ` clip-path="url(#${cid})"` : ''}>`);
  for (const { bd } of items) {
    const L = o.sketch ? { ...bd.look, stroke: '#3a3833', strokeWidth: Math.max(0.9, bd.look.strokeWidth ?? 0.6) } : bd.look;
    const sw = L.strokeWidth ?? 0.6;
    if (k > 0.001) {
      const walls: { d: number; path: string; fill: string }[] = [];
      for (const pl of bd.polys)
        for (const r of pl)
          for (let i = 0; i < r.length; i++) {
            const A = r[i], B = r[(i + 1) % r.length];
            const ra = rot(...A), rb = rot(...B);
            const dx = rb[0] - ra[0], dy = rb[1] - ra[1];
            const len = Math.hypot(dx, dy);
            if (dx <= 1e-6 || len < 1e-6) continue; // faces away from the viewer
            const nx = dy / len;
            const fill = mix(L.wallDark, L.wallLight, (1 - nx) / 2);
            const pts = [P(A[0], A[1], bd.z0), P(B[0], B[1], bd.z0), P(B[0], B[1], bd.z1), P(A[0], A[1], bd.z1)];
            walls.push({ d: (ra[1] + rb[1]) / 2, fill, path: `M${pts.map((v) => `${f1(v[0])} ${f1(v[1])}`).join('L')}Z` });
          }
      walls.sort((x, y) => y.d - x.d);
      for (const w of walls) out.push(`<path d="${w.path}" fill="${w.fill}" stroke="${L.stroke}" stroke-width="${sw}" ${nss}/>`);
    }
    if (bd.ridge) out.push(...gableRoof(bd, L, sw));
    else {
      const roof = bd.polys.map((pl) => polyPath(pl, bd.z1)).join('');
      out.push(`<path d="${roof}" fill="${L.roof}" fill-rule="evenodd" stroke="${L.roofStroke ?? L.stroke}" stroke-width="${L.roofStrokeWidth ?? sw}" ${nss}/>`);
    }
    if (o.labels && bd.label) {
      let cx = 0, cy = 0, n = 0;
      for (const q of bd.polys[0][0]) {
        const v = P(q[0], q[1], bd.z1);
        cx += v[0]; cy += v[1]; n++;
      }
      labels.push(`<text x="${f1((cx / n) * s + tx)}" y="${f1((cy / n) * s + ty)}" font-size="9" text-anchor="middle" dominant-baseline="middle" fill="#222" paint-order="stroke" stroke="#fff" stroke-width="2.5">${bd.label}</text>`);
    }
  }
  out.push('</g></g>');
  out.push(...labels);

  // ---- north arrow + scale bar (pixel space)
  if (o.north) {
    const nv = P(0, 1, 0), z = P(0, 0, 0);
    const ang = Math.atan2(nv[0] - z[0], -(nv[1] - z[1]));
    const cx = W - pad - 10, cy = pad + 18;
    out.push(`<g transform="translate(${cx} ${cy}) rotate(${f1((ang * 180) / Math.PI)})"><path d="M0 -16 L5 6 L0 2 L-5 6Z" fill="#111"/><text y="18" font-size="10" text-anchor="middle" transform="rotate(${f1((-ang * 180) / Math.PI)} 0 18)">N</text></g>`);
  }
  if (o.scaleBar) {
    const target = (W - pad * 2) / 5 / s;
    const nice = [5, 10, 20, 25, 50, 100, 200, 250, 500, 1000].reduce((p2, c) => (Math.abs(c - target) < Math.abs(p2 - target) ? c : p2));
    const px = nice * s, x0 = pad, y0 = H - 14;
    const note = o.mode === 'ortho' && o.pitch > 0 ? ' (across the page)' : '';
    out.push(`<g font-size="9" fill="#111"><rect x="${x0}" y="${y0 - 4}" width="${f1(px / 2)}" height="4" fill="#111"/><rect x="${f1(x0 + px / 2)}" y="${y0 - 4}" width="${f1(px / 2)}" height="4" fill="#fff" stroke="#111" stroke-width="0.8"/><text x="${x0}" y="${y0 + 9}">0</text><text x="${f1(x0 + px)}" y="${y0 + 9}" text-anchor="middle">${nice} m${note}</text></g>`);
  }
  out.push('</svg>');
  return out.join('');
}

/** Ground layers (landuse, water, roads) in a consistent diagram style. */
/** Widths (m) the drawings give each road class. */
export const ROAD_WIDTH_M: Record<string, number> = { motorway: 14, trunk: 12, primary: 11, secondary: 9, tertiary: 8, street: 6.5, street_limited: 5, service: 4, pedestrian: 4, track: 3, path: 1.6 };

export function groundLayers(m: { roads: { cls: string; lines: XY[][] }[]; landuse: { cls: string; polys: LocalPoly[] }[]; water: LocalPoly[][] }, green: Set<string>) {
  const W = ROAD_WIDTH_M;
  const layers: (GroundPolys | GroundLines)[] = [];
  layers.push({ polys: m.landuse.filter((l) => green.has(l.cls)).flatMap((l) => l.polys), fill: '#d3e2c4' });
  layers.push({ polys: m.water.flat(), fill: '#c4d9ea' });
  const groups = new Map<number, XY[][]>();
  for (const r of m.roads) {
    if (/rail/.test(r.cls)) continue;
    const w = W[r.cls.replace('_link', '')] ?? 4;
    if (!groups.has(w)) groups.set(w, []);
    groups.get(w)!.push(...r.lines);
  }
  [...groups.entries()].sort((x, y) => x[0] - y[0]).forEach(([w, lines]) => layers.push({ lines, stroke: '#ffffff', widthM: w }));
  const rail = m.roads.filter((r) => /rail/.test(r.cls)).flatMap((r) => r.lines);
  if (rail.length) layers.push({ lines: rail, stroke: '#8a8984', widthPx: 1.2, dash: '5 3', cap: 'butt' });
  return layers;
}
