// Walking reach along the street network: a shortest-path tree from a point, walked at 80 m a
// minute (4.8 km/h), cut into short pieces that each know how far from the start they are.
import type { Feature, FeatureCollection, LineString } from 'geojson';
import { LocalFrame, type XY } from './geo';

export const WALK_SPEED = 80; // metres per minute
export const BANDS = [5, 10, 15]; // minutes

interface Graph { pts: XY[]; adj: { to: number; w: number }[][] }

/** Build a graph from street lines, joining ends that meet (tile seams) and T-junctions. */
export function buildGraph(lines: { coords: number[][] }[], frame: LocalFrame): Graph {
  const pts: XY[] = [];
  const adj: { to: number; w: number }[][] = [];
  const cell = 2; // metres: points closer than this are the same node
  const grid = new Map<string, number[]>();
  const node = (p: XY) => {
    const gx = Math.floor(p[0] / cell), gy = Math.floor(p[1] / cell);
    for (let dx = -1; dx <= 1; dx++)
      for (let dy = -1; dy <= 1; dy++)
        for (const i of grid.get(`${gx + dx},${gy + dy}`) ?? [])
          if (Math.hypot(pts[i][0] - p[0], pts[i][1] - p[1]) < cell) return i;
    pts.push(p);
    adj.push([]);
    const k = `${gx},${gy}`;
    (grid.get(k) ?? grid.set(k, []).get(k)!).push(pts.length - 1);
    return pts.length - 1;
  };
  const link = (a: number, b: number) => {
    if (a === b) return;
    const w = Math.hypot(pts[a][0] - pts[b][0], pts[a][1] - pts[b][1]);
    adj[a].push({ to: b, w });
    adj[b].push({ to: a, w });
  };
  const edges: [number, number][] = [];
  for (const l of lines) {
    let prev = -1;
    for (const c of l.coords) {
      const i = node(frame.toLocal(c));
      if (prev >= 0 && prev !== i) (link(prev, i), edges.push([prev, i]));
      prev = i;
    }
  }
  // T-junctions: a street that stops within 4 m of another street's side joins it there.
  const eg = edgeGrid(pts, edges, 20);
  for (let i = 0; i < pts.length; i++) {
    if (adj[i].length !== 1) continue;
    const hit = nearestEdge(pts, eg, pts[i], 4, i);
    if (hit) attach(i, hit);
  }
  function attach(i: number, hit: { a: number; b: number; p: XY }) {
    const j = node(hit.p);
    link(j, hit.a);
    link(j, hit.b);
    link(i, j);
  }
  return { pts, adj };
}

interface EdgeGrid { size: number; cells: Map<string, [number, number][]> }
function edgeGrid(pts: XY[], edges: [number, number][], size: number): EdgeGrid {
  const cells = new Map<string, [number, number][]>();
  for (const e of edges) {
    const [a, b] = [pts[e[0]], pts[e[1]]];
    for (let x = Math.floor(Math.min(a[0], b[0]) / size); x <= Math.floor(Math.max(a[0], b[0]) / size); x++)
      for (let y = Math.floor(Math.min(a[1], b[1]) / size); y <= Math.floor(Math.max(a[1], b[1]) / size); y++) {
        const k = `${x},${y}`;
        (cells.get(k) ?? cells.set(k, []).get(k)!).push(e);
      }
  }
  return { size, cells };
}

function closest(p: XY, a: XY, b: XY): XY {
  const dx = b[0] - a[0], dy = b[1] - a[1], L = dx * dx + dy * dy;
  const t = L ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / L)) : 0;
  return [a[0] + t * dx, a[1] + t * dy];
}

function nearestEdge(pts: XY[], g: EdgeGrid, p: XY, max: number, skip = -1) {
  let best: { a: number; b: number; p: XY; d: number } | null = null;
  const gx = Math.floor(p[0] / g.size), gy = Math.floor(p[1] / g.size);
  const r = Math.ceil(max / g.size);
  for (let x = gx - r; x <= gx + r; x++)
    for (let y = gy - r; y <= gy + r; y++)
      for (const [a, b] of g.cells.get(`${x},${y}`) ?? []) {
        if (a === skip || b === skip) continue;
        const q = closest(p, pts[a], pts[b]);
        const d = Math.hypot(q[0] - p[0], q[1] - p[1]);
        if (d <= max && (!best || d < best.d)) best = { a, b, p: q, d };
      }
  return best;
}

/** Distances (metres) from the nearest street to `origin`, by Dijkstra. */
export function walkFrom(g: Graph, origin: XY, limit: number) {
  // Join the start to the nearest street (within 250 m), counting the walk to reach it.
  const edges: [number, number][] = [];
  g.adj.forEach((ns, a) => ns.forEach((n) => a < n.to && edges.push([a, n.to])));
  const hit = nearestEdge(g.pts, edgeGrid(g.pts, edges, 50), origin, 250);
  if (!hit) return null;
  const dist = new Float64Array(g.pts.length).fill(Infinity);
  const start = Math.hypot(hit.p[0] - origin[0], hit.p[1] - origin[1]);
  const heap = new MinHeap();
  for (const end of [hit.a, hit.b]) {
    const d = start + Math.hypot(g.pts[end][0] - hit.p[0], g.pts[end][1] - hit.p[1]);
    if (d < dist[end]) ((dist[end] = d), heap.push(d, end));
  }
  while (heap.size) {
    const [d, i] = heap.pop()!;
    if (d > dist[i] || d > limit) continue;
    for (const n of g.adj[i]) {
      const nd = d + n.w;
      if (nd < dist[n.to]) ((dist[n.to] = nd), heap.push(nd, n.to));
    }
  }
  return { dist, snap: hit.p, start };
}

/**
 * The reached streets as short pieces (about 8 m), each with `d`: metres from the start, and
 * `band`: 5, 10 or 15. Also the street length reached in each band.
 */
export function walkPieces(g: Graph, dist: Float64Array, frame: LocalFrame, limit: number) {
  const features: Feature<LineString>[] = [];
  const lengthIn: Record<number, number> = { 5: 0, 10: 0, 15: 0 };
  const done = new Set<string>();
  const band = (d: number) => BANDS.find((b) => d <= b * WALK_SPEED) ?? 15;
  g.adj.forEach((ns, a) => {
    for (const { to: b, w } of ns) {
      const key = a < b ? `${a}-${b}` : `${b}-${a}`;
      if (done.has(key)) continue;
      done.add(key);
      const da = dist[a], db = dist[b];
      if (Math.min(da, db) > limit || !isFinite(Math.min(da, db))) continue;
      const n = Math.max(1, Math.ceil(w / 8));
      const at = (t: number) => Math.min(da + t * w, db + (1 - t) * w); // shortest way to this point
      for (let k = 0; k < n; k++) {
        const t0 = k / n, t1 = (k + 1) / n;
        const d0 = at(t0), d1 = at(t1);
        const d = Math.min(d0, d1);
        if (d > limit) continue;
        const p0: XY = [g.pts[a][0] + (g.pts[b][0] - g.pts[a][0]) * t0, g.pts[a][1] + (g.pts[b][1] - g.pts[a][1]) * t0];
        const p1: XY = [g.pts[a][0] + (g.pts[b][0] - g.pts[a][0]) * t1, g.pts[a][1] + (g.pts[b][1] - g.pts[a][1]) * t1];
        const mid = (d0 + d1) / 2;
        const bd = band(mid);
        lengthIn[bd] += w / n;
        features.push({ type: 'Feature', properties: { d, band: bd }, geometry: { type: 'LineString', coordinates: [frame.toLngLat(p0), frame.toLngLat(p1)] } });
      }
    }
  });
  return { fc: { type: 'FeatureCollection', features } as FeatureCollection, lengthIn };
}

class MinHeap {
  private k: number[] = [];
  private v: number[] = [];
  get size() { return this.k.length; }
  push(key: number, val: number) {
    const k = this.k, v = this.v;
    let i = k.length;
    k.push(key); v.push(val);
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (k[p] <= k[i]) break;
      [k[p], k[i]] = [k[i], k[p]]; [v[p], v[i]] = [v[i], v[p]];
      i = p;
    }
  }
  pop(): [number, number] | undefined {
    const k = this.k, v = this.v;
    if (!k.length) return undefined;
    const top: [number, number] = [k[0], v[0]];
    const lk = k.pop()!, lv = v.pop()!;
    if (k.length) {
      k[0] = lk; v[0] = lv;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1, r = l + 1;
        let m = i;
        if (l < k.length && k[l] < k[m]) m = l;
        if (r < k.length && k[r] < k[m]) m = r;
        if (m === i) break;
        [k[m], k[i]] = [k[i], k[m]]; [v[m], v[i]] = [v[i], v[m]];
        i = m;
      }
    }
    return top;
  }
}

/** Walking distance (metres) from the walk's start to a point, via its nearest street (within `max` m). */
export function distanceTo(g: Graph, dist: Float64Array, p: XY, max = 150): number | null {
  const edges: [number, number][] = [];
  // Only edges near the point matter: a coarse filter keeps this quick for many points.
  g.adj.forEach((ns, a) => {
    const pa = g.pts[a];
    if (Math.abs(pa[0] - p[0]) > max + 200 || Math.abs(pa[1] - p[1]) > max + 200) return;
    ns.forEach((n) => a < n.to && edges.push([a, n.to]));
  });
  const hit = nearestEdge(g.pts, edgeGrid(g.pts, edges, 50), p, max);
  if (!hit) return null;
  const off = Math.hypot(hit.p[0] - p[0], hit.p[1] - p[1]);
  const via = (i: number) => dist[i] + Math.hypot(g.pts[i][0] - hit.p[0], g.pts[i][1] - hit.p[1]);
  const d = Math.min(via(hit.a), via(hit.b)) + off;
  return isFinite(d) ? d : null;
}
