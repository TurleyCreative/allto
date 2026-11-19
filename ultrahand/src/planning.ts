// England planning designations from planning.data.gov.uk (open data, no key needed).
import * as turf from '@turf/turf';
import type { Feature, FeatureCollection, BBox } from 'geojson';

export interface Dataset {
  id: string;
  label: string;
  color: string;
  kind: 'fill' | 'point';
  group: 'Heritage' | 'Environment' | 'Planning';
  on?: boolean;
}

export const DATASETS: Dataset[] = [
  { id: 'conservation-area', label: 'Conservation areas', color: '#C79A00', kind: 'fill', group: 'Heritage', on: true },
  { id: 'listed-building', label: 'Listed buildings', color: '#7B3FA0', kind: 'point', group: 'Heritage', on: true },
  { id: 'scheduled-monument', label: 'Scheduled monuments', color: '#9C4A1A', kind: 'fill', group: 'Heritage', on: true },
  { id: 'park-and-garden', label: 'Registered parks & gardens', color: '#4F8A3A', kind: 'fill', group: 'Heritage' },
  { id: 'world-heritage-site', label: 'World heritage sites', color: '#5B2C91', kind: 'fill', group: 'Heritage' },
  { id: 'flood-risk-zone', label: 'Flood zones 2 & 3', color: '#2F7EE0', kind: 'fill', group: 'Environment', on: true },
  { id: 'tree-preservation-zone', label: 'Tree preservation areas', color: '#2F7D32', kind: 'fill', group: 'Environment' },
  { id: 'site-of-special-scientific-interest', label: 'SSSI', color: '#3C9D7A', kind: 'fill', group: 'Environment' },
  { id: 'ancient-woodland', label: 'Ancient woodland', color: '#4A6B2A', kind: 'fill', group: 'Environment' },
  { id: 'local-nature-reserve', label: 'Local nature reserves', color: '#6FAE5F', kind: 'fill', group: 'Environment' },
  { id: 'green-belt', label: 'Green belt', color: '#8DBF6A', kind: 'fill', group: 'Planning' },
  { id: 'article-4-direction-area', label: 'Article 4 directions', color: '#D06C9A', kind: 'fill', group: 'Planning' },
  { id: 'brownfield-land', label: 'Brownfield register', color: '#A0522D', kind: 'point', group: 'Planning' },
];

const API = 'https://www.planning.data.gov.uk';

export async function fetchDataset(id: string, bbox: BBox): Promise<FeatureCollection> {
  const [w, s, e, n] = bbox;
  const wkt = `POLYGON((${w} ${s},${e} ${s},${e} ${n},${w} ${n},${w} ${s}))`;
  const features: Feature[] = [];
  const limit = 500;
  for (let offset = 0; offset < 3000; offset += limit) {
    const q = new URLSearchParams({ dataset: id, geometry: wkt, geometry_relation: 'intersects', limit: String(limit), offset: String(offset) });
    const r = await fetch(`${API}/entity.geojson?${q}`);
    if (!r.ok) break;
    const j = (await r.json()) as FeatureCollection;
    for (const f of j.features ?? []) {
      if (!f.geometry) continue;
      // Big national polygons (flood zones, green belt) get trimmed to the area so the map stays light.
      if (f.geometry.type !== 'Point') {
        try {
          const c = turf.bboxClip(f as any, [w - 0.01, s - 0.01, e + 0.01, n + 0.01]);
          if (!c.geometry || (c.geometry as any).coordinates.length === 0) continue;
          f.geometry = c.geometry;
        } catch { /* keep as is */ }
      }
      f.properties = { ...f.properties, dataset: id };
      features.push(f);
    }
    if ((j.features ?? []).length < limit) break;
  }
  return { type: 'FeatureCollection', features };
}

export async function fetchPlanningAuthority(lon: number, lat: number): Promise<string | null> {
  try {
    const q = new URLSearchParams({ dataset: 'local-planning-authority', longitude: String(lon), latitude: String(lat), limit: '1' });
    const r = await fetch(`${API}/entity.json?${q}`);
    const j = await r.json();
    return j.entities?.[0]?.name ?? null;
  } catch {
    return null;
  }
}

/** Human label for one designation feature. */
export function describe(f: Feature): string {
  const p = f.properties ?? {};
  const name = p.name || p.reference || 'Unnamed';
  switch (p.dataset) {
    case 'listed-building':
      return `${name}${p['listed-building-grade'] ? ` (Grade ${p['listed-building-grade']})` : ''}`;
    case 'flood-risk-zone':
      return `Flood zone ${p['flood-risk-level'] ?? ''}`.trim();
    default:
      return name;
  }
}

export const entityUrl = (f: Feature) => `${API}/entity/${f.properties?.entity}`;
