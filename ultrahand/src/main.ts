import mapboxgl from 'mapbox-gl';
import 'mapbox-gl/dist/mapbox-gl.css';
import MapboxDraw from '@mapbox/mapbox-gl-draw';
import '@mapbox/mapbox-gl-draw/dist/mapbox-gl-draw.css';
import * as turf from '@turf/turf';
import * as SunCalc from 'suncalc';
import type { Feature, FeatureCollection, Polygon, MultiPolygon, LineString, Position, Point } from 'geojson';
import './style.css';

import { DATASETS, fetchDataset, fetchPlanningAuthority, describe, entityUrl } from './planning';
import { fetchStreets, fetchPoisFromTiles, fetchWalkNetwork } from './tiles';
import { buildGraph, walkFrom, walkPieces, distanceTo, withDrawn, clipLines, WALK_SPEED, BANDS } from './walk';
import { ROFSW_TILES, surfaceWaterOn, type SurfaceWater } from './flood';
import { sunStudySVG } from './sunstudy';
import { computeMetrics, pct, ratio, type Metrics } from './metrics';
import { siteDXF, siteOBJ, type ExportLine, type ExportBlock } from './export3d';
import { createPen, type Snap, type SnapSources, type Editable, type Guide } from './pen';
import { bezierPath, autoHandles, nearestOnPath, splitAt, samePlace, cloneNodes, node as penNode, type PenNode } from './bezier';
import { clearAreas, TREE_TYPES, treeType, newTree, canopyR, treeSlices, plantAlong, fillWithTrees, treesGeoJSON, canopyShape, type TreeType, roundedShape, sketchGeoJSON, setStreetNodes, setOpenNodes, type HouseType, STREET_TYPES, OPEN_TYPES, HOUSE_TYPES, ROUNDABOUTS, AFFORDABLE_COLOUR, DEFAULT_TARGETS, streetType, openType, houseType, houseHeight, houseEave, emptyPlan, upgradePlan, newId, newStreet, newRoundabout, streetLine, snapEnds, streetPieces, streetLand, roundaboutIsland, homePartyLines, corridor, lineStreet, placeHome, spreadAffordable, schedule, planGeoJSON, type Plan, type Street, type OpenSpace, type Home, type HomeOpts, type Tenure, type Targets, type StreetType, type OpenType, type HouseTypeId, type Obstacles } from './masterplan';
import { initAgentPanel } from './agent';
import { loadPixels, siteMask, palette, swatchImage, traceRegions, labelWith, traceRoads, type Pixels, type Roads } from './trace';
import { fetchLidar, measureBuilding, groundLevels, profile, contourLines, type Lidar } from './lidar';
import { sectionSVG, type SectionPoint } from './section';
import { fetchPeople, IMD_COLOURS, type People } from './people';
import { USES, useOf, heightOf, footprintOf, giaOf, totals as massTotals, blocksGeoJSON, newBlock, DEFAULT_ASSUMPTIONS, type Block, type Use } from './massing';
import { buildModel, modelGeoJSON, GREEN, type SiteModel, type Bldg } from './model';
import { fetchPois, fetchBuildingAt, reverseGeocode, type Poi } from './osm';
import { renderAxo, groundLayers, LOOK, ROAD_WIDTH_M, type AxoBuilding, type GroundPolys, type GroundLines } from './axo';
import { openPassport, useLabel } from './passport';
import { layoutAtlas, translateFeature, ease, type AtlasLayout } from './atlas';
import { fmtArea, fmtDist, toLocalPolys, LocalFrame, type XY, type LocalPoly } from './geo';

const TOKEN = import.meta.env.VITE_MAPBOX_TOKEN as string;

// ---------------------------------------------------------------- allto shared project
// window.Allto comes from shared/allto.js (loaded in index.html). Ultrahand shares its red line
// and place, and takes in a red line drawn in Consultation (or anywhere else in allto).
interface AlltoProject { name?: string; place?: string; redLine?: number[][]; updatedAt?: number; source?: string }
interface AlltoApi {
  project(): AlltoProject;
  update(patch: Partial<AlltoProject>, source: string): AlltoProject;
  hasNews(product: string): boolean;
  markSeen(product: string): void;
  onChange(fn: (p: AlltoProject) => void): void;
  productLabel(id: string): string;
  mountSwitcher(host: HTMLElement | null, opts: { active?: string; theme?: string; logo?: boolean }): HTMLElement | null;
  mountProjectChip(host: HTMLElement | null, opts?: { theme?: string }): HTMLElement | null;
  notify(msg: string): void;
  beforeSave?(fn: () => void): void;
}
const Allto = (window as any).Allto as AlltoApi | undefined;
const PRODUCT = 'ultrahand';
Allto?.mountSwitcher(document.getElementById('alltoBar'), { active: PRODUCT });
Allto?.mountProjectChip(document.getElementById('alltoChip'));
let takingIn = false;
mapboxgl.accessToken = TOKEN;

type PolyF = Feature<Polygon | MultiPolygon>;
type View = 'plan' | '3d' | 'axo' | 'atlas' | 'eye';
const $ = <T extends HTMLElement = HTMLElement>(s: string) => document.querySelector<T>(s)!;
const empty: FeatureCollection = { type: 'FeatureCollection', features: [] };
const esc = (s: unknown) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
// Walk bands (5, 10, 15 minutes): colours and which are shown, remembered in this browser.
const WALK_PALETTES: Record<string, string[]> = {
  Orange: ['#c2410c', '#f19a3e', '#f7cf9c'],
  Blue: ['#1d3fbf', '#4f7be8', '#a9c1f5'],
  Green: ['#1f6b35', '#4fa45f', '#a8d5a6'],
  Purple: ['#5b2a86', '#9157c2', '#cfb3e8'],
  Grey: ['#141414', '#6f6e6a', '#c4c3be'],
};
const walkStyle = (() => {
  try {
    const j = JSON.parse(localStorage.getItem('ultrahand:walk') ?? 'null');
    if (j?.colours?.length === 3 && j?.on?.length === 3) return j as { colours: string[]; on: boolean[] };
  } catch { /* nothing saved */ }
  return { colours: [...WALK_PALETTES.Orange], on: [true, true, true] };
})();
const saveWalkStyle = () => {
  try {
    localStorage.setItem('ultrahand:walk', JSON.stringify(walkStyle));
  } catch { /* storage blocked */ }
};
// The allto Worker (workers/agent-token) also serves the Land Registry parcels; its address is the token URL's.
const WORKER_BASE = (() => {
  let u = (import.meta.env.VITE_AGENT_TOKEN_URL as string) || '';
  try {
    u = localStorage.getItem('ultrahand:agentTokenUrl') || u;
  } catch { /* storage blocked */ }
  // A relative address ("/token", when allto is served by the Worker itself) means this site.
  return u ? new URL(u, location.href).href.replace(/\/token\/?$/, '') : '';
})();
const HOME = { center: [-2.2557, 53.4776] as [number, number], zoom: 16 };

const S = {
  red: null as PolyF | null,
  study: null as PolyF | null,
  drawnStudy: null as PolyF | null,
  drawnBox: null as PolyF | null,
  studyMode: 'buffer' as 'buffer' | 'walk' | 'draw' | 'box',
  bufferM: 200,
  walkMin: 10,
  walk: empty as FeatureCollection,
  drawing: null as null | 'red' | 'study' | 'box' | 'massing' | 'section' | 'street' | 'open',
  model: null as SiteModel | null,
  modelFC: empty as FeatureCollection,
  designations: empty as FeatureCollection,
  pois: [] as Poi[],
  place: '',
  lpa: null as string | null,
  selected: null as Bldg | null,
  view: 'plan' as View,
  visible: new Set<string>([...DATASETS.filter((d) => d.on).map((d) => d.id), 'walk', 'pois']),
  openGroups: new Set<string>(),
  massing: 0,
  blocks: [] as Block[],
  blockSel: null as string | null,
  assume: { ...DEFAULT_ASSUMPTIONS },
  plan: emptyPlan() as Plan,
  mpSel: null as string | null,
  mpAssume: { householdSize: 2.4, aptParking: 1 },
  targets: { ...DEFAULT_TARGETS, mix: { ...DEFAULT_TARGETS.mix } } as Targets,
  sketch: false,
  atlas: null as AtlasLayout | null,
  metrics: null as Metrics | null,
  people: null as People | null,
  atlasT: 0,
};

// ---------------------------------------------------------------- map
const map = new mapboxgl.Map({
  container: 'map',
  style: 'mapbox://styles/mapbox/light-v11',
  center: HOME.center,
  zoom: HOME.zoom,
  preserveDrawingBuffer: true,
  antialias: true,
  maxZoom: 25, // eye level needs the camera within ~16 m of its look-at point
});
map.addControl(new mapboxgl.ScaleControl({ unit: 'metric' }), 'bottom-left');
map.addControl(new mapboxgl.NavigationControl({ visualizePitch: true }), 'bottom-right');

const draw = new MapboxDraw({
  displayControlsDefault: false,
  styles: [
    { id: 'gl-draw-fill', type: 'fill', filter: ['all', ['==', '$type', 'Polygon']], paint: { 'fill-color': '#d7262e', 'fill-opacity': 0.08 } },
    { id: 'gl-draw-line', type: 'line', filter: ['any', ['==', '$type', 'LineString'], ['==', '$type', 'Polygon']], layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': '#d7262e', 'line-width': 2.5 } },
    { id: 'gl-draw-vertex-halo', type: 'circle', filter: ['all', ['==', 'meta', 'vertex'], ['==', '$type', 'Point']], paint: { 'circle-radius': 6, 'circle-color': '#fff', 'circle-stroke-color': '#d7262e', 'circle-stroke-width': 2 } },
    { id: 'gl-draw-midpoint', type: 'circle', filter: ['all', ['==', 'meta', 'midpoint'], ['==', '$type', 'Point']], paint: { 'circle-radius': 3, 'circle-color': '#d7262e' } },
  ],
});
map.addControl(draw);

// ---------------------------------------------------------------- the pen (masterplan drawing and editing)
// Streets, open spaces and blocks are drawn and edited with a pen: anchors with curve handles. Streets
// share nodes where they meet, so dragging a junction moves every street that meets there.
let mpModeOn = false;
const pen = createPen(map, { sources: penSources, onEdit: applyPenEdit });

function penDraw(kind: 'street' | 'open' | 'massing', closed: boolean, onDone: (nodes: PenNode[], snaps: (Snap | null)[]) => void, msg: string) {
  draw.deleteAll();
  setPick(null);
  if (S.view !== 'plan') setView('plan');
  S.drawing = kind;
  const end = () => ((S.drawing = null), (lastDrawEnd = Date.now()), renderTiles());
  pen.draw({ closed, onDone: (n, sn) => (end(), onDone(n, sn)), onCancel: end });
  toast(msg);
}

/** What the pen can snap to: street nodes and centrelines, kerbs, the red line, spaces and blocks. */
function penSources(exclude: string[]): SnapSources {
  const ex = new Set(exclude);
  const points: SnapSources['points'] = [], lines: SnapSources['lines'] = [], guides: Guide[] = [];
  const brg = (a: Position | Feature<Point>, b: Position | Feature<Point>) => turf.bearing(a as any, b as any);
  const ringsOf = (f: Feature<Polygon | MultiPolygon>) => (f.geometry.type === 'Polygon' ? f.geometry.coordinates : f.geometry.coordinates.flat());
  for (const s of S.plan.streets) {
    if (ex.has(s.id)) continue;
    if (s.roundabout) {
      points.push({ p: s.pts[0], label: `Centre of ${s.name}`, ref: { type: 'roundabout', id: s.id } });
      lines.push({ coords: s.line.geometry.coordinates, label: `Join ${s.name}`, ref: { type: 'ring', id: s.id } });
      continue;
    }
    // Guides: each end extends along the street, and every point has a line square to the street.
    const len = turf.length(s.line, { units: 'meters' });
    const tangent = (p: Position) => {
      if (len < 2) return undefined;
      const d = turf.nearestPointOnLine(s.line, p, { units: 'meters' }).properties.location ?? 0;
      const a = turf.along(s.line, Math.max(0, d - 1), { units: 'meters' }), b = turf.along(s.line, Math.min(len, d + 1), { units: 'meters' });
      return brg(a, b);
    };
    s.nodes.forEach((n, i) => points.push({ p: n.p, label: i === 0 || i === s.nodes.length - 1 ? `Join the end of ${s.name}` : `Join ${s.name} here`, ref: { type: 'node', id: s.id, index: i }, dir: tangent(n.p) }));
    if (len > 4) {
      const at = (d: number) => turf.along(s.line, Math.max(0, Math.min(len, d)), { units: 'meters' }).geometry.coordinates;
      const start = s.nodes[0].p, end = s.nodes[s.nodes.length - 1].p;
      const bs = brg(at(2), start), be = brg(at(len - 2), end);
      guides.push({ p: start, bearing: bs, label: `Line of ${s.name}` }, { p: end, bearing: be, label: `Line of ${s.name}` });
      guides.push({ p: start, bearing: bs + 90, both: true, label: `Square to ${s.name}` }, { p: end, bearing: be + 90, both: true, label: `Square to ${s.name}` });
      s.nodes.slice(1, -1).forEach((n) => {
        const near = turf.nearestPointOnLine(s.line, n.p, { units: 'meters' });
        const d = near.properties.location ?? 0;
        guides.push({ p: n.p, bearing: brg(at(d - 1), at(d + 1)) + 90, both: true, label: `Square to ${s.name}` });
      });
    }
    lines.push({ coords: s.line.geometry.coordinates, label: `New junction on ${s.name}`, ref: { type: 'street', id: s.id } });
  }
  const land = streetLand(S.plan.streets.filter((x) => !ex.has(x.id)));
  if (land) for (const r of ringsOf(land)) lines.push({ coords: r, label: 'Kerb', ref: { type: 'kerb' } });
  // Straight edges (the red line, blocks) carry on as guides beyond their corners.
  const edgeGuides = (ring: Position[], name: string) => {
    if (ring.length > 40) return;
    for (let i = 0; i < ring.length - 1; i++) if (turf.distance(ring[i], ring[i + 1], { units: 'meters' }) > 3) guides.push({ p: ring[i], bearing: brg(ring[i], ring[i + 1]), both: true, label: `Line of ${name}` });
  };
  if (S.red) for (const r of ringsOf(S.red)) {
    r.slice(0, -1).forEach((p) => points.push({ p, label: 'Red line corner' }));
    lines.push({ coords: r, label: 'Red line' });
    edgeGuides(r, 'the red line');
  }
  for (const o of S.plan.open) {
    if (ex.has(o.id)) continue;
    o.nodes.forEach((n) => points.push({ p: n.p, label: `Corner of ${o.name}` }));
    lines.push({ coords: o.shape.geometry.coordinates[0], label: `Edge of ${o.name}` });
  }
  for (const b of S.blocks) {
    if (ex.has(b.id)) continue;
    b.shape.geometry.coordinates[0].slice(0, -1).forEach((p) => points.push({ p, label: `Corner of ${b.name}` }));
    edgeGuides(b.shape.geometry.coordinates[0], b.name);
    lines.push({ coords: b.shape.geometry.coordinates[0], label: `Edge of ${b.name}` });
  }
  return { points, lines, guides };
}

/** Anchors or handles moved on the map: the streets, spaces and blocks follow, and homes are laid out again. */
function applyPenEdit(changed: Map<string, PenNode[]>, snap: Snap | null, grabbed: { id: string; index: number } | null) {
  const moved: Street[] = [];
  let blocks = false;
  for (const [id, nodes] of changed) {
    const s = S.plan.streets.find((x) => x.id === id);
    if (s) {
      setStreetNodes(s, s.roundabout ? [nodes[0]] : nodes);
      moved.push(s);
      continue;
    }
    const o = S.plan.open.find((x) => x.id === id);
    if (o) {
      setOpenNodes(o, nodes);
      clearHomesUnder(o.shape, true);
      continue;
    }
    const b = S.blocks.find((x) => x.id === id);
    if (b) {
      b.nodes = cloneNodes(nodes);
      b.shape = turf.polygon([bezierPath(nodes, true)]) as Feature<Polygon>;
      blocks = true;
    }
  }
  // A street point dropped part way along another street makes a junction there.
  if (snap && grabbed && S.plan.streets.some((x) => x.id === grabbed.id)) joinAt(snap.p, snap);
  for (const s of moved) if (!s.roundabout) relineStreet(s);
  if (blocks) renderBlocks();
  renderPlan();
}

const blockNodes = (b: Block) => b.nodes ?? b.shape.geometry.coordinates[0].slice(0, -1).map((p) => penNode(p));

/** In masterplan mode (plan and 3D), every street's nodes can be dragged; the selected item shows its handles. */
function updateEditables() {
  pen.invalidate();
  if (!mpModeOn || mpPick || (S.view !== 'plan' && S.view !== '3d')) return pen.setEditables([]); // a pick wants plain clicks
  const list: Editable[] = S.plan.streets.map((s) => ({ id: s.id, nodes: s.nodes, closed: false, handles: s.id === S.mpSel && !s.roundabout, kind: s.roundabout ? 'roundabout' : 'street', minNodes: s.roundabout ? 1 : 2 }));
  const o = S.plan.open.find((x) => x.id === S.mpSel);
  if (o) list.push({ id: o.id, nodes: o.nodes, closed: true, handles: true, kind: 'open', minNodes: 3 });
  const b = S.blocks.find((x) => x.id === S.blockSel);
  if (b) list.push({ id: b.id, nodes: blockNodes(b), closed: true, handles: true, kind: 'block', minNodes: 3 });
  pen.setEditables(list);
}

// Figure-ground base: white ground, pale streets, blue water, grey buildings.
function styleBase() {
  for (const l of map.getStyle()!.layers ?? []) {
    const id = l.id;
    try {
      if (l.type === 'symbol' && /poi|transit|airport|natural|water-point|settlement-subdivision|waterway-label|water-line-label/.test(id)) map.setLayoutProperty(id, 'visibility', 'none');
      if (l.type === 'background') map.setPaintProperty(id, 'background-color', '#ffffff');
      if ((id === 'land' || id === 'landcover') && l.type === 'fill') map.setPaintProperty(id, 'fill-color', '#ffffff');
      if (/^(landuse|national-park)/.test(id) && l.type === 'fill') map.setPaintProperty(id, 'fill-color', '#f1f3ee');
      if (/^(water|waterway)/.test(id)) map.setPaintProperty(id, l.type === 'fill' ? 'fill-color' : 'line-color', '#bcd5e9');
      if (l.type === 'line' && /^(road|bridge|tunnel)/.test(id) && !/label/.test(id)) map.setPaintProperty(id, 'line-color', /path|steps|pedestrian/.test(id) ? '#e2e2e2' : '#ebebeb');
      if (l.type === 'line' && /case/.test(id)) map.setPaintProperty(id, 'line-color', '#e3e3e3');
      if (id === 'building') map.setPaintProperty(id, 'fill-color', '#cfcfcf');
      if (id === 'building-outline' || id === 'building-underground') map.setLayoutProperty(id, 'visibility', 'none');
    } catch { /* layer without that property */ }
  }
}

const growExpr = (prop: string, T: number): any => [
  '*', ['get', prop],
  ['let', 'f', ['min', 1, ['max', 0, ['/', ['-', T, ['*', ['get', 'd'], 0.65]], 0.35]]], ['*', ['var', 'f'], ['var', 'f'], ['-', 3, ['*', 2, ['var', 'f']]]]],
];

function addLayers() {
  styleBase();
  map.setFog(null as any); // fog greys out the pitched views; drawings want a clean white ground
  for (const id of ['mask', 'red', 'study', 'walk', 'walkpt', 'model', 'pois', 'selected', 'massing', 'blocks', 'contours', 'section-line', 'imd', 'atlas-labels', 'mp-streets', 'mp-land', 'mp-islands', 'mp-open', 'mp-homes', 'mp-plots', 'mp-gardens', 'mp-sk-lines', 'mp-sk-hatch', 'mp-paper', 'mp-trees', 'mp-clear']) map.addSource(id, { type: 'geojson', data: empty });

  // Sketch mode lays paper over the base map, under everything Ultrahand draws.
  (map.getSource('mp-paper') as mapboxgl.GeoJSONSource).setData(turf.bboxPolygon([-179, -85, 179, 85]));
  map.addLayer({ id: 'mp-paper', type: 'fill', source: 'mp-paper', layout: { visibility: 'none' }, paint: { 'fill-color': '#f8f4eb', 'fill-opacity': 0.62 } });
  // Cleared areas: plain ground over the base map's roads, paths and buildings there.
  map.addLayer({ id: 'mp-clear', type: 'fill', source: 'mp-clear', paint: { 'fill-color': '#ffffff', 'fill-opacity': 1 } });
  for (const d of DATASETS) {
    map.addSource(`ds-${d.id}`, { type: 'geojson', data: empty });
    if (d.kind === 'fill') {
      const color: any = d.id === 'flood-risk-zone' ? ['match', ['to-string', ['get', 'flood-risk-level']], '3', '#1f5fc4', '#7fb2f0'] : d.color;
      map.addLayer({ id: `ds-${d.id}-f`, type: 'fill', source: `ds-${d.id}`, paint: { 'fill-color': color, 'fill-opacity': 0.08 } });
      map.addLayer({ id: `ds-${d.id}-l`, type: 'line', source: `ds-${d.id}`, paint: { 'line-color': color, 'line-width': 1.5, 'line-dasharray': [3, 2] } });
    }
  }
  map.addSource('rofsw', { type: 'raster', tiles: [ROFSW_TILES], tileSize: 256, attribution: 'Surface water: © Environment Agency' });
  map.addLayer({ id: 'rofsw', type: 'raster', source: 'rofsw', layout: { visibility: 'none' }, paint: { 'raster-opacity': 0.7 } });
  if (WORKER_BASE) {
    map.addSource('parcels', { type: 'raster', tiles: [`${WORKER_BASE}/inspire-parcels?bbox={bbox-epsg-3857}`], tileSize: 256, minzoom: 15, attribution: 'Parcels: © HM Land Registry' });
    map.addLayer({ id: 'parcels', type: 'raster', source: 'parcels', layout: { visibility: 'none' }, paint: { 'raster-opacity': 0.85 } });
  }
  map.addLayer({ id: 'imd-fill', type: 'fill', source: 'imd', layout: { visibility: 'none' }, paint: { 'fill-color': ['match', ['get', 'decile'], ...IMD_COLOURS.slice(1).flatMap((c, i) => [i + 1, c]), '#e4e3df'] as any, 'fill-opacity': 0.45 } });
  map.addLayer({ id: 'imd-line', type: 'line', source: 'imd', layout: { visibility: 'none' }, paint: { 'line-color': '#6d1a36', 'line-width': 0.8, 'line-opacity': 0.6 } });
  map.addLayer({ id: 'mask', type: 'fill', source: 'mask', paint: { 'fill-color': '#ffffff', 'fill-opacity': 0.55 } });
  map.addLayer({ id: 'walk', type: 'line', source: 'walk', paint: { 'line-color': '#f08a1c', 'line-width': ['match', ['get', 'contour'], 5, 1.6, 10, 1.3, 1], 'line-dasharray': [1, 2] } });
  map.addLayer({
    id: 'walkpt', type: 'line', source: 'walkpt', filter: ['<=', ['get', 'd'], 0],
    layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: { 'line-color': walkColourExpr(), 'line-width': ['interpolate', ['linear'], ['zoom'], 14, ['match', ['get', 'band'], 5, 1.8, 10, 1.2, 0.9], 18, ['match', ['get', 'band'], 5, 4.5, 10, 3, 2.2]] },
  });
  map.addLayer({ id: 'contours', type: 'line', source: 'contours', layout: { visibility: 'none' }, paint: { 'line-color': '#a8875a', 'line-width': ['case', ['get', 'major'], 1.4, 0.6], 'line-opacity': 0.85 } }, 'mask');
  map.addLayer({ id: 'section-line', type: 'line', source: 'section-line', paint: { 'line-color': '#141414', 'line-width': 2, 'line-dasharray': [4, 2] } });
  map.addLayer({ id: 'study-line', type: 'line', source: 'study', paint: { 'line-color': '#141414', 'line-width': 1.1, 'line-dasharray': [7, 3, 1, 3] } });
  map.addLayer({ id: 'red-fill', type: 'fill', source: 'red', paint: { 'fill-color': '#d7262e', 'fill-opacity': 0.06 } });
  // Masterplan ground: open space, then street corridors over it, then centrelines.
  // Masterplan ground: gardens and plots, open space, then the streets, drawn at the widths the base
  // map gives its own streets (so they sit with the streets around them) over a faint outline of the
  // land the streets take.
  map.addLayer({ id: 'mp-gardens', type: 'fill', source: 'mp-gardens', paint: { 'fill-color': '#e3ecd8', 'fill-opacity': 0.9 } });
  map.addLayer({ id: 'mp-plots', type: 'line', source: 'mp-plots', minzoom: 15.5, paint: { 'line-color': '#b9b8b2', 'line-width': 0.6 } });
  map.addLayer({ id: 'mp-open-f', type: 'fill', source: 'mp-open', paint: { 'fill-color': ['get', 'colour'], 'fill-opacity': 0.75 } });
  map.addLayer({ id: 'mp-open-l', type: 'line', source: 'mp-open', paint: { 'line-color': ['case', ['get', 'selected'], '#2433e0', ['get', 'colour']], 'line-width': ['case', ['get', 'selected'], 2.5, 1] } });
  map.addLayer({ id: 'mp-land', type: 'line', source: 'mp-land', minzoom: 15.5, paint: { 'line-color': '#c9c8c3', 'line-width': 0.7, 'line-dasharray': [3, 2] } });
  const baseW = (id: string, fallback: any) => {
    try {
      return map.getPaintProperty(id, 'line-width') ?? fallback;
    } catch {
      return fallback;
    }
  };
  const streetW = baseW('road-simple', ['interpolate', ['exponential', 1.5], ['zoom'], 13, ['match', ['get', 'class'], 'primary', 2.4, 'street', 0.6, 'street_limited', 0.6, 0.3], 18, ['match', ['get', 'class'], 'primary', 19.2, 'street', 10.8, 'street_limited', 10.8, 6], 22, ['match', ['get', 'class'], 'primary', 192, 'street', 108, 'street_limited', 108, 60]]);
  const pathW = baseW('road-path', ['interpolate', ['exponential', 1.5], ['zoom'], 13, 0.5, 14, 1, 15, 1, 18, 4]);
  // Zoom-based widths can't sit inside a "case", so the selected outline is two layers.
  const round = { 'line-cap': 'round', 'line-join': 'round' } as const;
  map.addLayer({ id: 'mp-street-sel', type: 'line', source: 'mp-streets', filter: ['all', ['get', 'selected'], ['!', ['get', 'path']]], layout: round, paint: { 'line-color': '#2433e0', 'line-width': 2.5, 'line-gap-width': streetW } });
  map.addLayer({ id: 'mp-path-sel', type: 'line', source: 'mp-streets', filter: ['all', ['get', 'selected'], ['get', 'path']], layout: round, paint: { 'line-color': '#2433e0', 'line-width': 2.5, 'line-gap-width': pathW } });
  // A thin kerb line either side, so the proposed streets read on the site's tint.
  map.addLayer({ id: 'mp-street-case', type: 'line', source: 'mp-streets', filter: ['!', ['get', 'path']], layout: round, paint: { 'line-color': '#c4c3be', 'line-width': 0.8, 'line-gap-width': streetW } });
  map.addLayer({ id: 'mp-street', type: 'line', source: 'mp-streets', filter: ['!', ['get', 'path']], layout: round, paint: { 'line-color': '#ffffff', 'line-width': streetW } });
  map.addLayer({ id: 'mp-path', type: 'line', source: 'mp-streets', filter: ['get', 'path'], layout: round, paint: { 'line-color': '#ffffff', 'line-width': pathW } });
  map.addLayer({ id: 'mp-islands', type: 'fill', source: 'mp-islands', paint: { 'fill-color': '#d3e2c4' } });
  // Sketch: flat washed homes in plan (extrusions would hide the pencil lines), hatching, then pencil.
  map.addLayer({ id: 'mp-homes-flat', type: 'fill', source: 'mp-homes', filter: ['==', ['get', 'base'], 0], layout: { visibility: 'none' }, paint: { 'fill-color': ['case', ['get', 'selected'], '#9aa3ff', ['get', 'wash']] as any, 'fill-opacity': 0.9 } });
  const pencilW: any = ['interpolate', ['exponential', 1.6], ['zoom'], 14, ['*', ['get', 'w'], 0.35], 17, ['*', ['get', 'w'], 0.9], 20, ['*', ['get', 'w'], 2.2]];
  map.addLayer({ id: 'mp-trees-flat', type: 'fill', source: 'mp-trees', filter: ['get', 'flat'], layout: { visibility: 'none' }, paint: { 'fill-color': ['case', ['get', 'selected'], '#9aa3ff', ['get', 'wash']] as any, 'fill-opacity': 0.8 } });
  map.addLayer({ id: 'mp-sk-hatch', type: 'line', source: 'mp-sk-hatch', layout: { visibility: 'none', 'line-cap': 'round' }, paint: { 'line-color': ['get', 'c'], 'line-width': pencilW, 'line-opacity': ['get', 'o'] } });
  map.addLayer({ id: 'mp-sk-lines', type: 'line', source: 'mp-sk-lines', layout: { visibility: 'none', 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': ['get', 'c'], 'line-width': pencilW, 'line-opacity': ['get', 'o'] } });
  map.addLayer({ id: 'red-line', type: 'line', source: 'red', paint: { 'line-color': '#d7262e', 'line-width': 3 } });
  map.addLayer({ id: 'selected-line', type: 'line', source: 'selected', paint: { 'line-color': '#2433e0', 'line-width': 3 } });

  map.addLayer({
    id: 'context-3d', type: 'fill-extrusion', source: 'composite', 'source-layer': 'building', minzoom: 14,
    filter: ['==', ['get', 'extrude'], 'true'],
    layout: { visibility: 'none' },
    paint: { 'fill-extrusion-color': '#ecebe7', 'fill-extrusion-height': ['get', 'height'], 'fill-extrusion-base': ['get', 'min_height'], 'fill-extrusion-opacity': 0.92 },
  });
  map.addLayer({ id: 'model-3d', type: 'fill-extrusion', source: 'model', paint: { 'fill-extrusion-height': ['get', 'h'], 'fill-extrusion-base': ['get', 'minH'], 'fill-extrusion-opacity': 0.97 } });
  map.addLayer({ id: 'blocks-3d', type: 'fill-extrusion', source: 'blocks', paint: { 'fill-extrusion-color': ['get', 'colour'], 'fill-extrusion-height': ['get', 'top'], 'fill-extrusion-base': ['get', 'base'], 'fill-extrusion-opacity': 0.9 } });
  map.addLayer({ id: 'blocks-line', type: 'line', source: 'blocks', paint: { 'line-color': ['case', ['get', 'selected'], '#141414', ['get', 'colour']], 'line-width': ['case', ['get', 'selected'], 3, 1.5] } });
  map.addLayer({ id: 'mp-trees-3d', type: 'fill-extrusion', source: 'mp-trees', filter: ['!', ['get', 'flat']], paint: { 'fill-extrusion-color': ['case', ['get', 'selected'], '#2433e0', ['get', 'colour']], 'fill-extrusion-height': ['get', 'top'], 'fill-extrusion-base': ['get', 'base'], 'fill-extrusion-opacity': 0.95 } });
  map.addLayer({ id: 'mp-homes-3d', type: 'fill-extrusion', source: 'mp-homes', paint: { 'fill-extrusion-color': ['case', ['get', 'selected'], '#2433e0', ['get', 'colour']], 'fill-extrusion-height': ['get', 'top'], 'fill-extrusion-base': ['get', 'base'], 'fill-extrusion-opacity': 0.95 } });
  map.addLayer({ id: 'massing-3d', type: 'fill-extrusion', source: 'massing', paint: { 'fill-extrusion-color': '#e6262e', 'fill-extrusion-height': ['get', 'h'], 'fill-extrusion-opacity': 0.75 } });

  map.addLayer({
    id: 'ds-listed', type: 'circle', source: 'ds-listed-building',
    paint: { 'circle-radius': ['interpolate', ['linear'], ['zoom'], 14, 2.5, 18, 6], 'circle-color': ['match', ['get', 'listed-building-grade'], 'I', '#3b1066', 'II*', '#6a32a0', '#a57cc9'], 'circle-stroke-color': '#fff', 'circle-stroke-width': 1 },
  });
  map.addLayer({ id: 'ds-brownfield', type: 'circle', source: 'ds-brownfield-land', paint: { 'circle-radius': 5, 'circle-color': '#a0522d', 'circle-opacity': 0.8, 'circle-stroke-color': '#fff', 'circle-stroke-width': 1 } });
  map.addLayer({
    id: 'pois', type: 'circle', source: 'pois',
    paint: {
      'circle-radius': ['match', ['get', 'cat'], 'rail', 6, 'bus', 3, 3.5],
      'circle-color': ['match', ['get', 'cat'], 'rail', '#141414', 'bus', '#555', 'shop', '#f08a1c', 'school', '#2b7bb9', 'health', '#c0392b', 'park', '#3f8f3f', '#888'],
      'circle-stroke-color': '#fff', 'circle-stroke-width': 1.2,
    },
  });
  const font = ['DIN Pro Medium', 'Arial Unicode MS Regular'];
  map.addLayer({ id: 'pois-label', type: 'symbol', source: 'pois', filter: ['==', ['get', 'cat'], 'rail'], layout: { 'text-field': ['get', 'name'], 'text-size': 11, 'text-offset': [0, 1.1], 'text-anchor': 'top', 'text-font': font }, paint: { 'text-color': '#141414', 'text-halo-color': '#fff', 'text-halo-width': 1.5 } });
  map.addLayer({ id: 'atlas-labels', type: 'symbol', source: 'atlas-labels', layout: { 'text-field': ['get', 'text'], 'text-size': 10.5, 'text-anchor': 'top', 'text-font': font, 'text-letter-spacing': 0.06, 'text-allow-overlap': true }, paint: { 'text-color': '#141414' } });

  // Walking lines run along the drawn streets too, so they sit above the masterplan streets (under the homes).
  if (map.getLayer('mp-homes-flat')) map.moveLayer('walkpt', 'mp-homes-flat');
  pen.addLayers();
  unlitFlatLayers();
  setModelColours();
  applySun();
  applyVisibility();
  restoreProject();
}

/** Mapbox v3 lights also dim flat layers; keep the ground, lines and labels at full brightness so only buildings take light. */
function unlitFlatLayers() {
  const props: Record<string, string[]> = {
    background: ['background-emissive-strength'],
    fill: ['fill-emissive-strength'],
    line: ['line-emissive-strength'],
    circle: ['circle-emissive-strength'],
    symbol: ['icon-emissive-strength', 'text-emissive-strength'],
  };
  for (const l of map.getStyle()?.layers ?? [])
    for (const prop of props[l.type] ?? [])
      try {
        map.setPaintProperty(l.id, prop as any, 1);
      } catch { /* not supported on this layer */ }
}

map.on('style.load', () => {
  addLayers();
  setTimeout(() => { if (map.getSource('refimg')) refShow(); else loadRef(); }, 0);
  map.setCamera({ 'camera-projection': 'orthographic' });
});

/** Plan reads as figure-ground (black buildings); the 3D views read as a white model. */
function setModelColours() {
  if (!map.getLayer('model-3d')) return;
  const sel = ['boolean', ['feature-state', 'selected'], false], hov = ['boolean', ['feature-state', 'hover'], false];
  const plan = S.view === 'plan' || S.view === 'atlas';
  const atlas = S.view === 'atlas';
  const listedOn = S.visible.has('listed-building');
  map.setPaintProperty('model-3d', 'fill-extrusion-color', [
    'case',
    sel, '#2433e0',
    hov, plan ? '#4d58f0' : '#9aa3ff',
    ['all', ['get', 'listed'], listedOn], plan ? '#5d3d7d' : '#c9b2de',
    ['get', 'inSite'], atlas ? '#d7262e' : plan ? '#1a1a1a' : '#f1b2b5',
    ['get', 'inStudy'], plan ? '#232323' : '#ffffff',
    plan ? '#c9c9c9' : '#e3e2dd',
  ] as any);
}

// ---------------------------------------------------------------- search
let searchT = 0;
const searchBox = $<HTMLInputElement>('#search');
searchBox.addEventListener('input', () => {
  clearTimeout(searchT);
  const q = searchBox.value.trim();
  $('#clearSearch').hidden = !searchBox.value;
  if (q.length < 3) return void ($('#results').innerHTML = '');
  searchT = window.setTimeout(async () => {
    const r = await fetch(`https://api.mapbox.com/search/geocode/v6/forward?q=${encodeURIComponent(q)}&country=gb&autocomplete=true&limit=6&access_token=${TOKEN}`);
    const j = await r.json();
    $('#results').innerHTML = (j.features ?? [])
      .map((f: any, i: number) => `<li data-i="${i}">${esc(f.properties.name)}<small>${esc(f.properties.place_formatted ?? '')}</small></li>`)
      .join('');
    $('#results').querySelectorAll('li').forEach((li) =>
      li.addEventListener('click', () => {
        const f = j.features[+li.dataset.i!];
        map.flyTo({ center: f.geometry.coordinates, zoom: 17.2, pitch: 0, bearing: 0 });
        S.place = f.properties.context?.place?.name ?? f.properties.name;
        searchBox.value = f.properties.name;
        $('#results').innerHTML = '';
      }),
    );
  }, 250);
});
$('#clearSearch').onclick = () => {
  searchBox.value = '';
  $('#results').innerHTML = '';
  $('#clearSearch').hidden = true;
  searchBox.focus();
};

$('#example').onclick = () => {
  resetAll(false);
  setRed(turf.polygon([[[-2.25668, 53.47735], [-2.25545, 53.47783], [-2.25492, 53.47729], [-2.25611, 53.47683], [-2.25668, 53.47735]]]) as PolyF);
  S.place = 'Castlefield, Manchester';
  searchBox.value = S.place;
  map.fitBounds(turf.bbox(S.study!) as any, { padding: 60, pitch: 0, bearing: 0, duration: 800 });
};
$('#reset').onclick = () => resetAll(true);

// ---------------------------------------------------------------- drawing
function startDraw(kind: 'red' | 'study' | 'massing' | 'open') {
  draw.deleteAll();
  S.drawing = kind;
  if (S.view !== 'plan') setView('plan');
  draw.changeMode('draw_polygon');
  $('#redHint').textContent = 'Click each corner. Double-click (or click the first corner) to finish.';
}
$('#drawRed').onclick = () => startDraw('red');
$('#drawStudy').onclick = () => startDraw('study');
$('#drawBlock').onclick = () =>
  penDraw('massing', true, (nodes) => {
    const nb = newBlock(turf.polygon([bezierPath(nodes, true)]) as Feature<Polygon>, S.blocks);
    (nb as any).nodes = nodes;
    S.blocks.push(nb);
    S.blockSel = nb.id;
    renderBlocks();
  }, 'Click each corner of the block; drag to curve. Click the first corner or press Enter to finish.');
$('#editRed').onclick = () => {
  if (!S.red) return;
  draw.deleteAll();
  S.drawing = 'red';
  const [id] = draw.add(S.red as any);
  draw.changeMode('direct_select', { featureId: id });
  $('#redHint').textContent = 'Drag a corner to move it. Click the map outside the shape when done.';
};
$('#clearRed').onclick = () => setRed(null);

// ---- quick box: drag a rectangle on the map as the study area, no red line needed
function setStudyMode(mode: typeof S.studyMode) {
  S.studyMode = mode;
  document.querySelectorAll<HTMLElement>('#studyMode button').forEach((x) => x.classList.toggle('on', x.dataset.mode === mode));
  document.querySelectorAll<HTMLElement>('[data-for]').forEach((el) => (el.hidden = el.dataset.for !== mode));
}
let boxStart: mapboxgl.LngLat | null = null;
function startBox() {
  draw.deleteAll();
  setStudyMode('box');
  if (S.view !== 'plan') setView('plan');
  S.drawing = 'box';
  map.dragPan.disable();
  map.getCanvas().style.cursor = 'crosshair';
  toast('Drag on the map to draw the study area.');
}
const boxOf = (a: mapboxgl.LngLat, b: mapboxgl.LngLat) =>
  turf.bboxPolygon([Math.min(a.lng, b.lng), Math.min(a.lat, b.lat), Math.max(a.lng, b.lng), Math.max(a.lat, b.lat)]) as PolyF;
function boxSize(f: PolyF) {
  const [w, s, e, n] = turf.bbox(f);
  const wide = turf.distance([w, s], [e, s], { units: 'meters' }), tall = turf.distance([w, s], [w, n], { units: 'meters' });
  return `${Math.round(wide)} × ${Math.round(tall)} m`;
}
$('#quickBox').onclick = startBox;
$('#drawBox').onclick = startBox;
const boxDown = (e: mapboxgl.MapMouseEvent | mapboxgl.MapTouchEvent) => {
  if (S.drawing !== 'box') return;
  e.preventDefault();
  boxStart = e.lngLat;
};
const boxMove = (e: mapboxgl.MapMouseEvent | mapboxgl.MapTouchEvent) => {
  if (S.drawing !== 'box' || !boxStart) return;
  (map.getSource('study') as mapboxgl.GeoJSONSource).setData(boxOf(boxStart, e.lngLat));
};
const boxUp = (e: mapboxgl.MapMouseEvent | mapboxgl.MapTouchEvent) => {
  if (S.drawing !== 'box' || !boxStart) return;
  const f = boxOf(boxStart, e.lngLat);
  boxStart = null;
  lastDrawEnd = Date.now();
  map.dragPan.enable();
  map.getCanvas().style.cursor = '';
  // A click without a drag leaves the tool on; anything under 20 m is treated as that.
  if (turf.area(f) < 400) return;
  S.drawing = null;
  S.drawnBox = f;
  updateStudy();
};
map.on('mousedown', boxDown);
map.on('touchstart', boxDown);
map.on('mousemove', boxMove);
map.on('touchmove', boxMove);
map.on('mouseup', boxUp);
map.on('touchend', boxUp);
window.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape' || S.drawing !== 'box') return;
  S.drawing = null;
  boxStart = null;
  map.dragPan.enable();
  map.getCanvas().style.cursor = '';
  updateStudy();
});

function finishDraw() {
  const f = draw.getAll().features[0] as PolyF | undefined;
  if (!f || f.geometry.type !== 'Polygon' || f.geometry.coordinates[0].length < 4) return;
  const clean = turf.polygon(f.geometry.coordinates) as PolyF;
  if (S.drawing === 'red') setRed(clean);
  else if (S.drawing === 'study') ((S.drawnStudy = clean), updateStudy());
  else if (S.drawing === 'massing') {
    const shape = clean as Feature<Polygon>;
    const b = editingBlock ? S.blocks.find((x) => x.id === editingBlock) : null;
    if (b) b.shape = shape;
    else {
      const nb = newBlock(shape, S.blocks);
      S.blocks.push(nb);
      S.blockSel = nb.id;
    }
    renderBlocks();
  }
}
map.on('draw.create', () => {
  lastDrawEnd = Date.now();
  finishDraw();
  draw.deleteAll();
  S.drawing = null;
});
map.on('draw.update', finishDraw);
map.on('draw.modechange', (e: any) => {
  if (e.mode === 'simple_select' && S.drawing && S.drawing !== 'box') {
    finishDraw();
    draw.deleteAll();
    S.drawing = null;
  }
});

$<HTMLInputElement>('#importRed').onchange = async (e) => {
  const input = e.target as HTMLInputElement;
  const file = input.files?.[0];
  if (!file) return;
  const text = await file.text();
  input.value = '';
  let poly: PolyF | null = null;
  if (file.name.toLowerCase().endsWith('.kml')) {
    const doc = new DOMParser().parseFromString(text, 'text/xml');
    const c = doc.querySelector('Polygon outerBoundaryIs coordinates, Polygon coordinates')?.textContent?.trim();
    if (c) {
      const ring = c.split(/\s+/).map((t) => t.split(',').slice(0, 2).map(Number));
      if (ring.length > 3) poly = turf.polygon([ring]) as PolyF;
    }
  } else {
    const j = JSON.parse(text);
    const feats: Feature[] = j.type === 'FeatureCollection' ? j.features : j.type === 'Feature' ? [j] : [{ type: 'Feature', geometry: j, properties: {} }];
    poly = (feats.find((f) => f.geometry?.type === 'Polygon' || f.geometry?.type === 'MultiPolygon') as PolyF) ?? null;
  }
  if (!poly) return alert('No polygon found in that file.');
  setRed(poly);
  map.fitBounds(turf.bbox(S.study ?? poly) as any, { padding: 60 });
};

function setRed(f: PolyF | null) {
  S.red = f;
  if (f && Allto && !takingIn && isPrimarySite()) {
    const ring = f.geometry.type === 'Polygon' ? f.geometry.coordinates[0] : f.geometry.coordinates[0][0];
    Allto.update({ redLine: ring }, PRODUCT);
  }
  (map.getSource('red') as mapboxgl.GeoJSONSource)?.setData(f ?? empty);
  $<HTMLButtonElement>('#editRed').disabled = !f;
  $<HTMLButtonElement>('#clearRed').disabled = !f;
  $('#redStat').textContent = f ? `Red line ${fmtArea(turf.area(f))} · perimeter ${fmtDist(turf.length(turf.polygonToLine(f as any) as any, { units: 'meters' }))}` : '';
  $('#redHint').textContent = f ? 'Red line drawn. Set the study area, then analyse.' : 'Click each corner of the site boundary. Double-click to finish.';
  updateMassing();
  updateStudy();
  saveProject();
}

$<HTMLInputElement>('#massing').oninput = (e) => {
  S.massing = Math.max(0, +(e.target as HTMLInputElement).value || 0);
  updateMassing();
};
function updateMassing() {
  (map.getSource('massing') as mapboxgl.GeoJSONSource | undefined)?.setData(S.red && S.massing > 0 ? { ...S.red, properties: { h: S.massing } } : empty);
}

// ---------------------------------------------------------------- massing (proposed blocks)
let editingBlock: string | null = null;
let blockMarkers: mapboxgl.Marker[] = [];

let blocksQueued = false;
function renderBlocksSoon() {
  if (blocksQueued) return;
  blocksQueued = true;
  setTimeout(() => ((blocksQueued = false), renderBlocks()), 0);
}

function renderBlocks() {
  (map.getSource('blocks') as mapboxgl.GeoJSONSource | undefined)?.setData(blocksGeoJSON(S.blocks, S.blockSel));
  updateEditables();
  if (S.sketch) renderPlanMap();
  blockMarkers.forEach((m) => m.remove());
  blockMarkers = S.blocks.map((b) => {
    const el = document.createElement('span');
    el.className = 'block-ref';
    el.textContent = `${b.name} · ${b.storeys} storeys`;
    return new mapboxgl.Marker({ element: el }).setLngLat(turf.centroid(b.shape).geometry.coordinates as [number, number]).addTo(map);
  });
  if (S.view === 'atlas') blockMarkers.forEach((m) => (m.getElement().style.display = 'none'));
  $('#blockList').innerHTML = S.blocks
    .map(
      (b) => `<div class="blk${b.id === S.blockSel ? ' on' : ''}" data-b="${b.id}">
        <div class="blk-top"><span class="sw" style="background:${useOf(b.use).colour}"></span><input class="blk-name" value="${esc(b.name)}" aria-label="Block name">
          <button class="link" data-act="edit">Edit shape</button><button class="link" data-act="del">Delete</button></div>
        <div class="blk-row">
          <select data-f="use" aria-label="Use">${USES.map((u) => `<option value="${u.id}"${u.id === b.use ? ' selected' : ''}>${u.label}</option>`).join('')}</select>
          <label>Storeys <input data-f="storeys" type="number" min="1" max="80" value="${b.storeys}"></label>
          <label>From <input data-f="baseM" type="number" min="0" max="200" step="0.5" value="${b.baseM}"> m</label>
        </div>
        <p class="blk-meta">${m2(footprintOf(b))} footprint · ${m2(giaOf(b))} floor area · ${heightOf(b).toFixed(1)} m tall</p>
      </div>`,
    )
    .join('');
  $('#blockList').querySelectorAll<HTMLElement>('.blk').forEach((row) => {
    const b = S.blocks.find((x) => x.id === row.dataset.b)!;
    row.addEventListener('click', () => {
      if (S.blockSel !== b.id) ((S.blockSel = b.id), renderBlocksSoon());
    });
    row.querySelector<HTMLInputElement>('.blk-name')!.addEventListener('change', (e) => ((b.name = (e.target as HTMLInputElement).value || b.name), renderBlocksSoon()));
    row.querySelectorAll<HTMLInputElement | HTMLSelectElement>('[data-f]').forEach((el) =>
      el.addEventListener('change', () => {
        const f = el.dataset.f!;
        if (f === 'use') b.use = el.value as Use;
        else if (f === 'storeys') b.storeys = Math.max(1, Math.min(80, Math.round(+el.value || 1)));
        else if (f === 'baseM') b.baseM = Math.max(0, +el.value || 0);
        renderBlocksSoon();
      }),
    );
    row.querySelector('[data-act=del]')!.addEventListener('click', (e) => {
      e.stopPropagation();
      S.blocks = S.blocks.filter((x) => x !== b);
      if (S.blockSel === b.id) S.blockSel = null;
      renderBlocksSoon();
    });
    row.querySelector('[data-act=edit]')!.addEventListener('click', (e) => {
      e.stopPropagation();
      if (S.view !== 'plan') setView('plan');
      S.blockSel = b.id;
      renderBlocks();
      toast('Drag its corners. Alt-drag a corner to curve it, double-click an edge to add a corner, Delete removes the one picked.');
    });
  });
  const t = massTotals(S.blocks, S.red, S.assume);
  $('#massTotals').innerHTML = S.blocks.length
    ? `<table class="metrics">
        <tr><th>Floor area (GIA)</th><td>${m2(t.giaM2)}</td></tr>
        ${USES.filter((u) => t.giaByUse[u.id]).map((u) => `<tr><th class="ind"><span class="sw" style="background:${u.colour}"></span>${u.label}</th><td>${m2(t.giaByUse[u.id]!)}</td></tr>`).join('')}
        ${t.homes ? `<tr><th>Homes</th><td>about ${t.homes.toLocaleString('en-GB')}</td></tr>` : ''}
        ${t.dph != null && t.homes ? `<tr><th>Density</th><td>about ${Math.round(t.dph)} homes per hectare</td></tr>` : ''}
        ${t.plotRatio != null ? `<tr><th>Plot ratio</th><td>${t.plotRatio.toFixed(1)}</td></tr>` : ''}
        ${t.coverage != null ? `<tr><th>Site coverage</th><td>${pct(t.coverage)}</td></tr>` : ''}
        <tr><th>Tallest</th><td>${t.tallestM.toFixed(1)} m</td></tr>
      </table>
      <p class="hint">${S.red ? 'Against the red line.' : 'Draw a red line to see density, plot ratio and coverage.'} Homes assume ${Math.round(S.assume.netToGross * 100)}% net to gross and ${S.assume.homeSizeM2} m² homes.</p>`
    : '';
  renderSchedule();
  saveProject();
  agent.contextChanged();
}

const assumeIn = (id: string, get: () => number, set: (v: number) => void) => {
  const el = $<HTMLInputElement>(id);
  el.value = String(get());
  el.onchange = () => (set(+el.value), renderBlocksSoon());
};
assumeIn('#aNtg', () => Math.round(S.assume.netToGross * 100), (v) => (S.assume.netToGross = Math.max(0.5, Math.min(1, v / 100))));
assumeIn('#aHome', () => S.assume.homeSizeM2, (v) => (S.assume.homeSizeM2 = Math.max(25, Math.min(200, v))));

/** A look for the SVG drawings, from a block's use colour. */
function lookForColour(c: string): import('./axo').Look {
  const hex = (h: string) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
  const mixc = (a: string, b: string, t: number) => '#' + hex(a).map((v, i) => Math.round(v + (hex(b)[i] - v) * t).toString(16).padStart(2, '0')).join('');
  return { roof: c, wallLight: mixc(c, '#ffffff', 0.3), wallDark: mixc(c, '#000000', 0.35), stroke: mixc(c, '#000000', 0.55), strokeWidth: 0.7 };
}

// ---------------------------------------------------------------- masterplan: streets, open space, homes
type MpTool = 'streets' | 'open' | 'homes' | 'trees' | 'blocks' | 'ref';
let mpTool: MpTool = 'streets';
let mpPick: null | 'line' | 'place' | 'roundabout' | 'tree' | 'treeline' = null; // waiting for a click on the map
let streetMarkers: mapboxgl.Marker[] = [];

const fillSelect = (sel: string, items: { id: string; label: string }[], value: string) => {
  $<HTMLSelectElement>(sel).innerHTML = items.map((t) => `<option value="${t.id}"${t.id === value ? ' selected' : ''}>${esc(t.label)}</option>`).join('');
};
fillSelect('#stType', STREET_TYPES, 'residential');
fillSelect('#raType', ROUNDABOUTS, 'compact');
fillSelect('#osType', OPEN_TYPES, 'park');
fillSelect('#hoType', HOUSE_TYPES, 'semi');
const stNote = () => {
  const t = streetType($<HTMLSelectElement>('#stType').value as StreetType);
  $('#stNote').textContent = `${t.widthM} m of land: ${t.note}. Drawn like the streets on the base map.`;
};
const hoNote = () => {
  const t = houseType($<HTMLSelectElement>('#hoType').value as HouseTypeId);
  $('#hoNote').textContent = `${t.frontageM} m frontage, ${t.depthM} m deep, ${t.storeys} storey${t.storeys > 1 ? 's' : ''}, ${houseHeight(t).toFixed(1)} m to the ridge${t.homes > 1 ? `, ${t.homes} homes` : ''}; ${t.gapM ? `${t.gapM} m between` : 'joined in a row'}.`;
};
$<HTMLSelectElement>('#stType').onchange = stNote;
$<HTMLSelectElement>('#hoType').onchange = hoNote;
stNote();
hoNote();

function setMpTool(t: MpTool) {
  mpTool = t;
  setPick(null);
  document.querySelectorAll<HTMLButtonElement>('#mpTool button').forEach((b) => b.classList.toggle('on', b.dataset.t === t));
  document.querySelectorAll<HTMLElement>('[data-mp]').forEach((el) => (el.hidden = el.dataset.mp !== t));
  refHandles();
}
document.querySelectorAll<HTMLButtonElement>('#mpTool button').forEach((b) => b.addEventListener('click', () => setMpTool(b.dataset.t as MpTool)));

// ---------------------------------------------------------------- name tags on the plan
function setMpLabels(on: boolean) {
  document.body.classList.toggle('mp-nolabels', !on);
  $<HTMLInputElement>('#mpLabels').checked = on;
  try { localStorage.setItem('ultrahand:mpLabels', on ? '1' : '0'); } catch { /* ignore */ }
}
$<HTMLInputElement>('#mpLabels').addEventListener('change', (e) => setMpLabels((e.target as HTMLInputElement).checked));
try { if (localStorage.getItem('ultrahand:mpLabels') === '0') setMpLabels(false); } catch { /* ignore */ }

// ---------------------------------------------------------------- a drawing to trace, or to draft the masterplan from
// The drawing is laid over the map as an image the user moves, resizes and turns until it lines up.
// Where it sits says where any point on it is on the ground, so a draft read from it (by Claude, through
// the allto Worker's /draft-masterplan) lands in place. Kept per site, beside the site's own data.
interface RefDrawing { src: string; w: number; h: number; c: Position; widthM: number; rot: number; opacity: number; locked: boolean }
let refDrawing: RefDrawing | null = null;
/** The drawing at full size for tracing, while this page is open (the kept copy is a smaller JPEG). */
let refHiRes: string | null = null;
let refMarkers: mapboxgl.Marker[] = [];
const refKey = () => 'ultrahand:ref:' + sitesIdx().current;
const refFrame = (r: RefDrawing) => ({ kx: 111320 * Math.cos((r.c[1] * Math.PI) / 180), ky: 110574 });
/** A point on the drawing (u, v from 0 to 1, from the top left) on the ground. */
function refAt(r: RefDrawing, u: number, v: number): Position {
  const { kx, ky } = refFrame(r), W = r.widthM, H = (r.widthM * r.h) / r.w, a = (r.rot * Math.PI) / 180;
  const x = (u - 0.5) * W, y = (0.5 - v) * H;
  return [r.c[0] + (x * Math.cos(a) + y * Math.sin(a)) / kx, r.c[1] + (-x * Math.sin(a) + y * Math.cos(a)) / ky];
}
type Quad = [[number, number], [number, number], [number, number], [number, number]];
/** Where a point on the ground is on the drawing (u, v from 0 to 1, from the top left). */
function refUV(r: RefDrawing, ll: Position): [number, number] {
  const { kx, ky } = refFrame(r), W = r.widthM, H = (r.widthM * r.h) / r.w, a = (r.rot * Math.PI) / 180;
  const xp = (ll[0] - r.c[0]) * kx, yp = (ll[1] - r.c[1]) * ky;
  const x = xp * Math.cos(a) - yp * Math.sin(a), y = xp * Math.sin(a) + yp * Math.cos(a);
  return [x / W + 0.5, 0.5 - y / H];
}
/** Place the drawing so two points on it land on two points on the map (move, scale and turn). */
function refAlignTo(r: RefDrawing, uv: [number, number][], to: Position[]) {
  const P = uv.map(([u, v]) => [(u - 0.5) * r.w, (0.5 - v) * r.h]); // drawing pixels, y up, from its middle
  const ky = 110574, kx = 111320 * Math.cos((to[0][1] * Math.PI) / 180);
  const Q = to.map((t) => [(t[0] - to[0][0]) * kx, (t[1] - to[0][1]) * ky]); // metres from the first target
  const dp = [P[1][0] - P[0][0], P[1][1] - P[0][1]], dq = [Q[1][0] - Q[0][0], Q[1][1] - Q[0][1]];
  const den = dp[0] * dp[0] + dp[1] * dp[1];
  if (den < 1) return false;
  const zr = (dq[0] * dp[0] + dq[1] * dp[1]) / den, zi = (dq[1] * dp[0] - dq[0] * dp[1]) / den; // q = z p + t
  const t = [Q[0][0] - (zr * P[0][0] - zi * P[0][1]), Q[0][1] - (zr * P[0][1] + zi * P[0][0])];
  r.widthM = Math.hypot(zr, zi) * r.w;
  r.rot = (-Math.atan2(zi, zr) * 180) / Math.PI;
  r.c = [to[0][0] + t[0] / kx, to[0][1] + t[1] / ky];
  return true;
}
let refAlign: null | { uv: [number, number][]; to: Position[]; marks: mapboxgl.Marker[] } = null;
function refAlignMsg() {
  const m = $('#refAlignMsg');
  if (!refAlign) { m.textContent = ''; $('#refAlign').textContent = 'Line up by two points'; return; }
  const k = refAlign.uv.length + refAlign.to.length;
  m.textContent = [
    'Click a point on the drawing you can find on the map, such as a road junction or a building corner.',
    'Now click where that point is on the map.',
    'Click a second point on the drawing, well away from the first.',
    'Now click where that one is on the map.',
  ][k];
  $('#refAlign').textContent = 'Cancel';
}
function refAlignEnd() {
  refAlign?.marks.forEach((m) => m.remove());
  refAlign = null;
  map.getCanvas().style.cursor = '';
  refAlignMsg();
}
$('#refAlign').onclick = () => {
  if (refAlign) return refAlignEnd();
  if (!refDrawing) return;
  if (refDrawing.locked) { refDrawing.locked = false; $<HTMLInputElement>('#refLock').checked = false; }
  refAlign = { uv: [], to: [], marks: [] };
  map.getCanvas().style.cursor = 'crosshair';
  refAlignMsg();
};
map.on('click', (e) => {
  if (!refAlign || !refDrawing) return;
  const ll: Position = [e.lngLat.lng, e.lngLat.lat], onDrawing = refAlign.uv.length === refAlign.to.length;
  const el = document.createElement('div');
  el.className = 'ref-pt' + (onDrawing ? '' : ' on-map');
  el.textContent = String(refAlign.uv.length + (onDrawing ? 1 : 0));
  refAlign.marks.push(new mapboxgl.Marker({ element: el }).setLngLat(e.lngLat).addTo(map));
  if (onDrawing) refAlign.uv.push(refUV(refDrawing, ll));
  else refAlign.to.push(ll);
  if (refAlign.to.length === 2) {
    const ok = refAlignTo(refDrawing, refAlign.uv, refAlign.to);
    refAlignEnd();
    if (!ok) return toast('Pick two points further apart on the drawing.');
    saveRef();
    refShow();
    toast('Drawing lined up. Check it against a third point; drag the handles to fine-tune.');
  } else refAlignMsg();
});
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && refAlign) refAlignEnd(); });
const refCorners = (r: RefDrawing) => [refAt(r, 0, 0), refAt(r, 1, 0), refAt(r, 1, 1), refAt(r, 0, 1)] as Quad;
function refShow() {
  const r = refDrawing;
  if (!map.isStyleLoaded() && !map.getSource('mp-paper')) return;
  if (!r) {
    if (map.getLayer('refimg')) map.removeLayer('refimg');
    if (map.getSource('refimg')) map.removeSource('refimg');
  } else {
    const src = map.getSource('refimg') as mapboxgl.ImageSource | undefined;
    if (!src) {
      map.addSource('refimg', { type: 'image', url: r.src, coordinates: refCorners(r) });
      // Over the base map and sketch paper, under everything drawn on the plan.
      const ids = (map.getStyle().layers || []).map((l) => l.id), before = ids.find((id) => id.startsWith('mp-') && id !== 'mp-paper' && id !== 'mp-clear');
      map.addLayer({ id: 'refimg', type: 'raster', source: 'refimg', paint: { 'raster-opacity': r.opacity, 'raster-fade-duration': 0 } }, before);
    } else src.setCoordinates(refCorners(r));
    map.setPaintProperty('refimg', 'raster-opacity', r.opacity);
  }
  $('#refTools').hidden = !r;
  $<HTMLButtonElement>('#refFit').disabled = !r || !S.red;
  if (r) {
    $<HTMLInputElement>('#refOpacity').value = String(Math.round(r.opacity * 100));
    $('#refOpacityLbl').textContent = `${Math.round(r.opacity * 100)}%`;
    $<HTMLInputElement>('#refLock').checked = r.locked;
  }
  refHandles();
}
/** Handles to move, resize and turn the drawing, shown in the Drawing tab while it is not locked. */
function refHandles() {
  refMarkers.forEach((m) => m.remove());
  refMarkers = [];
  const r = refDrawing;
  if (!r || r.locked || mpTool !== 'ref' || $('#mpMode').hidden) return;
  const mk = (cls: string, at: Position, onDrag: (ll: Position) => void) => {
    const el = document.createElement('div');
    el.className = 'ref-h ' + cls;
    const m = new mapboxgl.Marker({ element: el }).setLngLat(at as [number, number]).addTo(map);
    // Our own drag with pointer capture, so letting go over a panel still ends it.
    el.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      el.setPointerCapture(e.pointerId);
      const box = map.getCanvasContainer().getBoundingClientRect();
      const move = (ev: PointerEvent) => {
        const ll = map.unproject([ev.clientX - box.left, ev.clientY - box.top]);
        m.setLngLat(ll);
        onDrag([ll.lng, ll.lat]);
        refShow2(m);
      };
      const up = () => {
        el.removeEventListener('pointermove', move);
        el.removeEventListener('pointerup', up);
        el.removeEventListener('pointercancel', up);
        saveRef();
        refHandles();
      };
      el.addEventListener('pointermove', move);
      el.addEventListener('pointerup', up);
      el.addEventListener('pointercancel', up);
    });
    ['mousedown', 'touchstart'].forEach((t) => el.addEventListener(t, (e) => e.stopPropagation(), { passive: true }));
    refMarkers.push(m);
    return m;
  };
  mk('move', r.c, (ll) => (r.c = ll));
  mk('size', refAt(r, 1, 1), (ll) => {
    const { kx, ky } = refFrame(r), dx = (ll[0] - r.c[0]) * kx, dy = (ll[1] - r.c[1]) * ky, half = Math.hypot(0.5, (0.5 * r.h) / r.w);
    r.widthM = Math.max(10, Math.hypot(dx, dy) / half);
  });
  mk('rot', refAt(r, 0.5, -0.06), (ll) => {
    const { kx, ky } = refFrame(r), dx = (ll[0] - r.c[0]) * kx, dy = (ll[1] - r.c[1]) * ky;
    r.rot = (Math.atan2(dx, dy) * 180) / Math.PI;
  });
}
/** While dragging: move the image and the other handles (never the one in hand) without rebuilding them. */
function refShow2(dragging?: mapboxgl.Marker) {
  const r = refDrawing;
  if (!r) return;
  (map.getSource('refimg') as mapboxgl.ImageSource | undefined)?.setCoordinates(refCorners(r));
  const at = [r.c, refAt(r, 1, 1), refAt(r, 0.5, -0.06)];
  refMarkers.forEach((m, i) => { if (m !== dragging) m.setLngLat(at[i] as [number, number]); });
}
function saveRef() {
  try {
    if (refDrawing) localStorage.setItem(refKey(), JSON.stringify(refDrawing));
    else localStorage.removeItem(refKey());
  } catch { toast('The drawing is too large to keep in this browser. Try a smaller image.'); }
}
function loadRef() {
  try { refDrawing = JSON.parse(localStorage.getItem(refKey()) ?? 'null'); } catch { refDrawing = null; }
  refShow();
}
/** Where a new drawing goes: over the red line if there is one, otherwise over most of the view. */
function refPlace(r: RefDrawing) {
  if (S.red) {
    const [w, s, e, n] = turf.bbox(S.red);
    r.c = turf.centroid(S.red).geometry.coordinates as Position;
    r.widthM = Math.max(turf.distance([w, s], [e, s], { units: 'meters' }), (turf.distance([w, s], [w, n], { units: 'meters' }) * r.w) / r.h) * 1.15;
  } else {
    const b = map.getBounds()!, c = map.getCenter();
    r.c = [c.lng, c.lat];
    r.widthM = turf.distance([b.getWest(), c.lat], [b.getEast(), c.lat], { units: 'meters' }) * 0.6;
  }
  r.rot = 0;
}
/** A picture (image or canvas) at most maxSide long, on white, as a JPEG data URL. */
function jpegOf(src: CanvasImageSource, w0: number, h0: number, maxSide: number) {
  const k = Math.min(1, maxSide / Math.max(w0, h0));
  const c = document.createElement('canvas');
  c.width = Math.round(w0 * k);
  c.height = Math.round(h0 * k);
  const g = c.getContext('2d')!;
  g.fillStyle = '#ffffff';
  g.fillRect(0, 0, c.width, c.height);
  g.drawImage(src, 0, 0, c.width, c.height);
  return { src: c.toDataURL('image/jpeg', 0.86), w: c.width, h: c.height };
}
function imageFrom(url: string): Promise<HTMLImageElement> {
  return new Promise((res, rej) => {
    const img = new Image();
    img.onload = () => res(img);
    img.onerror = () => rej(new Error('That file could not be read as an image.'));
    img.src = url;
  });
}
/** One page of a PDF drawn about 4000 px across, so its colours and lines are sharp for tracing. */
async function pdfPage(file: File): Promise<HTMLCanvasElement> {
  const pdfjs = await import('pdfjs-dist');
  pdfjs.GlobalWorkerOptions.workerSrc = (await import('pdfjs-dist/build/pdf.worker.min.mjs?url')).default;
  const task = pdfjs.getDocument({ data: new Uint8Array(await file.arrayBuffer()) }), doc = await task.promise;
  try {
    let n = 1;
    if (doc.numPages > 1) {
      const a = prompt(`This PDF has ${doc.numPages} pages. Which page is the masterplan?`, '1');
      if (a === null) throw new Error('No page chosen.');
      n = Math.min(doc.numPages, Math.max(1, parseInt(a, 10) || 1));
    }
    const page = await doc.getPage(n);
    const v1 = page.getViewport({ scale: 1 });
    const vp = page.getViewport({ scale: Math.min(4000 / Math.max(v1.width, v1.height), Math.sqrt(16e6 / (v1.width * v1.height))) });
    const c = document.createElement('canvas');
    c.width = Math.round(vp.width);
    c.height = Math.round(vp.height);
    const g = c.getContext('2d')!;
    g.fillStyle = '#ffffff';
    g.fillRect(0, 0, c.width, c.height);
    await page.render({ canvas: c, canvasContext: g, viewport: vp }).promise;
    return c;
  } finally {
    task.destroy();
  }
}
const canvasUrl = (c: HTMLCanvasElement) => new Promise<string>((res, rej) => c.toBlob((b) => (b ? res(URL.createObjectURL(b)) : rej(new Error('The PDF page could not be drawn.'))), 'image/png'));
$<HTMLInputElement>('#refFile').addEventListener('change', async (e) => {
  const f = (e.target as HTMLInputElement).files?.[0];
  (e.target as HTMLInputElement).value = '';
  if (!f) return;
  const st = $('#refStatus');
  try {
    let im: { src: string; w: number; h: number }, hi: string;
    if (f.type === 'application/pdf' || /\.pdf$/i.test(f.name)) {
      st.className = 'hint busy';
      st.textContent = 'Opening the PDF…';
      const c = await pdfPage(f);
      im = jpegOf(c, c.width, c.height, 2400);
      hi = await canvasUrl(c);
    } else {
      hi = URL.createObjectURL(f);
      const img = await imageFrom(hi);
      im = jpegOf(img, img.naturalWidth, img.naturalHeight, 2400);
    }
    if (refHiRes?.startsWith('blob:')) URL.revokeObjectURL(refHiRes);
    refHiRes = hi;
    refDrawing = { ...im, c: [0, 0], widthM: 200, rot: 0, opacity: 0.6, locked: false };
    refPlace(refDrawing);
    saveRef();
    refShow();
    refFit();
    st.className = 'hint';
    st.textContent = '';
  } catch (err) {
    st.className = 'hint';
    st.textContent = '';
    toast((err as Error).message);
  }
});
$('#refFit').onclick = () => { if (!refDrawing || !S.red) return; refPlace(refDrawing); saveRef(); refShow(); refFit(); };
/** Show the whole drawing in the open map between the masterplan panels, so its handles are not under them. */
function refFit() {
  if (!refDrawing) return;
  const box = (sel: string) => document.querySelector(sel)?.getBoundingClientRect();
  const mr = map.getContainer().getBoundingClientRect(), bar = box('#mpMode .mp-bar'), tools = box('#mpMode .mp-tools'), right = box('#mpMode .mp-right');
  const pad = {
    top: Math.max(40, (bar ? bar.bottom - mr.top : 0) + 50),
    left: Math.max(40, (tools ? tools.right - mr.left : 0) + 40),
    right: Math.max(40, (right ? mr.right - right.left : 0) + 40),
    bottom: 50,
  };
  if (pad.left + pad.right > mr.width - 200) pad.left = pad.right = 40;
  map.fitBounds(turf.bbox(turf.lineString(refCorners(refDrawing) as Position[])) as any, { padding: pad, duration: 600 });
}
$<HTMLInputElement>('#refOpacity').addEventListener('input', (e) => {
  if (!refDrawing) return;
  refDrawing.opacity = +(e.target as HTMLInputElement).value / 100;
  $('#refOpacityLbl').textContent = `${Math.round(refDrawing.opacity * 100)}%`;
  if (map.getLayer('refimg')) map.setPaintProperty('refimg', 'raster-opacity', refDrawing.opacity);
  saveRef();
});
$<HTMLInputElement>('#refLock').addEventListener('change', (e) => { if (!refDrawing) return; refDrawing.locked = (e.target as HTMLInputElement).checked; saveRef(); refHandles(); });
$('#refRemove').onclick = () => { if (!confirm('Remove the drawing from the map? (What you have drawn from it stays.)')) return; refAlignEnd(); refDrawing = null; saveRef(); refShow(); };

interface DraftPlan {
  summary: string;
  colours?: { id: number; category: string }[];
  streets: { name: string; type: StreetType; points: number[][] }[];
  open_spaces: { name: string; type: OpenType; outline: number[][] }[];
  blocks: { name: string; use: Use; storeys: number; outline: number[][] }[];
  trees: number[][];
}
const TRACED_USE: Record<string, [Use, string, number]> = {
  residential: ['residential', 'Parcel', 2], commercial: ['office', 'Commercial unit', 2], retail: ['retail', 'Retail unit', 1],
  community: ['community', 'Community building', 2], school: ['community', 'School', 2], care_home: ['community', 'Care home', 2],
};
/** Trace the colours Claude named into blocks (by use) and ponds. Returns what was added. */
function applyTraced(px: Pixels, labels: Uint8Array, mask: Uint8Array | null, colours: { id: number; category: string }[]) {
  const r = refDrawing!;
  const geo = (x: number, y: number) => refAt(r, (x + 0.5) / px.w, (y + 0.5) / px.h);
  const ids = (cat: string) => colours.filter((c) => c.category === cat).map((c) => c.id);
  const minPx = Math.max(20, Math.round(px.w * px.h * 0.00006));
  const n = { blocks: 0, ponds: 0 };
  for (const [cat, [use, label, storeys]] of Object.entries(TRACED_USE)) {
    const g = ids(cat);
    if (!g.length) continue;
    let k = 0;
    for (const reg of traceRegions(px, labels, g, mask, { minPx, open: 1, eps: 1.2, minFill: 0.2 })) {
      const ring = reg.ring.map(([x, y]) => geo(x, y));
      const nb = newBlock(turf.polygon([[...ring, ring[0]]]) as Feature<Polygon>, S.blocks);
      nb.name = `${label} ${++k}`;
      nb.use = use;
      nb.storeys = storeys;
      S.blocks.push(nb);
      n.blocks++;
    }
  }
  const w = ids('water');
  if (w.length) {
    let k = 0;
    for (const reg of traceRegions(px, labels, w, mask, { minPx: Math.round(minPx / 2), close: 1, eps: 1.5, minFill: 0.15 })) {
      const ring = reg.ring.map(([x, y]) => geo(x, y));
      S.plan.open.push(setOpenNodes({ id: newId('O', S.plan.open), name: `Pond ${++k}`, type: 'suds', round: 0.4 } as OpenSpace, ring.map((q) => penNode(q))));
      n.ponds++;
    }
  }
  return n;
}
/** Streets and roundabouts traced from the drawing's roads (pixels of `px`). */
function applyRoads(px: Pixels, roads: Roads) {
  const r = refDrawing!;
  const geo = (x: number, y: number) => refAt(r, (x + 0.5) / px.w, (y + 0.5) / px.h);
  const mPerPx = r.widthM / px.w;
  const n = { streets: 0, roundabouts: 0 };
  for (const ln of roads.lines) {
    const p = ln.pts.map(([x, y]) => geo(x, y));
    if (ln.closed) p.push(p[0]);
    if (p.length < 2 || turf.length(turf.lineString(p), { units: 'meters' }) < 12) continue;
    S.plan.streets.push(newStreet(S.plan, 'residential', autoHandles(p.map((q) => penNode(q)), 0.35), 0.35));
    n.streets++;
  }
  for (const ring of roads.rings) {
    // the drawn ring's outer edge is about the roundabout's inscribed circle
    const d = Math.max(16, Math.min(60, Math.round(ring.r * 2 * mPerPx)));
    S.plan.streets.push(newRoundabout(S.plan, geo(ring.x, ring.y), 'residential', d));
    n.roundabouts++;
  }
  return n;
}
/** Add a draft read from the drawing to the plan. Returns what was added. */
function applyDraft(d: DraftPlan) {
  const r = refDrawing!;
  const geo = (p: number[]) => refAt(r, Math.min(1, Math.max(0, (+p[0] || 0) / 1000)), Math.min(1, Math.max(0, (+p[1] || 0) / 1000)));
  const pts = (a: number[][]) => (a || []).filter((p) => Array.isArray(p) && p.length >= 2).map(geo);
  const n = { streets: 0, open: 0, blocks: 0, trees: 0 };
  for (const s of d.streets || []) {
    const p = pts(s.points);
    if (p.length < 2 || turf.length(turf.lineString(p), { units: 'meters' }) < 8) continue;
    const st = newStreet(S.plan, STREET_TYPES.some((t) => t.id === s.type) ? s.type : 'residential', autoHandles(p.map((q) => penNode(q)), 0.5), 0.5);
    if (s.name) st.name = s.name.slice(0, 60);
    S.plan.streets.push(st);
    n.streets++;
  }
  for (const o of d.open_spaces || []) {
    const p = pts(o.outline);
    if (p.length < 3) continue;
    const type = OPEN_TYPES.some((t) => t.id === o.type) ? o.type : 'park';
    S.plan.open.push(setOpenNodes({ id: newId('O', S.plan.open), name: (o.name || openType(type).label).slice(0, 60), type, round: 0 } as OpenSpace, p.map((q) => penNode(q))));
    n.open++;
  }
  for (const b of d.blocks || []) {
    const p = pts(b.outline);
    if (p.length < 3) continue;
    const nb = newBlock(turf.polygon([[...p, p[0]]]) as Feature<Polygon>, S.blocks);
    if (b.name) nb.name = b.name.slice(0, 60);
    nb.use = USES.some((u) => u.id === b.use) ? b.use : 'residential';
    nb.storeys = Math.max(1, Math.min(60, Math.round(+b.storeys || 2)));
    S.blocks.push(nb);
    n.blocks++;
  }
  for (const t of (d.trees || []).slice(0, 600)) {
    if (!Array.isArray(t) || t.length < 2) continue;
    S.plan.trees.push(newTree(S.plan, geo(t), 'medium'));
    n.trees++;
  }
  renderPlan();
  renderBlocks();
  return n;
}
$('#refDraft').onclick = async () => {
  if (!refDrawing) return;
  const btn = $<HTMLButtonElement>('#refDraft'), st = $('#refStatus');
  btn.disabled = true;
  st.className = 'hint busy';
  st.textContent = 'Reading the colours in the drawing…';
  try {
    // The drawing's colours, grouped and numbered here, so the shapes can be traced exactly once Claude says what each colour is.
    const source = refHiRes ?? refDrawing.src;
    const px = await loadPixels(source, 1000);
    const mask = siteMask(px), pal = palette(px, mask, 24);
    const hex = (c: number[]) => '#' + c.map((v) => v.toString(16).padStart(2, '0')).join('');
    st.textContent = `Reading the drawing${mask ? ' inside its red line' : ''}. This usually takes under a minute.`;
    const res = await fetch(new URL('../draft-masterplan', location.href).href, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({
        image: refDrawing.src.split(',')[1], mediaType: 'image/jpeg', note: $<HTMLTextAreaElement>('#refNote').value.trim(),
        swatch: swatchImage(pal.colours, pal.share), palette: pal.colours.map((c, i) => ({ id: i, hex: hex(c), share: +pal.share[i].toFixed(4) })),
      }),
    });
    const j = await res.json().catch(() => null);
    if (!res.ok || !j?.draft) throw new Error(j?.error || (res.status === 404 ? 'Drafting from drawings is only available on the allto site itself.' : `The drawing service answered ${res.status}.`));
    const draft = j.draft as DraftPlan;
    const t = j.traced && draft.colours?.length ? applyTraced(px, pal.labels, mask, draft.colours) : { blocks: 0, ponds: 0 };
    // Roads: traced from the drawing at a larger size, using the grey of the road surface and any colours named as road
    let rd = { streets: 0, roundabouts: 0 };
    if (j.traced) {
      st.textContent = 'Tracing the roads…';
      await new Promise((r) => setTimeout(r, 30));
      const big = await loadPixels(source, 2000), bigMask = siteMask(big);
      const roadIds = (draft.colours || []).filter((c) => c.category === 'road').map((c) => c.id);
      const roads = traceRoads(big, bigMask, roadIds.length ? labelWith(big, pal.colours) : null, roadIds);
      if (roads.lines.length >= 3) rd = applyRoads(big, roads);
    }
    const n = applyDraft({ ...draft, blocks: j.traced ? [] : draft.blocks, streets: rd.streets ? [] : draft.streets });
    n.blocks += t.blocks;
    n.open += t.ponds;
    n.streets += rd.streets;
    if (n.blocks + n.streets > 25) setMpLabels(false);
    const parts = [[n.streets, 'street'], [rd.roundabouts, 'roundabout'], [n.open, 'open space'], [n.blocks, 'block'], [n.trees, 'tree']].filter((x) => x[0]).map((x) => `${x[0]} ${x[1]}${x[0] === 1 ? '' : 's'}`);
    st.className = 'hint';
    st.textContent = parts.length
      ? `Added ${parts.join(', ')}${t.blocks ? ` (traced from the drawing's colours: ${[t.blocks && `${t.blocks} blocks`, t.ponds && `${t.ponds} ponds`, rd.streets && `${rd.streets} streets`].filter(Boolean).join(', ')})` : ''}. ${draft.summary || ''}${!mask && t.blocks ? ' No red line was found on the drawing, so shapes outside the site may have come in too.' : ''} Check them against the drawing; Undo takes them back off.${n.blocks + n.streets > 25 ? ' Name tags are off (Labels, top bar).' : ''}${rd.streets ? ' Traced streets all come in as residential streets: set the main roads in Streets.' : ''}`
      : `Nothing to add. ${draft.summary || ''}`;
  } catch (err) {
    st.className = 'hint';
    st.textContent = (err as Error).message;
  } finally {
    btn.disabled = false;
  }
};

function setPick(p: typeof mpPick) {
  mpPick = p;
  updateEditables();
  if (p && walkPick) setWalkPick(false);
  $('#lineStreet').classList.toggle('picking', p === 'line');
  $('#placeHome').classList.toggle('picking', p === 'place');
  $('#addRoundabout').classList.toggle('picking', p === 'roundabout');
  $('#plopTrees').classList.toggle('picking', p === 'tree');
  $('#plopTrees').textContent = p === 'tree' ? 'Done planting' : 'Plop trees';
  $('#treeLine').classList.toggle('picking', p === 'treeline');
  $('#treeLine').textContent = p === 'treeline' ? 'Click a street…' : 'Along a street';
  $('#lineStreet').textContent = p === 'line' ? 'Click a street…' : 'Line a street';
  $('#placeHome').textContent = p === 'place' ? 'Done placing' : 'Place homes';
  $('#addRoundabout').textContent = p === 'roundabout' ? 'Click a junction…' : 'Add a roundabout';
  map.getCanvas().style.cursor = p ? 'crosshair' : '';
}

$('#drawStreet').onclick = () =>
  penDraw('street', false, addStreetFromPen, 'Click to place points, or click and drag to pull out a curve. Start or end on a street to join it. Double-click or Enter to finish; Space-drag pans.');
$('#addRoundabout').onclick = () => {
  setPick(mpPick === 'roundabout' ? null : 'roundabout');
  if (mpPick) toast('Click a junction. The roundabout centres on the nearest one, and the streets stop at its ring.');
};
$('#drawOpen').onclick = () =>
  penDraw('open', true, addOpen, 'Click each corner, or click and drag to curve. Click the first corner (or press Enter) to close the shape.');
$('#lineStreet').onclick = () => {
  if (!S.plan.streets.length) return toast('Draw a street first, in Streets.');
  setPick(mpPick === 'line' ? null : 'line');
  if (mpPick) toast('Click the street to line with homes.');
};
$('#placeHome').onclick = () => {
  setPick(mpPick === 'place' ? null : 'place');
  if (mpPick) toast('Click where each home goes. Near a street it steps onto the building line and faces the street.');
};
$('#clearHomes').onclick = () => {
  if (!S.plan.homes.length) return;
  if (!confirm(`Remove all ${S.plan.homes.length} house footprints?`)) return;
  S.plan.homes = [];
  renderPlan();
};
$('#spreadAff').onclick = () => {
  if (!S.plan.homes.length) return toast('Add some homes first.');
  // The target is a share of all homes; only houses carry a tenure here, so they make up the whole of it.
  const before = mpSchedule();
  spreadAffordable(S.plan.homes, Math.min(1, ((S.targets.affordablePct / 100) * before.homes) / Math.max(1, before.houseHomes)));
  renderPlan();
  const sc = mpSchedule();
  toast(`${sc.affordable.homes} affordable homes spread through the houses: ${Math.round(sc.affordable.share * 100)}% of all ${sc.homes}${sc.apartmentHomes ? ', counting the apartments as market homes' : ''}.`);
};

/** Everything a new plot has to keep clear of. */
function mpObstacles(except?: Home): Obstacles {
  const land = streetLand(S.plan.streets);
  const shapes: Feature<Polygon | MultiPolygon>[] = [
    ...(land ? [land] : []),
    ...S.plan.open.map((o) => o.shape),
    ...S.plan.homes.filter((h) => h !== except).map((h) => h.plot),
    ...S.blocks.map((b) => b.shape),
  ];
  const cleared = new Set(clearedIds());
  if ($<HTMLInputElement>('#hoAvoid').checked && S.model) for (const b of S.model.buildings) if (b.inStudy && !cleared.has(b.idx)) shapes.push(b.feature as Feature<Polygon | MultiPolygon>);
  return { boundary: S.red, shapes };
}
const homeOpts = (): HomeOpts => {
  const gap = $<HTMLInputElement>('#hoGap').value;
  return {
    side: $<HTMLSelectElement>('#hoSide').value as 'both' | 'left' | 'right',
    setbackM: Math.max(0, +$<HTMLInputElement>('#hoSetback').value || 0),
    gardenM: Math.max(0, +$<HTMLInputElement>('#hoGarden').value || 0),
    gapM: gap === '' ? undefined : Math.max(0, +gap),
  };
};

function lineThisStreet(s: Street, typeId = $<HTMLSelectElement>('#hoType').value as HouseTypeId, quiet = false) {
  const added = lineStreet(s, S.plan.streets, typeId, homeOpts(), mpObstacles(), S.plan.homes);
  S.plan.homes.push(...added);
  renderPlan();
  if (!quiet) toast(added.length ? `${added.length} × ${houseType(typeId).label.toLowerCase()} along ${s.name}.` : `No room for that house type along ${s.name}: check the red line, the gardens and anything in the way.`);
  return added.length;
}

/** After a street changes: take its homes away and line it again with the type most used along it. */
function relineStreet(s: Street) {
  const mine = S.plan.homes.filter((h) => h.streetId === s.id);
  S.plan.homes = S.plan.homes.filter((h) => h.streetId !== s.id);
  clearHomesUnder(corridor(s, S.plan.streets), true);
  if (!mine.length) return renderPlan();
  const counts = new Map<HouseTypeId, number>();
  for (const h of mine) counts.set(h.type, (counts.get(h.type) ?? 0) + 1);
  lineThisStreet(s, [...counts].sort((a, b) => b[1] - a[1])[0][0], true);
}

/** A new street or open space clears the homes whose plots it lands on. */
function clearHomesUnder(shape: Feature<Polygon | MultiPolygon>, quiet = false) {
  const before = S.plan.homes.length;
  const small = (h: Home) => turf.transformScale(h.plot, 0.95);
  S.plan.homes = S.plan.homes.filter((h) => !turf.booleanIntersects(small(h), shape));
  const n = before - S.plan.homes.length;
  if (n && !quiet) toast(`${n} home${n > 1 ? 's' : ''} in the way removed.`);
}

/** A street drawn with the pen. Ends that landed on another street join it at a shared node. */
function addStreetFromPen(nodes: PenNode[], snaps: (Snap | null)[]) {
  if (turf.length(turf.lineString(bezierPath(nodes)), { units: 'meters' }) < 8) return toast('That street is too short.');
  // Clicked points only (no handles pulled): smooth them by the "How curved" setting.
  const curve = +$<HTMLInputElement>('#stCurve').value / 100;
  const ns = nodes.every((n) => !n.i[0] && !n.i[1] && !n.o[0] && !n.o[1]) ? autoHandles(nodes, curve) : nodes;
  for (const i of [0, ns.length - 1]) joinAt(ns[i].p, snaps[i]);
  const s = newStreet(S.plan, $<HTMLSelectElement>('#stType').value as StreetType, ns, curve);
  S.plan.streets.push(s);
  S.mpSel = s.id;
  clearHomesUnder(corridor(s, S.plan.streets));
  renderPlan();
}

/** Where a street end lands part way along another street, give that street a node there: a junction. */
function joinAt(p: Position, snap: Snap | null) {
  if (snap?.ref?.type !== 'street') return;
  const t = S.plan.streets.find((x) => x.id === snap.ref.id);
  if (!t || t.roundabout) return;
  if (t.nodes.some((n) => samePlace(n.p, p))) return;
  const near = nearestOnPath(t.nodes, false, p);
  const r = splitAt(t.nodes, near.seg, near.t);
  r.nodes[r.index].p = [p[0], p[1]];
  setStreetNodes(t, r.nodes);
}

function addRoundabout(at: Position) {
  const d = ROUNDABOUTS.find((r) => r.id === $<HTMLSelectElement>('#raType').value)!.diameterM;
  const r = newRoundabout(S.plan, at, $<HTMLSelectElement>('#stType').value === 'path' ? 'residential' : ($<HTMLSelectElement>('#stType').value as StreetType), d);
  S.plan.streets.push(r);
  S.mpSel = r.id;
  clearHomesUnder(corridor(r));
  // Homes on the streets it cuts into may now sit in the wrong place: re-line those.
  for (const s of S.plan.streets) if (s !== r && !s.roundabout && turf.booleanIntersects(s.line, corridor(r))) relineStreet(s);
  renderPlan();
}
function addOpen(nodes: PenNode[]) {
  const round = +$<HTMLInputElement>('#osRound').value / 100;
  const type = $<HTMLSelectElement>('#osType').value as OpenType;
  const o = setOpenNodes({ id: newId('O', S.plan.open), name: openType(type).label, type, round } as OpenSpace, nodes);
  const shape = o.shape;
  S.plan.open.push(o);
  S.mpSel = o.id;
  clearHomesUnder(shape);
  renderPlan();
}

function deleteMp(id: string) {
  const s = S.plan.streets.find((x) => x.id === id);
  if (s) {
    const n = S.plan.homes.filter((h) => h.streetId === id).length;
    S.plan.streets = S.plan.streets.filter((x) => x !== s);
    S.plan.homes = S.plan.homes.filter((h) => h.streetId !== id);
    if (n) toast(`${s.name} and its ${n} home${n > 1 ? 's' : ''} removed.`);
  }
  S.plan.open = S.plan.open.filter((x) => x.id !== id);
  S.plan.homes = S.plan.homes.filter((x) => x.id !== id);
  S.plan.trees = S.plan.trees.filter((x) => x.id !== id);
  if (S.mpSel === id) S.mpSel = null;
  renderPlan();
}

function selectMp(id: string | null) {
  S.mpSel = id;
  if (id?.startsWith('S')) setMpTool('streets');
  else if (id?.startsWith('O')) setMpTool('open');
  else if (id?.startsWith('H')) setMpTool('homes');
  else if (id?.startsWith('T')) setMpTool('trees');
  renderPlan();
  if (id) document.querySelector(`.mp-list [data-id="${id}"]`)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}

let planQueued = false;
function renderPlanSoon() {
  if (planQueued) return;
  planQueued = true;
  setTimeout(() => ((planQueued = false), renderPlan()), 0);
}

const setSrc = (id: string, data: FeatureCollection) => (map.getSource(id) as mapboxgl.GeoJSONSource | undefined)?.setData(data);

const curveLabel = (c: number) => (c ? `${Math.round(c * 100)}%` : 'straight');
const roundLabel = (r: number) => (r ? `${Math.round(r * 100)}%` : 'square');
for (const [id, lbl, fmt] of [['#stCurve', '#stCurveLbl', curveLabel], ['#osRound', '#osRoundLbl', roundLabel]] as const) {
  const el = $<HTMLInputElement>(id);
  el.addEventListener('input', () => ($(lbl).textContent = fmt(+el.value / 100)));
}

/** Just the map: quick enough to run while a slider moves. */
function renderPlanMap() {
  const g = planGeoJSON(S.plan, S.mpSel);
  setSrc('mp-streets', g.streets);
  setSrc('mp-land', g.land);
  setSrc('mp-islands', g.islands);
  setSrc('mp-open', g.open);
  setSrc('mp-homes', g.homes);
  setSrc('mp-plots', g.plots);
  setSrc('mp-gardens', g.gardens);
  setSrc('mp-trees', treesGeoJSON(S.plan.trees, S.mpSel));
  setSrc('mp-clear', { type: 'FeatureCollection', features: clearAreas(S.plan, S.red) as Feature[] });
  applyModelFilter();
  updateEditables();
  if (S.sketch) {
    const sk = sketchGeoJSON(S.plan, S.blocks.map((b) => b.shape));
    setSrc('mp-sk-lines', sk.lines);
    setSrc('mp-sk-hatch', sk.hatches);
  }
}

function renderPlan() {
  renderPlanMap();

  streetMarkers.forEach((m) => m.remove());
  streetMarkers = S.plan.streets.map((s) => {
    const el = document.createElement('span');
    el.className = 'block-ref street-ref';
    el.textContent = s.name;
    const at = s.roundabout ? s.pts[0] : turf.along(s.line, Math.min(40, turf.length(s.line, { units: 'meters' }) * 0.3), { units: 'meters' }).geometry.coordinates; // near the start, clear of junctions
    return new mapboxgl.Marker({ element: el }).setLngLat(at as [number, number]).addTo(map);
  });
  if (S.view === 'atlas') streetMarkers.forEach((m) => (m.getElement().style.display = 'none'));

  const on = (id: string) => (id === S.mpSel ? ' on' : '');
  $('#streetList').innerHTML = S.plan.streets
    .map((s) => {
      const homes = S.plan.homes.filter((h) => h.streetId === s.id).length;
      const len = s.roundabout ? `${s.roundabout.diameterM} m across` : `${Math.round(turf.length(s.line, { units: 'meters' }))} m`;
      return `<div class="mpr wrap${on(s.id)}" data-id="${s.id}">
        <span class="grow"><input class="mp-name" value="${esc(s.name)}" aria-label="Name"><small>${len}${homes ? ` · ${homes} homes` : ''}</small></span>
        ${s.roundabout ? '' : `<label class="tiny slide">Curve <input type="range" data-f="curve" min="0" max="100" step="5" value="${Math.round(s.curve * 100)}"><span>${curveLabel(s.curve)}</span></label>`}
        <select data-f="type" aria-label="Street type">${STREET_TYPES.filter((t) => !s.roundabout || t.id !== 'path').map((t) => `<option value="${t.id}"${t.id === s.type ? ' selected' : ''}>${esc(t.label)}</option>`).join('')}</select>
        ${s.roundabout ? '' : `<button class="link" data-act="edit">Edit</button>`}
        <button class="link" data-act="line">Line it</button><button class="link" data-act="del">Delete</button>
      </div>`;
    })
    .join('');
  $('#openList').innerHTML = S.plan.open
    .map((o) => `<div class="mpr wrap${on(o.id)}" data-id="${o.id}">
        <span class="sw" style="background:${openType(o.type).colour}"></span>
        <span class="grow"><input class="mp-name" value="${esc(o.name)}" aria-label="Name"><small>${m2(turf.area(o.shape))}</small></span>
        <label class="tiny slide">Corners <input type="range" data-f="round" min="0" max="100" step="5" value="${Math.round(o.round * 100)}"><span>${roundLabel(o.round)}</span></label>
        <select data-f="type" aria-label="Open space type">${OPEN_TYPES.map((t) => `<option value="${t.id}"${t.id === o.type ? ' selected' : ''}>${esc(t.label)}</option>`).join('')}</select>
        <button class="link" data-act="del">Delete</button>
      </div>`)
    .join('');
  const sel = S.plan.homes.find((h) => h.id === S.mpSel);
  const aff = S.plan.homes.filter((h) => h.tenure === 'affordable').length;
  $('#homeList').innerHTML =
    HOUSE_TYPES.map((t) => ({ t, n: S.plan.homes.filter((h) => h.type === t.id).length }))
      .filter((x) => x.n)
      .map(({ t, n }) => `<div class="mpr" data-type="${t.id}"><span class="sw" style="background:${t.colour}"></span><span class="grow"><b>${esc(t.label)}</b><small>${n} ${t.homes > 1 ? `pairs, ${n * t.homes} homes` : n > 1 ? 'homes' : 'home'}</small></span><button class="link" data-act="deltype">Remove</button></div>`)
      .join('') +
    (aff ? `<div class="mpr"><span class="sw" style="background:${AFFORDABLE_COLOUR}"></span><span class="grow"><b>Affordable</b><small>${aff} buildings shown in teal</small></span><button class="link" data-act="clearaff">Clear</button></div>` : '') +
    (sel
      ? `<div class="mpr on wrap" data-id="${sel.id}"><span class="grow"><b>Selected: ${esc(houseType(sel.type).label)}</b><small>Change its type or tenure; press Delete to remove it</small></span>
          <select data-f="htype" aria-label="House type">${HOUSE_TYPES.map((t) => `<option value="${t.id}"${t.id === sel.type ? ' selected' : ''}>${esc(t.label)}</option>`).join('')}</select>
          <select data-f="tenure" aria-label="Tenure"><option value="market"${sel.tenure === 'market' ? ' selected' : ''}>Market</option><option value="affordable"${sel.tenure === 'affordable' ? ' selected' : ''}>Affordable</option></select>
          <button class="link" data-act="del">Delete</button></div>`
      : '');

  document.querySelectorAll<HTMLElement>('.mp-list .mpr[data-id]').forEach((row) => {
    const id = row.dataset.id!;
    const s = S.plan.streets.find((x) => x.id === id);
    const o = S.plan.open.find((x) => x.id === id);
    const h = S.plan.homes.find((x) => x.id === id);
    row.addEventListener('click', (e) => {
      if ((e.target as HTMLElement).closest('select,button,input,label')) return;
      selectMp(S.mpSel === id ? null : id);
    });
    row.querySelector<HTMLInputElement>('.mp-name')?.addEventListener('change', (e) => {
      const v = (e.target as HTMLInputElement).value.trim();
      if (v && s) s.name = v;
      if (v && o) o.name = v;
      renderPlanSoon();
    });
    row.querySelector('[data-act=del]')?.addEventListener('click', () => deleteMp(id));
    row.querySelector('[data-act=line]')?.addEventListener('click', () => s && (setMpTool('homes'), lineThisStreet(s)));
    row.querySelector('[data-act=edit]')?.addEventListener('click', () => {
      if (!s) return;
      setPick(null);
      if (S.view !== 'plan') setView('plan');
      selectMp(s.id);
      toast('Drag its points and handles. Alt-drag a point to curve it, Alt-click to make it a corner, double-click the street to add a point.');
    });
    // Sliders redraw the map as they move, and lay the homes out again when let go.
    const curveIn = row.querySelector<HTMLInputElement>('[data-f=curve]');
    curveIn?.addEventListener('input', () => {
      if (!s) return;
      s.curve = +curveIn.value / 100;
      setStreetNodes(s, autoHandles(s.nodes, s.curve));
      (curveIn.nextElementSibling as HTMLElement).textContent = curveLabel(s.curve);
      renderPlanMap();
    });
    curveIn?.addEventListener('change', () => {
      if (!s) return;
      if (s.curve && s.pts.length < 3) toast('A curve needs three or more points: edit the street to add some.');
      relineStreet(s);
    });
    const roundIn = row.querySelector<HTMLInputElement>('[data-f=round]');
    roundIn?.addEventListener('input', () => {
      if (!o) return;
      o.round = +roundIn.value / 100;
      o.shape = roundedShape(bezierPath(o.nodes, true), o.round);
      (roundIn.nextElementSibling as HTMLElement).textContent = roundLabel(o.round);
      renderPlanMap();
    });
    roundIn?.addEventListener('change', () => o && (clearHomesUnder(o.shape), renderPlan()));
    row.querySelector<HTMLSelectElement>('[data-f=type]')?.addEventListener('change', (e) => {
      const v = (e.target as HTMLSelectElement).value;
      if (s) return ((s.type = v as StreetType), relineStreet(s));
      if (o) ((o.type = v as OpenType), (o.name = openType(o.type).label));
      renderPlanSoon();
    });
    row.querySelector<HTMLSelectElement>('[data-f=tenure]')?.addEventListener('change', (e) => {
      if (h) h.tenure = (e.target as HTMLSelectElement).value as Tenure;
      renderPlanSoon();
    });
    row.querySelector<HTMLSelectElement>('[data-f=htype]')?.addEventListener('change', (e) => {
      if (!h) return;
      const c = turf.centroid(h.shape).geometry.coordinates;
      const nh = placeHome(c, (e.target as HTMLSelectElement).value as HouseTypeId, S.plan.streets, homeOpts(), mpObstacles(h), S.plan.homes);
      if (!nh) return (toast('That house type does not fit there.'), renderPlanSoon());
      Object.assign(h, { ...nh, id: h.id, tenure: h.tenure });
      renderPlanSoon();
    });
  });
  document.querySelectorAll<HTMLElement>('#homeList [data-act=deltype]').forEach((b) =>
    b.addEventListener('click', () => {
      const t = (b.closest('.mpr') as HTMLElement).dataset.type;
      S.plan.homes = S.plan.homes.filter((h) => h.type !== t);
      renderPlan();
    }),
  );
  $('#homeList').querySelector('[data-act=clearaff]')?.addEventListener('click', () => (S.plan.homes.forEach((h) => (h.tenure = 'market')), renderPlan()));
  renderTreeList();
  renderClearList();
  renderSchedule();
  renderLegend();
  renderMpContext();
  $('#mpKey').innerHTML = mpLegend((bg, extra = '') => `<span class="sw" style="background:${bg};${extra}"></span>`);
  saveProject();
  agent.contextChanged();
}

function mpSchedule() {
  const t = massTotals(S.blocks, S.red, S.assume);
  return schedule(S.plan, S.red, t.homes ?? 0, (t.homes ?? 0) * S.mpAssume.aptParking, S.mpAssume.householdSize, S.targets);
}

function renderSchedule() {
  const has = S.plan.streets.length || S.plan.open.length || S.plan.homes.length || S.plan.trees.length;
  if (!has && !S.blocks.length) return void (($('#mpSchedule').innerHTML = '<p class="hint">Draw streets, spaces, homes or blocks and the schedule fills in.</p>'), ($('#mpMini').textContent = ''));
  const s = mpSchedule();
  $('#mpMini').textContent = [
    S.plan.streets.length && `${S.plan.streets.length} street${S.plan.streets.length > 1 ? 's' : ''}`,
    S.plan.open.length && `${S.plan.open.length} space${S.plan.open.length > 1 ? 's' : ''}`,
    s.homes && `${s.homes} homes`,
    s.grossDph != null && s.homes && `${Math.round(s.grossDph)} dph`,
  ].filter(Boolean).join(' · ');
  const share = (x: number) => (s.siteM2 ? ` <span class="muted">${pct(x / s.siteM2)}</span>` : '');
  const ha = (x: number) => `${x.toFixed(2)} ha`;
  const rows: string[] = [];
  if (s.siteM2) rows.push(`<tr><th>Site (red line)</th><td>${ha(s.siteM2 / 10000)}</td></tr>`);
  if (s.streetsM2) rows.push(`<tr><th>Streets</th><td>${m2(s.streetsM2)}${share(s.streetsM2)}</td></tr>`);
  for (const [k, v] of Object.entries(s.streetLengthM)) rows.push(`<tr><th class="ind">${esc(k)}</th><td>${Math.round(v)} m</td></tr>`);
  if (s.roundabouts) rows.push(`<tr><th class="ind">Roundabouts</th><td>${s.roundabouts}</td></tr>`);
  for (const t of OPEN_TYPES) if (s.openM2[t.id]) rows.push(`<tr><th><span class="sw" style="background:${t.colour}"></span>${esc(t.label)}</th><td>${m2(s.openM2[t.id]!)}${share(s.openM2[t.id]!)}</td></tr>`);
  if (s.netM2 != null) rows.push(`<tr class="tot"><th>Net developable</th><td>${ha(s.netM2 / 10000)}${share(s.netM2)}</td></tr>`);
  const homes: string[] = s.houses.map((h) => `<tr><th><span class="sw" style="background:${houseType(h.type).colour}"></span>${esc(h.label)}</th><td>${h.homes}</td></tr>`);
  if (s.apartmentHomes) homes.push(`<tr><th>Apartments (blocks)</th><td>about ${s.apartmentHomes}</td></tr>`);
  homes.push(`<tr class="tot"><th>Homes</th><td>${s.homes.toLocaleString('en-GB')}</td></tr>`);
  if (s.grossDph != null && s.homes) homes.push(`<tr><th>Gross density</th><td>${Math.round(s.grossDph)} dph</td></tr>`);
  if (s.netDph != null && s.homes) homes.push(`<tr><th>Net density</th><td>${Math.round(s.netDph)} dph</td></tr>`);
  if (s.trees.count) {
    homes.push(`<tr class="tot"><th>Trees</th><td>${s.trees.count}</td></tr>`);
    homes.push(`<tr><th>Canopy cover</th><td>${m2(s.trees.canopyM2)}${s.trees.canopyShare != null ? ` <span class="muted">${pct(s.trees.canopyShare)}</span>` : ''}</td></tr>`);
  }
  if (s.homes) homes.push(`<tr><th>People, about</th><td>${s.population.toLocaleString('en-GB')}</td></tr>`, `<tr><th>Parking, about</th><td>${s.parking} spaces</td></tr>`);
  const ok = (good: boolean) => (good ? 'met' : 'short');
  const a = s.affordable;
  const targets = s.homes
    ? `<h4>Against the targets</h4><table class="metrics">
        <tr><th>Affordable (${a.targetPct}%)</th><td class="${ok(a.homes >= a.targetHomes)}">${a.homes} of ${a.targetHomes} · ${Math.round(a.share * 100)}%</td></tr>
        ${s.mix.map((m) => `<tr><th>${m.beds === 4 ? '4+' : m.beds} bed (${m.targetPct}%)</th><td class="${ok(Math.abs(m.share * 100 - m.targetPct) <= 5)}">${m.homes} · ${Math.round(m.share * 100)}%</td></tr>`).join('')}
      </table><p class="hint">Green within 5 points of the target. Apartments split ${S.targets.apartmentOneBedPct}% 1 bed, the rest 2 bed.</p>`
    : '';
  const bench = s.population
    ? s.openVsBenchmark.map((b) => `<tr><th>${esc(b.label)}</th><td class="${ok(b.providedHa >= b.benchmarkHa)}">${b.providedHa.toFixed(2)} of ${b.benchmarkHa.toFixed(2)} ha</td></tr>`).join('')
    : '';
  $('#mpSchedule').innerHTML = `<table class="metrics">${rows.join('')}${homes.join('')}</table>
    ${targets}
    ${bench ? `<h4>Open space against Fields in Trust</h4><table class="metrics">${bench}</table><p class="hint">For about ${s.population.toLocaleString('en-GB')} people. Areas count inside the red line only.</p>` : ''}
    ${S.red ? '' : '<p class="hint">Draw a red line for site areas and density.</p>'}`;
}

const mpAssumeIn = (id: string, get: () => number, set: (v: number) => void) => {
  const el = $<HTMLInputElement>(id);
  el.value = String(get());
  el.onchange = () => (set(+el.value), renderPlanSoon());
};
const clampPct = (v: number) => Math.max(0, Math.min(100, Math.round(v) || 0));
function bindMpInputs() {
  mpAssumeIn('#aHh', () => S.mpAssume.householdSize, (v) => (S.mpAssume.householdSize = Math.max(1, Math.min(5, v || 2.4))));
  mpAssumeIn('#aAptPk', () => S.mpAssume.aptParking, (v) => (S.mpAssume.aptParking = Math.max(0, Math.min(3, v))));
  mpAssumeIn('#tApt1', () => S.targets.apartmentOneBedPct, (v) => (S.targets.apartmentOneBedPct = clampPct(v)));
  mpAssumeIn('#tAff', () => S.targets.affordablePct, (v) => (S.targets.affordablePct = clampPct(v)));
  for (const b of [1, 2, 3, 4] as const) mpAssumeIn(`#tMix${b}`, () => S.targets.mix[b], (v) => (S.targets.mix[b] = clampPct(v)));
}
bindMpInputs();

/** A click on the map for the masterplan. Returns true if it was used. */
function mpClick(e: mapboxgl.MapMouseEvent): boolean {
  const box: [mapboxgl.PointLike, mapboxgl.PointLike] = [[e.point.x - 7, e.point.y - 7], [e.point.x + 7, e.point.y + 7]];
  const at: Position = [e.lngLat.lng, e.lngLat.lat];
  if (mpPick === 'tree') return true; // the brush plants on mousedown
  if (mpPick === 'treeline') {
    let s: Street | undefined, best = 25;
    for (const x of S.plan.streets) {
      const d = turf.nearestPointOnLine(x.line, at, { units: 'meters' }).properties.dist ?? 99;
      if (d < best) ((best = d), (s = x));
    }
    if (!s) return (toast('Click on one of your streets.'), true);
    plantAlongStreet(s);
    setPick(null);
    return true;
  }
  if (mpPick === 'roundabout') {
    addRoundabout(at);
    setPick(null);
    return true;
  }
  if (mpPick === 'line') {
    const f = map.queryRenderedFeatures(box, { layers: ['mp-street', 'mp-path', 'mp-land'] }).find((x) => x.properties?.id);
    let s = f && S.plan.streets.find((x) => x.id === f.properties?.id);
    if (!s) {
      // Nearest street within 20 m of the click.
      let best = 20;
      for (const x of S.plan.streets) {
        const d = turf.nearestPointOnLine(x.line, at, { units: 'meters' }).properties.dist ?? 99;
        if (d < best) ((best = d), (s = x));
      }
    }
    if (!s) return (toast('Click on one of your streets.'), true);
    lineThisStreet(s);
    setPick(null);
    return true;
  }
  if (mpPick === 'place') {
    const h = placeHome(at, $<HTMLSelectElement>('#hoType').value as HouseTypeId, S.plan.streets, homeOpts(), mpObstacles(), S.plan.homes);
    if (!h) return (toast(S.red && !turf.booleanPointInPolygon(at, S.red) ? 'Homes go inside the red line.' : 'Something is in the way of that plot.'), true);
    S.plan.homes.push(h);
    S.mpSel = h.id;
    renderPlan();
    return true;
  }
  const hit = map.queryRenderedFeatures(e.point, { layers: ['mp-trees-3d', 'mp-trees-flat', 'mp-homes-3d', 'mp-homes-flat', 'mp-open-f'].filter((l) => map.getLayer(l) && map.getLayoutProperty(l, 'visibility') !== 'none') })[0] ?? map.queryRenderedFeatures(box, { layers: ['mp-street', 'mp-path', 'mp-islands'] })[0];
  if (hit?.properties?.id) {
    selectMp(String(hit.properties.id));
    return true;
  }
  if (S.mpSel) selectMp(null);
  return false;
}

document.addEventListener('keydown', (e) => {
  if ((e.target as HTMLElement)?.closest('input,select,textarea')) return;
  if ((e.key === 'Delete' || e.key === 'Backspace') && S.mpSel && !S.drawing) (e.preventDefault(), deleteMp(S.mpSel));
  if (e.key === 'Escape' && mpPick) setPick(null);
});

// ---- the masterplan in the drawings and CAD
const mpExportBlocks = (): ExportBlock[] =>
  S.plan.homes.map((h) => {
    const t = houseType(h.type);
    return {
      name: h.id, use: `${t.label}${h.tenure === 'affordable' ? ', affordable' : ''}`, shape: h.shape, base: 0, layer: 'UH_MP_HOMES',
      top: h.ridge ? houseEave(t) : houseHeight(t),
      ridge: h.ridge ? { a: h.ridge[0], b: h.ridge[1], top: houseHeight(t) } : undefined,
    };
  });
const mpExportLines = (): ExportLine[] => {
  const land = streetLand(S.plan.streets);
  const rings = (f: Feature<Polygon | MultiPolygon>) => (f.geometry.type === 'Polygon' ? f.geometry.coordinates : f.geometry.coordinates.flat());
  return [
    ...(land ? rings(land).map((r) => ({ layer: 'UH_MP_STREETS', coords: r, closed: true })) : []),
    ...S.plan.streets.flatMap((s) => streetPieces(s, S.plan.streets).map((p) => ({ layer: 'UH_MP_CENTRELINES', coords: p, closed: false }))),
    ...S.plan.streets.filter((s) => s.roundabout).map((s) => ({ layer: 'UH_MP_STREETS', coords: roundaboutIsland(s).geometry.coordinates[0], closed: true })),
    ...S.plan.open.map((o) => ({ layer: 'UH_MP_OPEN_SPACE', coords: o.shape.geometry.coordinates[0], closed: true })),
    ...S.plan.homes.map((h) => ({ layer: 'UH_MP_PLOTS', coords: h.plot.geometry.coordinates[0], closed: true })),
    ...S.plan.homes.flatMap((h) => homePartyLines(h).map((l) => ({ layer: 'UH_MP_PLOTS', coords: l, closed: false }))),
    ...S.plan.homes.filter((h) => h.garden).map((h) => ({ layer: 'UH_MP_GARDENS', coords: h.garden!.geometry.coordinates[0], closed: true })),
    ...S.plan.trees.map((t) => ({ layer: 'UH_MP_TREES', coords: canopyShape(t).geometry.coordinates[0], closed: true })),
  ];
};
/** Gardens, open space and streets as ground for the SVG drawings, drawn like the streets around them. */
function mpGround(frame: LocalFrame): (GroundPolys | GroundLines)[] {
  const out: (GroundPolys | GroundLines)[] = [];
  const gardens = S.plan.homes.filter((h) => h.garden).flatMap((h) => toLocalPolys(h.garden!.geometry, frame));
  if (gardens.length) out.push({ polys: gardens, fill: '#e3ecd8', opacity: 1 });
  const plots = S.plan.homes.flatMap((h) => toLocalPolys(h.plot.geometry, frame));
  if (plots.length) out.push({ polys: plots, fill: 'none', stroke: '#b9b8b2', strokeWidth: 0.5 });
  for (const o of S.plan.open) out.push({ polys: toLocalPolys(o.shape.geometry, frame), fill: openType(o.type).colour, opacity: 0.7, stroke: openType(o.type).colour, strokeWidth: 0.8 });
  const byWidth = new Map<number, XY[][]>();
  for (const s of S.plan.streets) {
    const w = ROAD_WIDTH_M[streetType(s.type).cls] ?? 5;
    if (!byWidth.has(w)) byWidth.set(w, []);
    byWidth.get(w)!.push(...streetPieces(s, S.plan.streets).map((p) => p.map((q) => frame.toLocal(q))));
  }
  [...byWidth].sort((a, b) => a[0] - b[0]).forEach(([w, lines]) => out.push({ lines, stroke: '#ffffff', widthM: w }));
  const islands = S.plan.streets.filter((s) => s.roundabout).flatMap((s) => toLocalPolys(roundaboutIsland(s).geometry, frame));
  if (islands.length) out.push({ polys: islands, fill: '#d3e2c4' });
  return out;
}
function mpBuildings(frame: LocalFrame, white = false): AxoBuilding[] {
  return S.plan.homes.map((h) => {
    const t = houseType(h.type);
    const colour = h.tenure === 'affordable' ? AFFORDABLE_COLOUR : t.colour;
    return {
      polys: toLocalPolys(h.shape.geometry, frame), z0: 0, z1: h.ridge ? houseEave(t) : houseHeight(t),
      ridge: h.ridge ? { a: frame.toLocal(h.ridge[0]), b: frame.toLocal(h.ridge[1]), z: houseHeight(t) } : undefined,
      look: white ? { roof: '#f6c9cb', wallLight: '#ffffff', wallDark: '#ffffff', stroke: '#6f6e6a', strokeWidth: 0.6 } : lookForColour(colour),
    };
  });
}

// ---------------------------------------------------------------- clearing what exists on the site
/** Existing buildings (from the analysis) that stand in a cleared area. */
function clearedIds(): number[] {
  const areas = clearAreas(S.plan, S.red);
  if (!S.model || !areas.length) return [];
  return S.model.buildings.filter((b) => areas.some((a) => turf.booleanPointInPolygon(b.ll, a))).map((b) => b.idx);
}
/** Existing buildings shown: the study area only in the axo and atlas, and none in cleared areas. */
function applyModelFilter() {
  if (!map.getLayer('model-3d')) return;
  const parts: any[] = [];
  if ((S.view === 'axo' || S.view === 'atlas') && S.model) parts.push(['==', ['get', 'inStudy'], true]);
  const ids = S.view === 'atlas' ? [] : clearedIds();
  if (ids.length) parts.push(['!', ['in', ['id'], ['literal', ids]]]);
  map.setFilter('model-3d', parts.length ? ['all', ...parts] : null);
}
$<HTMLInputElement>('#clrRed').onchange = (e) => {
  if (!S.red) return (toast('Draw a red line first.'), (($('#clrRed') as HTMLInputElement).checked = false));
  S.plan.clearRed = (e.target as HTMLInputElement).checked;
  renderPlan();
};
$('#clrDraw').onclick = () =>
  penDraw('open', true, (nodes) => {
    S.plan.clear.push({ id: newId('C', S.plan.clear), shape: turf.polygon([bezierPath(nodes, true)]) as Feature<Polygon> });
    renderPlan();
    toast('Cleared. Existing roads, paths and buildings there are hidden, and left out of walks that include the drawn streets.');
  }, 'Draw the area to clear: click each corner (drag to curve); click the first corner or press Enter to finish.');
function renderClearList() {
  $<HTMLInputElement>('#clrRed').checked = S.plan.clearRed;
  $('#clrList').innerHTML = S.plan.clear
    .map((c, i) => `<div class="mpr" data-clr="${c.id}"><span class="sw" style="background:#fff;border:1px dashed #9a9994"></span><span class="grow"><b>Cleared area ${i + 1}</b><small>${m2(turf.area(c.shape))}</small></span><button class="link" data-act="delclr">Restore</button></div>`)
    .join('');
  $('#clrList').querySelectorAll<HTMLElement>('[data-act=delclr]').forEach((b) =>
    b.addEventListener('click', () => {
      const id = (b.closest('.mpr') as HTMLElement).dataset.clr;
      S.plan.clear = S.plan.clear.filter((c) => c.id !== id);
      renderPlan();
    }),
  );
}

// ---------------------------------------------------------------- trees: the tree plopper
fillSelect('#trType', TREE_TYPES, 'medium');
const trNote = () => {
  const t = treeType($<HTMLSelectElement>('#trType').value as TreeType);
  $('#trNote').textContent = `About ${t.heightM} m tall with a ${t.canopyM} m crown; ${t.note}.`;
};
trNote();
const trSpacing = () => +$<HTMLInputElement>('#trSpace').value;
$<HTMLInputElement>('#trSpace').addEventListener('input', () => ($('#trSpaceLbl').textContent = `${trSpacing()} m`));
const trTypeNow = () => $<HTMLSelectElement>('#trType').value as TreeType;

$('#plopTrees').onclick = () => {
  setPick(mpPick === 'tree' ? null : 'tree');
  if (mpPick) {
    if (S.view !== 'plan' && S.view !== '3d') setView('plan');
    toast('Click to plop a tree, or hold and drag to paint them. Hold Alt and drag to rub trees out. Esc when done.');
  }
};
$('#treeLine').onclick = () => {
  if (!S.plan.streets.length) return toast('Draw a street first.');
  setPick(mpPick === 'treeline' ? null : 'treeline');
  if (mpPick) toast('Click a street for a row of trees on each side.');
};
$('#treeFill').onclick = () =>
  penDraw('open', true, (nodes) => {
    const shape = turf.polygon([bezierPath(nodes, true)]) as Feature<Polygon>;
    const added = fillWithTrees(shape, S.plan, trTypeNow(), trSpacing());
    S.plan.trees.push(...added);
    renderPlan();
    toast(added.length ? `${added.length} trees planted, about ${trSpacing()} m apart.` : 'No room for trees there.');
  }, 'Draw the area to plant: click each corner (drag to curve); click the first corner or press Enter to finish.');
$('#clearTrees').onclick = () => {
  if (!S.plan.trees.length) return;
  if (!confirm(`Remove all ${S.plan.trees.length} trees?`)) return;
  S.plan.trees = [];
  renderPlan();
};

function plantAlongStreet(s: Street) {
  const added = plantAlong(s, S.plan, trTypeNow(), trSpacing(), S.red);
  S.plan.trees.push(...added);
  renderPlan();
  toast(added.length ? `${added.length} trees along ${s.name}.` : `No room for trees along ${s.name}.`);
}

// Painting: hold and drag to plop trees about a spacing apart; with Alt, rub them out.
let brush: { last: Position | null; erase: boolean; changed: boolean } | null = null;
let brushFrame = 0;
const renderTreesSoon = () => {
  if (brushFrame) return;
  brushFrame = requestAnimationFrame(() => {
    brushFrame = 0;
    setSrc('mp-trees', treesGeoJSON(S.plan.trees, S.mpSel));
  });
};
function brushAt(p: Position) {
  if (!brush) return;
  if (brush.erase) {
    const before = S.plan.trees.length;
    S.plan.trees = S.plan.trees.filter((t) => turf.distance(t.p, p, { units: 'meters' }) > Math.max(3, canopyR(t)));
    if (S.plan.trees.length !== before) ((brush.changed = true), renderTreesSoon());
    return;
  }
  const type = trTypeNow();
  const gap = Math.max(2, Math.min(trSpacing(), treeType(type).canopyM * 0.9));
  if (brush.last && turf.distance(brush.last, p, { units: 'meters' }) < gap) return;
  if (brush.last && S.plan.trees.some((t) => turf.distance(t.p, p, { units: 'meters' }) < gap * 0.7)) return;
  S.plan.trees.push(newTree(S.plan, p, type));
  brush.last = p;
  brush.changed = true;
  renderTreesSoon();
}
map.on('mousedown', (e) => {
  if (mpPick !== 'tree' || e.originalEvent.button !== 0) return;
  e.preventDefault(); // painting, not panning
  brush = { last: null, erase: e.originalEvent.altKey, changed: false };
  brushAt([e.lngLat.lng, e.lngLat.lat]);
});
map.on('mousemove', (e) => {
  if (brush) brushAt([e.lngLat.lng, e.lngLat.lat]);
});
map.on('mouseup', () => {
  if (!brush) return;
  const changed = brush.changed;
  brush = null;
  if (changed) renderPlan();
});

function renderTreeList() {
  const sel = S.plan.trees.find((t) => t.id === S.mpSel);
  $('#treeList').innerHTML =
    TREE_TYPES.map((t) => ({ t, n: S.plan.trees.filter((x) => x.type === t.id).length }))
      .filter((x) => x.n)
      .map(({ t, n }) => `<div class="mpr" data-ttype="${t.id}"><span class="sw" style="background:${t.colour};border-radius:50%"></span><span class="grow"><b>${esc(t.label)}</b><small>${n} tree${n > 1 ? 's' : ''}</small></span><button class="link" data-act="deltt">Remove</button></div>`)
      .join('') +
    (sel
      ? `<div class="mpr on wrap" data-id="${sel.id}"><span class="grow"><b>Selected tree</b><small>Change its type; press Delete to remove it</small></span>
          <select data-f="ttype" aria-label="Tree type">${TREE_TYPES.map((t) => `<option value="${t.id}"${t.id === sel.type ? ' selected' : ''}>${esc(t.label)}</option>`).join('')}</select>
          <button class="link" data-act="del">Delete</button></div>`
      : '');
  $('#treeList').querySelectorAll<HTMLElement>('[data-act=deltt]').forEach((b) =>
    b.addEventListener('click', () => {
      const t = (b.closest('.mpr') as HTMLElement).dataset.ttype;
      S.plan.trees = S.plan.trees.filter((x) => x.type !== t);
      renderPlan();
    }),
  );
  $('#treeList').querySelector('[data-act=del]')?.addEventListener('click', () => sel && deleteMp(sel.id));
  $('#treeList').querySelector<HTMLSelectElement>('[data-f=ttype]')?.addEventListener('change', (e) => {
    if (sel) sel.type = (e.target as HTMLSelectElement).value as TreeType;
    renderPlan();
  });
}

/** Trees in the drawings: their trunk and crown slices, shaded green. */
function treeBuildings(frame: LocalFrame, white = false): AxoBuilding[] {
  return S.plan.trees.flatMap((t) =>
    treeSlices(t).map((sl) => ({
      polys: toLocalPolys(sl.shape.geometry, frame), z0: sl.base, z1: sl.top,
      look: sl.trunk ? { roof: '#7a6a55', wallLight: '#8c7b65', wallDark: '#5e5040', stroke: '#4a3f33', strokeWidth: 0.4 } : white ? { roof: '#e4eedb', wallLight: '#eef4e8', wallDark: '#cfdcc4', stroke: '#6f8a62', strokeWidth: 0.4 } : { ...lookForColour(treeType(t.type).colour), strokeWidth: 0.35 },
    })),
  );
}

// ---------------------------------------------------------------- masterplan mode: the floating workspace
// The masterplan has its own full-screen workspace with floating tool windows, kept apart from the
// analysis panels. The controls live there; the analysis sidebar only opens it.

/** Small drawings for the tool tiles. */
const tileIcon = {
  street: (w: number) => `<svg viewBox="0 0 40 26"><path d="M3 13h34" stroke="#c4c3be" stroke-width="${w + 2}" stroke-linecap="round"/><path d="M3 13h34" stroke="#fff" stroke-width="${w}" stroke-linecap="round"/>${w > 6 ? '<path d="M6 13h28" stroke="#9a9994" stroke-width="0.8" stroke-dasharray="3 2"/>' : ''}</svg>`,
  tree: (t: { canopyM: number; heightM: number; shape: string; colour: string }) => {
    const h = Math.min(24, 8 + t.heightM * 0.8), w = Math.min(30, 6 + t.canopyM * 1.4), cy = 25 - h + (t.shape === 'cone' ? 0 : w / 2.6);
    const crown = t.shape === 'cone' ? `<path d="M${20 - w / 2} ${25 - h * 0.25}L20 ${25 - h}L${20 + w / 2} ${25 - h * 0.25}Z" fill="${t.colour}"/>` : t.shape === 'column' ? `<ellipse cx="20" cy="${25 - h / 2 - 1}" rx="${w / 2}" ry="${h / 2 - 1}" fill="${t.colour}"/>` : `<ellipse cx="20" cy="${cy}" rx="${w / 2}" ry="${Math.min(w / 2.2, h / 2)}" fill="${t.colour}"/>`;
    return `<svg viewBox="0 0 40 26"><path d="M20 25V${25 - h * 0.45}" stroke="#7a6a55" stroke-width="1.6"/>${crown}</svg>`;
  },
  roundabout: `<svg viewBox="0 0 40 26"><path d="M0 13h40M20 0v26" stroke="#c4c3be" stroke-width="7"/><path d="M0 13h40M20 0v26" stroke="#fff" stroke-width="5"/><circle cx="20" cy="13" r="8" fill="#fff" stroke="#c4c3be" stroke-width="7"/><circle cx="20" cy="13" r="8" fill="none" stroke="#fff" stroke-width="5"/><circle cx="20" cy="13" r="4" fill="#d3e2c4"/></svg>`,
  space: (c: string, round: boolean) => `<svg viewBox="0 0 40 26"><rect x="6" y="3" width="28" height="20" rx="${round ? 9 : 0}" fill="${c}" stroke="${darkerHex(c)}" stroke-width="1"/></svg>`,
  house: (t: HouseType) => {
    const n = t.homes > 1 ? 2 : t.id.startsWith('terrace') || t.id === 'townhouse' ? 3 : 1;
    const w = t.id === 'bungalow' ? 22 : t.id === 'detached' ? 18 : n === 3 ? 10 : 12;
    const h = t.storeys === 1 ? 8 : t.storeys === 3 ? 15 : 11.5;
    const x0 = 20 - (n * w) / 2;
    let d = '';
    for (let i = 0; i < n; i++) {
      const x = x0 + i * w;
      d += `<path d="M${x} 24V${24 - h}L${x + w / 2} ${24 - h - 6}L${x + w} ${24 - h}V24Z" fill="${t.colour}" stroke="#fff" stroke-width="0.8"/>`;
    }
    return `<svg viewBox="0 0 40 26">${d}</svg>`;
  },
};
function darkerHex(hex: string) {
  return '#' + [1, 3, 5].map((i) => Math.round(parseInt(hex.slice(i, i + 2), 16) * 0.6).toString(16).padStart(2, '0')).join('');
}

function renderTiles() {
  const stT = $<HTMLSelectElement>('#stType').value, osT = $<HTMLSelectElement>('#osType').value, hoT = $<HTMLSelectElement>('#hoType').value;
  const px: Record<string, number> = { primary: 9, residential: 6.5, shared: 5, mews: 4, path: 2 };
  $('#stTiles').innerHTML =
    STREET_TYPES.map((t) => `<button class="tile${t.id === stT && S.drawing === 'street' ? ' on' : ''}" data-st="${t.id}" title="${esc(t.note)}">${tileIcon.street(px[t.id])}${esc(t.label)}</button>`).join('') +
    `<button class="tile${mpPick === 'roundabout' ? ' on' : ''}" data-ra="1" title="Click a junction">${tileIcon.roundabout}Roundabout</button>`;
  $('#osTiles').innerHTML = OPEN_TYPES.map((t) => `<button class="tile${t.id === osT && S.drawing === 'open' ? ' on' : ''}" data-os="${t.id}">${tileIcon.space(t.colour, +$<HTMLInputElement>('#osRound').value > 0)}${esc(t.label)}</button>`).join('');
  const trT = $<HTMLSelectElement>('#trType').value;
  $('#trTiles').innerHTML = TREE_TYPES.map((t) => `<button class="tile${t.id === trT ? ' on' : ''}" data-tr="${t.id}" title="${esc(t.note)}">${tileIcon.tree(t)}${esc(t.label)}</button>`).join('');
  $('#trTiles').querySelectorAll<HTMLElement>('[data-tr]').forEach((b) =>
    b.addEventListener('click', () => {
      $<HTMLSelectElement>('#trType').value = b.dataset.tr!;
      trNote();
      renderTiles();
    }),
  );
  $('#hoTiles').innerHTML = HOUSE_TYPES.map((t) => `<button class="tile${t.id === hoT ? ' on' : ''}" data-ho="${t.id}">${tileIcon.house(t)}${esc(t.label)}</button>`).join('');
  $('#stTiles').querySelectorAll<HTMLElement>('[data-st]').forEach((b) =>
    b.addEventListener('click', () => {
      $<HTMLSelectElement>('#stType').value = b.dataset.st!;
      stNote();
      $('#drawStreet').click();
      renderTiles();
    }),
  );
  $('#stTiles').querySelector('[data-ra]')!.addEventListener('click', () => ($('#addRoundabout').click(), renderTiles()));
  $('#osTiles').querySelectorAll<HTMLElement>('[data-os]').forEach((b) =>
    b.addEventListener('click', () => {
      $<HTMLSelectElement>('#osType').value = b.dataset.os!;
      $('#drawOpen').click();
      renderTiles();
    }),
  );
  $('#hoTiles').querySelectorAll<HTMLElement>('[data-ho]').forEach((b) =>
    b.addEventListener('click', () => {
      $<HTMLSelectElement>('#hoType').value = b.dataset.ho!;
      hoNote();
      renderTiles();
    }),
  );
}
renderTiles();
$<HTMLInputElement>('#osRound').addEventListener('change', renderTiles);
map.on('draw.create', () => setTimeout(renderTiles, 0));
map.on('draw.modechange', () => setTimeout(renderTiles, 0));

function setMpMode(on: boolean) {
  mpModeOn = on;
  if (!on) (pen.cancel(), (S.mpSel = null));
  document.body.classList.toggle('mp-mode', on);
  $('#mpMode').hidden = !on;
  setPick(null);
  if (on) {
    if (S.selected) select(null);
    if (S.view === 'atlas') setView('plan');
    if (!S.red && !S.study) toast('Draw a red line first (or a quick box) so the layout has a site to sit in.');
  }
  setTimeout(() => (map.resize(), drawLeader()), 0);
  renderPlan();
  renderTiles();
}
$('#mpOpen').onclick = () => setMpMode(true);
$('#mpClose').onclick = () => setMpMode(false);
document.querySelectorAll<HTMLButtonElement>('#mpViews [data-view]').forEach((b) => b.addEventListener('click', () => setView(b.dataset.view as View)));
document.querySelectorAll<HTMLButtonElement>('[data-fold]').forEach((b) =>
  b.addEventListener('click', () => {
    const el = document.getElementById(b.dataset.fold!)!;
    el.hidden = !el.hidden;
    b.querySelector('span')!.textContent = el.hidden ? '+' : '−';
  }),
);
$('#mpExport').onclick = async () => {
  if (!S.model) {
    if (!S.study) return toast('Draw a red line first.');
    toast('Reading the site for the drawing…');
    await analyse();
  }
  exportDrawing(S.view === 'plan' ? 'plan' : 'axo');
};

// ---- guides
const guidesSaved = (() => {
  try {
    return localStorage.getItem('ultrahand:guides') !== '0';
  } catch {
    return true;
  }
})();
$<HTMLInputElement>('#mpGuides').checked = guidesSaved;
pen.setGuides(guidesSaved);
function setGuides(on: boolean) {
  $<HTMLInputElement>('#mpGuides').checked = on;
  pen.setGuides(on);
  try {
    localStorage.setItem('ultrahand:guides', on ? '1' : '0');
  } catch { /* storage blocked */ }
}
$<HTMLInputElement>('#mpGuides').onchange = (e) => setGuides((e.target as HTMLInputElement).checked);
document.addEventListener('keydown', (e) => {
  if (!mpModeOn || e.key.toLowerCase() !== 'g' || e.ctrlKey || e.metaKey || e.altKey) return;
  if ((e.target as HTMLElement)?.closest('input,select,textarea')) return;
  setGuides(!$<HTMLInputElement>('#mpGuides').checked);
  toast($<HTMLInputElement>('#mpGuides').checked ? 'Guides on: extensions, square lines and measurements.' : 'Guides off.');
});

// ---- sketch
S.sketch = (() => {
  try {
    return localStorage.getItem('ultrahand:sketch') === '1';
  } catch {
    return false;
  }
})();
$<HTMLInputElement>('#mpSketch').checked = S.sketch;
$<HTMLInputElement>('#mpSketch').onchange = (e) => {
  S.sketch = (e.target as HTMLInputElement).checked;
  try {
    localStorage.setItem('ultrahand:sketch', S.sketch ? '1' : '0');
  } catch { /* storage blocked */ }
  renderPlanMap();
  applyMpStyle();
};

/** Sketch mode: paper over the base map, pencil lines and washes; plain mode: the crisp drawing. */
function applyMpStyle() {
  updateEditables();
  if (!map.getLayer('mp-sk-lines')) return;
  const vis = (id: string, on: boolean) => map.getLayer(id) && map.setLayoutProperty(id, 'visibility', on ? 'visible' : 'none');
  const atlas = S.view === 'atlas';
  const sk = S.sketch && !atlas;
  const flatHomes = sk && S.view === 'plan';
  vis('mp-paper', sk);
  if (map.getLayer('mp-clear')) map.setPaintProperty('mp-clear', 'fill-color', sk ? '#f9f6ef' : '#ffffff');
  vis('mp-sk-lines', sk);
  vis('mp-sk-hatch', sk);
  vis('mp-homes-flat', flatHomes);
  vis('mp-homes-3d', !atlas && !flatHomes);
  vis('mp-trees-flat', flatHomes);
  vis('mp-trees-3d', !atlas && !flatHomes);
  for (const id of ['mp-plots', 'mp-land', 'mp-street-case', 'mp-open-l']) vis(id, !atlas && !sk);
  map.setPaintProperty('mp-open-f', 'fill-opacity', sk ? 0.42 : 0.75);
  map.setPaintProperty('mp-gardens', 'fill-opacity', sk ? 0.55 : 0.9);
  map.setPaintProperty('mp-homes-3d', 'fill-extrusion-color', ['case', ['get', 'selected'], '#2433e0', ['get', sk ? 'wash' : 'colour']] as any);
}

// ---- undo and redo (streets, spaces, homes and blocks)
const undoStack: string[] = [], redoStack: string[] = [];
let restoring = false;
const snapshot = () => JSON.stringify({ plan: S.plan, blocks: S.blocks });
/** Called whenever the plan is saved: keeps a step if anything changed. */
function recordHistory() {
  if (restoring) return;
  const now = snapshot();
  if (undoStack[undoStack.length - 1] === now) return;
  undoStack.push(now);
  if (undoStack.length > 60) undoStack.shift();
  redoStack.length = 0;
  updateUndoButtons();
}
function updateUndoButtons() {
  $<HTMLButtonElement>('#mpUndo').disabled = undoStack.length < 2;
  $<HTMLButtonElement>('#mpRedo').disabled = !redoStack.length;
}
function restore(state: string) {
  restoring = true;
  try {
    const j = JSON.parse(state);
    S.plan = upgradePlan(j.plan);
    S.blocks = j.blocks ?? [];
    S.mpSel = null;
    S.blockSel = null;
    renderPlan();
    renderBlocks();
  } finally {
    restoring = false;
  }
  updateUndoButtons();
}
function undo() {
  if (undoStack.length < 2) return;
  redoStack.push(undoStack.pop()!);
  restore(undoStack[undoStack.length - 1]);
}
function redo() {
  const s = redoStack.pop();
  if (!s) return;
  undoStack.push(s);
  restore(s);
}
$('#mpUndo').onclick = undo;
$('#mpRedo').onclick = redo;
document.addEventListener('keydown', (e) => {
  if (!(e.ctrlKey || e.metaKey) || e.key.toLowerCase() !== 'z') return;
  if ((e.target as HTMLElement)?.closest('input,select,textarea') || S.drawing) return;
  e.preventDefault();
  e.shiftKey ? redo() : undo();
});

// ---------------------------------------------------------------- study area
document.querySelectorAll<HTMLButtonElement>('#studyMode button').forEach((b) =>
  b.addEventListener('click', () => {
    setStudyMode(b.dataset.mode as typeof S.studyMode);
    updateStudy();
  }),
);
$<HTMLInputElement>('#bufferM').oninput = (e) => {
  S.bufferM = +(e.target as HTMLInputElement).value;
  $('#bufferLbl').textContent = `${S.bufferM} m around the red line`;
  updateStudy();
};
document.querySelectorAll<HTMLButtonElement>('#walkMin button').forEach((b) =>
  b.addEventListener('click', () => {
    S.walkMin = +b.dataset.v!;
    document.querySelectorAll('#walkMin button').forEach((x) => x.classList.toggle('on', x === b));
    updateStudy();
  }),
);

let studySeq = 0;
async function updateStudy() {
  const seq = ++studySeq;
  let study: PolyF | null = null;
  if (S.studyMode === 'draw') study = S.drawnStudy;
  else if (S.studyMode === 'box') study = S.drawnBox;
  else if (S.red && S.studyMode === 'buffer') study = turf.buffer(S.red, S.bufferM, { units: 'meters' }) as PolyF;
  else if (S.red && S.studyMode === 'walk') {
    const fc = await isochrone(S.red);
    if (seq !== studySeq) return;
    const hit = fc.features.find((f) => f.properties?.contour === S.walkMin) as PolyF | undefined;
    if (hit) study = (turf.union(turf.featureCollection([hit, S.red as any])) as PolyF) ?? hit;
  }
  S.study = study;
  (map.getSource('study') as mapboxgl.GeoJSONSource)?.setData(study ?? empty);
  (map.getSource('mask') as mapboxgl.GeoJSONSource)?.setData(study ? maskOf(study) : empty);
  $('#studyStat').textContent = study && S.studyMode === 'box' && !S.red
    ? `Box ${boxSize(study)}, ${fmtArea(turf.area(study))}`
    : study
    ? S.red
      ? `Red line ${fmtArea(turf.area(S.red))} within a ${fmtArea(turf.area(study))} study area`
      : `Study area ${fmtArea(turf.area(study))}, no red line`
    : '';
  $<HTMLButtonElement>('#analyse').disabled = !study;
  renderLegend();
}

const walkCache = new Map<string, FeatureCollection>();
async function isochrone(f: PolyF): Promise<FeatureCollection> {
  const c = turf.centroid(f).geometry.coordinates;
  const key = c.map((v) => v.toFixed(5)).join(',');
  if (!walkCache.has(key)) {
    const r = await fetch(`https://api.mapbox.com/isochrone/v1/mapbox/walking/${c[0]},${c[1]}?contours_minutes=5,10,15&polygons=true&denoise=1&access_token=${TOKEN}`);
    walkCache.set(key, await r.json());
  }
  return walkCache.get(key)!;
}

const WORLD = [[-180, -85], [180, -85], [180, 85], [-180, 85], [-180, -85]];
function maskOf(study: PolyF | null): Feature<Polygon> {
  if (!study) return turf.polygon([WORLD]);
  const holes = study.geometry.type === 'Polygon' ? [study.geometry.coordinates[0]] : study.geometry.coordinates.map((p) => p[0]);
  return turf.polygon([WORLD, ...holes.map((h) => (turf.booleanClockwise(h) ? h : h.slice().reverse()))]);
}

// ---------------------------------------------------------------- analysis
$('#analyse').onclick = analyse;
let analyseSeq = 0;
async function analyse() {
  if (!S.study) return;
  const seq = ++analyseSeq;
  const btn = $<HTMLButtonElement>('#analyse');
  btn.disabled = true;
  const say = (t: string) => seq === analyseSeq && ($('#progress').textContent = t);
  try {
    const context = turf.buffer(S.study, 120, { units: 'meters' }) as PolyF;
    const ctxBox = turf.bbox(context);
    const poiBox = turf.bbox(turf.buffer(S.study, 1200, { units: 'meters' })!);
    const c = turf.centroid(S.red ?? S.study).geometry.coordinates as [number, number];
    say('Fetching buildings, designations and places…');

    const dsP = Promise.all(DATASETS.map((d) => fetchDataset(d.id, ctxBox).catch(() => empty)));
    // OpenStreetMap via Overpass first; if every Overpass server is busy, read places from Mapbox's tiles.
    const poiP = fetchPois(poiBox).catch((e) => (console.warn('Overpass unavailable, using Mapbox tiles', e), fetchPoisFromTiles(poiBox, TOKEN)));
    const walkP = S.red ? isochrone(S.red) : Promise.resolve(empty);
    const lpaP = fetchPlanningAuthority(c[0], c[1]);
    const placeP = S.place ? Promise.resolve(null) : reverseGeocode(c[0], c[1], TOKEN);
    const streets = await fetchStreets(ctxBox, TOKEN, say);
    say('Reading designations…');
    const ds = await dsP;
    if (seq !== analyseSeq) return;
    S.designations = { type: 'FeatureCollection', features: ds.flatMap((x) => x.features) };
    DATASETS.forEach((d, i) => (map.getSource(`ds-${d.id}`) as mapboxgl.GeoJSONSource).setData(ds[i]));

    say('Building the site model…');
    S.model = buildModel(streets, S.study, S.red, context, S.designations);
    S.modelFC = modelGeoJSON(S.model);
    S.metrics = computeMetrics(S.model, S.study, S.red);
    S.people = null;
    peopleError = '';
    lidar = null;
    lidarInfo = null;
    S.atlas = null;
    S.atlasT = 0;
    (map.getSource('model') as mapboxgl.GeoJSONSource).setData(S.modelFC);

    S.pois = await poiP;
    (map.getSource('pois') as mapboxgl.GeoJSONSource).setData({
      type: 'FeatureCollection',
      features: S.pois.map((p) => ({ type: 'Feature', geometry: { type: 'Point', coordinates: [p.lon, p.lat] }, properties: { cat: p.cat, name: p.name } })),
    });
    S.walk = await walkP;
    const walkLines: Feature[] = [];
    for (const f of S.walk.features) {
      const l: any = turf.polygonToLine(f as any);
      for (const x of l.type === 'FeatureCollection' ? l.features : [l]) walkLines.push({ ...x, properties: { contour: f.properties?.contour } });
    }
    (map.getSource('walk') as mapboxgl.GeoJSONSource).setData({ type: 'FeatureCollection', features: walkLines });
    S.lpa = await lpaP;
    const pl = await placeP;
    if (pl) S.place = [pl.street, pl.place].filter(Boolean).join(', ');
    if (S.place && isPrimarySite()) Allto?.update({ place: S.place, ...(Allto.project().name ? {} : { name: S.place }) }, PRODUCT);
    if (seq !== analyseSeq) return;

    map.setLayoutProperty('context-3d', 'visibility', 'none');
    renderLayerList();
    applyVisibility();
    renderSummary();
    renderLegend();
    select(null);
    ['#expAxo', '#expPlan', '#expAtlas', '#expSun', '#expDxf', '#expObj'].forEach((s) => ($<HTMLButtonElement>(s).disabled = false));
    surfaceWater = null;
    if (S.red)
      surfaceWaterOn(S.red)
        .then((w) => seq === analyseSeq && ((surfaceWater = w), renderSummary(), agent.contextChanged()))
        .catch(() => {});
    transitAccess(seq);
    peopleBusy = true;
    fetchPeople(S.study)
      .then((p) => {
        if (seq !== analyseSeq) return;
        S.people = p;
        (map.getSource('imd') as mapboxgl.GeoJSONSource).setData(p.map);
        renderLayerList();
        agent.contextChanged();
      })
      .catch((e) => (peopleError = (e as Error).message))
      .finally(() => ((peopleBusy = false), seq === analyseSeq && renderSummary()));
    say('');
    if (S.view === 'axo' || S.view === '3d') animateGrow();
    agent.contextChanged();
  } catch (e) {
    console.error(e);
    say(`Something failed: ${(e as Error).message}`);
  } finally {
    btn.disabled = !S.study;
  }
}

// ---------------------------------------------------------------- start again
function resetAll(home: boolean) {
  analyseSeq++;
  studySeq++;
  cancelAnimationFrame(growRAF);
  cancelAnimationFrame(atlasRAF);
  hideAtlasRefs();
  clearWalk();
  walkNet = null;
  surfaceWater = null;
  transit = null;
  lidar = null;
  lidarInfo = null;
  clearSection();
  if (map.getLayer('contours')) map.setLayoutProperty('contours', 'visibility', 'none');
  (map.getSource('contours') as mapboxgl.GeoJSONSource | undefined)?.setData(empty);
  editingBlock = null;
  setPick(null);
  setTimeout(renderBlocks, 0);
  setTimeout(renderPlan, 0);
  select(null);
  draw.deleteAll();
  Object.assign(S, {
    red: null, study: null, drawnStudy: null, drawnBox: null, drawing: null, model: null, modelFC: empty, designations: empty,
    pois: [], place: '', lpa: null, walk: empty, massing: 0, atlas: null, atlasT: 0, metrics: null, blocks: [], blockSel: null, people: null, plan: emptyPlan(), mpSel: null,
  });
  for (const id of ['mask', 'red', 'study', 'walk', 'model', 'pois', 'selected', 'massing', 'imd', 'atlas-labels', ...DATASETS.map((d) => `ds-${d.id}`)])
    (map.getSource(id) as mapboxgl.GeoJSONSource | undefined)?.setData(empty);
  searchBox.value = '';
  $('#results').innerHTML = '';
  $('#clearSearch').hidden = true;
  $<HTMLInputElement>('#massing').value = '0';
  $('#progress').textContent = '';
  $('#area').hidden = true;
  $('#area').innerHTML = '';
  ['#expAxo', '#expPlan', '#expAtlas', '#expSun', '#expDxf', '#expObj'].forEach((s) => ($<HTMLButtonElement>(s).disabled = true));
  setRed(null);
  try {
    localStorage.removeItem(KEY);
  } catch { /* storage blocked */ }
  if (map.getLayer('building')) map.setLayoutProperty('building', 'visibility', 'visible');
  S.view = 'plan';
  setView('plan', { quiet: true });
  map.easeTo({ pitch: 0, bearing: 0, ...(home ? { zoom: Math.min(map.getZoom(), 16) } : {}), duration: 600 });
  renderLayerList();
  renderLegend();
}

// ---------------------------------------------------------------- layers (accordions)
const GROUPS = ['Heritage', 'Environment', 'Planning', 'Movement', 'People'] as const;
function renderLayerList() {
  const counts = new Map<string, number>();
  const study = S.study;
  if (study)
    for (const f of S.designations.features) {
      const id = f.properties?.dataset;
      if (f.geometry && safe(() => turf.booleanIntersects(f as any, study), false)) counts.set(id, (counts.get(id) ?? 0) + 1);
    }
  const row = (id: string, label: string, color: string, point: boolean, n: string) =>
    `<label class="lyr"><input type="checkbox" data-l="${id}" ${S.visible.has(id) ? 'checked' : ''}/><span class="sw ${point ? 'pt' : ''}" style="border-color:${color};background:${color}33"></span>${label}<span class="n">${n}</span></label>`;
  let html = '';
  for (const g of GROUPS) {
    const rows =
      g === 'People'
        ? row('imd', 'Deprivation by neighbourhood (2019)', '#8a2846', false, S.people ? String(S.people.lsoas.length) : '')
        : g === 'Movement'
        ? row('walk', 'Walking reach 5 · 10 · 15 min', '#f08a1c', false, '') + row('pois', 'Transport & everyday places', '#141414', true, S.pois.length ? String(S.pois.length) : '') + row('labels', 'Street names', '#999', false, '')
        : DATASETS.filter((d) => d.group === g).map((d) => row(d.id, d.label, d.color, d.kind === 'point', S.model ? String(counts.get(d.id) ?? 0) : '')).join('') +
          (g === 'Environment' ? row('rofsw', 'Surface water flood risk (EA)', '#2f7ee0', false, '') : '') +
          (g === 'Planning' ? (WORKER_BASE ? row('parcels', 'Land Registry parcels (zoom in)', '#7a5c3a', false, '') : '<p class="lyr-note">Land Registry parcels appear once the allto Worker is set up.</p>') : '');
    const ids = g === 'People' ? ['imd'] : g === 'Movement' ? ['walk', 'pois', 'labels'] : [...DATASETS.filter((d) => d.group === g).map((d) => d.id), ...(g === 'Environment' ? ['rofsw'] : []), ...(g === 'Planning' ? ['parcels'] : [])];
    const on = ids.filter((i) => S.visible.has(i)).length;
    const open = S.openGroups.has(g);
    html += `<div class="acc"><button data-g="${g}"><span>${g}${on ? `<span class="on-count">${on} on</span>` : ''}</span><span class="pm">${open ? '−' : '+'}</span></button>${open ? `<div class="body">${rows}</div>` : ''}</div>`;
  }
  $('#layers').innerHTML = html;
  $('#layers').querySelectorAll<HTMLButtonElement>('[data-g]').forEach((b) =>
    b.addEventListener('click', () => {
      const g = b.dataset.g!;
      S.openGroups.has(g) ? S.openGroups.delete(g) : S.openGroups.add(g);
      renderLayerList();
    }),
  );
  $('#layers').querySelectorAll<HTMLInputElement>('input[data-l]').forEach((cb) =>
    cb.addEventListener('change', () => {
      cb.checked ? S.visible.add(cb.dataset.l!) : S.visible.delete(cb.dataset.l!);
      applyVisibility();
      setModelColours();
      renderLayerList();
      renderLegend();
    }),
  );
}

function applyVisibility() {
  const vis = (id: string, on: boolean) => map.getLayer(id) && map.setLayoutProperty(id, 'visibility', on ? 'visible' : 'none');
  const atlas = S.view === 'atlas';
  const flat = S.view === 'plan'; // point markers read in plan; in 3D the tinted buildings carry it
  for (const d of DATASETS) {
    const on = !atlas && S.visible.has(d.id);
    vis(`ds-${d.id}-f`, on);
    vis(`ds-${d.id}-l`, on);
  }
  vis('ds-listed', flat && S.visible.has('listed-building'));
  vis('ds-brownfield', flat && S.visible.has('brownfield-land'));
  vis('walk', !atlas && S.visible.has('walk'));
  vis('imd-fill', !atlas && S.visible.has('imd'));
  vis('rofsw', !atlas && S.visible.has('rofsw'));
  vis('parcels', !atlas && S.visible.has('parcels'));
  vis('imd-line', !atlas && S.visible.has('imd'));
  vis('walkpt', !atlas);
  if (walkMarker) walkMarker.getElement().style.display = atlas ? 'none' : '';
  const wp = document.getElementById('walkPanel');
  if (wp && walkMarker) wp.hidden = atlas;
  vis('pois', flat && S.visible.has('pois'));
  vis('pois-label', flat && S.visible.has('pois'));
  for (const id of ['red-fill', 'red-line', 'study-line', 'massing-3d', 'selected-line', 'blocks-3d', 'blocks-line', 'mp-gardens', 'mp-plots', 'mp-open-f', 'mp-open-l', 'mp-land', 'mp-street-sel', 'mp-path-sel', 'mp-street-case', 'mp-street', 'mp-path', 'mp-islands', 'mp-homes-3d', 'mp-trees-3d']) vis(id, !atlas);
  [...blockMarkers, ...streetMarkers].forEach((mk) => (mk.getElement().style.display = atlas ? 'none' : ''));
  vis('mp-homes-flat', false);
  applyMpStyle();
  vis('atlas-labels', atlas);
  for (const l of map.getStyle()?.layers ?? []) if (l.type === 'symbol' && /road-label|road-number|road-exit|street/.test(l.id)) vis(l.id, !atlas && S.visible.has('labels'));
}

// ---------------------------------------------------------------- summary (left) + legend (right)
function renderSummary() {
  const m = S.model!;
  const inStudy = m.buildings.filter((b) => b.inStudy);
  const known = inStudy.filter((b) => b.heightKnown);
  const tallest = known.reduce<Bldg | null>((t, b) => (!t || b.h > t.h ? b : t), null);
  const listed = inStudy.reduce((n, b) => n + b.listed.length, 0);
  const onRed = S.red ? S.designations.features.filter((f) => f.geometry && safe(() => turf.booleanIntersects(f as any, S.red!), false)) : [];
  const c = turf.centroid(S.red ?? S.study!).geometry.coordinates;
  const near = (cat: string) => S.pois.filter((p) => p.cat === cat).map((p) => ({ p, d: turf.distance(c, [p.lon, p.lat], { units: 'meters' }) })).sort((a, b) => a.d - b.d);
  const rail = near('rail')[0];
  const buses = near('bus').filter((x) => x.d <= 400).length;
  const colorOf = (id: string) => DATASETS.find((d) => d.id === id)?.color ?? '#999';
  const ha = turf.area(S.study!) / 10000;

  $('#area').hidden = false;
  $('#area').innerHTML = `
    <h3>The area${S.place ? ` · ${esc(S.place)}` : ''}</h3>
    <p class="big"><b>${ha < 10 ? ha.toFixed(1) : Math.round(ha)} ha</b> · <b>${inStudy.length}</b> buildings${tallest ? `, the tallest about <b>${Math.round(tallest.h)} m</b>` : ''}</p>
    <p class="muted">${known.length} heights recorded, the rest estimated at 6 m. ${listed} listed building entries.${S.lpa ? ` ${esc(S.lpa)}.` : ''}</p>
    <p><button class="link strong" id="drawAnother">Draw another area</button></p>
    ${townscapeHTML()}
    ${accessHTML()}
    ${terrainHTML()}
    ${peopleHTML()}
    <h4>On the red line</h4>
    ${onRed.length ? onRed.map((f) => `<div class="desig"><span class="sw" style="background:${colorOf(f.properties?.dataset)}"></span><a href="${entityUrl(f)}" target="_blank">${esc(describe(f))}</a></div>`).join('') : `<p class="muted">${S.red ? 'No designations touch the red line.' : 'No red line drawn.'}</p>`}
    <h4>Getting about</h4>
    ${rail ? `<p>Nearest station: <b>${esc(rail.p.name)}</b>, ${fmtDist(rail.d)}</p>` : '<p class="muted">No station within 1.2 km.</p>'}
    <p>${buses} bus stops within 400 m</p>`;
  $('#drawAnother').onclick = () => resetAll(false);
  bindTerrain();
}

// ---------------------------------------------------------------- surface water and public transport access
let surfaceWater: SurfaceWater | null = null;
let transit: { bus: { name: string; min: number }[]; rail: { name: string; kind: string; min: number }[] } | null = null;

/** Stops and stations by walking time along the streets from the site (not straight lines). */
async function transitAccess(seq: number) {
  transit = null;
  try {
    if (!S.study) return;
    if (!walkNet || walkNet.study !== S.study) {
      const area = turf.buffer(S.study, WALK_LIMIT + 100, { units: 'meters' })!;
      const c = turf.centroid(S.study).geometry.coordinates;
      const frame = new LocalFrame(c[0], c[1]);
      const lines = await fetchWalkNetwork(turf.bbox(area), TOKEN);
      walkNet = { study: S.study, frame, lines, graph: buildGraph(lines, frame) };
    }
    if (seq !== analyseSeq) return;
    const { graph, frame } = walkNet;
    const from = turf.centroid(S.red ?? S.study).geometry.coordinates as [number, number];
    const res = walkFrom(graph, frame.toLocal(from), 1000);
    if (!res) return;
    const mins = (p: Poi) => {
      const d = distanceTo(graph, res.dist, frame.toLocal([p.lon, p.lat]));
      return d == null ? null : d / WALK_SPEED;
    };
    const bus = S.pois.filter((p) => p.cat === 'bus').map((p) => ({ name: p.name, min: mins(p) })).filter((x): x is { name: string; min: number } => x.min != null && x.min <= 5).sort((a, b) => a.min - b.min);
    const rail = S.pois.filter((p) => p.cat === 'rail').map((p) => ({ name: p.name, kind: p.kind, min: mins(p) })).filter((x): x is { name: string; kind: string; min: number } => x.min != null && x.min <= 12).sort((a, b) => a.min - b.min);
    // One entry per named stop (a stop often has a node per platform or side of the road).
    const uniq = <T extends { name: string }>(xs: T[]) => xs.filter((x, i) => xs.findIndex((y) => y.name === x.name) === i);
    transit = { bus: uniq(bus), rail: uniq(rail) };
    renderSummary();
    agent.contextChanged();
  } catch (e) {
    console.warn('transit access', e);
  }
}

function accessHTML() {
  const out: string[] = [];
  if (transit) {
    out.push(`<h4>Public transport access</h4>
      <p>${transit.rail.length ? transit.rail.slice(0, 4).map((r) => `<b>${esc(r.name)}</b> (${r.kind}) ${Math.max(1, Math.round(r.min))} min`).join(', ') + ' walk' : 'No station or tram stop within a 12 minute walk.'}</p>
      <p>${transit.bus.length} bus stop${transit.bus.length === 1 ? '' : 's'} within a 5 minute walk${transit.bus.length ? `, nearest ${esc(transit.bus[0].name)} (${Math.max(1, Math.round(transit.bus[0].min))} min)` : ''}.</p>
      <p class="muted fine">Walking times along the streets from the ${S.red ? 'red line' : 'study area'}'s centre at 4.8 km/h. Stops from OpenStreetMap; service frequencies are not included.</p>`);
  }
  if (surfaceWater) {
    const b = Object.entries(surfaceWater.bands).filter(([, v]) => v >= 1);
    out.push(`<h4>Surface water flood risk</h4>
      <p>${b.length ? `On the red line: ${b.map(([k, v]) => `<b>${k.toLowerCase()}</b> risk ${v / surfaceWater!.siteM2 < 0.005 ? 'under 1%' : pct(v / surfaceWater!.siteM2)}`).join(', ')}.` : 'No surface water flood risk recorded on the red line.'}</p>
      <p class="muted fine">Environment Agency national assessment (2025), read at ${surfaceWater.sampled} points across the site. Not a flood risk assessment. Map: Environment in the layers.</p>`);
  }
  return out.join('');
}

// ---------------------------------------------------------------- people and place (Census 2021, IMD 2019)
let peopleBusy = false;
let peopleError = '';
function peopleHTML() {
  if (!S.model) return '';
  const p = S.people;
  if (!p) return `<h4>People and place</h4><p class="muted">${peopleBusy ? 'Reading the 2021 census and deprivation figures…' : peopleError || ''}</p>`;
  const P = (x: number) => `${Math.round(x * 100)}%`;
  return `<h4>People and place</h4>
    <p>The ${p.lsoas.length} census neighbourhoods overlapping the study area: <b>${p.residents.toLocaleString('en-GB')}</b> residents in ${p.households.toLocaleString('en-GB')} households, ${Math.round(p.densityPerHa)} people per hectare.</p>
    <table class="metrics">
      <tr><th>Age</th><td>${P(p.age.under15)} under 15 · ${P(p.age.age15to64)} 15–64 · ${P(p.age.over65)} 65+</td></tr>
      <tr><th>Homes</th><td>${P(p.accommodation.flats)} flats · ${P(p.accommodation.terracedOrSemi)} terraced or semi · ${P(p.accommodation.detached)} detached</td></tr>
      <tr><th>Tenure</th><td>${P(p.tenure.owned)} owned · ${P(p.tenure.privateRented)} private rent · ${P(p.tenure.socialRented)} social rent${p.tenure.sharedOwnership >= 0.01 ? ` · ${P(p.tenure.sharedOwnership)} shared` : ''}</td></tr>
      <tr><th>No car</th><td>${P(p.noCar)} of households</td></tr>
      <tr><th>To work</th><td>${P(p.travel.home)} at home · ${P(p.travel.walk)} walk · ${P(p.travel.cycle)} cycle · ${P(p.travel.publicTransport)} public transport · ${P(p.travel.car)} car</td></tr>
      ${p.imd.mostDeprivedDecile ? `<tr><th>Deprivation</th><td>deciles ${p.imd.mostDeprivedDecile} to ${p.imd.leastDeprivedDecile} (1 = the most deprived 10% in England)</td></tr>` : ''}
    </table>
    <p class="muted fine">Census 2021 (ONS, Nomis) for the 2021 neighbourhoods (LSOAs), which extend beyond the study area. Deprivation: English Indices of Deprivation 2019${p.imd.changedBoundaries ? `; ${p.imd.changedBoundaries} neighbourhood${p.imd.changedBoundaries > 1 ? 's' : ''} redrawn in 2021 ha${p.imd.changedBoundaries > 1 ? 've' : 's'} no 2019 score` : ''}. Map: People in the layers.</p>`;
}

// ---------------------------------------------------------------- LIDAR: heights, ground, section, contours
let lidar: Lidar | null = null;
let lidarInfo: { measured: number; total: number; ground: ReturnType<typeof groundLevels> } | null = null;
let lidarBusy = false;

function terrainHTML() {
  if (!S.model) return '';
  const g = lidarInfo?.ground;
  return `<h4>Terrain and heights</h4>
    ${
      lidarInfo
        ? `<p>Heights measured from LIDAR for <b>${lidarInfo.measured}</b> of ${lidarInfo.total} buildings; the rest keep their OpenStreetMap heights.</p>
           ${g ? `<p>Ground ${S.red ? 'on the red line' : 'in the study area'}: ${g.min.toFixed(1)} to ${g.max.toFixed(1)} m AOD (a fall of ${g.fall.toFixed(1)} m).</p>` : ''}
           <div class="row wrap"><button class="ghost" id="sectionBtn">Draw a section</button><label class="inline"><input type="checkbox" id="contourCb" ${map.getLayoutProperty('contours', 'visibility') === 'visible' ? 'checked' : ''}> 1 m contours</label></div>`
        : `<p class="muted">Measure every building's height and the ground levels from the Environment Agency's 1 m LIDAR (open data). Also gives sections and contours.</p>
           <button class="ghost" id="lidarBtn" ${lidarBusy ? 'disabled' : ''}>${lidarBusy ? 'Measuring…' : 'Measure with LIDAR'}</button>`
    }`;
}

function bindTerrain() {
  document.getElementById('lidarBtn')?.addEventListener('click', () => measureLidar());
  document.getElementById('sectionBtn')?.addEventListener('click', startSection);
  document.getElementById('contourCb')?.addEventListener('change', (e) => toggleContours((e.target as HTMLInputElement).checked));
}

async function ensureLidar() {
  if (lidar) return lidar;
  lidar = await fetchLidar(turf.bbox(S.study!) as [number, number, number, number]);
  return lidar;
}

/**
 * New homes are drawn with real roofs (eaves and ridge); existing buildings are flat blocks at an estimated
 * height unless measured. Say so beside the masterplan, with a way to measure them, so the two compare fairly.
 */
function renderMpContext() {
  const el = $('#mpContext');
  el.hidden = !mpModeOn || !S.plan.homes.length;
  if (el.hidden) return;
  if (lidarInfo) {
    el.innerHTML = `<p class="hint">Existing heights measured from LIDAR for ${lidarInfo.measured} of ${lidarInfo.total} buildings, to their main roof. New 2-storey homes: 5.3 m to the eaves, 8.5 m to the ridge.</p>`;
    return;
  }
  el.innerHTML = `<p class="hint"><b>Comparing heights?</b> New homes have real roofs (2 storeys: 5.3 m eaves, 8.5 m ridge). Existing buildings are flat blocks at estimated heights, 6 m where none is recorded, so they look lower than they are.</p>
    <button class="ghost" id="mpLidar" ${lidarBusy ? 'disabled' : ''}>${lidarBusy ? 'Measuring…' : 'Measure existing heights with LIDAR'}</button>`;
  $('#mpLidar').onclick = async () => {
    if (!S.study) return toast('Draw a red line first.');
    if (!S.model) {
      toast('Reading the site first…');
      await analyse();
    }
    await measureLidar();
    renderMpContext();
  };
}

async function measureLidar() {
  if (!S.model || !S.study || lidarBusy) return;
  lidarBusy = true;
  renderSummary();
  try {
    const l = await ensureLidar();
    let measured = 0;
    const inStudy = S.model.buildings.filter((b) => b.inStudy);
    for (const b of inStudy) {
      const r = measureBuilding(l, b.feature);
      if (!r) continue;
      b.osmH ??= b.heightKnown ? b.h : undefined;
      b.h = r.heightM;
      b.minH = Math.min(b.minH, b.h - 1);
      b.heightKnown = true;
      b.heightSource = 'lidar';
      b.groundM = r.groundM;
      measured++;
    }
    lidarInfo = { measured, total: inStudy.length, ground: groundLevels(l, (S.red ?? S.study) as any) };
    S.modelFC = modelGeoJSON(S.model);
    (map.getSource('model') as mapboxgl.GeoJSONSource).setData(S.atlasT > 0 ? atlasFC(S.atlasT) : S.modelFC);
    S.metrics = computeMetrics(S.model, S.study, S.red);
    toast(`Heights measured from LIDAR for ${measured} of ${inStudy.length} buildings.`);
    if (S.view === 'axo' || S.view === '3d') animateGrow();
    if (S.selected) renderCard(S.selected, null);
    agent.contextChanged();
  } catch (e) {
    toast((e as Error).message || 'Could not reach the LIDAR service just now.');
  } finally {
    lidarBusy = false;
    renderSummary();
  }
}

async function toggleContours(on: boolean) {
  if (on && !(map.getSource('contours') as any)._data?.features?.length) {
    try {
      const l = await ensureLidar();
      (map.getSource('contours') as mapboxgl.GeoJSONSource).setData(contourLines(l, 1));
    } catch (e) {
      return toast((e as Error).message);
    }
  }
  map.setLayoutProperty('contours', 'visibility', on ? 'visible' : 'none');
}

// Section: two clicks on the map, A then A′.
let sectionA: [number, number] | null = null;
let sectionMarks: mapboxgl.Marker[] = [];
function startSection() {
  if (S.view !== 'plan') setView('plan');
  S.drawing = 'section';
  sectionA = null;
  clearSection();
  map.getCanvas().style.cursor = 'crosshair';
  toast('Click the start of the section (A), then the end (A′).');
}
function clearSection() {
  sectionMarks.forEach((m) => m.remove());
  sectionMarks = [];
  (map.getSource('section-line') as mapboxgl.GeoJSONSource | undefined)?.setData(empty);
}
function sectionMark(ll: [number, number], text: string) {
  const el = document.createElement('span');
  el.className = 'section-mark';
  el.textContent = text;
  sectionMarks.push(new mapboxgl.Marker({ element: el }).setLngLat(ll).addTo(map));
}
map.on('mousemove', (e) => {
  if (S.drawing !== 'section' || !sectionA) return;
  (map.getSource('section-line') as mapboxgl.GeoJSONSource).setData(turf.lineString([sectionA, [e.lngLat.lng, e.lngLat.lat]]));
});
map.on('click', async (e) => {
  if (S.drawing !== 'section') return;
  const ll: [number, number] = [e.lngLat.lng, e.lngLat.lat];
  if (!sectionA) {
    sectionA = ll;
    sectionMark(ll, 'A');
    return;
  }
  const a = sectionA;
  sectionA = null;
  S.drawing = null;
  lastDrawEnd = Date.now();
  map.getCanvas().style.cursor = '';
  sectionMark(ll, 'A′');
  (map.getSource('section-line') as mapboxgl.GeoJSONSource).setData(turf.lineString([a, ll]));
  try {
    toast('Reading the ground along the section…');
    const l = await ensureLidar();
    const prof = profile(l, [a, ll]);
    const pts: SectionPoint[] = prof.points.map((p) => {
      const pt = turf.point(p.ll);
      const blk = S.blocks.find((b) => turf.booleanPointInPolygon(pt, b.shape));
      return {
        d: p.d,
        ground: p.ground,
        surface: p.surface,
        inSite: !!S.red && turf.booleanPointInPolygon(pt, S.red as any),
        proposed: blk ? { base: blk.baseM, top: blk.baseM + heightOf(blk), colour: useOf(blk.use).colour, name: blk.name } : null,
      };
    });
    showExport(sectionSVG(pts, { title: `Section A–A′${S.place ? ` · ${esc(S.place)}` : ''} · ${Math.round(prof.len)} m` }), `${slug(S.place || 'site')}-section`);
  } catch (err) {
    toast((err as Error).message || 'Could not read the LIDAR along that line.');
  }
});

/** Floor areas are quoted in square metres, rounded to a sensible figure. */
const m2 = (x: number) => `${(x >= 10000 ? Math.round(x / 100) * 100 : Math.round(x)).toLocaleString('en-GB')} m²`;

/** Townscape measures for the study area and, with a red line, the site. */
function townscapeHTML() {
  const t = S.metrics;
  if (!t) return '';
  const row = (k: string, a: string, b?: string | null) => `<tr><th>${k}</th><td>${a}</td>${t.site ? `<td>${b ?? '—'}</td>` : ''}</tr>`;
  const s = t.study, r = t.site;
  return `<h4>Townscape</h4>
    <table class="metrics">
      ${t.site ? '<tr><th></th><td class="muted">Study area</td><td class="muted">Red line</td></tr>' : ''}
      ${row('Coverage', pct(s.coverage), r && pct(r.coverage))}
      ${row('Plot ratio', `about ${ratio(s.plotRatio)}`, r && `about ${ratio(r.plotRatio)}`)}
      ${row('Floor area', `about ${m2(s.gfaM2)}`, r && `about ${m2(r.gfaM2)}`)}
      ${row('Average storeys', s.meanStoreys.toFixed(1), r && (r.buildings ? r.meanStoreys.toFixed(1) : '—'))}
      ${row('Buildings', String(s.buildings), r && String(r.buildings))}
    </table>
    <p class="muted">Heights: median ${Math.round(t.heights.median)} m, tallest ${Math.round(t.heights.tallest)} m (${t.heights.known} recorded). Grain: median footprint ${fmtArea(t.grainM2)}. Streets and paths: ${t.streetKmPerKm2.toFixed(0)} km per km².</p>
    <div class="hbars">${t.heights.bands
      .map((b) => `<div class="hb"><span>${b.label}</span><i style="width:${s.buildings ? (b.count / s.buildings) * 100 : 0}%"></i><b>${b.count}</b></div>`)
      .join('')}</div>
    <p class="muted fine">Floor areas are estimates from height at ${3.2} m a storey.</p>`;
}

function renderLegend() {
  const m = S.model;
  const n = m ? m.buildings.filter((b) => b.inStudy).length : 0;
  const plan = S.view === 'plan' || S.view === 'atlas';
  const sw = (bg: string, extra = '') => `<span class="sw" style="background:${bg};${extra}"></span>`;
  $('#legend').innerHTML = `
    <div class="lg">${m ? `<b>${n}</b>&nbsp;in the study area` : '<span class="muted">Analyse the site to read the buildings</span>'}</div>
    <div class="lg">${sw(plan ? '#232323' : '#fff', plan ? '' : 'border:1px solid #888')}Building</div>
    ${S.visible.has('listed-building') && m ? `<div class="lg">${sw(plan ? '#5d3d7d' : '#c9b2de')}Listed building</div>` : ''}
    ${S.red ? (S.view === 'atlas' ? `<div class="lg">${sw('#d7262e')}On the site</div>` : `<div class="lg">${sw('transparent', 'border:2.5px solid #d7262e')}Red line</div>`) : ''}
    ${S.study ? `<div class="lg">${sw('transparent', 'border:1.5px dashed #141414')}Study area</div>` : ''}
    ${S.selected ? `<div class="lg">${sw('#2433e0')}Selected: ${S.selected.ref}</div>` : ''}
    ${S.view === 'atlas' ? '' : mpLegend(sw)}`;
}

/** Key for the masterplan: only what is on the drawing. */
function mpLegend(sw: (bg: string, extra?: string) => string) {
  const P = S.plan;
  if (!P.streets.length && !P.open.length && !P.homes.length && !P.trees.length) return '';
  const rows: string[] = [];
  if (P.streets.length) rows.push(`<div class="lg">${sw('#ebebeb', 'border:1px solid #c9c8c3')}Proposed streets</div>`);
  for (const t of HOUSE_TYPES) if (P.homes.some((h) => h.type === t.id && h.tenure === 'market')) rows.push(`<div class="lg">${sw(t.colour)}${esc(t.label)}</div>`);
  if (P.homes.some((h) => h.tenure === 'affordable')) rows.push(`<div class="lg">${sw(AFFORDABLE_COLOUR)}Affordable homes</div>`);
  if (P.homes.some((h) => h.garden)) rows.push(`<div class="lg">${sw('#e3ecd8', 'border:1px solid #b9b8b2')}Gardens and plots</div>`);
  for (const t of OPEN_TYPES) if (P.open.some((o) => o.type === t.id)) rows.push(`<div class="lg">${sw(t.colour)}${esc(t.label)}</div>`);
  for (const t of TREE_TYPES) if (P.trees.some((x) => x.type === t.id)) rows.push(`<div class="lg">${sw(t.colour, 'border-radius:50%;width:11px;height:11px')}${esc(t.label)}</div>`);
  return `<div class="lg"><b>Masterplan</b></div>${rows.join('')}`;
}

// ---------------------------------------------------------------- selection + leader line
let hoverId: number | null = null;
map.on('mousemove', 'model-3d', (e) => {
  if (S.drawing) return;
  map.getCanvas().style.cursor = 'pointer';
  const id = e.features?.[0]?.id as number;
  if (hoverId !== null && hoverId !== id) map.setFeatureState({ source: 'model', id: hoverId }, { hover: false });
  hoverId = id;
  map.setFeatureState({ source: 'model', id }, { hover: true });
});
map.on('mouseleave', 'model-3d', () => {
  map.getCanvas().style.cursor = '';
  if (hoverId !== null) map.setFeatureState({ source: 'model', id: hoverId }, { hover: false });
  hoverId = null;
});
let walkPick = false;
function setWalkPick(on: boolean) {
  walkPick = on;
  if (on) setPick(null);
  const b = $('#walkBtn');
  b.classList.toggle('on', on);
  b.textContent = on ? 'Click a spot on the map…' : 'Walk from a point';
  map.getCanvas().style.cursor = on ? 'crosshair' : '';
}
$('#walkBtn').onclick = () => {
  if (walkPick) return setWalkPick(false);
  if (!S.study) return toast('Draw a red line or a study area first, then walk from a point in it.');
  if (S.view === 'atlas' || S.view === 'eye') setView('plan');
  setWalkPick(true);
  toast('Click a spot to see 5, 10 and 15 minute walks from it. Esc to cancel.');
};
document.addEventListener('keydown', (e) => e.key === 'Escape' && walkPick && setWalkPick(false));
let lastDrawEnd = 0; // the click that finishes a drawing must not also start a walk
map.on('click', (e) => {
  if (S.drawing || pen.active() || eye.dragged || Date.now() - lastDrawEnd < 400) return;
  // Walking distances only once "Walk from a point" has been pressed: the next click is the start.
  if (walkPick) {
    setWalkPick(false);
    walkFromPoint([e.lngLat.lng, e.lngLat.lat]);
    return;
  }
  if (S.view !== 'atlas' && mpClick(e)) return;
  const bh = map.queryRenderedFeatures(e.point, { layers: ['blocks-3d'] })[0];
  if (bh) {
    S.blockSel = String(bh.properties?.id);
    renderBlocks();
    document.querySelector(`#blockList [data-b="${S.blockSel}"]`)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    return;
  }
  const hit = S.model ? map.queryRenderedFeatures(e.point, { layers: ['model-3d'] })[0] : undefined;
  if (S.model) select(hit ? S.model.buildings[hit.id as number] : null);
});

let osmSeq = 0;
function select(b: Bldg | null) {
  if (S.selected && map.getSource('model')) map.setFeatureState({ source: 'model', id: S.selected.idx }, { selected: false });
  S.selected = b;
  (map.getSource('selected') as mapboxgl.GeoJSONSource)?.setData(b ? b.feature : empty);
  $('#card').hidden = !b;
  if (!b) {
    $('#card').innerHTML = '';
    renderLegend();
    return void drawLeader();
  }
  map.setFeatureState({ source: 'model', id: b.idx }, { selected: true });
  renderCard(b, null);
  agent.contextChanged();
  renderLegend();
  const seq = ++osmSeq;
  fetchBuildingAt(b.ll[0], b.ll[1]).then((o) => seq === osmSeq && S.selected === b && renderCard(b, o?.tags ?? {}));
  drawLeader();
}

function renderCard(b: Bldg, tags: Record<string, string> | null) {
  const use = tags ? useLabel(tags, b.type) : b.type === 'building' ? '…' : useLabel({}, b.type);
  const name = tags?.name || b.places[0];
  const colorOf = (id: string) => DATASETS.find((d) => d.id === id)?.color ?? '#999';
  const study = S.model!.buildings.filter((x) => x.inStudy).sort((x, y) => x.ref.localeCompare(y.ref));
  const i = study.indexOf(b);
  $('#card').innerHTML = `
    <span class="anchor" id="anchor"></span>
    <div class="ref">${b.ref}${b.inSite ? ' · on the site' : b.inStudy ? '' : ' · context'}</div>
    <h1>${esc(name || use)}</h1>
    <p class="muted">${name ? esc(use) : ''}${tags?.['addr:street'] ? ` · ${esc([tags['addr:housenumber'], tags['addr:street']].filter(Boolean).join(' '))}` : ''}</p>
    <h4>Identity and form</h4>
    <dl class="kv">
      <dt>Height</dt><dd>${b.heightKnown ? `${b.h.toFixed(1)} m <span class="muted">${b.heightSource === 'lidar' ? 'LIDAR' : 'OpenStreetMap'}</span>` : '<span class="muted">not recorded (6 m drawn)</span>'}</dd>
      ${b.groundM != null ? `<dt>Ground</dt><dd>${b.groundM.toFixed(1)} m AOD</dd>` : ''}
      ${tags?.['building:levels'] ? `<dt>Storeys</dt><dd>${esc(tags['building:levels'])}</dd>` : ''}
      <dt>Footprint</dt><dd>${fmtArea(b.area)}</dd>
      <dt>Date</dt><dd>${esc(tags?.start_date ?? 'not recorded')}</dd>
      <dt>To red line</dt><dd>${S.red ? (b.inSite ? '<b class="red">on the site</b>' : fmtDist(Math.max(0, turf.pointToPolygonDistance(b.ll, S.red as any, { units: 'meters' })))) : '—'}</dd>
    </dl>
    <h4>Protection and planning</h4>
    ${b.listed.map((l) => `<div class="desig"><span class="sw" style="background:#7B3FA0"></span><a href="${entityUrl(l)}" target="_blank">Listed: ${esc(describe(l))}</a></div>`).join('')}
    ${b.designations.map((d) => `<div class="desig"><span class="sw" style="background:${colorOf(d.properties?.dataset)}"></span><a href="${entityUrl(d)}" target="_blank">${esc(describe(d))}</a></div>`).join('')}
    ${!b.listed.length && !b.designations.length ? '<p class="muted">No designations recorded.</p>' : ''}
    <div class="nav">
      <button class="solid" id="openPassport">Building passport</button>
      <button class="ghost" id="prevB" ${i <= 0 ? 'disabled' : ''}>‹ Prev</button>
      <button class="ghost" id="nextB" ${i < 0 || i >= study.length - 1 ? 'disabled' : ''}>Next ›</button>
      <button class="ghost" id="eyeB">Eye level</button>
      <button class="ghost" id="closeB">Close</button>
    </div>`;
  $('#openPassport').onclick = () => openPassport(b, { model: S.model!, pois: S.pois, token: TOKEN, place: S.place, lpa: S.lpa }, $('#passport'));
  $('#prevB').onclick = () => (select(study[i - 1]), ensureVisible(study[i - 1]));
  $('#nextB').onclick = () => (select(study[i + 1]), ensureVisible(study[i + 1]));
  $('#eyeB').onclick = () => setView('eye');
  $('#closeB').onclick = () => select(null);
  drawLeader();
}

/** Where a building currently is on the map: its real place, or its slot in the atlas. */
function displayLL(b: Bldg): [number, number] {
  const o = S.atlas?.offsets.get(b.idx);
  if (!o || S.atlasT <= 0 || !S.model) return b.ll;
  const f = atlasFactor(b.idx, S.atlasT);
  return [b.ll[0] + (o[0] * f) / S.model.frame.kx, b.ll[1] + (o[1] * f) / S.model.frame.ky];
}

function ensureVisible(b: Bldg) {
  const p = map.project(displayLL(b));
  const c = map.getCanvas();
  if (p.x < 40 || p.y < 40 || p.x > c.clientWidth - 40 || p.y > c.clientHeight - 40) map.easeTo({ center: displayLL(b), duration: 500 });
}

/** The atlas leader: from the selected building on the map to its card, redrawn every frame. */
function drawLeader() {
  const svg = $('#leader');
  const b = S.selected;
  const anchor = document.getElementById('anchor');
  if (!b || !anchor || $('#card').hidden || !$('#agentDrawer').hidden) return void (svg.innerHTML = '');
  const mr = $('#map').getBoundingClientRect();
  const pt = projectAt(displayLL(b), S.view === 'plan' ? 0 : b.h * 0.6);
  const x0 = mr.left + pt.x, y0 = mr.top + pt.y;
  const ar = anchor.getBoundingClientRect();
  const ir = $('#info').getBoundingClientRect();
  const x1 = ar.left, y1 = Math.min(Math.max(ar.top, ir.top + 10), ir.bottom - 10);
  if (pt.x < 0 || pt.y < 0 || pt.x > mr.width || pt.y > mr.height) return void (svg.innerHTML = '');
  const mx = x0 + (x1 - x0) * 0.55;
  svg.innerHTML = `<path d="M${x0} ${y0} C ${mx} ${y0}, ${mx} ${y1}, ${x1} ${y1}" fill="none" stroke="#2433e0" stroke-width="1.5"/>
    <circle cx="${x0}" cy="${y0}" r="6" fill="none" stroke="#2433e0" stroke-width="2"/><circle cx="${x0}" cy="${y0}" r="2" fill="#2433e0"/>
    <circle cx="${x1}" cy="${y1}" r="3.5" fill="#2433e0"/>`;
}

/** Screen position of a point lifted to a height, so the leader lands on the building, not its base. */
function projectAt(ll: [number, number], h: number) {
  const base = map.project(ll);
  if (h <= 0 || map.getPitch() < 1) return base;
  try {
    const tr: any = (map as any).transform;
    const mc = mapboxgl.MercatorCoordinate.fromLngLat(ll, h);
    const m = tr.mercatorMatrix as number[];
    const v = [mc.x, mc.y, mc.z, 1]; // mercatorMatrix takes raw mercator units
    const o = [0, 1, 2, 3].map((r) => m[r] * v[0] + m[4 + r] * v[1] + m[8 + r] * v[2] + m[12 + r] * v[3]);
    const x = (o[0] / o[3] + 1) * tr.width * 0.5;
    const y = (1 - o[1] / o[3]) * tr.height * 0.5;
    return isFinite(x) && isFinite(y) ? { x, y } : base;
  } catch {
    return base;
  }
}

map.on('render', drawLeader);
window.addEventListener('resize', drawLeader);
$('#info').addEventListener('scroll', drawLeader);

// ---------------------------------------------------------------- animations
let growRAF = 0;
/** Buildings rise out of the ground, rippling outward from the site. */
function animateGrow(ms = 1600) {
  cancelAnimationFrame(growRAF);
  if (!map.getLayer('model-3d')) return;
  const t0 = performance.now();
  const step = () => {
    const T = Math.min(1, (performance.now() - t0) / ms);
    map.setPaintProperty('model-3d', 'fill-extrusion-height', growExpr('h', T));
    map.setPaintProperty('model-3d', 'fill-extrusion-base', growExpr('minH', T));
    map.setPaintProperty('context-3d', 'fill-extrusion-height', ['*', ['get', 'height'], ease(T)]);
    map.setPaintProperty('massing-3d', 'fill-extrusion-height', ['*', ['get', 'h'], ease(Math.max(0, T * 1.4 - 0.4))]);
    if (T < 1) growRAF = requestAnimationFrame(step);
    else {
      map.setPaintProperty('model-3d', 'fill-extrusion-height', ['get', 'h']);
      map.setPaintProperty('model-3d', 'fill-extrusion-base', ['get', 'minH']);
      map.setPaintProperty('context-3d', 'fill-extrusion-height', ['get', 'height']);
      map.setPaintProperty('massing-3d', 'fill-extrusion-height', ['get', 'h']);
    }
  };
  step();
}

const atlasFactor = (idx: number, t: number) => ease(Math.min(1, Math.max(0, t * 1.5 - (S.atlas?.rank.get(idx) ?? 0) * 0.5)));

function atlasFC(t: number): FeatureCollection {
  const m = S.model!, A = S.atlas!;
  return {
    type: 'FeatureCollection',
    features: S.modelFC.features.map((f) => {
      const o = A.offsets.get(f.id as number);
      if (!o || t <= 0) return f;
      const k = atlasFactor(f.id as number, t);
      return k ? translateFeature(f as PolyF, [o[0] * k, o[1] * k], m) : f;
    }),
  };
}

let atlasRAF = 0;
/** Split the buildings out into the atlas grid (to=1) or put them back (to=0). */
function animateAtlas(to: 0 | 1, ms = 1500): Promise<void> {
  cancelAnimationFrame(atlasRAF);
  const src = map.getSource('model') as mapboxgl.GeoJSONSource;
  const from = S.atlasT;
  if (!S.model || !S.atlas || from === to) return Promise.resolve();
  hideAtlasRefs();
  const t0 = performance.now();
  return new Promise((res) => {
    const step = () => {
      const k = Math.min(1, (performance.now() - t0) / ms);
      S.atlasT = from + (to - from) * k;
      src.setData(k < 1 ? atlasFC(S.atlasT) : to ? atlasFC(1) : S.modelFC);
      if (k < 1) atlasRAF = requestAnimationFrame(step);
      else {
        if (to) showAtlasRefs();
        res();
      }
    };
    step();
  });
}

// Atlas references are page labels (Plus Jakarta Sans), not map-drawn text in Mapbox's own font.
let atlasRefs: mapboxgl.Marker[] = [];
function showAtlasRefs() {
  hideAtlasRefs();
  for (const f of atlasLabels().features) {
    const el = document.createElement('span');
    el.className = 'atlas-ref';
    el.textContent = String(f.properties?.text ?? '');
    atlasRefs.push(new mapboxgl.Marker({ element: el, anchor: 'top' }).setLngLat((f.geometry as any).coordinates).addTo(map));
  }
}
function hideAtlasRefs() {
  atlasRefs.forEach((m) => m.remove());
  atlasRefs = [];
}

function atlasLabels(): FeatureCollection {
  const m = S.model!;
  return { type: 'FeatureCollection', features: S.atlas!.labels.map((l) => ({ type: 'Feature', geometry: { type: 'Point', coordinates: m.frame.toLngLat(l.at) }, properties: { text: l.text } })) };
}

function atlasBounds(): [[number, number], [number, number]] {
  const m = S.model!, B = S.atlas!.bounds;
  return [m.frame.toLngLat([B.minX, B.minY]), m.frame.toLngLat([B.maxX, B.maxY])];
}

// ---------------------------------------------------------------- views
document.querySelectorAll<HTMLButtonElement>('#views [data-view]').forEach((b) => b.addEventListener('click', () => setView(b.dataset.view as View)));
$('#rotL').onclick = () => (eye.on ? ((eye.heading -= 45), applyEye()) : map.easeTo({ bearing: map.getBearing() - 45, duration: 600 }));
$('#rotR').onclick = () => (eye.on ? ((eye.heading += 45), applyEye()) : map.easeTo({ bearing: map.getBearing() + 45, duration: 600 }));

async function setView(v: View, opts: { quiet?: boolean } = {}) {
  const prev = S.view;
  if (v === 'atlas' && !S.model) return toast('Analyse the site first: the atlas lays out every building in the study area.');
  // The axonometric is a cut-out model of the study area, so read the buildings first if needed.
  if (v === 'axo' && !S.model && S.study) {
    toast('Reading the buildings in the study area…');
    await analyse();
  }
  if (v === 'axo' && !S.study) toast('Draw a red line or a quick box first: the axonometric cuts out the study area.');
  S.view = v;
  if (prev === 'eye' && v !== 'eye') exitEye();
  document.querySelectorAll('#views [data-view], #mpViews [data-view]').forEach((x) => x.classList.toggle('on', (x as HTMLElement).dataset.view === v));
  map.setCamera({ 'camera-projection': v === 'axo' || v === 'plan' || v === 'atlas' ? 'orthographic' : 'perspective' });
  const isolate = (v === 'axo' || v === 'atlas') && !!S.model;
  applyModelFilter();
  void isolate;
  if (map.getLayer('building')) map.setLayoutProperty('building', 'visibility', isolate ? 'none' : 'visible');
  map.setPaintProperty('mask', 'fill-opacity', v === 'atlas' ? 1 : isolate ? 0.94 : 0.55);
  (map.getSource('mask') as mapboxgl.GeoJSONSource)?.setData(v === 'atlas' ? maskOf(null) : S.study ? maskOf(S.study) : empty);
  if (!S.model) map.setLayoutProperty('context-3d', 'visibility', v === 'plan' ? 'none' : 'visible');
  setModelColours();
  applyVisibility();
  renderLegend();
  applySun();
  if (opts.quiet) return;

  if (prev === 'atlas' && v !== 'atlas') await animateAtlas(0, 1100);

  const target = (S.selected?.ll ?? (S.red || S.study ? turf.centroid((S.red ?? S.study)!).geometry.coordinates : map.getCenter().toArray())) as [number, number];
  const bearing = Math.abs(map.getBearing()) < 1 ? -30 : map.getBearing();
  if (v === 'plan') map.easeTo({ pitch: 0, bearing: 0, duration: 700 });
  else if (v === '3d') {
    map.easeTo({ pitch: 60, bearing, zoom: Math.max(map.getZoom(), 16), duration: 700 });
    if (prev === 'plan' || prev === 'atlas') animateGrow();
  } else if (v === 'axo') {
    if (S.study) map.fitBounds(turf.bbox(S.study) as any, { pitch: 55, bearing, padding: 50, duration: 700 });
    else map.easeTo({ pitch: 55, bearing, duration: 700 });
    if (prev !== 'axo') animateGrow();
  } else if (v === 'atlas') {
    const c = map.getCanvas();
    S.atlas ??= layoutAtlas(S.model!.buildings.filter((b) => b.inStudy), c.clientWidth / c.clientHeight);
    // Opens top-down so the grid reads as a sheet; tilt with right-drag or the compass to see it in 3D.
    map.fitBounds(atlasBounds(), { pitch: 0, bearing: 0, padding: 36, duration: 900 });
    await animateAtlas(1);
  } else if (v === 'eye') {
    const { from, look } = eyePoint(target);
    enterEye(from, turf.bearing(from, look));
  }
  if (prev === 'eye' && v !== 'eye' && v !== 'atlas' && v !== 'axo') map.easeTo({ center: target, zoom: 16.5, duration: 700 });
  setTimeout(drawLeader, 750);
}

let toastT = 0;
function toast(msg: string) {
  const el = $('#toast');
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toastT);
  toastT = window.setTimeout(() => (el.hidden = true), 3500);
}

// ---- eye level: first-person controls
// Mapbox's own controls orbit and pan around a point on the ground ahead of the camera, which
// feels like sliding about. At eye level you stand still and look around, and walk forward.
const eye = { on: false, pos: [0, 0] as [number, number], heading: 0, look: 16, dragged: false };
const EYE_H = 1.7; // metres
const EYE_MAX_LOOK = 16; // aiming 16 m ahead at 1.7 m is about 84°, as level as Mapbox allows

function applyEye() {
  const aim = turf.destination(eye.pos, eye.look, eye.heading, { units: 'meters' }).geometry.coordinates as [number, number];
  const cam = map.getFreeCameraOptions();
  cam.position = mapboxgl.MercatorCoordinate.fromLngLat(eye.pos, EYE_H);
  cam.lookAtPoint(aim);
  map.setFreeCameraOptions(cam);
}
function enterEye(from: [number, number], heading: number) {
  Object.assign(eye, { on: true, pos: from, heading, look: EYE_MAX_LOOK });
  for (const h of [map.dragPan, map.dragRotate, map.scrollZoom, map.keyboard, map.doubleClickZoom, map.touchZoomRotate, map.touchPitch]) h.disable();
  applyEye();
  toast('Drag to look around. W / S or ↑ / ↓ (or scroll) to walk, A / D or ← / → to turn.');
}
function exitEye() {
  eye.on = false;
  for (const h of [map.dragPan, map.dragRotate, map.scrollZoom, map.keyboard, map.doubleClickZoom, map.touchZoomRotate, map.touchPitch]) h.enable();
}
function eyeWalk(m: number) {
  eye.pos = turf.destination(eye.pos, m, eye.heading, { units: 'meters' }).geometry.coordinates as [number, number];
  applyEye();
}
{
  const canvas = map.getCanvasContainer();
  let last: { x: number; y: number } | null = null;
  canvas.addEventListener('pointerdown', (e) => {
    if (!eye.on) return;
    last = { x: e.clientX, y: e.clientY };
    eye.dragged = false;
  });
  window.addEventListener('pointermove', (e) => {
    if (!eye.on || !last) return;
    const dx = e.clientX - last.x, dy = e.clientY - last.y;
    if (Math.abs(dx) + Math.abs(dy) > 2) eye.dragged = true;
    last = { x: e.clientX, y: e.clientY };
    eye.heading -= dx * 0.25; // drag the view: dragging left turns right, like grabbing the scene
    eye.look = Math.max(5, Math.min(EYE_MAX_LOOK, eye.look * Math.exp(-dy * 0.01))); // drag up to look down
    applyEye();
  });
  window.addEventListener('pointerup', () => {
    last = null;
    setTimeout(() => (eye.dragged = false), 0);
  });
  canvas.addEventListener('wheel', (e) => {
    if (!eye.on) return;
    e.preventDefault();
    eyeWalk(-Math.sign(e.deltaY) * 4);
  }, { passive: false });
  window.addEventListener('keydown', (e) => {
    if (!eye.on || (e.target as HTMLElement).closest('input, textarea, select')) return;
    const k = e.key.toLowerCase();
    if (k === 'w' || k === 'arrowup') eyeWalk(2.5);
    else if (k === 's' || k === 'arrowdown') eyeWalk(-2.5);
    else if (k === 'a' || k === 'arrowleft') ((eye.heading -= 5), applyEye());
    else if (k === 'd' || k === 'arrowright') ((eye.heading += 5), applyEye());
    else return;
    e.preventDefault();
  });
}

/** Stand in a street at a comfortable distance from the facade (about twice the height), facing the building. */
function eyePoint(target: [number, number]): { from: [number, number]; look: [number, number] } {
  const m = S.model;
  const fallback = () => ({ from: turf.destination(target, 80, map.getBearing() + 180, { units: 'meters' }).geometry.coordinates as [number, number], look: target });
  if (!m) return fallback();
  const t = m.frame.toLocal(target);
  const sel = S.selected;
  const want = sel ? Math.min(80, Math.max(25, sel.h * 2)) : 60;
  const edges: [XY, XY][] = sel ? sel.polys.flatMap((pl) => pl[0].map((q, i) => [q, pl[0][(i + 1) % pl[0].length]] as [XY, XY])) : [];
  const distTo = (q: XY) => (edges.length ? Math.min(...edges.map(([a, b]) => { const c = closestOnSegment(q, a, b); return Math.hypot(c[0] - q[0], c[1] - q[1]); })) : Math.hypot(q[0] - t[0], q[1] - t[1]));
  const near = m.buildings.filter((b) => Math.hypot(b.centroid[0] - t[0], b.centroid[1] - t[1]) < want + 200);
  const inBuilding = (q: XY) => near.some((b) => b.polys.some((pl) => pointInRing(q, pl[0])));
  let best: { q: XY; score: number } | null = null;
  for (const r of m.roads) {
    if (/rail|track/.test(r.cls)) continue;
    for (const line of r.lines)
      for (let i = 1; i < line.length; i++) {
        const [a, b] = [line[i - 1], line[i]];
        const n = Math.max(1, Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) / 5));
        for (let k = 0; k <= n; k++) {
          const q: XY = [a[0] + ((b[0] - a[0]) * k) / n, a[1] + ((b[1] - a[1]) * k) / n];
          if (Math.abs(q[0] - t[0]) > want + 150 || Math.abs(q[1] - t[1]) > want + 150) continue;
          const score = Math.abs(distTo(q) - want);
          if ((!best || score < best.score) && !inBuilding(q)) best = { q, score };
        }
      }
  }
  if (!best) return fallback();
  return { from: m.frame.toLngLat(best.q), look: target };
}
function closestOnSegment(p: XY, a: XY, b: XY): XY {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const L = dx * dx + dy * dy;
  const t = L ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / L)) : 0;
  return [a[0] + t * dx, a[1] + t * dy];
}
function pointInRing(p: XY, r: XY[]) {
  let c = false;
  for (let i = 0, j = r.length - 1; i < r.length; j = i++)
    if (r[i][1] > p[1] !== r[j][1] > p[1] && p[0] < ((r[j][0] - r[i][0]) * (p[1] - r[i][1])) / (r[j][1] - r[i][1]) + r[i][0]) c = !c;
  return c;
}

// ---------------------------------------------------------------- walking reach from a point
// Click a spot in the study area: the streets you can walk to in 5, 10 and 15 minutes spread out
// from it, along the real street network at 80 m a minute.
let walkNet: { study: PolyF; frame: LocalFrame; lines: { coords: number[][] }[]; graph: ReturnType<typeof buildGraph> } | null = null;
/** Walk along the drawn masterplan streets and paths too (remembered in this browser). */
let walkDrawn = (() => {
  try {
    return localStorage.getItem('ultrahand:walkDrawn') === '1';
  } catch {
    return false;
  }
})();
let walkUsedDrawn = false, walkUsedClear = false;
const drawnLines = () => S.plan.streets.flatMap((s) => streetPieces(s, S.plan.streets));
let walkMarker: mapboxgl.Marker | null = null;
let walkRAF = 0;
let walkSeq = 0;
const WALK_LIMIT = BANDS[BANDS.length - 1] * WALK_SPEED;

async function walkFromPoint(ll: [number, number]) {
  if (!S.study) return;
  if (!turf.booleanPointInPolygon(ll, turf.buffer(S.study, 150, { units: 'meters' })!)) return toast('Click a spot inside the study area to walk from there.');
  const seq = ++walkSeq;
  clearWalk(false);
  const el = document.createElement('div');
  el.className = 'walk-origin';
  el.title = 'Walking from here (click to clear)';
  el.addEventListener('click', (ev) => (ev.stopPropagation(), clearWalk()));
  walkMarker = new mapboxgl.Marker({ element: el }).setLngLat(ll).addTo(map);
  showWalkPanel('<p class="muted">Finding the streets around the study area…</p>');
  try {
    if (!walkNet || walkNet.study !== S.study) {
      const area = turf.buffer(S.study, WALK_LIMIT + 100, { units: 'meters' })!;
      const c = turf.centroid(S.study).geometry.coordinates;
      const frame = new LocalFrame(c[0], c[1]);
      const lines = await fetchWalkNetwork(turf.bbox(area), TOKEN);
      if (seq !== walkSeq) return;
      walkNet = { study: S.study, frame, lines, graph: buildGraph(lines, frame) };
    }
    const { frame } = walkNet;
    // With drawn streets on, the network is rebuilt from the existing streets plus the plan as it is now.
    const drawn = walkDrawn ? drawnLines() : [];
    const cleared = walkDrawn ? clearAreas(S.plan, S.red) : [];
    walkUsedDrawn = drawn.length > 0 || cleared.length > 0;
    walkUsedClear = cleared.length > 0;
    const graph = walkUsedDrawn ? buildGraph(withDrawn(clipLines(walkNet.lines, cleared), drawn, frame), frame) : walkNet.graph;
    const res = walkFrom(graph, frame.toLocal(ll), WALK_LIMIT);
    if (!res) return (clearWalk(), toast('No street within 250 m of that spot.'));
    const { fc, lengthIn } = walkPieces(graph, res.dist, frame, WALK_LIMIT);
    (map.getSource('walkpt') as mapboxgl.GeoJSONSource).setData(fc);
    lastWalk = { lengthIn, start: res.start };
    renderWalkKey();
    agent.contextChanged();
    // Spread outward from the marker.
    cancelAnimationFrame(walkRAF);
    const t0 = performance.now(), ms = 2600;
    const step = () => {
      const k = Math.min(1, (performance.now() - t0) / ms);
      walkReach = WALK_LIMIT * k;
      map.setFilter('walkpt', walkFilter());
      if (k < 1) walkRAF = requestAnimationFrame(step);
    };
    step();
  } catch (e) {
    console.error(e);
    if (seq === walkSeq) (clearWalk(), toast('Could not read the streets just now.'));
  }
}

let walkReach = 0; // metres revealed so far by the spreading animation
let lastWalk: { lengthIn: Record<number, number>; start: number } | null = null;

function walkColourExpr(): any {
  return ['match', ['get', 'band'], 5, walkStyle.colours[0], 10, walkStyle.colours[1], walkStyle.colours[2]];
}
/** Reached so far, and only the bands that are switched on in the key. */
function walkFilter(): any {
  const on = BANDS.filter((_, i) => walkStyle.on[i]);
  return ['all', ['<=', ['get', 'd'], walkReach], ['in', ['get', 'band'], ['literal', on]]];
}
function applyWalkStyle() {
  if (!map.getLayer('walkpt')) return;
  map.setPaintProperty('walkpt', 'line-color', walkColourExpr());
  map.setFilter('walkpt', walkFilter());
  saveWalkStyle();
}

/** The key: a row per band with a tick box (show on the map) and a colour, plus palettes. */
function renderWalkKey() {
  if (!lastWalk) return;
  const { lengthIn, start } = lastWalk;
  showWalkPanel(
    BANDS.map(
      (b, i) => `<label class="wr${walkStyle.on[i] ? '' : ' off'}">
        <input type="checkbox" data-band="${i}" ${walkStyle.on[i] ? 'checked' : ''} aria-label="Show ${b} minutes on the map">
        <input type="color" data-colour="${i}" value="${walkStyle.colours[i]}" aria-label="Colour for ${b} minutes" title="Change colour">
        <b>${b} min</b><span>${fmtDist(b * WALK_SPEED)}</span><span class="muted">${(lengthIn[b] / 1000).toFixed(1)} km of street</span>
      </label>`,
    ).join('') +
      `<div class="wpal">${Object.entries(WALK_PALETTES)
        .map(([name, c]) => `<button data-pal="${name}" title="${name}" aria-label="${name} colours" style="background:linear-gradient(90deg,${c[0]} 0 33%,${c[1]} 33% 66%,${c[2]} 66%)"></button>`)
        .join('')}</div>` +
      (S.plan.streets.length || S.plan.clear.length || S.plan.clearRed
        ? `<label class="wdrawn"><input type="checkbox" id="walkDrawn" ${walkDrawn ? 'checked' : ''}> Include drawn streets and paths <span class="muted">(${S.plan.streets.length})</span></label>`
        : '') +
      `<p class="muted">Along ${walkUsedDrawn ? 'existing and drawn ' : ''}streets and footpaths${walkUsedClear ? ' (existing ones cleared inside the site)' : ''} at 4.8 km/h${start > 15 ? `, starting ${Math.round(start)} m from the nearest street` : ''}. Tick a band to show it on the map; click a swatch to change its colour. Press Walk from a point to start somewhere else.</p>`,
  );
  const el = $('#walkPanel');
  el.querySelector<HTMLInputElement>('#walkDrawn')?.addEventListener('change', (e) => {
    walkDrawn = (e.target as HTMLInputElement).checked;
    try {
      localStorage.setItem('ultrahand:walkDrawn', walkDrawn ? '1' : '0');
    } catch { /* storage blocked */ }
    if (walkMarker) walkFromPoint(walkMarker.getLngLat().toArray() as [number, number]);
  });
  el.querySelectorAll<HTMLInputElement>('[data-band]').forEach((cb) =>
    cb.addEventListener('change', () => {
      walkStyle.on[+cb.dataset.band!] = cb.checked;
      cb.closest('.wr')!.classList.toggle('off', !cb.checked);
      applyWalkStyle();
    }),
  );
  el.querySelectorAll<HTMLInputElement>('[data-colour]').forEach((ci) =>
    ci.addEventListener('input', () => {
      walkStyle.colours[+ci.dataset.colour!] = ci.value;
      applyWalkStyle();
    }),
  );
  el.querySelectorAll<HTMLButtonElement>('[data-pal]').forEach((b) =>
    b.addEventListener('click', () => {
      walkStyle.colours = [...WALK_PALETTES[b.dataset.pal!]];
      applyWalkStyle();
      renderWalkKey();
    }),
  );
}

function showWalkPanel(body: string) {
  const el = $('#walkPanel');
  el.innerHTML = `<div class="wp-head"><b>Walking from here</b><button id="walkClear" title="Clear (Esc)">Clear</button></div>${body}`;
  el.hidden = false;
  $('#walkClear').onclick = () => clearWalk();
}

function clearWalk(all = true) {
  cancelAnimationFrame(walkRAF);
  walkMarker?.remove();
  walkMarker = null;
  (map.getSource('walkpt') as mapboxgl.GeoJSONSource | undefined)?.setData(empty);
  walkReach = 0;
  if (map.getLayer('walkpt')) map.setFilter('walkpt', walkFilter());
  if (all) {
    walkSeq++;
    lastWalk = null;
    $('#walkPanel').hidden = true;
  }
}
window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !S.drawing && walkMarker) clearWalk();
});

// ---------------------------------------------------------------- sun
const today = new Date();
$<HTMLInputElement>('#sunDate').value = today.toISOString().slice(0, 10);
$<HTMLInputElement>('#sunDate').onchange = applySun;
$<HTMLInputElement>('#sunTime').oninput = applySun;
$<HTMLInputElement>('#sunOn').onchange = applySun;

function sunNow() {
  const d = new Date($<HTMLInputElement>('#sunDate').value + 'T00:00:00');
  const mins = +$<HTMLInputElement>('#sunTime').value;
  d.setHours(Math.floor(mins / 60), mins % 60);
  const c = map.getCenter();
  const p = SunCalc.getPosition(d, c.lat, c.lng);
  // suncalc v2: degrees, azimuth clockwise from north.
  const alt = p.altitude;
  const az = p.azimuth;
  const toSun: XY = [Math.sin((az * Math.PI) / 180), Math.cos((az * Math.PI) / 180)]; // east, north
  const times: any = (SunCalc as any).getTimes(d, c.lat, c.lng);
  return { d, alt, az, toSun, sunset: times?.sunset as Date | null };
}

const hm = (d: Date) => d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
function applySun() {
  const s = sunNow();
  // No cast shadows in the atlas: it is a sheet of objects, not a place.
  const on = $<HTMLInputElement>('#sunOn').checked && s.alt > 0 && S.view !== 'atlas';
  $('#sunClock').textContent = hm(s.d);
  const shadow = s.alt > 0 ? 10 / Math.tan((s.alt * Math.PI) / 180) : 0;
  $('#sunStat').textContent =
    s.alt > 0
      ? `Sun ${s.alt.toFixed(0)}° above the horizon, bearing ${s.az.toFixed(0)}° (${compass(s.az)}). A 10 m wall throws ${shadow > 500 ? 'a very long' : `${Math.round(shadow)} m of`} shadow.${s.sunset ? ` Sunset ${hm(s.sunset)}.` : ''}`
      : `The sun is below the horizon.${s.sunset ? ` Sunset was ${hm(s.sunset)}.` : ''}`;
  if (!map.getLayer('model-3d')) return;
  map.setLights([
    { id: 'ambient', type: 'ambient', properties: { color: '#ffffff', intensity: on ? 0.55 : 0.8 } },
    { id: 'sun', type: 'directional', properties: { color: '#ffffff', intensity: on ? 0.55 : 0.3, direction: [s.az, Math.min(89, Math.max(5, 90 - s.alt))], 'cast-shadows': on, 'shadow-intensity': 0.55 } },
  ]);
}
const compass = (a: number) => ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'][Math.round(a / 45) % 8];

// ---------------------------------------------------------------- export
function overlayPolys(): GroundPolys[] {
  const m = S.model!;
  const out: GroundPolys[] = [];
  for (const d of DATASETS) {
    if (d.kind !== 'fill' || !S.visible.has(d.id)) continue;
    const polys = S.designations.features
      .filter((f) => f.properties?.dataset === d.id && (f.geometry?.type === 'Polygon' || f.geometry?.type === 'MultiPolygon'))
      .flatMap((f) => toLocalPolys(f.geometry as any, m.frame));
    if (polys.length) out.push({ polys, fill: d.color, opacity: 0.14, stroke: d.color, strokeWidth: 1.2, dash: '5 3' });
  }
  if (m.redPolys) out.push({ polys: m.redPolys, fill: '#d7262e', opacity: 0.08, stroke: '#d7262e', strokeWidth: 2.4 });
  return out;
}

const lookFor = (b: Bldg) => (b === S.selected ? LOOK.selected : b.listed.length ? LOOK.listed : b.inSite ? LOOK.site : LOOK.context);

function exportDrawing(kind: 'axo' | 'plan') {
  const m = S.model;
  if (!m) return;
  const mode = $<HTMLSelectElement>('#axoMode').value as 'ortho' | 'oblique';
  const s = sunNow();
  const buildings: AxoBuilding[] = m.buildings.filter((b) => b.cut).map((b) => ({ polys: b.cut!, z0: b.minH, z1: b.h, label: b.ref, look: lookFor(b) }));
  if (S.massing > 0 && m.redPolys) buildings.push({ polys: m.redPolys, z0: 0, z1: S.massing, look: LOOK.massing, label: 'Proposed' });
  for (const b of S.blocks) buildings.push({ polys: toLocalPolys(b.shape.geometry, m.frame), z0: b.baseM, z1: b.baseM + heightOf(b), look: lookForColour(useOf(b.use).colour), label: b.name });
  buildings.push(...mpBuildings(m.frame), ...treeBuildings(m.frame));
  const pitch = kind === 'plan' ? 0 : S.view === 'axo' || S.view === '3d' ? map.getPitch() : 55;
  const svg = renderAxo(
    {
      buildings: kind === 'plan' ? buildings.map((b) => ({ ...b, z1: b.z0, ridge: undefined })) : buildings,
      clip: m.studyPolys,
      ground: [...groundLayers(m, GREEN), ...mpGround(m.frame), ...overlayPolys()],
      shadows: $<HTMLInputElement>('#sunOn').checked && s.alt > 0 ? { toSun: s.toSun, alt: s.alt } : undefined,
    },
    {
      bearing: kind === 'plan' ? 0 : map.getBearing(), mode: kind === 'plan' ? 'ortho' : mode, pitch,
      width: 1800, plinth: kind === 'axo' && $<HTMLInputElement>('#optPlinth').checked ? 10 : 0,
      background: '#ffffff', north: true, scaleBar: kind === 'plan' || mode === 'oblique', labels: $<HTMLInputElement>('#optLabels').checked, sketch: S.sketch,
    },
  );
  showExport(svg, `${slug(S.place || 'site')}-${kind}`);
}

/** Every building in the study area at the same scale, laid out in reference order. */
function exportAtlas() {
  const m = S.model;
  if (!m) return;
  const c = map.getCanvas();
  S.atlas ??= layoutAtlas(m.buildings.filter((b) => b.inStudy), c.clientWidth / c.clientHeight);
  const A = S.atlas;
  const buildings: AxoBuilding[] = m.buildings
    .filter((b) => A.offsets.has(b.idx))
    .map((b) => {
      const [dx, dy] = A.offsets.get(b.idx)!;
      const polys: LocalPoly[] = b.polys.map((pl) => pl.map((r) => r.map((q) => [q[0] + dx, q[1] + dy] as XY)));
      return { polys, z0: b.minH, z1: b.h, label: b.ref, look: lookFor(b) };
    });
  const svg = renderAxo({ buildings }, { bearing: 0, mode: $<HTMLSelectElement>('#axoMode').value as 'ortho' | 'oblique', pitch: 50, width: 2000, background: '#ffffff', labels: true, scaleBar: true });
  showExport(svg, `${slug(S.place || 'site')}-atlas`);
}

$('#expAxo').onclick = () => exportDrawing('axo');
$('#expPlan').onclick = () => exportDrawing('plan');
$('#expAtlas').onclick = exportAtlas;
$('#expSun').onclick = () => {
  const m = S.model;
  if (!m) return;
  const xs = m.studyPolys.flatMap((p) => p[0].map((q) => q[0])), ys = m.studyPolys.flatMap((p) => p[0].map((q) => q[1]));
  const buildings: AxoBuilding[] = m.buildings.filter((b) => b.cut).map((b) => ({ polys: b.cut!, z0: b.minH, z1: b.h, look: { roof: b.inSite ? '#f6c9cb' : '#ffffff', wallLight: '#ffffff', wallDark: '#ffffff', stroke: '#6f6e6a', strokeWidth: 0.6 } }));
  for (const b of S.blocks) buildings.push({ polys: toLocalPolys(b.shape.geometry, m.frame), z0: b.baseM, z1: b.baseM + heightOf(b), look: { ...lookForColour(useOf(b.use).colour), strokeWidth: 0.8 } });
  buildings.push(...mpBuildings(m.frame, true), ...treeBuildings(m.frame, true));
  const red: GroundPolys[] = m.redPolys ? [{ polys: m.redPolys, fill: '#d7262e', opacity: 0.06, stroke: '#d7262e', strokeWidth: 1.6 }] : [];
  const c = turf.centroid(S.red ?? S.study!).geometry.coordinates;
  const svg = sunStudySVG({
    lat: c[1], lng: c[0], buildings, ground: [...groundLayers(m, GREEN), ...mpGround(m.frame), ...red], clip: m.studyPolys,
    frame: { minX: Math.min(...xs), maxX: Math.max(...xs), minY: Math.min(...ys), maxY: Math.max(...ys) },
    title: `Sun study${S.place ? ` · ${esc(S.place)}` : ''}${S.blocks.length || S.plan.homes.length ? ' · with the proposals' : ''}`,
  });
  showExport(svg, `${slug(S.place || 'site')}-sun-study`);
};
const exportBlocks = () => S.blocks.map((b) => ({ name: b.name, use: useOf(b.use).label, shape: b.shape, base: b.baseM, top: b.baseM + heightOf(b) }));
$('#expDxf').onclick = () => {
  if (!S.model) return;
  download(new Blob([siteDXF(S.model, { massing: S.massing, blocks: [...exportBlocks(), ...mpExportBlocks()], lines: mpExportLines() })], { type: 'application/dxf' }), `${slug(S.place || 'site')}-bng.dxf`);
  toast('DXF on British National Grid, in metres. Buildings carry their heights as elevation and thickness.');
};
$('#expObj').onclick = () => {
  if (!S.model) return;
  const { obj, origin } = siteOBJ(S.model, { massing: S.massing, context: false, blocks: [...exportBlocks(), ...mpExportBlocks(), ...S.plan.trees.flatMap((t) => treeSlices(t).map((sl, i) => ({ name: `${t.id}_${i}`, use: treeType(t.type).label, shape: sl.shape, base: sl.base, top: sl.top, layer: 'UH_MP_TREES' })))] });
  download(new Blob([obj], { type: 'text/plain' }), `${slug(S.place || 'site')}-E${origin[0]}-N${origin[1]}.obj`);
  toast(`OBJ in metres, Z up, origin at British National Grid E ${origin[0]} N ${origin[1]}.`);
};
$('#expPng').onclick = () => map.getCanvas().toBlob((b) => b && download(b, `${slug(S.place || 'site')}-${S.view}.png`));

function showExport(svg: string, name: string) {
  const host = $('#exportView');
  host.hidden = false;
  host.innerHTML = `<div class="pp-toolbar"><span>${esc(name)}.svg</span><button data-a="svg">Download SVG</button><button data-a="png">Download PNG</button><button data-a="close">Close</button></div><div class="ex-body">${svg}</div>`;
  host.querySelector<HTMLButtonElement>('[data-a=close]')!.onclick = () => (host.hidden = true);
  host.querySelector<HTMLButtonElement>('[data-a=svg]')!.onclick = () => download(new Blob([svg], { type: 'image/svg+xml' }), `${name}.svg`);
  host.querySelector<HTMLButtonElement>('[data-a=png]')!.onclick = () => {
    const img = new Image();
    img.onload = () => {
      const c = document.createElement('canvas');
      c.width = img.width * 2;
      c.height = img.height * 2;
      const g = c.getContext('2d')!;
      g.scale(2, 2);
      g.drawImage(img, 0, 0);
      c.toBlob((b) => b && download(b, `${name}.png`));
    };
    img.src = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }));
  };
}

function download(b: Blob, name: string) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(b);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}
const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'site';
function safe<T>(fn: () => T, fb: T): T {
  try {
    return fn();
  } catch {
    return fb;
  }
}

// ---------------------------------------------------------------- the site, for the agent
// Everything Ultrahand knows about the site, as data (sent to the agent) and as text (to copy).
// The shape is documented in docs/agent/site-context.md; bump `schema` if it changes.
function siteContext() {
  if (!S.model || !S.study) return null;
  const m = S.model, t = S.metrics;
  const r0 = (n: number) => Math.round(n), r1 = (n: number) => Math.round(n * 10) / 10, r6 = (n: number) => Math.round(n * 1e6) / 1e6;
  const centre = turf.centroid(S.red ?? S.study).geometry.coordinates;
  const label = (id: string) => DATASETS.find((d) => d.id === id)?.label ?? id;
  const hits = (g: PolyF) => S.designations.features.filter((f) => f.geometry && safe(() => turf.booleanIntersects(f as any, g), false));
  const item = (f: Feature) => ({ type: label(f.properties?.dataset), name: describe(f), reference: f.properties?.reference ?? null, url: entityUrl(f) });
  const grouped: Record<string, { count: number; examples: string[] }> = {};
  for (const f of hits(S.study)) {
    const g = (grouped[label(f.properties?.dataset)] ??= { count: 0, examples: [] });
    g.count++;
    if (g.examples.length < 12 && !g.examples.includes(describe(f))) g.examples.push(describe(f));
  }
  const inStudy = m.buildings.filter((b) => b.inStudy);
  const near = (cat: string) => S.pois.filter((p) => p.cat === cat).map((p) => ({ p, d: turf.distance(centre, [p.lon, p.lat], { units: 'meters' }) })).sort((a, b) => a.d - b.d);
  const rail = near('rail')[0];
  const area = (s: { areaM2: number; coverage: number; plotRatio: number; gfaM2: number; meanStoreys: number; buildings: number }) =>
    ({ landM2: r0(s.areaM2), buildings: s.buildings, coverage: r1(s.coverage * 100) / 100, plotRatioEstimate: r1(s.plotRatio), floorAreaEstimateM2: r0(s.gfaM2), meanStoreys: r1(s.meanStoreys) });
  const sel = S.selected;
  return {
    schema: 'allto.ultrahand.site/3',
    generatedAt: new Date().toISOString(),
    place: S.place || null,
    localPlanningAuthority: S.lpa,
    location: { lng: r6(centre[0]), lat: r6(centre[1]) },
    redLine: S.red
      ? { areaM2: r0(turf.area(S.red)), perimeterM: r0(turf.length(turf.polygonToLine(S.red as any) as any, { units: 'meters' })), geometry: turf.truncate(S.red, { precision: 6 }).geometry }
      : null,
    studyArea: {
      kind: S.studyMode === 'buffer' ? `${S.bufferM} m around the red line` : S.studyMode === 'walk' ? `${S.walkMin} minutes' walk from the red line` : S.studyMode === 'box' ? 'quick box' : 'drawn',
      areaM2: r0(turf.area(S.study)),
    },
    buildings: {
      inStudyArea: inStudy.length,
      onSite: inStudy.filter((b) => b.inSite).length,
      heightsRecorded: t?.heights.known ?? 0,
      medianHeightM: t ? r1(t.heights.median) : null,
      tallestM: t ? r1(t.heights.tallest) : null,
      listedEntries: inStudy.reduce((n, b) => n + b.listed.length, 0),
      heightsMeasuredByLidar: inStudy.filter((b) => b.heightSource === 'lidar').length,
      heightBands: t?.heights.bands ?? [],
    },
    townscape: t
      ? { studyArea: area(t.study), redLine: t.site ? area(t.site) : null, medianFootprintM2: r0(t.grainM2), streetsAndPathsKmPerKm2: r1(t.streetKmPerKm2), storeyHeightAssumedM: 3.2 }
      : null,
    publicTransportAccess: transit
      ? { busStopsWithin5MinWalk: transit.bus.map((b) => ({ name: b.name, minutes: r1(b.min) })), stationsWithin12MinWalk: transit.rail.map((r) => ({ name: r.name, kind: r.kind, minutes: r1(r.min) })), note: 'Walking times along streets; no service frequencies.' }
      : null,
    surfaceWaterRiskOnRedLine: surfaceWater ? Object.fromEntries(Object.entries(surfaceWater.bands).map(([k, v]) => [k, { areaM2: r0(v), share: r1((v / surfaceWater!.siteM2) * 100) / 100 }])) : null,
    peopleAndPlace: S.people
      ? {
          neighbourhoods: S.people.lsoas.map((l) => ({ code: l.code, name: l.name, imdDecile2019: l.imdDecile })),
          residents: S.people.residents,
          households: S.people.households,
          peoplePerHectare: r0(S.people.densityPerHa),
          shares: { age: S.people.age, accommodation: S.people.accommodation, tenure: S.people.tenure, householdsWithoutACar: S.people.noCar, travelToWork: S.people.travel },
          note: 'Census 2021 for the 2021 LSOAs overlapping the study area (they extend beyond it); IMD 2019 deciles, 1 = most deprived 10% in England.',
        }
      : null,
    groundLevelsAOD: lidarInfo?.ground ? { min: r1(lidarInfo.ground.min), max: r1(lidarInfo.ground.max), fall: r1(lidarInfo.ground.fall), over: S.red ? 'red line' : 'study area' } : null,
    designations: { onRedLine: S.red ? hits(S.red).map(item) : [], inStudyArea: grouped },
    gettingAbout: {
      nearestStation: rail ? { name: rail.p.name, kind: rail.p.kind, distanceM: r0(rail.d) } : null,
      busStopsWithin400m: near('bus').filter((x) => x.d <= 400).length,
    },
    walkingReach:
      lastWalk && walkMarker
        ? {
            from: { lng: r6(walkMarker.getLngLat().lng), lat: r6(walkMarker.getLngLat().lat) },
            speedKmh: 4.8,
            includesDrawnStreets: walkUsedDrawn,
            bands: BANDS.map((b) => ({ minutes: b, metres: b * WALK_SPEED, streetsAndPathsKm: r1(lastWalk!.lengthIn[b] / 1000) })),
          }
        : null,
    selectedBuilding: sel
      ? { ref: sel.ref, name: sel.places[0] ?? null, heightM: r1(sel.h), heightRecorded: sel.heightKnown, footprintM2: r0(sel.area), onSite: sel.inSite, listed: sel.listed.map(describe), designations: sel.designations.map(describe) }
      : null,
    proposedMassingHeightM: S.massing || null,
    proposedBlocks: S.blocks.length
      ? (() => {
          const t = massTotals(S.blocks, S.red, S.assume);
          return {
            blocks: S.blocks.map((b) => ({ name: b.name, use: useOf(b.use).label, storeys: b.storeys, heightM: r1(heightOf(b)), fromM: b.baseM, footprintM2: r0(footprintOf(b)), floorAreaM2: r0(giaOf(b)) })),
            totals: { floorAreaM2: r0(t.giaM2), byUse: Object.fromEntries(Object.entries(t.giaByUse).map(([k, v]) => [useOf(k as Use).label, r0(v!)])), homes: t.homes, dwellingsPerHectare: t.dph != null ? r0(t.dph) : null, plotRatio: t.plotRatio != null ? r1(t.plotRatio) : null, coverage: t.coverage != null ? r1(t.coverage * 100) / 100 : null, tallestM: r1(t.tallestM) },
            assumptions: { residentialNetToGross: S.assume.netToGross, averageHomeM2: S.assume.homeSizeM2 },
          };
        })()
      : null,
    masterplan:
      S.plan.streets.length || S.plan.open.length || S.plan.homes.length || S.plan.trees.length
        ? (() => {
            const sc = mpSchedule();
            return {
              streets: S.plan.streets.map((x) => ({
                name: x.name, type: streetType(x.type).label, widthM: streetType(x.type).widthM, curve: x.curve,
                roundaboutDiameterM: x.roundabout?.diameterM ?? null,
                lengthM: x.roundabout ? null : r0(streetPieces(x, S.plan.streets).reduce((a, p) => a + turf.length(turf.lineString(p), { units: 'meters' }), 0)),
                homes: S.plan.homes.filter((h) => h.streetId === x.id).length,
              })),
              openSpaces: S.plan.open.map((o) => ({ name: o.name, type: openType(o.type).label, areaM2: r0(turf.area(o.shape)), roundedCorners: o.round })),
              houses: sc.houses.map((h) => ({ type: h.label, buildings: h.buildings, homes: h.homes, bedrooms: h.beds, storeys: houseType(h.type).storeys, floorAreaM2: r0(h.giaM2) })),
              schedule: {
                siteHa: sc.siteM2 != null ? Math.round(sc.siteM2 / 100) / 100 : null,
                streetsM2: r0(sc.streetsM2),
                openSpaceM2: Object.fromEntries(Object.entries(sc.openM2).map(([k, v]) => [openType(k as OpenType).label, r0(v!)])),
                netDevelopableHa: sc.netM2 != null ? Math.round(sc.netM2 / 100) / 100 : null,
                houseHomes: sc.houseHomes,
                apartmentHomesFromBlocks: sc.apartmentHomes,
                homes: sc.homes,
                grossDwellingsPerHa: sc.grossDph != null ? r0(sc.grossDph) : null,
                netDwellingsPerHa: sc.netDph != null ? r0(sc.netDph) : null,
                populationEstimate: sc.population,
                parkingSpacesEstimate: sc.parking,
              },
              affordable: { homes: sc.affordable.homes, share: Math.round(sc.affordable.share * 100) / 100, targetPct: sc.affordable.targetPct },
              bedroomMix: sc.mix.map((m) => ({ bedrooms: m.beds === 4 ? '4+' : m.beds, homes: m.homes, share: Math.round(m.share * 100) / 100, targetPct: m.targetPct })),
              plots: { frontGardenM: homeOpts().setbackM, rearGardenM: homeOpts().gardenM },
              trees: { count: sc.trees.count, byType: Object.fromEntries(sc.trees.byType.map((x) => [x.label, x.n])), canopyCoverM2: r0(sc.trees.canopyM2), canopyCoverShareOfSite: sc.trees.canopyShare != null ? Math.round(sc.trees.canopyShare * 1000) / 1000 : null },
              openSpaceAgainstFieldsInTrust: sc.openVsBenchmark.map((b) => ({ type: b.label, providedHa: Math.round(b.providedHa * 100) / 100, benchmarkHa: Math.round(b.benchmarkHa * 100) / 100 })),
              assumptions: { peoplePerHome: S.mpAssume.householdSize, parkingPerApartment: S.mpAssume.aptParking, visitorParkingPerHome: 0.2 },
              note: 'A sketch layout from typical UK dimensions, not a design. Street widths are the land each street takes. Areas count inside the red line. Apartments are split by the 1 bed share assumed.',
            };
          })()
        : null,
    sources: ['Heights and ground levels: Environment Agency LIDAR 1 m (where measured)', 'Buildings and streets: OpenStreetMap via Mapbox', 'Designations: planning.data.gov.uk', 'Places: OpenStreetMap', 'Walking: street network at 4.8 km/h'],
    caveats: ['Heights are from OpenStreetMap where recorded; others are drawn at 6 m.', 'Floor areas and plot ratios are estimates at 3.2 m a storey.', 'Drawn from open data: not a measured survey or a flood risk assessment.'],
  };
}

function siteSummary(): string {
  const c = siteContext();
  if (!c) return '';
  const L: string[] = [];
  L.push(`Site: ${c.place ?? 'unnamed'}${c.localPlanningAuthority ? ` (${c.localPlanningAuthority})` : ''}`);
  if (c.redLine) L.push(`Red line: ${fmtArea(c.redLine.areaM2)}, perimeter ${fmtDist(c.redLine.perimeterM)}`);
  L.push(`Study area: ${c.studyArea.kind}, ${fmtArea(c.studyArea.areaM2)}`);
  L.push(`Buildings: ${c.buildings.inStudyArea} in the study area, ${c.buildings.onSite} on the site; median height ${c.buildings.medianHeightM} m, tallest ${c.buildings.tallestM} m (${c.buildings.heightsRecorded} heights recorded); ${c.buildings.listedEntries} listed building entries`);
  if (c.townscape) {
    const s = c.townscape.studyArea, r = c.townscape.redLine;
    L.push(`Townscape (study area): coverage ${Math.round(s.coverage * 100)}%, plot ratio about ${s.plotRatioEstimate}, average ${s.meanStoreys} storeys, median footprint ${fmtArea(c.townscape.medianFootprintM2)}, ${c.townscape.streetsAndPathsKmPerKm2} km of streets and paths per km²`);
    if (r) L.push(`Townscape (red line): coverage ${Math.round(r.coverage * 100)}%, plot ratio about ${r.plotRatioEstimate}, ${r.buildings} buildings`);
  }
  if (c.buildings.heightsMeasuredByLidar) L.push(`Heights: ${c.buildings.heightsMeasuredByLidar} measured from Environment Agency LIDAR`);
  if (c.groundLevelsAOD) L.push(`Ground (${c.groundLevelsAOD.over}): ${c.groundLevelsAOD.min} to ${c.groundLevelsAOD.max} m AOD, a fall of ${c.groundLevelsAOD.fall} m`);
  if (c.publicTransportAccess) {
    const t = c.publicTransportAccess;
    L.push(`Public transport (walking times): ${t.stationsWithin12MinWalk.length ? t.stationsWithin12MinWalk.slice(0, 4).map((r) => `${r.name} ${Math.round(r.minutes)} min`).join(', ') : 'no station within 12 min'}; ${t.busStopsWithin5MinWalk.length} bus stops within 5 min`);
  }
  if (c.surfaceWaterRiskOnRedLine) {
    const e = Object.entries(c.surfaceWaterRiskOnRedLine);
    L.push(`Surface water flood risk on the red line: ${e.length ? e.map(([k, v]) => `${k} ${Math.round(v.share * 100)}%`).join(', ') : 'none recorded'}`);
  }
  if (c.peopleAndPlace) {
    const p = c.peopleAndPlace, P = (x: number) => `${Math.round(x * 100)}%`;
    L.push(`People (census 2021, ${p.neighbourhoods.length} neighbourhoods): ${p.residents} residents, ${p.households} households, ${p.peoplePerHectare} per hectare; ${P(p.shares.accommodation.flats)} flats; ${P(p.shares.tenure.privateRented)} private rented, ${P(p.shares.tenure.socialRented)} social rented; ${P(p.shares.householdsWithoutACar)} of households without a car`);
    const d = p.neighbourhoods.map((n) => n.imdDecile2019).filter((x): x is number => x != null);
    if (d.length) L.push(`Deprivation (IMD 2019): deciles ${Math.min(...d)} to ${Math.max(...d)} (1 = most deprived)`);
  }
  L.push(`On the red line: ${c.designations.onRedLine.length ? c.designations.onRedLine.map((d) => `${d.type}: ${d.name}`).join('; ') : 'no designations'}`);
  const g = Object.entries(c.designations.inStudyArea);
  if (g.length) L.push(`In the study area: ${g.map(([k, v]) => `${k} ${v.count}${v.examples.length ? ` (${v.examples.slice(0, 4).join(', ')}${v.count > 4 ? ', …' : ''})` : ''}`).join('; ')}`);
  const ga = c.gettingAbout;
  L.push(`Getting about: ${ga.nearestStation ? `nearest station ${ga.nearestStation.name}, ${fmtDist(ga.nearestStation.distanceM)}` : 'no station within 1.2 km'}; ${ga.busStopsWithin400m} bus stops within 400 m`);
  if (c.walkingReach) L.push(`Walking from the marked point: ${c.walkingReach.bands.map((b) => `${b.minutes} min ${b.streetsAndPathsKm} km of street`).join(', ')}`);
  if (c.selectedBuilding) {
    const b = c.selectedBuilding;
    L.push(`Selected building ${b.ref}${b.name ? ` (${b.name})` : ''}: ${b.heightM} m${b.heightRecorded ? '' : ' (estimated)'}, footprint ${fmtArea(b.footprintM2)}${b.onSite ? ', on the site' : ''}${b.listed.length ? `; listed: ${b.listed.join(', ')}` : ''}`);
  }
  if (c.proposedMassingHeightM) L.push(`Proposed massing: ${c.proposedMassingHeightM} m over the red line`);
  if (c.proposedBlocks) {
    const t = c.proposedBlocks.totals;
    L.push(`Proposed blocks: ${c.proposedBlocks.blocks.map((b) => `${b.name} (${b.use}, ${b.storeys} storeys, ${b.heightM} m)`).join('; ')}`);
    L.push(`Proposed totals: ${m2(t.floorAreaM2)} floor area${t.homes ? `, about ${t.homes} homes` : ''}${t.dwellingsPerHectare ? `, about ${t.dwellingsPerHectare} homes per hectare` : ''}${t.plotRatio != null ? `, plot ratio ${t.plotRatio}` : ''}${t.coverage != null ? `, coverage ${Math.round(t.coverage * 100)}%` : ''}`);
  }
  if (c.masterplan) {
    const mp = c.masterplan, sc = mp.schedule;
    if (mp.streets.length) L.push(`Masterplan streets: ${mp.streets.map((x) => (x.roundaboutDiameterM ? `${x.name} (${x.roundaboutDiameterM} m roundabout)` : `${x.name} (${x.type}, ${x.widthM} m wide${x.curve ? `, curved ${Math.round(x.curve * 100)}%` : ''}, ${x.lengthM} m long)`)).join('; ')}`);
    if (mp.openSpaces.length) L.push(`Masterplan open space: ${mp.openSpaces.map((o) => `${o.name} ${m2(o.areaM2)}`).join('; ')}`);
    if (mp.houses.length) L.push(`Masterplan houses: ${mp.houses.map((h) => `${h.homes} × ${h.type}`).join('; ')}`);
    if (mp.trees.count) L.push(`Trees: ${mp.trees.count} (${Object.entries(mp.trees.byType).map(([k, v]) => `${v} ${k.toLowerCase()}`).join(', ')}); canopy cover ${m2(mp.trees.canopyCoverM2)}${mp.trees.canopyCoverShareOfSite != null ? `, ${Math.round(mp.trees.canopyCoverShareOfSite * 100)}% of the site` : ''}`);
    L.push(`Masterplan schedule: ${sc.homes} homes (${sc.houseHomes} houses, ${sc.apartmentHomesFromBlocks} apartments)${sc.grossDwellingsPerHa != null ? `, ${sc.grossDwellingsPerHa} dph gross` : ''}${sc.netDwellingsPerHa != null ? `, ${sc.netDwellingsPerHa} dph net` : ''}, about ${sc.populationEstimate} people, about ${sc.parkingSpacesEstimate} parking spaces${sc.netDevelopableHa != null ? `; net developable ${sc.netDevelopableHa} ha of ${sc.siteHa} ha` : ''}`);
    L.push(`Affordable: ${mp.affordable.homes} homes, ${Math.round(mp.affordable.share * 100)}% against a ${mp.affordable.targetPct}% target. Mix: ${mp.bedroomMix.map((m) => `${m.bedrooms} bed ${Math.round(m.share * 100)}% (target ${m.targetPct}%)`).join(', ')}`);
    if (mp.openSpaceAgainstFieldsInTrust.length) L.push(`Open space against Fields in Trust: ${mp.openSpaceAgainstFieldsInTrust.map((b) => `${b.type} ${b.providedHa} of ${b.benchmarkHa} ha`).join('; ')}`);
  }
  L.push('', ...c.caveats);
  return L.join('\n');
}

const agent = initAgentPanel({ context: siteContext, summary: siteSummary, place: () => S.place });
$('#askBtn').onclick = () => (($('#agentDrawer').hidden ? agent.open() : agent.close()), drawLeader());

// ---------------------------------------------------------------- remember the last site (this browser only)
const KEY = 'ultrahand:last';
try {
  // Carry over a site saved under the tool's old name.
  const old = localStorage.getItem('site-lab:last');
  if (old && !localStorage.getItem(KEY)) localStorage.setItem(KEY, old);
  localStorage.removeItem('site-lab:last');
} catch { /* storage blocked */ }
/**
 * A ready-made copy of the masterplan as drawn here, for Consultation to bring onto its scenes:
 * homes as walls plus stepped roof slices (the map can only extrude flat tops), and the sketch
 * (pencil outlines, ridges, hatching). Written a moment after each change, and before a project file is saved.
 */
const MP_EXPORT_KEY = 'ultrahand:mp-export';

// ---------------------------------------------------------------- sites
// Several sites (e.g. three locations in one consultation). Each keeps its own red line, masterplan,
// massing, assumptions and targets in "ultrahand:site:<id>"; the one open is also the working copy
// in KEY, so everything else here is unchanged. Switching saves, swaps the working copy and reloads.
// Only the first site shares its red line and place with the rest of allto.
const SITES_KEY = 'ultrahand:sites';
interface SiteRef { id: string; name: string; updatedAt: number }
interface SitesIdx { current: string; list: SiteRef[] }
const siteKey = (id: string) => 'ultrahand:site:' + id;
const newSiteId = () => 'site' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
function sitesIdx(): SitesIdx {
  let ix: SitesIdx | null = null;
  try { ix = JSON.parse(localStorage.getItem(SITES_KEY) ?? 'null'); } catch { /* none yet */ }
  if (ix && ix.list?.length && ix.list.some((s) => s.id === ix!.current)) return ix;
  // First run: the site already here becomes site 1.
  const id = newSiteId();
  let name = 'Site 1';
  try {
    const j = JSON.parse(localStorage.getItem(KEY) ?? 'null');
    if (j?.place) name = String(j.place).split(',')[0].trim() || name;
  } catch { /* nothing saved */ }
  ix = { current: id, list: [{ id, name, updatedAt: Date.now() }] };
  try {
    localStorage.setItem(SITES_KEY, JSON.stringify(ix));
    const cur = localStorage.getItem(KEY);
    if (cur) localStorage.setItem(siteKey(id), cur);
    const ex = localStorage.getItem(MP_EXPORT_KEY);
    if (ex) localStorage.setItem(MP_EXPORT_KEY + ':' + id, ex);
  } catch { /* storage blocked */ }
  return ix;
}
function writeSitesIdx(ix: SitesIdx) { try { localStorage.setItem(SITES_KEY, JSON.stringify(ix)); } catch { /* storage blocked */ } }
function isPrimarySite() { const ix = sitesIdx(); return ix.list[0]?.id === ix.current; }
function currentSite() { const ix = sitesIdx(); return ix.list.find((s) => s.id === ix.current)!; }
function renderSites() {
  const ix = sitesIdx(), sel = $<HTMLSelectElement>('#siteSel');
  if (!sel) return;
  sel.innerHTML = ix.list.map((s, i) => `<option value="${s.id}"${s.id === ix.current ? ' selected' : ''}>${esc(s.name)}${i === 0 && ix.list.length > 1 ? ' (main)' : ''}</option>`).join('');
  $<HTMLButtonElement>('#siteDel').disabled = false;
}
/** Save the open site, make `id` the working copy and reload into it. */
function openSite(id: string) {
  saveProject();
  writeMpExport();
  loadSite(id);
}
/** Make `id` the working copy and reload into it (without saving the site open now). */
function loadSite(id: string) {
  const ix = sitesIdx();
  ix.current = id;
  writeSitesIdx(ix);
  try {
    const d = localStorage.getItem(siteKey(id)), ex = localStorage.getItem(MP_EXPORT_KEY + ':' + id);
    if (d) localStorage.setItem(KEY, d); else localStorage.removeItem(KEY);
    if (ex) localStorage.setItem(MP_EXPORT_KEY, ex); else localStorage.removeItem(MP_EXPORT_KEY);
  } catch { /* storage blocked */ }
  Allto?.markSeen(PRODUCT); // open the site as saved, not the red line shared from elsewhere
  location.reload();
}
function siteName(prompted: string | null) { return (prompted ?? '').trim().slice(0, 60); }
$('#siteSel').addEventListener('change', (e) => openSite((e.target as HTMLSelectElement).value));
$('#siteNew').onclick = () => {
  const ix = sitesIdx(), name = siteName(prompt('Name the new site', `Site ${ix.list.length + 1}`));
  if (!name) return;
  const id = newSiteId();
  ix.list.push({ id, name, updatedAt: Date.now() });
  writeSitesIdx(ix);
  openSite(id);
};
$('#siteRename').onclick = () => {
  const ix = sitesIdx(), s = ix.list.find((x) => x.id === ix.current)!, name = siteName(prompt('Rename this site', s.name));
  if (!name) return;
  s.name = name;
  writeSitesIdx(ix);
  renderSites();
};
$('#siteDup').onclick = () => {
  saveProject();
  writeMpExport();
  const ix = sitesIdx(), s = ix.list.find((x) => x.id === ix.current)!, id = newSiteId();
  try {
    const d = localStorage.getItem(KEY), ex = localStorage.getItem(MP_EXPORT_KEY);
    if (d) localStorage.setItem(siteKey(id), d);
    if (ex) localStorage.setItem(MP_EXPORT_KEY + ':' + id, ex);
  } catch { return alert('There is not enough room in this browser to copy the site.'); }
  ix.list.push({ id, name: `${s.name} (copy)`, updatedAt: Date.now() });
  writeSitesIdx(ix);
  openSite(id);
};
$('#siteDel').onclick = () => {
  const ix = sitesIdx(), s = ix.list.find((x) => x.id === ix.current)!;
  if (!confirm(`Delete \u201c${s.name}\u201d? Its red line, masterplan and massing go with it.${ix.list.length === 1 ? ' (It is the only site, so you start again with an empty one.)' : ''}`)) return;
  try { localStorage.removeItem(siteKey(s.id)); localStorage.removeItem(MP_EXPORT_KEY + ':' + s.id); } catch { /* ignore */ }
  ix.list = ix.list.filter((x) => x.id !== s.id);
  if (!ix.list.length) ix.list.push({ id: newSiteId(), name: 'Site 1', updatedAt: Date.now() });
  ix.current = ix.list[0].id;
  writeSitesIdx(ix);
  loadSite(ix.current);
};
renderSites();
let mpExportT = 0;
const r6 = (c: any): any => (typeof c[0] === 'number' ? [+c[0].toFixed(6), +c[1].toFixed(6)] : c.map(r6));
function writeMpExport() {
  clearTimeout(mpExportT);
  try {
    const p = S.plan;
    if (!p.homes.length && !p.streets.length && !p.open.length && !p.trees.length && !S.blocks.length) { localStorage.removeItem(MP_EXPORT_KEY + ':' + sitesIdx().current); return localStorage.removeItem(MP_EXPORT_KEY); }
    const typeOf = new Map(p.homes.map((h) => [h.id, h.type]));
    const homes = planGeoJSON(p, null).homes.features.map((f: any) => ({
      type: 'Feature', geometry: { type: f.geometry.type, coordinates: r6(f.geometry.coordinates) },
      properties: { type: typeOf.get(f.properties.id), colour: f.properties.colour, wash: f.properties.wash, base: +(+f.properties.base).toFixed(2), top: +(+f.properties.top).toFixed(2) },
    }));
    const sk = sketchGeoJSON(p, S.blocks.map((b) => b.shape));
    const slim = (fs: any[]) => fs.map((f) => ({ type: 'Feature', geometry: { type: f.geometry.type, coordinates: r6(f.geometry.coordinates) }, properties: f.properties }));
    const out = JSON.stringify({ v: 1, at: Date.now(), site: currentSite().name, homes, sketch: { lines: slim(sk.lines.features), hatches: slim(sk.hatches.features) } });
    localStorage.setItem(MP_EXPORT_KEY, out);
    localStorage.setItem(MP_EXPORT_KEY + ':' + sitesIdx().current, out);
  } catch { /* storage full or blocked: Consultation falls back to flat-topped homes */ }
}
function saveProject() {
  recordHistory();
  clearTimeout(mpExportT);
  mpExportT = window.setTimeout(writeMpExport, 700);
  try {
    const hasPlan = S.plan.streets.length || S.plan.open.length || S.plan.homes.length || S.plan.trees.length || S.plan.clear.length || S.plan.clearRed;
    const ix = sitesIdx();
    if (!S.red && !S.blocks.length && !hasPlan) { localStorage.removeItem(siteKey(ix.current)); return localStorage.removeItem(KEY); }
    const data = JSON.stringify({ red: S.red, place: S.place, bufferM: S.bufferM, blocks: S.blocks, assume: S.assume, plan: S.plan, mpAssume: S.mpAssume, targets: S.targets });
    localStorage.setItem(KEY, data);
    localStorage.setItem(siteKey(ix.current), data);
    const me = ix.list.find((x) => x.id === ix.current);
    if (me) {
      me.updatedAt = Date.now();
      // A site still called "Site n" takes the name of its place.
      if (/^Site \d+$/.test(me.name) && S.place) { me.name = S.place.split(',')[0].trim() || me.name; setTimeout(renderSites, 0); }
      writeSitesIdx(ix);
    }
  } catch { /* storage blocked */ }
}
let restored = false;
function restoreProject() {
  if (restored) return;
  restored = true;
  if (takeInShared(true)) return;
  try {
    const j = JSON.parse(localStorage.getItem(KEY) ?? 'null');
    if (Array.isArray(j?.blocks)) S.blocks = j.blocks;
    if (j?.assume) S.assume = { ...DEFAULT_ASSUMPTIONS, ...j.assume };
    if (S.blocks.length) setTimeout(renderBlocks, 0);
    if (j?.plan?.streets) S.plan = upgradePlan(j.plan);
    if (j?.targets) S.targets = { ...S.targets, ...j.targets, mix: { ...S.targets.mix, ...(j.targets.mix ?? {}) } };
    if (j?.mpAssume) S.mpAssume = { ...S.mpAssume, ...j.mpAssume };
    bindMpInputs();
    setTimeout(renderPlan, 0);
    setTimeout(() => ((undoStack.length = 0), (redoStack.length = 0), recordHistory()), 50); // a fresh history from the saved plan
    if (!j?.red) return;
    S.place = j.place ?? '';
    searchBox.value = S.place;
    $('#clearSearch').hidden = !S.place;
    S.bufferM = j.bufferM ?? 200;
    $<HTMLInputElement>('#bufferM').value = String(S.bufferM);
    $('#bufferLbl').textContent = `${S.bufferM} m around the red line`;
    setRed(j.red);
    map.jumpTo({ center: turf.centroid(j.red).geometry.coordinates as [number, number], zoom: 16 });
  } catch { /* nothing saved */ }
}

/** Use a red line drawn elsewhere in allto. Returns true if one was taken in. */
function takeInShared(opening: boolean): boolean {
  if (!Allto || !Allto.hasNews(PRODUCT) || !isPrimarySite()) return false;
  const p = Allto.project();
  Allto.markSeen(PRODUCT);
  if (!p.redLine || p.redLine.length < 4) return false;
  const same = S.red && S.red.geometry.type === 'Polygon' && JSON.stringify(S.red.geometry.coordinates[0]) === JSON.stringify(p.redLine);
  if (same) return false;
  takingIn = true;
  try {
    if (S.model || S.red) resetAll(false);
    S.place = p.place || p.name || '';
    searchBox.value = S.place;
    $('#clearSearch').hidden = !S.place;
    setRed(turf.polygon([p.redLine]) as PolyF);
    map.fitBounds(turf.bbox(S.study ?? S.red!) as any, { padding: 60, pitch: 0, bearing: 0, duration: opening ? 0 : 800 });
  } finally {
    takingIn = false;
  }
  Allto.notify(`Red line from ${Allto.productLabel(p.source ?? '')}. Press Analyse the site to read it.`);
  return true;
}
Allto?.onChange(() => map.isStyleLoaded() && takeInShared(false));
// The .allto project file stores the latest site, masterplan and assumptions.
Allto?.beforeSave?.(() => { saveProject(); writeMpExport(); });
// A copy for Consultation from a plan saved before this existed.
setTimeout(() => { try { if (!localStorage.getItem(MP_EXPORT_KEY)) writeMpExport(); } catch { /* ignore */ } }, 2500);
window.addEventListener('focus', () => map.isStyleLoaded() && takeInShared(false));

renderLayerList();
renderLegend();
applySun();
// Exposed for debugging in the console.
(window as any).ultrahand = { map, S, setView, select, analyse, resetAll };
