// Pen paths: anchors with Bézier handles, as drawn with a pen tool. Shared by the pen tool (drawing and
// editing on the map) and the masterplan (streets, open spaces and blocks keep their anchors).
import type { Position } from 'geojson';

export type XY = [number, number];
/** An anchor and its handles: i (in) and o (out) are offsets from the anchor in metres (east, north). */
export interface PenNode { p: Position; i: XY; o: XY }

const KY = 110574;
const kxAt = (lat: number) => 111320 * Math.cos((lat * Math.PI) / 180);

/** A flat frame in metres around a point; fine over a site or a town. */
export function frameAt(p: Position) {
  const kx = kxAt(p[1]);
  return {
    to: (q: Position): XY => [(q[0] - p[0]) * kx, (q[1] - p[1]) * KY],
    from: (q: XY): Position => [p[0] + q[0] / kx, p[1] + q[1] / KY],
  };
}

export const node = (p: Position, i: XY = [0, 0], o: XY = [0, 0]): PenNode => ({ p: [p[0], p[1]], i: [i[0], i[1]], o: [o[0], o[1]] });
export const nodesFrom = (pts: Position[]) => pts.map((p) => node(p));
export const isCorner = (n: PenNode) => !n.i[0] && !n.i[1] && !n.o[0] && !n.o[1];
export const cloneNodes = (ns: PenNode[]) => ns.map((n) => node(n.p, n.i, n.o));

/** A handle's position on the map. */
export function handleAt(n: PenNode, which: 'i' | 'o'): Position {
  const h = n[which];
  return [n.p[0] + h[0] / kxAt(n.p[1]), n.p[1] + h[1] / KY];
}
/** The offset (metres) from an anchor to a point on the map. */
export function offsetTo(n: PenNode, q: Position): XY {
  return [(q[0] - n.p[0]) * kxAt(n.p[1]), (q[1] - n.p[1]) * KY];
}

const lerp = (a: XY, b: XY, t: number): XY => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
function cubic(a: XY, b: XY, c: XY, d: XY, t: number): XY {
  const u = 1 - t;
  return [u * u * u * a[0] + 3 * u * u * t * b[0] + 3 * u * t * t * c[0] + t * t * t * d[0], u * u * u * a[1] + 3 * u * u * t * b[1] + 3 * u * t * t * c[1] + t * t * t * d[1]];
}

/** The four control points of segment k (from node k to the next), in a frame. */
function segment(nodes: PenNode[], k: number, F: ReturnType<typeof frameAt>): [XY, XY, XY, XY] {
  const a = nodes[k], b = nodes[(k + 1) % nodes.length];
  const A = F.to(a.p), B = F.to(b.p);
  return [A, [A[0] + a.o[0], A[1] + a.o[1]], [B[0] + b.i[0], B[1] + b.i[1]], B];
}
const segCount = (n: number, closed: boolean) => (closed ? n : n - 1);
const straight = (s: [XY, XY, XY, XY]) => s[1][0] === s[0][0] && s[1][1] === s[0][1] && s[2][0] === s[3][0] && s[2][1] === s[3][1];

/** The path as points on the map: straight segments stay two points; curves are sampled every ~1.5 m. */
export function bezierPath(nodes: PenNode[], closed = false): Position[] {
  if (nodes.length < 2) return nodes.map((n) => n.p);
  const F = frameAt(nodes[0].p);
  const out: XY[] = [F.to(nodes[0].p)];
  for (let k = 0; k < segCount(nodes.length, closed); k++) {
    const s = segment(nodes, k, F);
    if (straight(s)) {
      out.push(s[3]);
      continue;
    }
    const len = Math.hypot(s[1][0] - s[0][0], s[1][1] - s[0][1]) + Math.hypot(s[2][0] - s[1][0], s[2][1] - s[1][1]) + Math.hypot(s[3][0] - s[2][0], s[3][1] - s[2][1]);
    const steps = Math.max(6, Math.min(80, Math.round(len / 1.5)));
    for (let j = 1; j <= steps; j++) out.push(cubic(...s, j / steps));
  }
  return out.map(F.from);
}

/**
 * Smooth handles for every anchor (Catmull-Rom), k from 0 (corners) to 1 (a full curve through the
 * anchors). The ends of an open path keep no handle.
 */
export function autoHandles(nodes: PenNode[], k: number, closed = false): PenNode[] {
  const n = nodes.length;
  if (n < 3 || !(k > 0)) return nodes.map((x) => node(x.p));
  return nodes.map((x, i) => {
    const end = !closed && (i === 0 || i === n - 1);
    if (end) return node(x.p);
    const prev = nodes[(i - 1 + n) % n].p, next = nodes[(i + 1) % n].p;
    const F = frameAt(x.p);
    const a = F.to(prev), b = F.to(next);
    const t: XY = [((b[0] - a[0]) * k) / 6, ((b[1] - a[1]) * k) / 6];
    return node(x.p, [-t[0], -t[1]], t);
  });
}

/** The point on the path nearest q: its segment, its place along it (t) and the distance in metres. */
export function nearestOnPath(nodes: PenNode[], closed: boolean, q: Position): { seg: number; t: number; p: Position; dist: number } {
  const F = frameAt(q);
  let best = { seg: 0, t: 0, p: nodes[0]?.p ?? q, dist: Infinity };
  for (let k = 0; k < segCount(nodes.length, closed); k++) {
    const s = segment(nodes, k, F);
    const N = straight(s) ? 1 : 60;
    for (let j = 0; j < N; j++) {
      // the nearest point on each small chord
      const a = straight(s) ? s[0] : cubic(...s, j / N), b = straight(s) ? s[3] : cubic(...s, (j + 1) / N);
      const dx = b[0] - a[0], dy = b[1] - a[1];
      const L2 = dx * dx + dy * dy || 1e-9;
      const u = Math.max(0, Math.min(1, (-a[0] * dx - a[1] * dy) / L2));
      const px = a[0] + dx * u, py = a[1] + dy * u;
      const d = Math.hypot(px, py);
      if (d < best.dist) best = { seg: k, t: (j + u) / N, p: F.from([px, py]), dist: d };
    }
  }
  return best;
}

/** Insert an anchor on segment `seg` at `t`, keeping the curve exactly as it was (de Casteljau). */
export function splitAt(nodes: PenNode[], seg: number, t: number): { nodes: PenNode[]; index: number } {
  const ns = cloneNodes(nodes);
  const F = frameAt(ns[seg].p);
  const [P0, P1, P2, P3] = segment(ns, seg, F);
  const P01 = lerp(P0, P1, t), P12 = lerp(P1, P2, t), P23 = lerp(P2, P3, t);
  const P012 = lerp(P01, P12, t), P123 = lerp(P12, P23, t), Q = lerp(P012, P123, t);
  const a = ns[seg], bi = (seg + 1) % ns.length, b = ns[bi];
  const corner = straight([P0, P1, P2, P3]);
  a.o = corner ? [0, 0] : [P01[0] - P0[0], P01[1] - P0[1]];
  // b's handle is in b's own frame, but the frames differ only by a scale too small to matter here.
  b.i = corner ? [0, 0] : [P23[0] - P3[0], P23[1] - P3[1]];
  const mid = node(F.from(Q), corner ? [0, 0] : [P012[0] - Q[0], P012[1] - Q[1]], corner ? [0, 0] : [P123[0] - Q[0], P123[1] - Q[1]]);
  ns.splice(seg + 1, 0, mid);
  return { nodes: ns, index: seg + 1 };
}

/** Same place, to within a few centimetres. */
export const samePlace = (a: Position, b: Position, tolM = 0.3) => Math.hypot((a[0] - b[0]) * kxAt(a[1]), (a[1] - b[1]) * KY) < tolM;
