// Masterplanning: streets, open space and house types on top of the red line, with a live schedule.
// Dimensions are typical UK figures to sketch with, not a design standard; each is shown where used.
import * as turf from '@turf/turf';
import type { Feature, FeatureCollection, LineString, Polygon, MultiPolygon } from 'geojson';

// ------------------------------------------------------------------ libraries

export type StreetType = 'primary' | 'residential' | 'shared' | 'mews' | 'path';
export const STREET_TYPES: { id: StreetType; label: string; widthM: number; note: string }[] = [
  { id: 'primary', label: 'Primary street', widthM: 16, note: '6.7 m carriageway, verges, 2 m footways' },
  { id: 'residential', label: 'Residential street', widthM: 11, note: '5.5 m carriageway, 2 m footways' },
  { id: 'shared', label: 'Shared surface', widthM: 7.5, note: 'one surface for people and cars' },
  { id: 'mews', label: 'Mews or lane', widthM: 6, note: 'access to a few homes' },
  { id: 'path', label: 'Foot and cycle path', widthM: 3.5, note: 'no cars' },
];
export const streetType = (id: StreetType) => STREET_TYPES.find((t) => t.id === id)!;

export type OpenType = 'park' | 'amenity' | 'natural' | 'play' | 'suds' | 'allotment';
/** haPer1000: Fields in Trust benchmark (hectares per 1,000 people), where there is one. */
export const OPEN_TYPES: { id: OpenType; label: string; colour: string; haPer1000: number | null }[] = [
  { id: 'park', label: 'Park or garden', colour: '#7fb86c', haPer1000: 0.8 },
  { id: 'amenity', label: 'Amenity green space', colour: '#b3d69c', haPer1000: 0.6 },
  { id: 'natural', label: 'Natural and semi-natural', colour: '#5f9150', haPer1000: 1.8 },
  { id: 'play', label: 'Equipped play', colour: '#e3c35a', haPer1000: 0.25 },
  { id: 'suds', label: 'SuDS and attenuation', colour: '#93c1e3', haPer1000: null },
  { id: 'allotment', label: 'Allotments and growing', colour: '#c7ad72', haPer1000: null },
];
export const openType = (id: OpenType) => OPEN_TYPES.find((t) => t.id === id)!;

export type HouseTypeId = 'terrace' | 'semi' | 'detached' | 'townhouse' | 'bungalow';
export interface HouseType { id: HouseTypeId; label: string; frontageM: number; depthM: number; storeys: number; homes: number; beds: number; gapM: number; colour: string; parking: number }
export const HOUSE_TYPES: HouseType[] = [
  { id: 'terrace', label: 'Terrace, 3 bed', frontageM: 5.5, depthM: 9, storeys: 2, homes: 1, beds: 3, gapM: 0, colour: '#e6262e', parking: 2 },
  { id: 'semi', label: 'Semi-detached pair, 3 bed', frontageM: 11, depthM: 9, storeys: 2, homes: 2, beds: 3, gapM: 3, colour: '#ef5f5f', parking: 2 },
  { id: 'detached', label: 'Detached, 4 bed', frontageM: 9.5, depthM: 9.5, storeys: 2, homes: 1, beds: 4, gapM: 3.5, colour: '#f59090', parking: 2 },
  { id: 'townhouse', label: 'Townhouse, 4 bed, 3 storey', frontageM: 5.5, depthM: 10, storeys: 3, homes: 1, beds: 4, gapM: 0, colour: '#b81d24', parking: 2 },
  { id: 'bungalow', label: 'Bungalow, 2 bed', frontageM: 10, depthM: 8, storeys: 1, homes: 1, beds: 2, gapM: 3, colour: '#f7b6b6', parking: 1 },
];
export const houseType = (id: HouseTypeId) => HOUSE_TYPES.find((t) => t.id === id)!;
/** Extruded height: about 3 m a storey plus half the roof. */
export const houseHeight = (t: HouseType) => t.storeys * 3 + 1.5;

// ------------------------------------------------------------------ the plan

export interface Street { id: string; name: string; type: StreetType; line: Feature<LineString> }
export interface OpenSpace { id: string; name: string; type: OpenType; shape: Feature<Polygon> }
export interface Home { id: string; type: HouseTypeId; shape: Feature<Polygon>; streetId: string | null }
export interface Plan { streets: Street[]; open: OpenSpace[]; homes: Home[] }
export const emptyPlan = (): Plan => ({ streets: [], open: [], homes: [] });

let seq = 0;
export const newId = (prefix: string, existing: { id: string }[]) => {
  seq = Math.max(seq, ...existing.map((x) => Number(x.id.replace(/\D/g, '')) || 0)) + 1;
  return `${prefix}${seq}`;
};

export function corridor(s: Street): Feature<Polygon | MultiPolygon> {
  return turf.buffer(s.line, streetType(s.type).widthM / 2, { units: 'meters', steps: 6 }) as Feature<Polygon | MultiPolygon>;
}

/** A house footprint: a rectangle centred on `c`, its frontage along `bearing`. */
function rect(c: number[], bearing: number, frontage: number, depth: number): Feature<Polygon> {
  const f = frontage / 2, d = depth / 2;
  const corner = (u: number, v: number) => {
    const a = turf.destination(c, Math.abs(u), u >= 0 ? bearing : bearing + 180, { units: 'meters' });
    return turf.destination(a, Math.abs(v), v >= 0 ? bearing + 90 : bearing - 90, { units: 'meters' }).geometry.coordinates;
  };
  const ring = [corner(-f, -d), corner(f, -d), corner(f, d), corner(-f, d)];
  return turf.polygon([[...ring, ring[0]]]);
}

export interface Obstacles {
  boundary: Feature<Polygon | MultiPolygon> | null; // homes must sit inside it (the red line)
  shapes: Feature<Polygon | MultiPolygon>[]; // streets, open space, other homes, blocks, existing buildings
}

function blocked(full: Feature<Polygon>, o: Obstacles, extra: Feature<Polygon>[]) {
  if (o.boundary && !turf.booleanWithin(full, o.boundary)) return true;
  // Test a slightly smaller footprint, so homes in a terrace can share a party wall.
  const f = turf.transformScale(full, 0.96);
  const [w, s, e, n] = turf.bbox(f);
  for (const g of [...o.shapes, ...extra]) {
    const [gw, gs, ge, gn] = (g.bbox as number[] | undefined) ?? turf.bbox(g);
    if (gw > e || ge < w || gs > n || gn < s) continue;
    try {
      if (turf.booleanIntersects(f, g)) return true;
    } catch { /* ignore awkward geometry */ }
  }
  return false;
}

/**
 * Line a street with homes: footprints step along the street on one or both sides, facing it, set back
 * from the edge of its corridor. Positions that would clash with anything already there are skipped,
 * so junctions, open space and existing buildings leave gaps.
 */
export function lineStreet(street: Street, typeId: HouseTypeId, opts: { side: 'both' | 'left' | 'right'; setbackM: number; gapM?: number }, o: Obstacles, existing: Home[]): Home[] {
  const t = houseType(typeId);
  const line = street.line;
  const len = turf.length(line, { units: 'meters' });
  const step = t.frontageM + (opts.gapM ?? t.gapM);
  const offset = streetType(street.type).widthM / 2 + opts.setbackM + t.depthM / 2;
  const sides = opts.side === 'both' ? [1, -1] : opts.side === 'left' ? [-1] : [1];
  const placed: Home[] = [];
  const shapes = o.shapes.map((g) => ({ ...g, bbox: turf.bbox(g) }));
  for (const side of sides) {
    for (let d = step / 2 + 2; d <= len - step / 2 - 2; d += step) {
      const p = turf.along(line, d, { units: 'meters' });
      const a = turf.along(line, Math.max(0, d - 2), { units: 'meters' }), b = turf.along(line, Math.min(len, d + 2), { units: 'meters' });
      const bearing = turf.bearing(a, b);
      const c = turf.destination(p, offset, bearing + 90 * side, { units: 'meters' }).geometry.coordinates;
      const f = rect(c, bearing, t.frontageM, t.depthM);
      if (blocked(f, { boundary: o.boundary, shapes }, placed.map((h) => h.shape))) continue;
      placed.push({ id: newId('H', [...existing, ...placed]), type: typeId, shape: f, streetId: street.id });
    }
  }
  return placed;
}

/** One home at a point, facing the nearest street (or north when there are none). */
export function placeHome(at: [number, number], typeId: HouseTypeId, streets: Street[], o: Obstacles, existing: Home[]): Home | null {
  const t = houseType(typeId);
  let bearing = 0, best = Infinity, sid: string | null = null;
  for (const s of streets) {
    const np = turf.nearestPointOnLine(s.line, at, { units: 'meters' });
    if ((np.properties.dist ?? Infinity) < best) {
      best = np.properties.dist ?? Infinity;
      const coords = s.line.geometry.coordinates, i = Math.min(np.properties.index ?? 0, coords.length - 2);
      bearing = turf.bearing(coords[i], coords[i + 1]);
      sid = s.id;
    }
  }
  const f = rect(at, bearing, t.frontageM, t.depthM);
  if (blocked(f, o, [])) return null;
  return { id: newId('H', existing), type: typeId, shape: f, streetId: best < 60 ? sid : null };
}

// ------------------------------------------------------------------ schedule

export interface Schedule {
  siteM2: number | null;
  streetsM2: number;
  streetLengthM: Record<string, number>;
  openM2: Partial<Record<OpenType, number>>;
  netM2: number | null;
  houses: { type: HouseTypeId; label: string; buildings: number; homes: number; beds: number; giaM2: number }[];
  houseHomes: number;
  apartmentHomes: number;
  homes: number;
  population: number;
  grossDph: number | null;
  netDph: number | null;
  parking: number;
  openVsBenchmark: { type: OpenType; label: string; providedHa: number; benchmarkHa: number }[];
}

export function schedule(plan: Plan, site: Feature<Polygon | MultiPolygon> | null, apartmentHomes: number, apartmentParking: number, householdSize: number): Schedule {
  const inSite = (f: Feature<Polygon | MultiPolygon>) => {
    if (!site) return turf.area(f);
    try {
      const x = turf.intersect(turf.featureCollection([f, site as any]));
      return x ? turf.area(x) : 0;
    } catch {
      return 0;
    }
  };
  let streetsM2 = 0;
  if (plan.streets.length) {
    try {
      const u = plan.streets.length > 1 ? turf.union(turf.featureCollection(plan.streets.map(corridor))) : corridor(plan.streets[0]);
      if (u) streetsM2 = inSite(u as any);
    } catch {
      streetsM2 = plan.streets.reduce((s, x) => s + inSite(corridor(x)), 0);
    }
  }
  const streetLengthM: Record<string, number> = {};
  for (const s of plan.streets) streetLengthM[streetType(s.type).label] = (streetLengthM[streetType(s.type).label] ?? 0) + turf.length(s.line, { units: 'meters' });
  const openM2: Partial<Record<OpenType, number>> = {};
  for (const o of plan.open) openM2[o.type] = (openM2[o.type] ?? 0) + inSite(o.shape);
  const openTotal = Object.values(openM2).reduce((a, b) => a + (b ?? 0), 0);
  const siteM2 = site ? turf.area(site) : null;
  const netM2 = siteM2 != null ? Math.max(0, siteM2 - streetsM2 - openTotal) : null;

  const houses = HOUSE_TYPES.map((t) => {
    const n = plan.homes.filter((h) => h.type === t.id).length;
    return { type: t.id, label: t.label, buildings: n, homes: n * t.homes, beds: t.beds, giaM2: n * t.frontageM * t.depthM * t.storeys };
  }).filter((h) => h.buildings);
  const houseHomes = houses.reduce((s, h) => s + h.homes, 0);
  const homes = houseHomes + apartmentHomes;
  const population = Math.round(homes * householdSize);
  const parking = Math.round(houses.reduce((s, h) => s + h.homes * houseType(h.type).parking, 0) + apartmentParking + homes * 0.2);
  const openVsBenchmark = OPEN_TYPES.filter((t) => t.haPer1000 != null && (openM2[t.id] || population))
    .map((t) => ({ type: t.id, label: t.label, providedHa: (openM2[t.id] ?? 0) / 10000, benchmarkHa: (t.haPer1000! * population) / 1000 }));
  return {
    siteM2, streetsM2, streetLengthM, openM2, netM2, houses, houseHomes, apartmentHomes, homes, population,
    grossDph: siteM2 ? homes / (siteM2 / 10000) : null,
    netDph: netM2 ? homes / (netM2 / 10000) : null,
    parking, openVsBenchmark,
  };
}

// ------------------------------------------------------------------ map data

export function planGeoJSON(plan: Plan, selected: string | null) {
  const streets: FeatureCollection = { type: 'FeatureCollection', features: plan.streets.map((s) => ({ ...corridor(s), id: Number(s.id.replace(/\D/g, '')), properties: { id: s.id, type: s.type, selected: s.id === selected } })) };
  const centrelines: FeatureCollection = { type: 'FeatureCollection', features: plan.streets.map((s) => ({ ...s.line, properties: { id: s.id, type: s.type } })) };
  const open: FeatureCollection = { type: 'FeatureCollection', features: plan.open.map((o) => ({ ...o.shape, id: Number(o.id.replace(/\D/g, '')), properties: { id: o.id, type: o.type, colour: openType(o.type).colour, selected: o.id === selected } })) };
  const homes: FeatureCollection = {
    type: 'FeatureCollection',
    features: plan.homes.map((h) => {
      const t = houseType(h.type);
      return { ...h.shape, id: Number(h.id.replace(/\D/g, '')), properties: { id: h.id, type: h.type, colour: t.colour, top: houseHeight(t), selected: h.id === selected } };
    }),
  };
  return { streets, centrelines, open, homes };
}
