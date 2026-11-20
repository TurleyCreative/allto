// CAD and 3D exports of the site model, on British National Grid (EPSG:27700) so they line up with
// OS mapping and survey drawings. Projection uses the standard Helmert transformation, which is
// good to a few metres: fine for context models, not a substitute for a measured survey.
import proj4 from 'proj4';
import earcut from 'earcut';
import type { Feature, Polygon, MultiPolygon, Position } from 'geojson';
import type { SiteModel, Bldg } from './model';

const BNG = '+proj=tmerc +lat_0=49 +lon_0=-2 +k=0.9996012717 +x_0=400000 +y_0=-100000 +ellps=airy +towgs84=446.448,-125.157,542.06,0.15,0.247,0.842,-20.489 +units=m +no_defs';
const toBNG = proj4('EPSG:4326', BNG);
const en = (p: Position): [number, number] => toBNG.forward([p[0], p[1]]) as [number, number];

type PolyF = Feature<Polygon | MultiPolygon>;
const polysOf = (f: PolyF) => (f.geometry.type === 'Polygon' ? [f.geometry.coordinates] : f.geometry.coordinates);
const f3 = (n: number) => (Math.round(n * 1000) / 1000).toString();

// ------------------------------------------------------------------ DXF (AutoCAD R12, ASCII)

const LAYERS: [string, number][] = [
  ['UH_BUILDINGS', 7],
  ['UH_SITE_BUILDINGS', 1],
  ['UH_LISTED', 6],
  ['UH_CONTEXT', 8],
  ['UH_RED_LINE', 1],
  ['UH_STUDY_AREA', 8],
  ['UH_ROADS', 9],
  ['UH_REFS', 7],
  ['UH_MASSING', 1],
];

export function siteDXF(m: SiteModel, opts: { massing: number }): string {
  const out: string[] = [];
  const put = (...pairs: (string | number)[]) => {
    for (let i = 0; i < pairs.length; i += 2) out.push(String(pairs[i]), String(pairs[i + 1]));
  };
  put(0, 'SECTION', 2, 'HEADER', 9, '$ACADVER', 1, 'AC1009', 9, '$INSUNITS', 70, 6, 0, 'ENDSEC');
  put(0, 'SECTION', 2, 'TABLES', 0, 'TABLE', 2, 'LAYER', 70, LAYERS.length);
  for (const [name, colour] of LAYERS) put(0, 'LAYER', 2, name, 70, 0, 62, colour, 6, 'CONTINUOUS');
  put(0, 'ENDTAB', 0, 'ENDSEC', 0, 'SECTION', 2, 'ENTITIES');

  /** A polyline; closed rings get elevation (z) and thickness (extruded height) so CAD shows them in 3D. */
  const poly = (layer: string, pts: [number, number][], closed: boolean, z = 0, thickness = 0) => {
    if (pts.length < 2) return;
    put(0, 'POLYLINE', 8, layer, 66, 1, 10, 0, 20, 0, 30, f3(z), 70, closed ? 1 : 0);
    if (thickness) put(39, f3(thickness));
    for (const p of pts) put(0, 'VERTEX', 8, layer, 10, f3(p[0]), 20, f3(p[1]), 30, f3(z));
    put(0, 'SEQEND', 8, layer);
  };
  const ring = (r: Position[]) => {
    const pts = r.map(en);
    const a = pts[0], b = pts[pts.length - 1];
    return a[0] === b[0] && a[1] === b[1] ? pts.slice(0, -1) : pts;
  };

  const layerOf = (b: Bldg) => (!b.inStudy ? 'UH_CONTEXT' : b.inSite ? 'UH_SITE_BUILDINGS' : b.listed.length ? 'UH_LISTED' : 'UH_BUILDINGS');
  for (const b of m.buildings) {
    for (const p of polysOf(b.feature)) for (const r of p) poly(layerOf(b), ring(r), true, b.minH, b.h - b.minH);
    if (b.inStudy) {
      const c = en(b.ll);
      put(0, 'TEXT', 8, 'UH_REFS', 10, f3(c[0]), 20, f3(c[1]), 30, f3(b.h), 40, 1.5, 1, b.ref);
    }
  }
  if (m.red) {
    for (const p of polysOf(m.red)) for (const r of p) poly('UH_RED_LINE', ring(r), true);
    if (opts.massing > 0) for (const p of polysOf(m.red)) poly('UH_MASSING', ring(p[0]), true, 0, opts.massing);
  }
  for (const p of polysOf(m.study)) for (const r of p) poly('UH_STUDY_AREA', ring(r), true);
  for (const r of m.roads) for (const l of r.lines) poly('UH_ROADS', l.map((q) => en(m.frame.toLngLat(q))), false);

  put(0, 'ENDSEC', 0, 'EOF');
  return out.join('\r\n') + '\r\n';
}

// ------------------------------------------------------------------ OBJ (3D massing)

/**
 * Extruded buildings with walls and roofs, in metres, Z up, relative to a British National Grid
 * origin (rounded to 100 m and written in the header) so 3D packages keep full precision.
 */
export function siteOBJ(m: SiteModel, opts: { massing: number; context: boolean }): { obj: string; origin: [number, number] } {
  const c = en(m.frame.toLngLat([0, 0]));
  const origin: [number, number] = [Math.round(c[0] / 100) * 100, Math.round(c[1] / 100) * 100];
  const v: string[] = [], faces: string[] = [];
  let n = 0;
  const local = (p: Position) => {
    const q = en(p);
    return [q[0] - origin[0], q[1] - origin[1]] as [number, number];
  };

  const solid = (name: string, f: PolyF, z0: number, z1: number) => {
    faces.push(`o ${name}`);
    for (const p of polysOf(f)) {
      const rings = p.map((r) => {
        const pts = r.map(local);
        const a = pts[0], b = pts[pts.length - 1];
        return a[0] === b[0] && a[1] === b[1] ? pts.slice(0, -1) : pts;
      });
      // Outer ring anticlockwise, holes clockwise, so faces point outward.
      rings.forEach((r, i) => {
        const area = r.reduce((s, q, k) => s + q[0] * r[(k + 1) % r.length][1] - r[(k + 1) % r.length][0] * q[1], 0);
        if ((i === 0 && area < 0) || (i > 0 && area > 0)) r.reverse();
      });
      // Roof (and floor when lifted off the ground).
      const flat: number[] = [], holes: number[] = [];
      rings.forEach((r, i) => {
        if (i) holes.push(flat.length / 2);
        for (const q of r) flat.push(q[0], q[1]);
      });
      const tris = earcut(flat, holes.length ? holes : undefined, 2);
      const base = n;
      for (let i = 0; i < flat.length; i += 2) v.push(`v ${f3(flat[i])} ${f3(flat[i + 1])} ${f3(z1)}`);
      n += flat.length / 2;
      for (let i = 0; i < tris.length; i += 3) faces.push(`f ${base + tris[i] + 1} ${base + tris[i + 1] + 1} ${base + tris[i + 2] + 1}`);
      if (z0 > 0.1) {
        const fb = n;
        for (let i = 0; i < flat.length; i += 2) v.push(`v ${f3(flat[i])} ${f3(flat[i + 1])} ${f3(z0)}`);
        n += flat.length / 2;
        for (let i = 0; i < tris.length; i += 3) faces.push(`f ${fb + tris[i] + 1} ${fb + tris[i + 2] + 1} ${fb + tris[i + 1] + 1}`);
      }
      // Walls.
      for (const r of rings)
        for (let i = 0; i < r.length; i++) {
          const a = r[i], b = r[(i + 1) % r.length];
          v.push(`v ${f3(a[0])} ${f3(a[1])} ${f3(z0)}`, `v ${f3(b[0])} ${f3(b[1])} ${f3(z0)}`, `v ${f3(b[0])} ${f3(b[1])} ${f3(z1)}`, `v ${f3(a[0])} ${f3(a[1])} ${f3(z1)}`);
          faces.push(`f ${n + 1} ${n + 2} ${n + 3} ${n + 4}`);
          n += 4;
        }
    }
  };

  for (const b of m.buildings) if (b.inStudy || opts.context) solid(`${b.ref}${b.inSite ? '_site' : ''}${b.listed.length ? '_listed' : ''}`, b.feature, b.minH, b.h);
  if (m.red && opts.massing > 0) solid('Proposed_massing', m.red, 0, opts.massing);

  // The study area as a ground plate.
  faces.push('o Study_area');
  for (const p of polysOf(m.study)) {
    const r = p[0].map(local).slice(0, -1);
    const flat = r.flatMap((q) => q);
    const tris = earcut(flat, undefined, 2);
    const base = n;
    for (const q of r) v.push(`v ${f3(q[0])} ${f3(q[1])} 0`);
    n += r.length;
    for (let i = 0; i < tris.length; i += 3) faces.push(`f ${base + tris[i] + 1} ${base + tris[i + 1] + 1} ${base + tris[i + 2] + 1}`);
  }

  const head = [
    '# allto: Ultrahand site model',
    '# Units: metres. Z is up.',
    `# Origin: British National Grid E ${origin[0]} N ${origin[1]} (add these to x and y for true coordinates)`,
    '# Buildings: OpenStreetMap via Mapbox (heights where recorded, otherwise 6 m).',
  ];
  return { obj: [...head, ...v, ...faces].join('\n') + '\n', origin };
}
