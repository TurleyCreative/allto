// Everyday places and transport from OpenStreetMap (Overpass), plus Mapbox walking times.
import type { BBox } from 'geojson';

export type PoiCat = 'shop' | 'school' | 'health' | 'park' | 'bus' | 'rail';
export interface Poi { id: string; cat: PoiCat; name: string; lon: number; lat: number; kind: string }

export const CAT_LABEL: Record<PoiCat, string> = {
  shop: 'A food shop',
  school: 'A school or college',
  health: 'A GP, pharmacy or hospital',
  park: 'A park or playground',
  bus: 'A bus stop',
  rail: 'A station or tram stop',
};

const OVERPASS = ['https://overpass-api.de/api/interpreter', 'https://overpass.private.coffee/api/interpreter'];

/** POST a query to the first Overpass server that answers. */
async function overpass(q: string, timeoutMs = 30000): Promise<any> {
  let last: unknown;
  for (const url of OVERPASS) {
    try {
      const ctl = new AbortController();
      const t = setTimeout(() => ctl.abort(), timeoutMs);
      const r = await fetch(url, { method: 'POST', body: new URLSearchParams({ data: q }), signal: ctl.signal });
      clearTimeout(t);
      if (r.ok) return await r.json();
      last = new Error(`Overpass ${r.status}`);
    } catch (e) {
      last = e;
    }
  }
  throw last;
}

export async function fetchPois(b: BBox): Promise<Poi[]> {
  const bb = `${b[1]},${b[0]},${b[3]},${b[2]}`;
  const q = `[out:json][timeout:40];(
    nwr["shop"~"^(supermarket|convenience|greengrocer|bakery|butcher|general|deli)$"](${bb});
    nwr["amenity"~"^(school|college|doctors|pharmacy|hospital|clinic)$"](${bb});
    nwr["leisure"~"^(park|playground)$"](${bb});
    node["highway"="bus_stop"](${bb});
    nwr["railway"~"^(station|halt|tram_stop)$"](${bb});
  );out center tags;`;
  const j = await overpass(q);
  const out: Poi[] = [];
  for (const e of j.elements ?? []) {
    const t = e.tags ?? {};
    const lon = e.lon ?? e.center?.lon, lat = e.lat ?? e.center?.lat;
    if (lon == null) continue;
    let cat: PoiCat | null = null, kind = '';
    if (t.shop) (cat = 'shop'), (kind = t.shop);
    else if (/^(school|college)$/.test(t.amenity)) (cat = 'school'), (kind = t.amenity);
    else if (/^(doctors|pharmacy|hospital|clinic)$/.test(t.amenity)) (cat = 'health'), (kind = t.amenity);
    else if (t.leisure) (cat = 'park'), (kind = t.leisure);
    else if (t.highway === 'bus_stop') (cat = 'bus'), (kind = 'bus stop');
    else if (t.railway) (cat = 'rail'), (kind = t.railway === 'tram_stop' ? 'tram stop' : t.station === 'subway' ? 'underground' : 'station');
    if (cat) out.push({ id: `${e.type}/${e.id}`, cat, kind, lon, lat, name: t.name || t.brand || kind });
  }
  return out;
}

export interface OsmBuilding { id: string; tags: Record<string, string> }

/** The OSM building way that contains a point (used for the passport's identity section). */
export async function fetchBuildingAt(lon: number, lat: number): Promise<OsmBuilding | null> {
  const q = `[out:json][timeout:20];way(around:4,${lat},${lon})["building"];out tags geom;`;
  try {
    const j = await overpass(q, 15000);
    const ways = j.elements ?? [];
    const inside = ways.find((w: any) => pointInRing([lon, lat], (w.geometry ?? []).map((g: any) => [g.lon, g.lat])));
    const w = inside ?? ways[0];
    return w ? { id: `way/${w.id}`, tags: w.tags ?? {} } : null;
  } catch {
    return null;
  }
}

function pointInRing(p: number[], r: number[][]) {
  let c = false;
  for (let i = 0, j = r.length - 1; i < r.length; j = i++)
    if (r[i][1] > p[1] !== r[j][1] > p[1] && p[0] < ((r[j][0] - r[i][0]) * (p[1] - r[i][1])) / (r[j][1] - r[i][1]) + r[i][0]) c = !c;
  return c;
}

/** Walking minutes from one origin to up to 24 destinations (Mapbox Matrix API). */
export async function walkTimes(origin: [number, number], dests: [number, number][], token: string, profile = 'walking'): Promise<(number | null)[]> {
  if (!dests.length) return [];
  const coords = [origin, ...dests.slice(0, 24)].map((c) => `${c[0].toFixed(6)},${c[1].toFixed(6)}`).join(';');
  const r = await fetch(`https://api.mapbox.com/directions-matrix/v1/mapbox/${profile}/${coords}?sources=0&annotations=duration&access_token=${token}`);
  const j = await r.json();
  return (j.durations?.[0] ?? []).slice(1).map((s: number | null) => (s == null ? null : s / 60));
}

export async function reverseGeocode(lon: number, lat: number, token: string): Promise<{ street?: string; place?: string } | null> {
  try {
    const r = await fetch(`https://api.mapbox.com/search/geocode/v6/reverse?longitude=${lon}&latitude=${lat}&types=address,street&limit=1&access_token=${token}`);
    const j = await r.json();
    const p = j.features?.[0]?.properties;
    if (!p) return null;
    return { street: p.context?.street?.name ?? p.name, place: p.context?.place?.name ?? p.context?.locality?.name };
  } catch {
    return null;
  }
}
