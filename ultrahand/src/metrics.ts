// Townscape metrics from the site model: the measures a design and access statement leans on.
// Floor areas are estimates (height ÷ 3.2 m a storey), so they are labelled "about" wherever shown.
import * as turf from '@turf/turf';
import type { Feature, Polygon, MultiPolygon } from 'geojson';
import type { SiteModel } from './model';
import { areaOf, toLocalPolys, type LocalPoly, type XY } from './geo';

export const STOREY = 3.2; // metres a storey, for floor-area estimates

export interface AreaMetrics {
  areaM2: number;
  buildings: number;
  footprintM2: number;
  coverage: number; // 0..1 of the land covered by buildings
  gfaM2: number; // estimated gross floor area
  plotRatio: number; // estimated floor area ÷ land area
  meanStoreys: number;
}

export interface Metrics {
  study: AreaMetrics;
  site: AreaMetrics | null;
  heights: { known: number; mean: number; median: number; tallest: number; bands: { label: string; count: number }[] };
  grainM2: number; // median footprint: fine or coarse grain
  streetKmPerKm2: number;
}

const storeysOf = (h: number, minH: number) => Math.max(1, Math.round((h - minH) / STOREY));
const median = (xs: number[]) => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

function inRing(p: XY, r: XY[]) {
  let c = false;
  for (let i = 0, j = r.length - 1; i < r.length; j = i++)
    if (r[i][1] > p[1] !== r[j][1] > p[1] && p[0] < ((r[j][0] - r[i][0]) * (p[1] - r[i][1])) / (r[j][1] - r[i][1]) + r[i][0]) c = !c;
  return c;
}
const inPolys = (p: XY, polys: LocalPoly[]) => polys.some((pl) => inRing(p, pl[0]) && !pl.slice(1).some((h) => inRing(p, h)));

function areaMetrics(parts: { polys: LocalPoly[]; h: number; minH: number }[], landM2: number): AreaMetrics {
  let footprint = 0, gfa = 0;
  for (const b of parts) {
    const a = areaOf(b.polys);
    footprint += a;
    gfa += a * storeysOf(b.h, b.minH);
  }
  return {
    areaM2: landM2,
    buildings: parts.length,
    footprintM2: footprint,
    coverage: landM2 ? footprint / landM2 : 0,
    gfaM2: gfa,
    plotRatio: landM2 ? gfa / landM2 : 0,
    meanStoreys: footprint ? gfa / footprint : 0,
  };
}

export function computeMetrics(m: SiteModel, study: Feature<Polygon | MultiPolygon>, red: Feature<Polygon | MultiPolygon> | null): Metrics {
  const inStudy = m.buildings.filter((b) => b.cut);
  const studyM = areaMetrics(inStudy.map((b) => ({ polys: b.cut!, h: b.h, minH: b.minH })), turf.area(study));

  let siteM: AreaMetrics | null = null;
  if (red) {
    const parts: { polys: LocalPoly[]; h: number; minH: number }[] = [];
    for (const b of m.buildings.filter((x) => x.inSite)) {
      try {
        const g = turf.intersect(turf.featureCollection([b.feature, red as any]));
        if (g) parts.push({ polys: toLocalPolys(g.geometry, m.frame), h: b.h, minH: b.minH });
      } catch { /* skip awkward geometry */ }
    }
    siteM = areaMetrics(parts, turf.area(red));
  }

  const known = inStudy.filter((b) => b.heightKnown).map((b) => b.h);
  const bands = [
    { label: 'Up to 6 m (1–2 storeys)', lo: 0, hi: 6 },
    { label: '6–12 m (2–4 storeys)', lo: 6, hi: 12 },
    { label: '12–20 m (4–6 storeys)', lo: 12, hi: 20 },
    { label: '20–40 m (6–12 storeys)', lo: 20, hi: 40 },
    { label: 'Over 40 m', lo: 40, hi: Infinity },
  ].map((b) => ({ label: b.label, count: inStudy.filter((x) => x.h > b.lo && x.h <= b.hi).length }));

  // Street and path length inside the study area, per square kilometre.
  let streetM = 0;
  for (const r of m.roads) {
    if (/rail|ferry|aerialway/.test(r.cls)) continue;
    for (const l of r.lines)
      for (let i = 1; i < l.length; i++) {
        const mid: XY = [(l[i - 1][0] + l[i][0]) / 2, (l[i - 1][1] + l[i][1]) / 2];
        if (inPolys(mid, m.studyPolys)) streetM += Math.hypot(l[i][0] - l[i - 1][0], l[i][1] - l[i - 1][1]);
      }
  }

  return {
    study: studyM,
    site: siteM,
    heights: {
      known: known.length,
      mean: known.length ? known.reduce((a, b) => a + b, 0) / known.length : 0,
      median: median(known),
      tallest: known.length ? Math.max(...known) : 0,
      bands,
    },
    grainM2: median(inStudy.map((b) => areaOf(b.cut!))),
    streetKmPerKm2: studyM.areaM2 ? streetM / 1000 / (studyM.areaM2 / 1e6) : 0,
  };
}

export const pct = (x: number) => `${Math.round(x * 100)}%`;
export const ratio = (x: number) => x.toFixed(x < 10 ? 1 : 0);
