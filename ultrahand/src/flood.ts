// Surface water flood risk: the Environment Agency's national flood risk assessment (NaFRA2,
// "Risk of Flooding from Surface Water"). Shown as a map overlay, and read for the red line by
// asking the service what lies at a grid of points across it: each answer is a whole risk polygon,
// so the areas at each risk level are measured from the polygons found.
import * as turf from '@turf/turf';
import type { Feature, Polygon, MultiPolygon } from 'geojson';

const WMS = 'https://environment.data.gov.uk/spatialdata/nafra2-risk-of-flooding-from-surface-water/wms';

export const ROFSW_TILES = `${WMS}?service=WMS&version=1.3.0&request=GetMap&layers=rofsw&styles=&format=image/png&transparent=true&crs=EPSG:3857&width=256&height=256&bbox={bbox-epsg-3857}`;

export interface SurfaceWater { bands: Record<string, number>; sampled: number; siteM2: number }

const ORDER = ['High', 'Medium', 'Low', 'Very low'];

export async function surfaceWaterOn(site: Feature<Polygon | MultiPolygon>): Promise<SurfaceWater> {
  // Up to about 25 points across the site, at least 8 m apart.
  const area = turf.area(site);
  const spacing = Math.max(8, Math.sqrt(area / 25));
  const grid = turf.pointGrid(turf.bbox(site), spacing / 1000, { units: 'kilometers', mask: site as any });
  const pts = [turf.pointOnFeature(site), ...grid.features].slice(0, 30).map((p) => p.geometry.coordinates);

  const found = new Map<string, Feature<MultiPolygon | Polygon>>();
  const d = 0.00004;
  let i = 0;
  await Promise.all(
    Array.from({ length: 5 }, async () => {
      while (i < pts.length) {
        const [lon, lat] = pts[i++];
        const q = `${WMS}?service=WMS&version=1.3.0&request=GetFeatureInfo&layers=rofsw&query_layers=rofsw&styles=&crs=CRS:84&bbox=${lon - d},${lat - d},${lon + d},${lat + d}&width=3&height=3&i=1&j=1&info_format=application/json&feature_count=5`;
        try {
          const j = await (await fetch(q)).json();
          for (const f of j.features ?? []) if (f.geometry) found.set(String(f.id), f);
        } catch { /* a missed point only narrows the sample */ }
      }
    }),
  );

  const bands: Record<string, number> = {};
  for (const f of found.values()) {
    try {
      const x = turf.intersect(turf.featureCollection([f as any, site as any]));
      if (!x) continue;
      const band = String(f.properties?.risk_band ?? 'Unknown');
      bands[band] = (bands[band] ?? 0) + turf.area(x);
    } catch { /* skip awkward geometry */ }
  }
  const sorted = Object.fromEntries(Object.entries(bands).sort(([a], [b]) => (ORDER.indexOf(a) + 9) % 9 - (ORDER.indexOf(b) + 9) % 9));
  return { bands: sorted, sampled: pts.length, siteM2: area };
}
