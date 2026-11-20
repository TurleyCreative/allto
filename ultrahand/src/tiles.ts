// Pull buildings, roads, landuse and water straight from Mapbox Streets v8 vector tiles
// for an area, independent of what the map currently has on screen.
import { VectorTile } from '@mapbox/vector-tile';
import { PbfReader } from 'pbf';
import * as turf from '@turf/turf';
import type { Feature, Polygon, MultiPolygon, LineString, MultiLineString, Point, BBox } from 'geojson';
import type { Poi, PoiCat } from './osm';

export interface StreetsData {
  buildings: Feature<Polygon | MultiPolygon>[];
  roads: Feature<LineString | MultiLineString>[];
  landuse: Feature<Polygon | MultiPolygon>[];
  water: Feature<Polygon | MultiPolygon>[];
  places: Feature<Point>[]; // named Mapbox POIs, used to name buildings
  zoom: number;
}

const lon2tile = (lon: number, z: number) => Math.floor(((lon + 180) / 360) * 2 ** z);
const lat2tile = (lat: number, z: number) => {
  const r = (lat * Math.PI) / 180;
  return Math.floor(((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * 2 ** z);
};

function tilesFor(b: BBox, z: number) {
  const out: [number, number][] = [];
  for (let x = lon2tile(b[0], z); x <= lon2tile(b[2], z); x++)
    for (let y = lat2tile(b[3], z); y <= lat2tile(b[1], z); y++) out.push([x, y]);
  return out;
}

async function pool<T, R>(items: T[], n: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const res: R[] = new Array(items.length);
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(n, items.length) }, async () => {
      while (i < items.length) {
        const k = i++;
        res[k] = await fn(items[k]);
      }
    }),
  );
  return res;
}

const isPoly = (f: Feature): f is Feature<Polygon | MultiPolygon> =>
  f.geometry?.type === 'Polygon' || f.geometry?.type === 'MultiPolygon';
const isLine = (f: Feature): f is Feature<LineString | MultiLineString> =>
  f.geometry?.type === 'LineString' || f.geometry?.type === 'MultiLineString';

export async function fetchStreets(bbox: BBox, token: string, onProgress?: (s: string) => void): Promise<StreetsData> {
  let z = 16;
  while (z > 14 && tilesFor(bbox, z).length > 80) z--;
  const tiles = tilesFor(bbox, z);
  let done = 0;
  const byId = new Map<string, Feature<Polygon | MultiPolygon>[]>();
  const loose: Feature<Polygon | MultiPolygon>[] = [];
  const roads: StreetsData['roads'] = [];
  const landuse: StreetsData['landuse'] = [];
  const water: StreetsData['water'] = [];
  const places: StreetsData['places'] = [];

  await pool(tiles, 8, async ([x, y]) => {
    const url = `https://api.mapbox.com/v4/mapbox.mapbox-streets-v8/${z}/${x}/${y}.vector.pbf?access_token=${token}`;
    const r = await fetch(url);
    if (!r.ok) return;
    const vt = new VectorTile(new PbfReader(new Uint8Array(await r.arrayBuffer())));
    const L = vt.layers;
    if (L.building)
      for (let i = 0; i < L.building.length; i++) {
        const f = L.building.feature(i);
        const gj = f.toGeoJSON(x, y, z) as Feature;
        if (!isPoly(gj) || gj.properties?.underground === 'true') continue;
        if (f.id != null) {
          const k = String(f.id);
          if (!byId.has(k)) byId.set(k, []);
          byId.get(k)!.push(gj);
        } else loose.push(gj);
      }
    if (L.road)
      for (let i = 0; i < L.road.length; i++) {
        const gj = L.road.feature(i).toGeoJSON(x, y, z) as Feature;
        if (isLine(gj) && gj.properties?.structure !== 'tunnel') roads.push(gj);
      }
    for (const name of ['landuse', 'landuse_overlay'])
      if (L[name])
        for (let i = 0; i < L[name].length; i++) {
          const gj = L[name].feature(i).toGeoJSON(x, y, z) as Feature;
          if (isPoly(gj)) landuse.push(gj);
        }
    if (L.water)
      for (let i = 0; i < L.water.length; i++) {
        const gj = L.water.feature(i).toGeoJSON(x, y, z) as Feature;
        if (isPoly(gj)) water.push(gj);
      }
    if (L.poi_label)
      for (let i = 0; i < L.poi_label.length; i++) {
        const gj = L.poi_label.feature(i).toGeoJSON(x, y, z) as Feature;
        if (gj.geometry?.type === 'Point' && gj.properties?.name) places.push(gj as Feature<Point>);
      }
    onProgress?.(`Loading map tiles ${++done}/${tiles.length}`);
  });

  // Buildings that cross tile edges arrive in pieces sharing an id: stitch them back together.
  const buildings: StreetsData['buildings'] = [...loose];
  for (const [id, parts] of byId) {
    let f: Feature<Polygon | MultiPolygon> | null = parts[0];
    if (parts.length > 1) {
      try {
        f = turf.union(turf.featureCollection(parts)) ?? parts[0];
      } catch {
        f = parts[0];
      }
      const h = Math.max(...parts.map((p) => +(p.properties?.height ?? 0)));
      const mh = Math.min(...parts.map((p) => +(p.properties?.min_height ?? 0)));
      f.properties = { ...parts[0].properties, height: h, min_height: mh };
    }
    f.id = id;
    buildings.push(f);
  }
  return { buildings, roads, landuse, water, places, zoom: z };
}

/** Everyday places and transport stops from Mapbox Streets tiles: the fallback when Overpass is unavailable. */
export async function fetchPoisFromTiles(bbox: BBox, token: string): Promise<Poi[]> {
  let z = 15;
  while (z > 13 && tilesFor(bbox, z).length > 40) z--;
  const out = new Map<string, Poi>();
  const add = (cat: PoiCat, kind: string, name: string, c: number[]) => {
    const id = `${cat}:${name}:${c[0].toFixed(4)},${c[1].toFixed(4)}`;
    if (!out.has(id)) out.set(id, { id, cat, kind, name, lon: c[0], lat: c[1] });
  };
  await pool(tilesFor(bbox, z), 8, async ([x, y]) => {
    const r = await fetch(`https://api.mapbox.com/v4/mapbox.mapbox-streets-v8/${z}/${x}/${y}.vector.pbf?access_token=${token}`);
    if (!r.ok) return;
    const L = new VectorTile(new PbfReader(new Uint8Array(await r.arrayBuffer()))).layers;
    if (L.poi_label)
      for (let i = 0; i < L.poi_label.length; i++) {
        const f = L.poi_label.feature(i).toGeoJSON(x, y, z) as Feature<Point>;
        const p = f.properties ?? {};
        const maki = String(p.maki ?? ''), cls = String(p.class ?? ''), name = String(p.name ?? maki);
        const c = f.geometry.coordinates;
        if (/^(grocery|convenience|bakery)$/.test(maki) || cls === 'food_and_drink_stores') add('shop', maki || 'shop', name, c);
        else if (/^(school|college|university)$/.test(maki) || cls === 'education') add('school', maki || 'school', name, c);
        else if (/^(doctor|pharmacy|hospital|dentist)$/.test(maki) || cls === 'medical') add('health', maki || 'health', name, c);
        else if (/^(park|playground|garden)$/.test(maki) || cls === 'park_like') add('park', maki || 'park', name, c);
      }
    if (L.transit_stop_label)
      for (let i = 0; i < L.transit_stop_label.length; i++) {
        const f = L.transit_stop_label.feature(i).toGeoJSON(x, y, z) as Feature<Point>;
        const mode = String(f.properties?.mode ?? ''), name = String(f.properties?.name ?? mode);
        if (mode === 'bus') add('bus', 'bus stop', name, f.geometry.coordinates);
        else if (/rail|tram|metro/.test(mode)) add('rail', mode.replace('_', ' '), name, f.geometry.coordinates);
      }
  });
  return [...out.values()];
}

/**
 * Walkable street lines for an area, cut exactly at each tile's edge so the same street in
 * neighbouring tiles meets end to end (the walk network joins them back up).
 */
export async function fetchWalkNetwork(bbox: BBox, token: string): Promise<{ cls: string; coords: number[][] }[]> {
  let z = 16;
  while (z > 14 && tilesFor(bbox, z).length > 100) z--;
  const NO_WALK = /^(motorway|motorway_link|ferry|aerialway|golf|major_rail|minor_rail|service_rail)$/;
  const out: { cls: string; coords: number[][] }[] = [];
  const t2lon = (x: number) => (x / 2 ** z) * 360 - 180;
  const t2lat = (y: number) => (Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / 2 ** z))) * 180) / Math.PI;
  await pool(tilesFor(bbox, z), 8, async ([x, y]) => {
    const r = await fetch(`https://api.mapbox.com/v4/mapbox.mapbox-streets-v8/${z}/${x}/${y}.vector.pbf?access_token=${token}`);
    if (!r.ok) return;
    const L = new VectorTile(new PbfReader(new Uint8Array(await r.arrayBuffer()))).layers;
    if (!L.road) return;
    const tb: BBox = [t2lon(x), t2lat(y + 1), t2lon(x + 1), t2lat(y)];
    for (let i = 0; i < L.road.length; i++) {
      const gj = L.road.feature(i).toGeoJSON(x, y, z) as Feature;
      const cls = String(gj.properties?.class ?? '');
      if (!isLine(gj) || NO_WALK.test(cls) || gj.properties?.structure === 'tunnel' && /motorway|trunk/.test(cls)) continue;
      const clipped = turf.bboxClip(gj as any, tb).geometry as LineString | MultiLineString;
      const parts = clipped.type === 'LineString' ? [clipped.coordinates] : clipped.coordinates;
      for (const c of parts) if (c.length > 1) out.push({ cls, coords: c });
    }
  });
  return out;
}
