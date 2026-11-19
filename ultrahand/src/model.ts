// The site model: every building around the site with a reference number, local geometry and the
// planning facts that touch it. One model drives the map, the axo export and the building passport.
import * as turf from '@turf/turf';
import type { Feature, Polygon, MultiPolygon, FeatureCollection } from 'geojson';
import { LocalFrame, toLocalPolys, centroidOf, areaOf, type LocalPoly, type XY } from './geo';
import type { StreetsData } from './tiles';

export interface Bldg {
  idx: number;
  ref: string;
  feature: Feature<Polygon | MultiPolygon>;
  polys: LocalPoly[];
  cut: LocalPoly[] | null; // footprint trimmed to the study area, for the cut-out model
  h: number;
  minH: number;
  heightKnown: boolean;
  type: string;
  inStudy: boolean;
  inSite: boolean;
  centroid: XY;
  ll: [number, number];
  area: number;
  listed: Feature[];
  designations: Feature[];
  places: string[]; // names of mapped places inside the footprint
}

export interface SiteModel {
  frame: LocalFrame;
  study: Feature<Polygon | MultiPolygon>;
  studyPolys: LocalPoly[];
  red: Feature<Polygon | MultiPolygon> | null;
  redPolys: LocalPoly[] | null;
  buildings: Bldg[];
  roads: { cls: string; lines: XY[][] }[];
  landuse: { cls: string; polys: LocalPoly[] }[];
  water: LocalPoly[][];
}

export const GREEN = new Set(['park', 'grass', 'pitch', 'wood', 'scrub', 'cemetery', 'playground', 'garden', 'agriculture', 'national_park']);

export function buildModel(
  s: StreetsData,
  study: Feature<Polygon | MultiPolygon>,
  red: Feature<Polygon | MultiPolygon> | null,
  context: Feature<Polygon | MultiPolygon>,
  designations: FeatureCollection,
): SiteModel {
  const c = turf.centroid(red ?? study).geometry.coordinates;
  const frame = new LocalFrame(c[0], c[1]);
  const listedPts = designations.features.filter((f) => f.properties?.dataset === 'listed-building' && f.geometry?.type === 'Point');
  const areas = designations.features.filter((f) => f.geometry && f.geometry.type !== 'Point');

  const raw = s.buildings.filter((b) => {
    try {
      return turf.booleanIntersects(b, context);
    } catch {
      return false;
    }
  });

  const buildings: Bldg[] = raw.map((f, i) => {
    const polys = toLocalPolys(f.geometry, frame);
    const inStudy = safe(() => turf.booleanIntersects(f, study), false);
    let cut: LocalPoly[] | null = null;
    if (inStudy) {
      const g = safe(() => turf.intersect(turf.featureCollection([f, study as any])), null);
      if (g) cut = toLocalPolys(g.geometry, frame);
    }
    const centroid = centroidOf(polys);
    const hRaw = +(f.properties?.height ?? 0);
    return {
      idx: i,
      ref: '',
      feature: f,
      polys,
      cut,
      h: hRaw > 0 ? hRaw : 6,
      minH: +(f.properties?.min_height ?? 0),
      heightKnown: hRaw > 0,
      type: String(f.properties?.type ?? 'building'),
      inStudy,
      inSite: red ? safe(() => turf.booleanIntersects(f, red), false) : false,
      centroid,
      ll: frame.toLngLat(centroid),
      area: areaOf(polys),
      listed: listedPts.filter((p) => safe(() => turf.booleanPointInPolygon(p as any, f), false)),
      designations: [],
      places: s.places.filter((p) => safe(() => turf.booleanPointInPolygon(p, f), false)).map((p) => String(p.properties?.name)),
    };
  });

  // Reference numbers run outward from the site, like a survey schedule.
  const order = buildings.filter((b) => b.inStudy).sort((a, b) => Math.hypot(...a.centroid) - Math.hypot(...b.centroid));
  order.forEach((b, i) => (b.ref = `B${String(i + 1).padStart(3, '0')}`));
  buildings.filter((b) => !b.inStudy).forEach((b, i) => (b.ref = `C${String(i + 1).padStart(3, '0')}`));

  // Area designations touching each study building (conservation area, flood zone, ...).
  for (const b of order) {
    const bb = turf.bbox(b.feature);
    b.designations = areas.filter((a) => {
      const ab = turf.bbox(a);
      if (ab[0] > bb[2] || ab[2] < bb[0] || ab[1] > bb[3] || ab[3] < bb[1]) return false;
      return safe(() => turf.booleanIntersects(a, b.feature), false);
    });
  }

  const roads: SiteModel['roads'] = [];
  for (const r of s.roads) {
    const g = r.geometry;
    const lines = g.type === 'LineString' ? [g.coordinates] : g.coordinates;
    roads.push({ cls: String(r.properties?.class ?? 'street'), lines: lines.map((l) => l.map((p) => frame.toLocal(p))) });
  }
  const landuse = s.landuse.map((l) => ({ cls: String(l.properties?.class ?? ''), polys: toLocalPolys(l.geometry, frame) }));
  const water = s.water.map((w) => toLocalPolys(w.geometry, frame));

  return {
    frame,
    study,
    studyPolys: toLocalPolys(study.geometry, frame),
    red,
    redPolys: red ? toLocalPolys(red.geometry, frame) : null,
    buildings,
    roads,
    landuse,
    water,
  };
}

function safe<T>(fn: () => T, fb: T): T {
  try {
    return fn();
  } catch {
    return fb;
  }
}

export function modelGeoJSON(m: SiteModel): FeatureCollection {
  // d: 0 at the site, 1 at the edge of the study area, for the outward "grow" animation.
  const maxD = Math.max(1, ...m.buildings.filter((b) => b.inStudy).map((b) => Math.hypot(...b.centroid)));
  return {
    type: 'FeatureCollection',
    features: m.buildings.map((b) => ({
      type: 'Feature',
      id: b.idx,
      geometry: b.feature.geometry,
      properties: {
        ref: b.ref,
        h: b.h,
        minH: b.minH,
        inStudy: b.inStudy,
        inSite: b.inSite,
        listed: b.listed.length > 0,
        d: b.inStudy ? Math.min(1, Math.hypot(...b.centroid) / maxD) : 1,
      },
    })),
  };
}
