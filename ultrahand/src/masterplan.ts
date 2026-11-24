// Masterplanning: streets (curved, joined, with roundabouts), open space and house types with plots
// and gardens, on top of the red line, with a live schedule. Dimensions are typical UK figures to
// sketch with, not a design standard; each is shown where it is used.
import * as turf from '@turf/turf';
import type { Feature, FeatureCollection, LineString, Polygon, MultiPolygon, Position } from 'geojson';

type PolyF = Feature<Polygon | MultiPolygon>;

// ------------------------------------------------------------------ libraries

export type StreetType = 'primary' | 'residential' | 'shared' | 'mews' | 'path';
/**
 * widthM is the land a street takes (carriageway, verges and footways), used for layout and areas.
 * cls is the Mapbox road class it is drawn as, so a drawn street looks like the streets around it.
 */
export const STREET_TYPES: { id: StreetType; label: string; widthM: number; cls: string; note: string }[] = [
  { id: 'primary', label: 'Primary street', widthM: 14, cls: 'primary', note: '6.7 m carriageway, verges and 2 m footways' },
  { id: 'residential', label: 'Residential street', widthM: 9.5, cls: 'street', note: '5.5 m carriageway and 2 m footways' },
  { id: 'shared', label: 'Shared surface', widthM: 6, cls: 'street_limited', note: 'one 6 m surface for people and cars' },
  { id: 'mews', label: 'Mews or lane', widthM: 5, cls: 'service', note: 'access to a few homes' },
  { id: 'path', label: 'Foot and cycle path', widthM: 3, cls: 'path', note: 'no cars' },
];
export const streetType = (id: StreetType) => STREET_TYPES.find((t) => t.id === id) ?? STREET_TYPES[1];

/** Roundabouts by inscribed circle diameter. The circulating carriageway is about 7 m wide. */
export const ROUNDABOUTS = [
  { id: 'mini', label: 'Mini roundabout, 16 m', diameterM: 16 },
  { id: 'compact', label: 'Compact roundabout, 28 m', diameterM: 28 },
  { id: 'standard', label: 'Roundabout, 40 m', diameterM: 40 },
];
const ringR = (d: number) => d / 2 - 3.5; // centre of the circulating carriageway
const islandR = (d: number) => Math.max(1.5, d / 2 - 7);
const KERB_RADIUS = 6; // rounds the corners where streets meet

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
export const openType = (id: OpenType) => OPEN_TYPES.find((t) => t.id === id) ?? OPEN_TYPES[0];

export type HouseTypeId = 'terrace2' | 'terrace' | 'semi' | 'detached' | 'townhouse' | 'bungalow';
export interface HouseType { id: HouseTypeId; label: string; frontageM: number; depthM: number; storeys: number; homes: number; beds: number; gapM: number; colour: string; parking: number }
export const HOUSE_TYPES: HouseType[] = [
  { id: 'terrace2', label: 'Terrace, 2 bed', frontageM: 4.8, depthM: 8.5, storeys: 2, homes: 1, beds: 2, gapM: 0, colour: '#f07d6e', parking: 1 },
  { id: 'terrace', label: 'Terrace, 3 bed', frontageM: 5.5, depthM: 9, storeys: 2, homes: 1, beds: 3, gapM: 0, colour: '#e6262e', parking: 2 },
  { id: 'semi', label: 'Semi-detached pair, 3 bed', frontageM: 11, depthM: 9, storeys: 2, homes: 2, beds: 3, gapM: 3, colour: '#ef5f5f', parking: 2 },
  { id: 'detached', label: 'Detached, 4 bed', frontageM: 9.5, depthM: 9.5, storeys: 2, homes: 1, beds: 4, gapM: 3.5, colour: '#c43a3f', parking: 2 },
  { id: 'townhouse', label: 'Townhouse, 4 bed, 3 storey', frontageM: 5.5, depthM: 10, storeys: 3, homes: 1, beds: 4, gapM: 0, colour: '#9c1c22', parking: 2 },
  { id: 'bungalow', label: 'Bungalow, 2 bed', frontageM: 10, depthM: 8, storeys: 1, homes: 1, beds: 2, gapM: 3, colour: '#f7b6b6', parking: 1 },
];
export const houseType = (id: HouseTypeId) => HOUSE_TYPES.find((t) => t.id === id) ?? HOUSE_TYPES[1];
/** Eaves at about 2.75 m a storey; a 35° gable roof spans the depth. */
export const houseEave = (t: HouseType) => t.storeys * 2.75;
export const houseRise = (t: HouseType) => (t.depthM / 2) * Math.tan((35 * Math.PI) / 180);
export const houseHeight = (t: HouseType) => houseEave(t) + houseRise(t);
export const AFFORDABLE_COLOUR = '#1f8a8a';

// ------------------------------------------------------------------ the plan

export interface Street {
  id: string;
  name: string;
  type: StreetType;
  pts: Position[]; // the points drawn (the centre, for a roundabout)
  curved: boolean;
  line: Feature<LineString>; // the centreline: smoothed through pts when curved; the ring for a roundabout
  roundabout?: { diameterM: number };
}
export interface OpenSpace { id: string; name: string; type: OpenType; shape: Feature<Polygon> }
export type Tenure = 'market' | 'affordable';
export interface Home {
  id: string;
  type: HouseTypeId;
  shape: Feature<Polygon>; // the footprint
  plot: Feature<Polygon>; // footprint, front garden and rear garden
  garden: Feature<Polygon> | null; // the rear garden
  ridge: [Position, Position] | null; // ends of the roof ridge (null: a flat roof)
  streetId: string | null;
  tenure: Tenure;
}
export interface Plan { streets: Street[]; open: OpenSpace[]; homes: Home[] }
export const emptyPlan = (): Plan => ({ streets: [], open: [], homes: [] });

let seq = 0;
export const newId = (prefix: string, existing: { id: string }[]) => {
  seq = Math.max(seq, ...existing.map((x) => Number(x.id.replace(/\D/g, '')) || 0)) + 1;
  return `${prefix}${seq}`;
};

/** A plan saved by an earlier version: fill in what it lacks. */
export function upgradePlan(p: any): Plan {
  const plan = { ...emptyPlan(), ...(p ?? {}) } as Plan;
  plan.streets = plan.streets.map((s: any) => ({ ...s, pts: s.pts ?? s.line.geometry.coordinates, curved: !!s.curved }));
  plan.homes = plan.homes.map((h: any) => ({ ...h, type: HOUSE_TYPES.some((t) => t.id === h.type) ? h.type : 'terrace', plot: h.plot ?? h.shape, garden: h.garden ?? null, ridge: h.ridge ?? null, tenure: h.tenure ?? 'market' }));
  return plan;
}

// ------------------------------------------------------------------ street geometry

export function streetLine(pts: Position[], curved: boolean): Feature<LineString> {
  const l = turf.lineString(pts);
  if (!curved || pts.length < 3) return l;
  try {
    return turf.bezierSpline(l, { resolution: 10000, sharpness: 0.85 }) as Feature<LineString>;
  } catch {
    return l;
  }
}

export function newStreet(plan: Plan, type: StreetType, pts: Position[], curved: boolean): Street {
  const snapped = snapEnds(pts, plan.streets);
  return { id: newId('S', plan.streets), name: `Street ${plan.streets.filter((s) => !s.roundabout).length + 1}`, type, pts: snapped, curved, line: streetLine(snapped, curved) };
}

export function newRoundabout(plan: Plan, at: Position, type: StreetType, diameterM: number): Street {
  const centre = roundaboutSpot(at, plan.streets);
  const ring = turf.circle(centre, ringR(diameterM), { units: 'meters', steps: 64 }).geometry.coordinates[0];
  const n = plan.streets.filter((s) => s.roundabout).length + 1;
  return { id: newId('S', plan.streets), name: `Roundabout ${n}`, type, pts: [centre], curved: false, line: turf.lineString(ring), roundabout: { diameterM } };
}

/** Ends of a new street within 15 m of another street join it, making a junction. */
export function snapEnds(pts: Position[], streets: Street[], tolM = 15): Position[] {
  const out = pts.map((p) => [...p]);
  for (const i of [0, out.length - 1]) {
    let best = tolM, at: Position | null = null;
    for (const s of streets) {
      const np = turf.nearestPointOnLine(s.line, out[i], { units: 'meters' });
      if ((np.properties.dist ?? Infinity) < best) ((best = np.properties.dist!), (at = np.geometry.coordinates));
    }
    if (at) out[i] = at;
  }
  return out;
}

/** A roundabout goes on the nearest junction within 25 m, else on the nearest street within 15 m. */
function roundaboutSpot(at: Position, streets: Street[]): Position {
  let best = 25, spot: Position | null = null;
  const plain = streets.filter((s) => !s.roundabout);
  for (let i = 0; i < plain.length; i++)
    for (let j = i + 1; j < plain.length; j++)
      for (const x of turf.lineIntersect(plain[i].line, plain[j].line).features) {
        const d = turf.distance(at, x, { units: 'meters' });
        if (d < best) ((best = d), (spot = x.geometry.coordinates));
      }
  // A street ending on another makes a T: its end point is the junction.
  for (const s of plain)
    for (const e of [s.pts[0], s.pts[s.pts.length - 1]]) {
      const d = turf.distance(at, e, { units: 'meters' });
      if (d < best && plain.some((o) => o !== s && (turf.nearestPointOnLine(o.line, e, { units: 'meters' }).properties.dist ?? 99) < 0.5)) ((best = d), (spot = e));
    }
  if (spot) return spot;
  best = 15;
  for (const s of plain) {
    const np = turf.nearestPointOnLine(s.line, at, { units: 'meters' });
    if ((np.properties.dist ?? Infinity) < best) ((best = np.properties.dist!), (spot = np.geometry.coordinates));
  }
  return spot ?? at;
}

export const roundaboutCentre = (s: Street) => s.pts[0];
export const roundaboutIsland = (s: Street): Feature<Polygon> => turf.circle(s.pts[0], islandR(s.roundabout!.diameterM), { units: 'meters', steps: 48 });

/** A street's centreline with the parts inside roundabouts taken out, so streets stop at the ring. */
export function streetPieces(s: Street, streets: Street[]): Position[][] {
  if (s.roundabout) return [s.line.geometry.coordinates];
  let pieces: Position[][] = [s.line.geometry.coordinates];
  for (const r of streets) {
    if (!r.roundabout) continue;
    const c = r.pts[0], R = ringR(r.roundabout.diameterM);
    const [w, so, e, n] = turf.bbox(turf.lineString(pieces.flat()));
    const [cw, cs, ce, cn] = turf.bbox(turf.circle(c, R + 1, { units: 'meters', steps: 8 }));
    if (cw > e || ce < w || cs > n || cn < so) continue;
    const circle = turf.circle(c, R, { units: 'meters', steps: 64 });
    pieces = pieces.flatMap((p) => {
      if (p.length < 2) return [];
      const split = turf.lineSplit(turf.lineString(p), circle).features;
      const parts = split.length ? split.map((f) => f.geometry.coordinates) : [p];
      return parts.filter((q) => {
        const ql = turf.lineString(q);
        const mid = turf.along(ql, turf.length(ql, { units: 'meters' }) / 2, { units: 'meters' });
        return turf.distance(mid, c, { units: 'meters' }) > R;
      });
    });
  }
  return pieces.filter((p) => p.length > 1);
}

/** The land one street takes. */
export function corridor(s: Street, streets: Street[] = []): PolyF {
  if (s.roundabout) return turf.circle(s.pts[0], s.roundabout.diameterM / 2 + 2, { units: 'meters', steps: 64 });
  const pieces = streetPieces(s, streets);
  const geom = pieces.length === 1 ? turf.lineString(pieces[0]) : turf.multiLineString(pieces.length ? pieces : [s.line.geometry.coordinates]);
  return turf.buffer(geom, streetType(s.type).widthM / 2, { units: 'meters', steps: 6 }) as PolyF;
}

/** All the street land as one shape, with rounded kerbs where streets meet. */
export function streetLand(streets: Street[]): PolyF | null {
  if (!streets.length) return null;
  try {
    const all = streets.map((s) => corridor(s, streets));
    let u: PolyF | null = all.length > 1 ? (turf.union(turf.featureCollection(all as any)) as PolyF | null) : all[0];
    if (!u) return null;
    const grown = turf.buffer(u, KERB_RADIUS, { units: 'meters', steps: 6 });
    const shrunk = grown && turf.buffer(grown, -KERB_RADIUS, { units: 'meters', steps: 6 });
    if (shrunk?.geometry) u = shrunk as PolyF;
    return u;
  } catch {
    return null;
  }
}

// ------------------------------------------------------------------ homes

/** A rectangle centred on c: `along` metres in the direction `axis`, `across` metres at right angles. */
function box(c: Position, axis: number, along: number, across: number): Feature<Polygon> {
  const a = along / 2, b = across / 2;
  const corner = (u: number, v: number) => {
    const p = u ? turf.destination(c, Math.abs(u), u > 0 ? axis : axis + 180, { units: 'meters' }).geometry.coordinates : c;
    return turf.destination(p, Math.abs(v), v >= 0 ? axis + 90 : axis - 90, { units: 'meters' }).geometry.coordinates;
  };
  const ring = [corner(-a, -b), corner(-a, b), corner(a, b), corner(a, -b)];
  return turf.polygon([[...ring, ring[0]]]);
}

export interface HomeOpts { side: 'both' | 'left' | 'right'; setbackM: number; gardenM: number; gapM?: number }

/** A home centred on c, its front facing `front` (a bearing), with its plot and rear garden. */
function makeHome(c: Position, front: number, t: HouseType, o: HomeOpts, gap: number): Omit<Home, 'id' | 'streetId' | 'tenure'> {
  const width = t.frontageM + gap;
  const shape = box(c, front, t.depthM, t.frontageM);
  const plotC = turf.destination(c, (o.setbackM - o.gardenM) / 2, front, { units: 'meters' }).geometry.coordinates;
  const plot = box(plotC, front, o.setbackM + t.depthM + o.gardenM, width);
  const garden = o.gardenM > 0.5 ? box(turf.destination(c, t.depthM / 2 + o.gardenM / 2, front + 180, { units: 'meters' }).geometry.coordinates, front, o.gardenM, width) : null;
  const ridge: [Position, Position] = [
    turf.destination(c, t.frontageM / 2, front - 90, { units: 'meters' }).geometry.coordinates,
    turf.destination(c, t.frontageM / 2, front + 90, { units: 'meters' }).geometry.coordinates,
  ];
  return { type: t.id, shape, plot, garden, ridge };
}

export interface Obstacles {
  boundary: PolyF | null; // plots must sit inside it (the red line)
  shapes: PolyF[]; // street land, open space, other plots, blocks, existing buildings
}

function blocked(plot: Feature<Polygon>, o: Obstacles, extra: Feature<Polygon>[]) {
  if (o.boundary && !turf.booleanWithin(plot, o.boundary)) return true;
  // Test a slightly smaller plot, so neighbours can share a boundary and a party wall.
  const f = turf.transformScale(plot, 0.95);
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
 * Line a street with homes: plots step along the street on one or both sides, the homes facing it,
 * set back from the edge of the street land. A plot that would clash with anything already there is
 * skipped, so junctions, open space and existing buildings leave gaps; on a bend the plots fan out.
 */
export function lineStreet(street: Street, streets: Street[], typeId: HouseTypeId, opts: HomeOpts, o: Obstacles, existing: Home[]): Home[] {
  const t = houseType(typeId);
  const gap = opts.gapM ?? t.gapM;
  const step = t.frontageM + gap;
  const offset = streetType(street.type).widthM / 2 + opts.setbackM + t.depthM / 2;
  const sides = street.roundabout ? [1] : opts.side === 'both' ? [1, -1] : opts.side === 'left' ? [-1] : [1];
  const placed: Home[] = [];
  const shapes = o.shapes.map((g) => ({ ...g, bbox: turf.bbox(g) }));
  const pieces = streetPieces(street, streets).map((p) => turf.lineString(p));
  for (const line of pieces) {
    const len = turf.length(line, { units: 'meters' });
    for (const side of sides) {
      // A roundabout's ring runs anticlockwise, so its outside is on the right (+1).
      for (let d = step / 2 + 1; d <= len - step / 2 - 1; d += step) {
        const p = turf.along(line, d, { units: 'meters' });
        const a = turf.along(line, Math.max(0, d - 2), { units: 'meters' }), b = turf.along(line, Math.min(len, d + 2), { units: 'meters' });
        const bearing = turf.bearing(a, b);
        const c = turf.destination(p, offset, bearing + 90 * side, { units: 'meters' }).geometry.coordinates;
        const h = makeHome(c, bearing + 90 * side + 180, t, opts, gap);
        if (blocked(h.plot, { boundary: o.boundary, shapes }, placed.map((x) => x.plot))) continue;
        placed.push({ ...h, id: newId('H', [...existing, ...placed]), streetId: street.id, tenure: 'market' });
      }
    }
  }
  return placed;
}

/**
 * One home at a point. Near a street (within 40 m) it moves onto the building line and faces the
 * street; elsewhere it stays where it was put, facing south.
 */
export function placeHome(at: Position, typeId: HouseTypeId, streets: Street[], opts: HomeOpts, o: Obstacles, existing: Home[]): Home | null {
  const t = houseType(typeId);
  let best = 40, front = 180, c = at, sid: string | null = null;
  for (const s of streets) {
    for (const piece of streetPieces(s, streets)) {
      const line = turf.lineString(piece);
      const np = turf.nearestPointOnLine(line, at, { units: 'meters' });
      const dist = np.properties.dist ?? Infinity;
      if (dist >= best || dist < 0.01) continue;
      best = dist;
      front = turf.bearing(at, np);
      c = turf.destination(np, streetType(s.type).widthM / 2 + opts.setbackM + t.depthM / 2, front + 180, { units: 'meters' }).geometry.coordinates;
      // Square the home to the street: face straight across it.
      const i = Math.min(np.properties.index ?? 0, piece.length - 2);
      const along = turf.bearing(piece[i], piece[i + 1]);
      const cands = [along + 90, along - 90];
      const diff = (x: number) => Math.abs(((x - front + 540) % 360) - 180);
      front = diff(cands[0]) < diff(cands[1]) ? cands[0] : cands[1];
      sid = s.id;
    }
  }
  const h = makeHome(c, front, t, opts, opts.gapM ?? t.gapM);
  if (blocked(h.plot, o, [])) return null;
  return { ...h, id: newId('H', existing), streetId: sid, tenure: 'market' };
}

/** Pepper-pot affordable homes through the layout to reach `share` (0–1) of the homes. */
export function spreadAffordable(homes: Home[], share: number) {
  let credit = 0;
  for (const h of homes) {
    const n = houseType(h.type).homes;
    credit += n * share;
    if (credit >= n - 1e-6) ((h.tenure = 'affordable'), (credit -= n));
    else h.tenure = 'market';
  }
}

// ------------------------------------------------------------------ schedule

export interface Targets { affordablePct: number; mix: Record<1 | 2 | 3 | 4, number>; apartmentOneBedPct: number }
export const DEFAULT_TARGETS: Targets = { affordablePct: 30, mix: { 1: 10, 2: 30, 3: 40, 4: 20 }, apartmentOneBedPct: 50 };

export interface Schedule {
  siteM2: number | null;
  streetsM2: number;
  streetLengthM: Record<string, number>;
  roundabouts: number;
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
  affordable: { homes: number; share: number; targetPct: number; targetHomes: number };
  mix: { beds: 1 | 2 | 3 | 4; homes: number; share: number; targetPct: number }[];
  openVsBenchmark: { type: OpenType; label: string; providedHa: number; benchmarkHa: number }[];
}

export function schedule(plan: Plan, site: PolyF | null, apartmentHomes: number, apartmentParking: number, householdSize: number, targets: Targets): Schedule {
  const inSite = (f: PolyF) => {
    if (!site) return turf.area(f);
    try {
      const x = turf.intersect(turf.featureCollection([f, site as any]));
      return x ? turf.area(x) : 0;
    } catch {
      return 0;
    }
  };
  const land = streetLand(plan.streets);
  const streetsM2 = land ? inSite(land) : 0;
  const streetLengthM: Record<string, number> = {};
  for (const s of plan.streets) {
    if (s.roundabout) continue;
    const len = streetPieces(s, plan.streets).reduce((a, p) => a + turf.length(turf.lineString(p), { units: 'meters' }), 0);
    streetLengthM[streetType(s.type).label] = (streetLengthM[streetType(s.type).label] ?? 0) + len;
  }
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

  const affHomes = plan.homes.filter((h) => h.tenure === 'affordable').reduce((s, h) => s + houseType(h.type).homes, 0);
  const bedsCount: Record<1 | 2 | 3 | 4, number> = { 1: 0, 2: 0, 3: 0, 4: 0 };
  for (const h of houses) bedsCount[Math.min(4, h.beds) as 1 | 2 | 3 | 4] += h.homes;
  const apt1 = Math.round((apartmentHomes * targets.apartmentOneBedPct) / 100);
  bedsCount[1] += apt1;
  bedsCount[2] += apartmentHomes - apt1;
  const mix = ([1, 2, 3, 4] as const).map((b) => ({ beds: b, homes: bedsCount[b], share: homes ? bedsCount[b] / homes : 0, targetPct: targets.mix[b] }));

  const openVsBenchmark = OPEN_TYPES.filter((t) => t.haPer1000 != null && (openM2[t.id] || population))
    .map((t) => ({ type: t.id, label: t.label, providedHa: (openM2[t.id] ?? 0) / 10000, benchmarkHa: (t.haPer1000! * population) / 1000 }));
  return {
    siteM2, streetsM2, streetLengthM, roundabouts: plan.streets.filter((s) => s.roundabout).length, openM2, netM2, houses, houseHomes, apartmentHomes, homes, population,
    grossDph: siteM2 ? homes / (siteM2 / 10000) : null,
    netDph: netM2 ? homes / (netM2 / 10000) : null,
    parking,
    affordable: { homes: affHomes, share: homes ? affHomes / homes : 0, targetPct: targets.affordablePct, targetHomes: Math.ceil((homes * targets.affordablePct) / 100) },
    mix,
    openVsBenchmark,
  };
}

// ------------------------------------------------------------------ map data

/** A gable roof as stepped slices, for the map (Mapbox extrudes flat tops only). */
function roofSlices(h: Home, t: HouseType, n = 5) {
  const out: { shape: Feature<Polygon>; base: number; top: number }[] = [];
  if (!h.ridge) return out;
  const c = turf.midpoint(h.ridge[0], h.ridge[1]).geometry.coordinates;
  const front = turf.bearing(h.ridge[0], h.ridge[1]) - 90;
  const eave = houseEave(t), rise = houseRise(t);
  for (let k = 0; k < n; k++) out.push({ shape: box(c, front, t.depthM * (1 - (k + 0.5) / n), t.frontageM), base: eave + (rise * k) / n, top: eave + (rise * (k + 1)) / n });
  return out;
}

/** Lines splitting a pair's plot and footprint into two homes. */
function partyLines(h: Home): Position[][] {
  if (houseType(h.type).homes < 2) return [];
  const mid = (a: Position, b: Position) => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
  const r = h.plot.geometry.coordinates[0];
  return [[mid(r[0], r[1]), mid(r[3], r[2])]];
}

export function planGeoJSON(plan: Plan, selected: string | null) {
  const fc = (features: Feature[]): FeatureCollection => ({ type: 'FeatureCollection', features });
  const streets = fc(
    plan.streets.map((s) => ({
      type: 'Feature',
      geometry: { type: 'MultiLineString', coordinates: streetPieces(s, plan.streets) },
      properties: { id: s.id, class: streetType(s.type).cls, path: s.type === 'path', selected: s.id === selected },
    })),
  );
  const land = streetLand(plan.streets);
  const islands = fc(plan.streets.filter((s) => s.roundabout).map((s) => ({ ...roundaboutIsland(s), properties: { id: s.id } })));
  const open = fc(plan.open.map((o) => ({ ...o.shape, properties: { id: o.id, type: o.type, colour: openType(o.type).colour, selected: o.id === selected } })));
  const homes = fc(
    plan.homes.flatMap((h) => {
      const t = houseType(h.type);
      const colour = h.tenure === 'affordable' ? AFFORDABLE_COLOUR : t.colour;
      const props = { id: h.id, colour, selected: h.id === selected, tenure: h.tenure };
      const walls = { ...h.shape, properties: { ...props, base: 0, top: h.ridge ? houseEave(t) : houseHeight(t) } };
      return [walls, ...roofSlices(h, t).map((r) => ({ ...r.shape, properties: { ...props, base: r.base, top: r.top } }))];
    }),
  );
  const plots = fc([
    ...plan.homes.map((h) => ({ type: 'Feature' as const, geometry: { type: 'LineString' as const, coordinates: h.plot.geometry.coordinates[0] }, properties: { id: h.id } })),
    ...plan.homes.flatMap((h) => partyLines(h).map((l) => ({ type: 'Feature' as const, geometry: { type: 'LineString' as const, coordinates: l }, properties: { id: h.id } }))),
  ]);
  const gardens = fc(plan.homes.filter((h) => h.garden).map((h) => ({ ...h.garden!, properties: { id: h.id } })));
  return { streets, land: fc(land ? [land] : []), islands, open, homes, plots, gardens };
}

/** Plot dividers for pairs, for the drawings and CAD. */
export const homePartyLines = partyLines;
