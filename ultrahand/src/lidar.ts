// Environment Agency National LIDAR Programme (1 m composite): measured building heights, ground
// levels, sections and contours. Open data (Open Government Licence), served as GeoTIFF over WCS,
// with CORS, so the browser fetches it directly.
import { fromArrayBuffer } from 'geotiff';
import { contours as d3contours } from 'd3-contour';
import type { Feature, FeatureCollection, Polygon, MultiPolygon, Position, LineString } from 'geojson';
import { toBNG, fromBNG } from './bng';

const WCS = {
  dsm: {
    url: 'https://environment.data.gov.uk/spatialdata/lidar-composite-digital-surface-model-first-return-dsm-1m/wcs',
    id: 'df4e3ec3-315e-48aa-aaaf-b5ae74d7b2bb__Lidar_Composite_Elevation_FZ_DSM_1m',
  },
  dtm: {
    url: 'https://environment.data.gov.uk/spatialdata/lidar-composite-digital-terrain-model-dtm-1m/wcs',
    id: '13787b9a-26a4-4775-8523-806d13af58fc__Lidar_Composite_Elevation_DTM_1m',
  },
};
export const MAX_SIDE_M = 1400; // ~2 million cells a model: keeps the download to a few MB

/** A 1 m grid on British National Grid. Row 0 is the north edge. */
export interface Grid { e0: number; n1: number; w: number; h: number; z: Float32Array }

export function at(g: Grid, e: number, n: number): number | null {
  const c = Math.floor(e - g.e0), r = Math.floor(g.n1 - n);
  if (c < 0 || r < 0 || c >= g.w || r >= g.h) return null;
  const v = g.z[r * g.w + c];
  return v > -1000 && v < 10000 ? v : null; // no-data is a huge negative number
}

async function coverage(kind: 'dsm' | 'dtm', e0: number, n0: number, e1: number, n1: number): Promise<Grid> {
  const s = WCS[kind];
  const q = `${s.url}?service=WCS&version=2.0.1&request=GetCoverage&CoverageId=${s.id}&format=image/tiff&subset=E(${e0},${e1})&subset=N(${n0},${n1})`;
  let last: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const r = await fetch(q);
      if (r.ok && /tiff/.test(r.headers.get('content-type') ?? '')) {
        const tiff = await fromArrayBuffer(await r.arrayBuffer());
        const img = await tiff.getImage();
        const [raster] = (await img.readRasters()) as unknown as Float32Array[];
        const [ox, oy] = img.getOrigin();
        return { e0: ox, n1: oy, w: img.getWidth(), h: img.getHeight(), z: Float32Array.from(raster) };
      }
      last = new Error(`LIDAR service answered ${r.status}`);
    } catch (e) {
      last = e;
    }
    await new Promise((res) => setTimeout(res, 800 * (attempt + 1))); // the service has the odd brief 500
  }
  throw last;
}

export interface Lidar { dsm: Grid; dtm: Grid; bbox: [number, number, number, number] }

/** Fetch both models for an area (lng/lat bbox), padded by 20 m. */
export async function fetchLidar(bboxLL: [number, number, number, number]): Promise<Lidar> {
  const a = toBNG([bboxLL[0], bboxLL[1]]), b = toBNG([bboxLL[2], bboxLL[3]]);
  const c = toBNG([bboxLL[0], bboxLL[3]]), d = toBNG([bboxLL[2], bboxLL[1]]);
  const e0 = Math.floor(Math.min(a[0], c[0]) - 20), e1 = Math.ceil(Math.max(b[0], d[0]) + 20);
  const n0 = Math.floor(Math.min(a[1], d[1]) - 20), n1 = Math.ceil(Math.max(b[1], c[1]) + 20);
  if (e1 - e0 > MAX_SIDE_M || n1 - n0 > MAX_SIDE_M) throw new Error(`LIDAR heights work for study areas up to ${(MAX_SIDE_M / 1000).toFixed(1)} km across.`);
  const [dsm, dtm] = await Promise.all([coverage('dsm', e0, n0, e1, n1), coverage('dtm', e0, n0, e1, n1)]);
  return { dsm, dtm, bbox: [e0, n0, e1, n1] };
}

function quantile(xs: number[], q: number) {
  if (!xs.length) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.round(q * (s.length - 1))))];
}

function ringsBNG(f: Feature<Polygon | MultiPolygon>) {
  const polys = f.geometry.type === 'Polygon' ? [f.geometry.coordinates] : f.geometry.coordinates;
  return polys.map((p) => p.map((r) => r.map((q: Position) => toBNG(q))));
}
function inside(e: number, n: number, rings: [number, number][][]) {
  let c = false;
  for (const r of rings)
    for (let i = 0, j = r.length - 1; i < r.length; j = i++)
      if (r[i][1] > n !== r[j][1] > n && e < ((r[j][0] - r[i][0]) * (n - r[i][1])) / (r[j][1] - r[i][1]) + r[i][0]) c = !c;
  return c;
}

/** Cells (centres) inside a footprint: surface and ground values. */
function sample(l: Lidar, f: Feature<Polygon | MultiPolygon>) {
  const top: number[] = [], ground: number[] = [];
  for (const poly of ringsBNG(f)) {
    const xs = poly[0].map((q) => q[0]), ys = poly[0].map((q) => q[1]);
    for (let n = Math.floor(Math.min(...ys)) + 0.5; n < Math.max(...ys); n++)
      for (let e = Math.floor(Math.min(...xs)) + 0.5; e < Math.max(...xs); e++) {
        if (!inside(e, n, poly)) continue;
        const s = at(l.dsm, e, n), g = at(l.dtm, e, n);
        if (s != null) top.push(s);
        if (g != null) ground.push(g);
      }
  }
  return { top, ground };
}

export interface Measured { heightM: number; groundM: number; cells: number }

/**
 * A building's height: the 90th percentile of the surface inside its footprint (the main roof,
 * ignoring the odd chimney or mast) above the median ground level. Null when there's too little
 * data (very small footprints, gaps in coverage) or the result is implausible.
 */
export function measureBuilding(l: Lidar, f: Feature<Polygon | MultiPolygon>): Measured | null {
  const { top, ground } = sample(l, f);
  if (top.length < 4 || ground.length < 4) return null;
  const roof = quantile(top, 0.9), g = quantile(ground, 0.5);
  const h = roof - g;
  if (!isFinite(h) || h < 2 || h > 400) return null;
  return { heightM: Math.round(h * 10) / 10, groundM: Math.round(g * 100) / 100, cells: top.length };
}

/** Ground levels (AOD) inside an area: lowest, highest, average. */
export function groundLevels(l: Lidar, f: Feature<Polygon | MultiPolygon>) {
  const { ground } = sample(l, f);
  if (!ground.length) return null;
  const min = Math.min(...ground), max = Math.max(...ground);
  return { min, max, mean: ground.reduce((a, b) => a + b, 0) / ground.length, fall: max - min };
}

/** Elevations along a line every metre: ground and surface. */
export function profile(l: Lidar, line: [number, number][]) {
  const a = toBNG(line[0]), b = toBNG(line[1]);
  const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
  const out: { d: number; ground: number | null; surface: number | null; ll: [number, number] }[] = [];
  for (let d = 0; d <= len; d += 1) {
    const t = len ? d / len : 0;
    const e = a[0] + (b[0] - a[0]) * t, n = a[1] + (b[1] - a[1]) * t;
    out.push({ d, ground: at(l.dtm, e, n), surface: at(l.dsm, e, n), ll: fromBNG([e, n]) });
  }
  return { len, points: out };
}

/** Contours from the terrain model, every `step` metres (every 5th a major line). */
export function contourLines(l: Lidar, step = 1): FeatureCollection<LineString | any> {
  const g = l.dtm;
  // 2 m cells are plenty for contours and keep the work small.
  const k = 2, w = Math.floor(g.w / k), h = Math.floor(g.h / k);
  const v = new Float64Array(w * h);
  let lo = Infinity, hi = -Infinity;
  for (let r = 0; r < h; r++)
    for (let c = 0; c < w; c++) {
      const z = g.z[r * k * g.w + c * k];
      const ok = z > -1000 && z < 10000;
      v[r * w + c] = ok ? z : NaN;
      if (ok) ((lo = Math.min(lo, z)), (hi = Math.max(hi, z)));
    }
  if (!isFinite(lo)) return { type: 'FeatureCollection', features: [] };
  for (let i = 0; i < v.length; i++) if (Number.isNaN(v[i])) v[i] = lo - step; // no-data sinks below the lowest line
  const levels: number[] = [];
  for (let z = Math.ceil(lo / step) * step; z <= hi; z += step) levels.push(Math.round(z * 100) / 100);
  const toLL = (p: number[]) => fromBNG([g.e0 + p[0] * k, g.n1 - p[1] * k]);
  const features = d3contours().size([w, h]).thresholds(levels)(Array.from(v)).flatMap((mp) =>
    mp.coordinates.flatMap((poly) =>
      poly.map((ring) => ({
        type: 'Feature' as const,
        properties: { z: mp.value, major: Math.abs(mp.value / (step * 5) - Math.round(mp.value / (step * 5))) < 1e-6 },
        geometry: { type: 'LineString' as const, coordinates: ring.map(toLL) },
      })),
    ),
  );
  return { type: 'FeatureCollection', features };
}
