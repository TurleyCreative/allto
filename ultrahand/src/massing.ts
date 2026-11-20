// Massing: draw proposed blocks, give each a use and a number of storeys, and read the totals live.
// Floor areas are gross internal area (footprint × storeys); homes and density use stated assumptions
// that are shown with the figures and can be changed.
import * as turf from '@turf/turf';
import type { Feature, FeatureCollection, Polygon } from 'geojson';

export type Use = 'residential' | 'office' | 'retail' | 'community' | 'other';
export const USES: { id: Use; label: string; colour: string; storeyM: number }[] = [
  { id: 'residential', label: 'Residential', colour: '#e6262e', storeyM: 3.15 },
  { id: 'office', label: 'Workspace', colour: '#2f6fd6', storeyM: 4.0 },
  { id: 'retail', label: 'Retail and food', colour: '#f08a1c', storeyM: 4.5 },
  { id: 'community', label: 'Community', colour: '#3f8f3f', storeyM: 4.0 },
  { id: 'other', label: 'Other', colour: '#6f6e6a', storeyM: 3.5 },
];
export const useOf = (id: Use) => USES.find((u) => u.id === id)!;

export interface Block {
  id: string;
  name: string;
  shape: Feature<Polygon>;
  use: Use;
  storeys: number;
  baseM: number; // starts above the ground (e.g. above a podium)
}

export interface Assumptions {
  netToGross: number; // residential net internal area ÷ gross internal area
  homeSizeM2: number; // average home, net internal
}
export const DEFAULT_ASSUMPTIONS: Assumptions = { netToGross: 0.82, homeSizeM2: 65 };

export const heightOf = (b: Block) => b.storeys * useOf(b.use).storeyM;
export const footprintOf = (b: Block) => turf.area(b.shape);
export const giaOf = (b: Block) => footprintOf(b) * b.storeys;

export interface MassingTotals {
  blocks: number;
  footprintM2: number;
  giaM2: number;
  giaByUse: Partial<Record<Use, number>>;
  homes: number;
  tallestM: number;
  siteM2: number | null;
  plotRatio: number | null;
  coverage: number | null;
  dph: number | null; // dwellings per hectare
}

export function totals(blocks: Block[], site: Feature<Polygon | any> | null, a: Assumptions): MassingTotals {
  const giaByUse: Partial<Record<Use, number>> = {};
  let footprint = 0, gia = 0, tallest = 0;
  for (const b of blocks) {
    const g = giaOf(b);
    giaByUse[b.use] = (giaByUse[b.use] ?? 0) + g;
    gia += g;
    footprint += footprintOf(b);
    tallest = Math.max(tallest, b.baseM + heightOf(b));
  }
  // Blocks can overlap on plan (a tower on a podium): coverage uses their union.
  let covered = footprint;
  if (blocks.length > 1) {
    try {
      const u = turf.union(turf.featureCollection(blocks.map((b) => b.shape)));
      if (u) covered = turf.area(u);
    } catch { /* keep the simple sum */ }
  }
  const homes = Math.floor(((giaByUse.residential ?? 0) * a.netToGross) / a.homeSizeM2);
  const siteM2 = site ? turf.area(site) : null;
  return {
    blocks: blocks.length,
    footprintM2: covered,
    giaM2: gia,
    giaByUse,
    homes,
    tallestM: tallest,
    siteM2,
    plotRatio: siteM2 ? gia / siteM2 : null,
    coverage: siteM2 ? covered / siteM2 : null,
    dph: siteM2 ? homes / (siteM2 / 10000) : null,
  };
}

export function blocksGeoJSON(blocks: Block[], selected: string | null): FeatureCollection {
  return {
    type: 'FeatureCollection',
    features: blocks.map((b) => ({
      type: 'Feature',
      id: Number(b.id.replace(/\D/g, '')) || 0,
      geometry: b.shape.geometry,
      properties: { id: b.id, name: b.name, colour: useOf(b.use).colour, base: b.baseM, top: b.baseM + heightOf(b), selected: b.id === selected },
    })),
  };
}

/** Labels for the map: name and storeys at each block's centre. */
export function blockLabels(blocks: Block[]): FeatureCollection {
  return {
    type: 'FeatureCollection',
    features: blocks.map((b) => ({ type: 'Feature', geometry: turf.centroid(b.shape).geometry, properties: { text: `${b.name} · ${b.storeys}` } })),
  };
}

let n = 0;
export function newBlock(shape: Feature<Polygon>, existing: Block[]): Block {
  n = Math.max(n, ...existing.map((b) => Number(b.id.replace(/\D/g, '')) || 0)) + 1;
  return { id: `M${n}`, name: `Block ${String.fromCharCode(64 + ((n - 1) % 26) + 1)}${n > 26 ? Math.ceil(n / 26) : ''}`, shape, use: 'residential', storeys: 6, baseM: 0 };
}
