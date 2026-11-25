// Masterplanning: streets (curved, joined, with roundabouts), open space and house types with plots
// and gardens, on top of the red line, with a live schedule. Dimensions are typical UK figures to
// sketch with, not a design standard; each is shown where it is used.
import * as turf from '@turf/turf';
import type { Feature, FeatureCollection, LineString, Polygon, MultiPolygon, Position } from 'geojson';

import { bezierPath, autoHandles, nodesFrom, cloneNodes, samePlace, type PenNode } from './bezier';

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
  pts: Position[]; // the anchors (the centre, for a roundabout)
  nodes: PenNode[]; // the anchors with their curve handles, as drawn with the pen
  curve: number; // the last "smooth all" setting: 0 corners, up to 1 a full curve through the anchors
  line: Feature<LineString>; // the centreline; the ring for a roundabout
  roundabout?: { diameterM: number };
}
export interface OpenSpace { id: string; name: string; type: OpenType; pts: Position[]; nodes: PenNode[]; round: number; shape: Feature<Polygon> } // nodes: the outline as drawn; round 0–1
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
  plan.streets = plan.streets.map(({ curved, ...s }: any) => {
    const pts: Position[] = s.pts ?? s.line.geometry.coordinates;
    const curve = s.curve ?? (curved ? 0.85 : 0);
    const nodes: PenNode[] = s.nodes ?? (s.roundabout ? nodesFrom([pts[0]]) : autoHandles(nodesFrom(pts), curve));
    return { ...s, pts, curve, nodes, line: s.roundabout ? s.line : turf.lineString(bezierPath(nodes)) };
  });
  plan.open = plan.open.map((o: any) => {
    const ring: Position[] = o.pts ?? o.shape.geometry.coordinates[0];
    const nodes: PenNode[] = o.nodes ?? nodesFrom(samePlace(ring[0], ring[ring.length - 1], 0.01) ? ring.slice(0, -1) : ring);
    return { ...o, nodes, pts: nodes.map((n) => n.p), round: o.round ?? 0 };
  });
  plan.homes = plan.homes.map((h: any) => ({ ...h, type: HOUSE_TYPES.some((t) => t.id === h.type) ? h.type : 'terrace', plot: h.plot ?? h.shape, garden: h.garden ?? null, ridge: h.ridge ?? null, tenure: h.tenure ?? 'market' }));
  return plan;
}

// ------------------------------------------------------------------ street geometry

export function streetLine(pts: Position[], curve: number): Feature<LineString> {
  const l = turf.lineString(pts);
  if (!(curve > 0) || pts.length < 3) return l;
  try {
    // turf reads a sharpness of 0 as "use the default", so keep it just above.
    return turf.bezierSpline(l, { resolution: 10000, sharpness: Math.max(0.03, 0.85 * Math.min(1, curve)) }) // past 0.85 the curve overshoots the points as Feature<LineString>;
  } catch {
    return l;
  }
}

export function newStreet(plan: Plan, type: StreetType, nodes: PenNode[], curve: number): Street {
  const s = { id: newId('S', plan.streets), name: `Street ${plan.streets.filter((x) => !x.roundabout).length + 1}`, type, curve } as Street;
  return setStreetNodes(s, nodes);
}

/** Give a street new anchors and handles; its centreline follows. A roundabout's one node is its centre. */
export function setStreetNodes(s: Street, nodes: PenNode[]): Street {
  s.nodes = cloneNodes(nodes);
  s.pts = s.nodes.map((n) => n.p);
  s.line = s.roundabout
    ? turf.lineString(turf.circle(s.pts[0], ringR(s.roundabout.diameterM), { units: 'meters', steps: 64 }).geometry.coordinates[0])
    : turf.lineString(bezierPath(s.nodes));
  return s;
}

/** Give an open space a new outline; its shape (with rounded corners, if set) follows. */
export function setOpenNodes(o: OpenSpace, nodes: PenNode[]): OpenSpace {
  o.nodes = cloneNodes(nodes);
  o.pts = o.nodes.map((n) => n.p);
  o.shape = roundedShape(bezierPath(o.nodes, true), o.round);
  return o;
}

export function newRoundabout(plan: Plan, at: Position, type: StreetType, diameterM: number): Street {
  const centre = roundaboutSpot(at, plan.streets);
  const ring = turf.circle(centre, ringR(diameterM), { units: 'meters', steps: 64 }).geometry.coordinates[0];
  const n = plan.streets.filter((s) => s.roundabout).length + 1;
  return { id: newId('S', plan.streets), name: `Roundabout ${n}`, type, pts: [centre], nodes: nodesFrom([centre]), curve: 0, line: turf.lineString(ring), roundabout: { diameterM } };
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

/**
 * Round a polygon's corners by cutting them again and again (Chaikin). round 0 keeps the corners;
 * 1 gives a smooth, pebble-like outline. The shape shrinks a little as its corners go.
 */
export function roundedShape(ring: Position[], round: number): Feature<Polygon> {
  let pts = ring.slice(0, -1);
  const closed = (p: Position[]) => turf.polygon([[...p, p[0]]]);
  if (!(round > 0) || pts.length < 3) return closed(pts);
  const r = 0.25 * Math.min(1, round);
  for (let it = 0; it < 4; it++) {
    const next: Position[] = [];
    for (let i = 0; i < pts.length; i++) {
      const a = pts[i], b = pts[(i + 1) % pts.length];
      next.push([a[0] + (b[0] - a[0]) * r, a[1] + (b[1] - a[1]) * r], [a[0] + (b[0] - a[0]) * (1 - r), a[1] + (b[1] - a[1]) * (1 - r)]);
    }
    pts = next;
  }
  return closed(pts);
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
      const props = { id: h.id, colour, wash: wash(colour), selected: h.id === selected, tenure: h.tenure };
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

// ------------------------------------------------------------------ sketch

type XY = [number, number];

/** A repeatable random sequence, so a sketch looks the same each time it is drawn. */
function rng(seed: number) {
  let s = seed >>> 0 || 1;
  return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296);
}
const hashOf = (str: string) => [...str].reduce((h, c) => (Math.imul(h, 31) + c.charCodeAt(0)) >>> 0, 7);

/** Metres around a point, for drawing; small areas only. */
function frameAt(p: Position) {
  const kx = 111320 * Math.cos((p[1] * Math.PI) / 180), ky = 110574;
  return { to: (q: Position): XY => [(q[0] - p[0]) * kx, (q[1] - p[1]) * ky], from: (q: XY): Position => [p[0] + q[0] / kx, p[1] + q[1] / ky] };
}

/** Split a closed ring into strokes at its corners (turns sharper than 25°); a smooth ring is one stroke. */
function strokesOf(ring: XY[]): { pts: XY[]; closed: boolean }[] {
  const r = ring.length > 1 && ring[0][0] === ring[ring.length - 1][0] && ring[0][1] === ring[ring.length - 1][1] ? ring.slice(0, -1) : ring;
  const n = r.length;
  if (n < 3) return [];
  const corner = r.map((p, i) => {
    const a = r[(i - 1 + n) % n], b = r[(i + 1) % n];
    const t1 = Math.atan2(p[1] - a[1], p[0] - a[0]), t2 = Math.atan2(b[1] - p[1], b[0] - p[0]);
    let d = Math.abs(t2 - t1);
    if (d > Math.PI) d = 2 * Math.PI - d;
    return d > (25 * Math.PI) / 180;
  });
  const starts = corner.map((c, i) => (c ? i : -1)).filter((i) => i >= 0);
  if (!starts.length) return [{ pts: [...r, r[0], r[1]], closed: true }];
  return starts.map((s, k) => {
    const e = starts[(k + 1) % starts.length];
    const pts: XY[] = [];
    for (let i = s; ; i = (i + 1) % n) {
      pts.push(r[i]);
      if (i === e && pts.length > 1) break;
    }
    return { pts, closed: false };
  });
}

/** A hand-drawn version of a stroke: a slight bow, a little wobble, and an overshoot past each end. */
function wobble(pts: XY[], rand: () => number, amp: number, over: number): XY[] {
  if (pts.length < 2) return pts;
  const out: XY[] = [];
  const ext = (a: XY, b: XY, d: number): XY => {
    const L = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
    return [a[0] + ((a[0] - b[0]) / L) * d, a[1] + ((a[1] - b[1]) / L) * d];
  };
  const line = over ? [ext(pts[0], pts[1], over * (0.5 + rand())), ...pts, ext(pts[pts.length - 1], pts[pts.length - 2], over * (0.5 + rand()))] : pts;
  const total = line.slice(1).reduce((s, p, i) => s + Math.hypot(p[0] - line[i][0], p[1] - line[i][1]), 0) || 1;
  const bow = (rand() - 0.5) * Math.min(0.6, total * 0.012);
  let run = 0;
  for (let i = 0; i < line.length - 1; i++) {
    const a = line[i], b = line[i + 1];
    const L = Math.hypot(b[0] - a[0], b[1] - a[1]);
    const nx = -(b[1] - a[1]) / (L || 1), ny = (b[0] - a[0]) / (L || 1);
    const steps = Math.max(1, Math.round(L / 2.5));
    for (let k = 0; k < steps; k++) {
      const t = k / steps, s = (run + L * t) / total;
      const off = Math.sin(Math.PI * s) * bow + (rand() - 0.5) * amp;
      out.push([a[0] + (b[0] - a[0]) * t + nx * off, a[1] + (b[1] - a[1]) * t + ny * off]);
    }
    run += L;
  }
  const last = line[line.length - 1];
  out.push([last[0] + (rand() - 0.5) * amp, last[1] + (rand() - 0.5) * amp]);
  return out;
}

/** Parallel hatch lines across a polygon (local metres), at `angle` degrees, `gap` metres apart. */
function hatch(rings: XY[][], angle: number, gap: number, rand: () => number): XY[][] {
  const t = (angle * Math.PI) / 180, c = Math.cos(t), s = Math.sin(t);
  const rot = (p: XY): XY => [p[0] * c + p[1] * s, -p[0] * s + p[1] * c];
  const back = (p: XY): XY => [p[0] * c - p[1] * s, p[0] * s + p[1] * c];
  const R = rings.map((r) => r.map(rot));
  const ys = R.flat().map((p) => p[1]);
  const out: XY[][] = [];
  for (let y = Math.min(...ys) + gap / 2; y < Math.max(...ys); y += gap) {
    const xs: number[] = [];
    for (const r of R)
      for (let i = 0; i < r.length - 1; i++) {
        const a = r[i], b = r[i + 1];
        if ((a[1] <= y && b[1] > y) || (b[1] <= y && a[1] > y)) xs.push(a[0] + ((y - a[1]) / (b[1] - a[1])) * (b[0] - a[0]));
      }
    xs.sort((p, q) => p - q);
    for (let i = 0; i + 1 < xs.length; i += 2) {
      const inset = 0.4 + rand() * 0.8; // hand hatching stops short of the edge
      const x0 = xs[i] + inset, x1 = xs[i + 1] - inset * (0.5 + rand());
      if (x1 - x0 > 0.8) out.push([back([x0, y + (rand() - 0.5) * 0.3]), back([x1, y + (rand() - 0.5) * 0.3])]);
    }
  }
  return out;
}

const HATCH: Partial<Record<OpenType, { angle: number; gap: number; cross?: boolean }>> = {
  park: { angle: 45, gap: 3.2 },
  amenity: { angle: 45, gap: 5 },
  natural: { angle: -40, gap: 2.2 },
  play: { angle: 45, gap: 2.5, cross: true },
  suds: { angle: 0, gap: 2.4 },
  allotment: { angle: 90, gap: 3 },
};
const darker = (hex: string, t = 0.45) => '#' + [1, 3, 5].map((i) => Math.round(parseInt(hex.slice(i, i + 2), 16) * (1 - t)).toString(16).padStart(2, '0')).join('');

/**
 * The plan as a sketch: pencil strokes that wobble and overshoot their corners (two passes, one light),
 * ridge lines on the roofs, light plot lines and hatched open space. `extra` adds outlines (e.g. blocks).
 */
export function sketchGeoJSON(plan: Plan, extra: Feature<Polygon>[] = []) {
  const lines: Feature[] = [], hatches: Feature[] = [];
  const pencil = '#2b2a27';
  const add = (target: Feature[], coords: Position[], w: number, o: number, c = pencil) =>
    coords.length > 1 && target.push({ type: 'Feature', geometry: { type: 'LineString', coordinates: coords }, properties: { w, o, c } });
  const outline = (rings: Position[][], seed: string, o: { amp: number; over: number; passes: number; w?: number }) => {
    if (!rings.length || !rings[0].length) return;
    const F = frameAt(rings[0][0]);
    const rand = rng(hashOf(seed));
    for (const ring of rings)
      for (const st of strokesOf(ring.map(F.to)))
        for (let pass = 0; pass < o.passes; pass++) {
          const pts = wobble(st.pts, rand, o.amp * (pass ? 1.6 : 1), st.closed ? 0 : o.over * (pass ? 1.3 : 1));
          add(lines, pts.map(F.from), pass ? (o.w ?? 1) * 0.6 : o.w ?? 1, pass ? 0.35 : 0.85);
        }
  };
  const ringsOf = (f: PolyF) => (f.geometry.type === 'Polygon' ? f.geometry.coordinates : f.geometry.coordinates.flat());

  const land = streetLand(plan.streets);
  if (land) outline(ringsOf(land), 'land', { amp: 0.25, over: 2.2, passes: 2, w: 1.1 });
  for (const s of plan.streets) if (s.roundabout) outline([roundaboutIsland(s).geometry.coordinates[0]], s.id + 'i', { amp: 0.2, over: 0, passes: 2 });
  for (const o of plan.open) {
    outline([o.shape.geometry.coordinates[0]], o.id, { amp: 0.35, over: 2, passes: 2, w: 1 });
    const h = HATCH[o.type];
    if (!h) continue;
    const F = frameAt(o.shape.geometry.coordinates[0][0]);
    const rand = rng(hashOf(o.id + 'h'));
    const rings = [o.shape.geometry.coordinates[0].map(F.to)];
    const c = darker(openType(o.type).colour);
    for (const l of hatch(rings, h.angle, h.gap, rand)) add(hatches, l.map(F.from), 0.6, 0.55, c);
    if (h.cross) for (const l of hatch(rings, h.angle + 90, h.gap, rand)) add(hatches, l.map(F.from), 0.6, 0.45, c);
  }
  for (const h of plan.homes) {
    outline([h.plot.geometry.coordinates[0]], h.id + 'p', { amp: 0.15, over: 0.6, passes: 1, w: 0.45 });
    outline([h.shape.geometry.coordinates[0]], h.id, { amp: 0.12, over: 0.9, passes: 2, w: 1 });
    if (h.ridge) {
      const F = frameAt(h.ridge[0]);
      add(lines, wobble([F.to(h.ridge[0]), F.to(h.ridge[1])], rng(hashOf(h.id + 'r')), 0.1, 0.5).map(F.from), 0.7, 0.7);
    }
  }
  for (const [i, f] of extra.entries()) outline([f.geometry.coordinates[0]], `x${i}`, { amp: 0.2, over: 1.4, passes: 2, w: 1.1 });
  const fc = (features: Feature[]): FeatureCollection => ({ type: 'FeatureCollection', features });
  return { lines: fc(lines), hatches: fc(hatches) };
}

/** A watercolour wash of a colour: lighter, for sketch mode. */
export const wash = (hex: string, t = 0.45) => '#' + [1, 3, 5].map((i) => { const v = parseInt(hex.slice(i, i + 2), 16); return Math.round(v + (255 - v) * t).toString(16).padStart(2, '0'); }).join('');
