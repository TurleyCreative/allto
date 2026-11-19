// Local metric frame + polygon helpers shared by the map, the SVG renderer and the passport.
import type { Feature, Polygon, MultiPolygon, Position } from 'geojson';

export type XY = [number, number];
/** One polygon as rings in local metres: [outer, ...holes]. Outer CCW, holes CW. */
export type LocalPoly = XY[][];

export class LocalFrame {
  readonly kx: number;
  readonly ky = 110574;
  constructor(readonly lon0: number, readonly lat0: number) {
    this.kx = 111320 * Math.cos((lat0 * Math.PI) / 180);
  }
  toLocal(p: Position): XY {
    return [(p[0] - this.lon0) * this.kx, (p[1] - this.lat0) * this.ky];
  }
  toLngLat(p: XY): [number, number] {
    return [this.lon0 + p[0] / this.kx, this.lat0 + p[1] / this.ky];
  }
}

export function signedArea(r: XY[]): number {
  let a = 0;
  for (let i = 0, n = r.length; i < n; i++) {
    const [x1, y1] = r[i];
    const [x2, y2] = r[(i + 1) % n];
    a += x1 * y2 - x2 * y1;
  }
  return a / 2;
}

function openRing(r: XY[]): XY[] {
  if (r.length > 1) {
    const a = r[0], b = r[r.length - 1];
    if (a[0] === b[0] && a[1] === b[1]) return r.slice(0, -1);
  }
  return r;
}

/** Convert a (Multi)Polygon to local polygons with consistent winding (outer CCW, holes CW). */
export function toLocalPolys(g: Polygon | MultiPolygon, f: LocalFrame): LocalPoly[] {
  const polys = g.type === 'Polygon' ? [g.coordinates] : g.coordinates;
  return polys.map((rings) =>
    rings.map((ring, i) => {
      let r = openRing(ring.map((p) => f.toLocal(p)));
      const a = signedArea(r);
      if ((i === 0 && a < 0) || (i > 0 && a > 0)) r = r.slice().reverse();
      return r;
    }),
  );
}

export function centroidOf(polys: LocalPoly[]): XY {
  let sx = 0, sy = 0, sa = 0;
  for (const p of polys) {
    const r = p[0];
    const a = signedArea(r);
    let cx = 0, cy = 0;
    for (let i = 0; i < r.length; i++) {
      const [x1, y1] = r[i];
      const [x2, y2] = r[(i + 1) % r.length];
      const k = x1 * y2 - x2 * y1;
      cx += (x1 + x2) * k;
      cy += (y1 + y2) * k;
    }
    if (Math.abs(a) > 1e-6) {
      sx += cx / 6;
      sy += cy / 6;
      sa += a;
    }
  }
  if (sa === 0) {
    const r = polys[0][0];
    return [r.reduce((s, p) => s + p[0], 0) / r.length, r.reduce((s, p) => s + p[1], 0) / r.length];
  }
  return [sx / sa, sy / sa];
}

export function areaOf(polys: LocalPoly[]): number {
  return polys.reduce((s, p) => s + p.reduce((t, r) => t + signedArea(r), 0), 0);
}

export const fmtArea = (m2: number) =>
  m2 >= 10000 ? `${(m2 / 10000).toFixed(m2 >= 100000 ? 1 : 2)} ha` : `${Math.round(m2).toLocaleString()} m²`;

export const fmtDist = (m: number) => (m >= 1000 ? `${(m / 1000).toFixed(1)} km` : `${Math.round(m)} m`);

export function asPolyFeature(f: Feature): Feature<Polygon | MultiPolygon> | null {
  if (!f.geometry) return null;
  if (f.geometry.type === 'Polygon' || f.geometry.type === 'MultiPolygon') return f as Feature<Polygon | MultiPolygon>;
  return null;
}
