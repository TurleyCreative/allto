import mapboxgl from 'mapbox-gl';
import 'mapbox-gl/dist/mapbox-gl.css';
import MapboxDraw from '@mapbox/mapbox-gl-draw';
import '@mapbox/mapbox-gl-draw/dist/mapbox-gl-draw.css';
import * as turf from '@turf/turf';
import * as SunCalc from 'suncalc';
import type { Feature, FeatureCollection, Polygon, MultiPolygon } from 'geojson';
import './style.css';

import { DATASETS, fetchDataset, fetchPlanningAuthority, describe, entityUrl } from './planning';
import { fetchStreets, fetchPoisFromTiles, fetchWalkNetwork } from './tiles';
import { buildGraph, walkFrom, walkPieces, WALK_SPEED, BANDS } from './walk';
import { buildModel, modelGeoJSON, GREEN, type SiteModel, type Bldg } from './model';
import { fetchPois, fetchBuildingAt, reverseGeocode, type Poi } from './osm';
import { renderAxo, groundLayers, LOOK, type AxoBuilding, type GroundPolys } from './axo';
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
  drawing: null as null | 'red' | 'study' | 'box',
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
  atlas: null as AtlasLayout | null,
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
  for (const id of ['mask', 'red', 'study', 'walk', 'walkpt', 'model', 'pois', 'selected', 'massing', 'atlas-labels']) map.addSource(id, { type: 'geojson', data: empty });

  for (const d of DATASETS) {
    map.addSource(`ds-${d.id}`, { type: 'geojson', data: empty });
    if (d.kind === 'fill') {
      const color: any = d.id === 'flood-risk-zone' ? ['match', ['to-string', ['get', 'flood-risk-level']], '3', '#1f5fc4', '#7fb2f0'] : d.color;
      map.addLayer({ id: `ds-${d.id}-f`, type: 'fill', source: `ds-${d.id}`, paint: { 'fill-color': color, 'fill-opacity': 0.08 } });
      map.addLayer({ id: `ds-${d.id}-l`, type: 'line', source: `ds-${d.id}`, paint: { 'line-color': color, 'line-width': 1.5, 'line-dasharray': [3, 2] } });
    }
  }
  map.addLayer({ id: 'mask', type: 'fill', source: 'mask', paint: { 'fill-color': '#ffffff', 'fill-opacity': 0.55 } });
  map.addLayer({ id: 'walk', type: 'line', source: 'walk', paint: { 'line-color': '#f08a1c', 'line-width': ['match', ['get', 'contour'], 5, 1.6, 10, 1.3, 1], 'line-dasharray': [1, 2] } });
  map.addLayer({
    id: 'walkpt', type: 'line', source: 'walkpt', filter: ['<=', ['get', 'd'], 0],
    layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: { 'line-color': walkColourExpr(), 'line-width': ['interpolate', ['linear'], ['zoom'], 14, ['match', ['get', 'band'], 5, 1.8, 10, 1.2, 0.9], 18, ['match', ['get', 'band'], 5, 4.5, 10, 3, 2.2]] },
  });
  map.addLayer({ id: 'study-line', type: 'line', source: 'study', paint: { 'line-color': '#141414', 'line-width': 1.1, 'line-dasharray': [7, 3, 1, 3] } });
  map.addLayer({ id: 'red-fill', type: 'fill', source: 'red', paint: { 'fill-color': '#d7262e', 'fill-opacity': 0.06 } });
  map.addLayer({ id: 'red-line', type: 'line', source: 'red', paint: { 'line-color': '#d7262e', 'line-width': 3 } });
  map.addLayer({ id: 'selected-line', type: 'line', source: 'selected', paint: { 'line-color': '#2433e0', 'line-width': 3 } });

  map.addLayer({
    id: 'context-3d', type: 'fill-extrusion', source: 'composite', 'source-layer': 'building', minzoom: 14,
    filter: ['==', ['get', 'extrude'], 'true'],
    layout: { visibility: 'none' },
    paint: { 'fill-extrusion-color': '#ecebe7', 'fill-extrusion-height': ['get', 'height'], 'fill-extrusion-base': ['get', 'min_height'], 'fill-extrusion-opacity': 0.92 },
  });
  map.addLayer({ id: 'model-3d', type: 'fill-extrusion', source: 'model', paint: { 'fill-extrusion-height': ['get', 'h'], 'fill-extrusion-base': ['get', 'minH'], 'fill-extrusion-opacity': 0.97 } });
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
function startDraw(kind: 'red' | 'study') {
  draw.deleteAll();
  S.drawing = kind;
  if (S.view !== 'plan') setView('plan');
  draw.changeMode('draw_polygon');
  $('#redHint').textContent = 'Click each corner. Double-click (or click the first corner) to finish.';
}
$('#drawRed').onclick = () => startDraw('red');
$('#drawStudy').onclick = () => startDraw('study');
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
  if (f && Allto && !takingIn) {
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
    if (S.place) Allto?.update({ place: S.place, ...(Allto.project().name ? {} : { name: S.place }) }, PRODUCT);
    if (seq !== analyseSeq) return;

    map.setLayoutProperty('context-3d', 'visibility', 'none');
    renderLayerList();
    applyVisibility();
    renderSummary();
    renderLegend();
    select(null);
    ['#expAxo', '#expPlan', '#expAtlas'].forEach((s) => ($<HTMLButtonElement>(s).disabled = false));
    say('');
    if (S.view === 'axo' || S.view === '3d') animateGrow();
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
  select(null);
  draw.deleteAll();
  Object.assign(S, {
    red: null, study: null, drawnStudy: null, drawnBox: null, drawing: null, model: null, modelFC: empty, designations: empty,
    pois: [], place: '', lpa: null, walk: empty, massing: 0, atlas: null, atlasT: 0,
  });
  for (const id of ['mask', 'red', 'study', 'walk', 'model', 'pois', 'selected', 'massing', 'atlas-labels', ...DATASETS.map((d) => `ds-${d.id}`)])
    (map.getSource(id) as mapboxgl.GeoJSONSource | undefined)?.setData(empty);
  searchBox.value = '';
  $('#results').innerHTML = '';
  $('#clearSearch').hidden = true;
  $<HTMLInputElement>('#massing').value = '0';
  $('#progress').textContent = '';
  $('#area').hidden = true;
  $('#area').innerHTML = '';
  ['#expAxo', '#expPlan', '#expAtlas'].forEach((s) => ($<HTMLButtonElement>(s).disabled = true));
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
const GROUPS = ['Heritage', 'Environment', 'Planning', 'Movement'] as const;
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
      g === 'Movement'
        ? row('walk', 'Walking reach 5 · 10 · 15 min', '#f08a1c', false, '') + row('pois', 'Transport & everyday places', '#141414', true, S.pois.length ? String(S.pois.length) : '') + row('labels', 'Street names', '#999', false, '')
        : DATASETS.filter((d) => d.group === g).map((d) => row(d.id, d.label, d.color, d.kind === 'point', S.model ? String(counts.get(d.id) ?? 0) : '')).join('');
    const ids = g === 'Movement' ? ['walk', 'pois', 'labels'] : DATASETS.filter((d) => d.group === g).map((d) => d.id);
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
  vis('walkpt', !atlas);
  if (walkMarker) walkMarker.getElement().style.display = atlas ? 'none' : '';
  const wp = document.getElementById('walkPanel');
  if (wp && walkMarker) wp.hidden = atlas;
  vis('pois', flat && S.visible.has('pois'));
  vis('pois-label', flat && S.visible.has('pois'));
  for (const id of ['red-fill', 'red-line', 'study-line', 'massing-3d', 'selected-line']) vis(id, !atlas);
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
    <h4>On the red line</h4>
    ${onRed.length ? onRed.map((f) => `<div class="desig"><span class="sw" style="background:${colorOf(f.properties?.dataset)}"></span><a href="${entityUrl(f)}" target="_blank">${esc(describe(f))}</a></div>`).join('') : `<p class="muted">${S.red ? 'No designations touch the red line.' : 'No red line drawn.'}</p>`}
    <h4>Getting about</h4>
    ${rail ? `<p>Nearest station: <b>${esc(rail.p.name)}</b>, ${fmtDist(rail.d)}</p>` : '<p class="muted">No station within 1.2 km.</p>'}
    <p>${buses} bus stops within 400 m</p>`;
  $('#drawAnother').onclick = () => resetAll(false);
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
    ${S.selected ? `<div class="lg">${sw('#2433e0')}Selected: ${S.selected.ref}</div>` : ''}`;
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
let lastDrawEnd = 0; // the click that finishes a drawing must not also start a walk
map.on('click', (e) => {
  if (S.drawing || eye.dragged || Date.now() - lastDrawEnd < 400) return;
  const hit = S.model ? map.queryRenderedFeatures(e.point, { layers: ['model-3d'] })[0] : undefined;
  if (S.model) select(hit ? S.model.buildings[hit.id as number] : null);
  // An empty spot: walk from here (not in the atlas, where the buildings are out of place, or at eye level).
  if (!hit && S.view !== 'atlas' && S.view !== 'eye') walkFromPoint([e.lngLat.lng, e.lngLat.lat]);
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
      <dt>Height</dt><dd>${b.heightKnown ? `${b.h.toFixed(1)} m` : '<span class="muted">not recorded (6 m drawn)</span>'}</dd>
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
  if (!b || !anchor || $('#card').hidden) return void (svg.innerHTML = '');
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
  document.querySelectorAll('#views [data-view]').forEach((x) => x.classList.toggle('on', (x as HTMLElement).dataset.view === v));
  map.setCamera({ 'camera-projection': v === 'axo' || v === 'plan' || v === 'atlas' ? 'orthographic' : 'perspective' });
  const isolate = (v === 'axo' || v === 'atlas') && !!S.model;
  map.setFilter('model-3d', isolate ? ['==', ['get', 'inStudy'], true] : null);
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
let walkNet: { study: PolyF; frame: LocalFrame; graph: ReturnType<typeof buildGraph> } | null = null;
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
      walkNet = { study: S.study, frame, graph: buildGraph(lines, frame) };
    }
    const { graph, frame } = walkNet;
    const res = walkFrom(graph, frame.toLocal(ll), WALK_LIMIT);
    if (!res) return (clearWalk(), toast('No street within 250 m of that spot.'));
    const { fc, lengthIn } = walkPieces(graph, res.dist, frame, WALK_LIMIT);
    (map.getSource('walkpt') as mapboxgl.GeoJSONSource).setData(fc);
    lastWalk = { lengthIn, start: res.start };
    renderWalkKey();
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
      `<p class="muted">Along streets and footpaths at 4.8 km/h${start > 15 ? `, starting ${Math.round(start)} m from the nearest street` : ''}. Tick a band to show it on the map; click a swatch to change its colour. Click another spot to walk from there.</p>`,
  );
  const el = $('#walkPanel');
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
  const pitch = kind === 'plan' ? 0 : S.view === 'axo' || S.view === '3d' ? map.getPitch() : 55;
  const svg = renderAxo(
    {
      buildings: kind === 'plan' ? buildings.map((b) => ({ ...b, z1: b.z0 })) : buildings,
      clip: m.studyPolys,
      ground: [...groundLayers(m, GREEN), ...overlayPolys()],
      shadows: $<HTMLInputElement>('#sunOn').checked && s.alt > 0 ? { toSun: s.toSun, alt: s.alt } : undefined,
    },
    {
      bearing: kind === 'plan' ? 0 : map.getBearing(), mode: kind === 'plan' ? 'ortho' : mode, pitch,
      width: 1800, plinth: kind === 'axo' && $<HTMLInputElement>('#optPlinth').checked ? 10 : 0,
      background: '#ffffff', north: true, scaleBar: kind === 'plan' || mode === 'oblique', labels: $<HTMLInputElement>('#optLabels').checked,
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

// ---------------------------------------------------------------- remember the last site (this browser only)
const KEY = 'ultrahand:last';
try {
  // Carry over a site saved under the tool's old name.
  const old = localStorage.getItem('site-lab:last');
  if (old && !localStorage.getItem(KEY)) localStorage.setItem(KEY, old);
  localStorage.removeItem('site-lab:last');
} catch { /* storage blocked */ }
function saveProject() {
  try {
    if (!S.red) return;
    localStorage.setItem(KEY, JSON.stringify({ red: S.red, place: S.place, bufferM: S.bufferM }));
  } catch { /* storage blocked */ }
}
let restored = false;
function restoreProject() {
  if (restored) return;
  restored = true;
  if (takeInShared(true)) return;
  try {
    const j = JSON.parse(localStorage.getItem(KEY) ?? 'null');
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
  if (!Allto || !Allto.hasNews(PRODUCT)) return false;
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
window.addEventListener('focus', () => map.isStyleLoaded() && takeInShared(false));

renderLayerList();
renderLegend();
applySun();
// Exposed for debugging in the console.
(window as any).ultrahand = { map, S, setView, select, analyse, resetAll };
