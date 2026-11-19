// Atlas: every building in the study area lifted out and laid in a true-scale grid, in reference order.
import type { Feature, Polygon, MultiPolygon, Position } from 'geojson';
import type { Bldg, SiteModel } from './model';
import type { XY } from './geo';

export interface AtlasLayout {
  offsets: Map<number, XY>; // building idx -> translation in local metres
  rank: Map<number, number>; // 0..1 order, for staggering the animation
  labels: { idx: number; text: string; at: XY }[];
  bounds: { minX: number; minY: number; maxX: number; maxY: number };
}

/**
 * A table-style grid: buildings in reference order, read left to right, top to bottom.
 * Every column is as wide as its widest building and every row as tall as its tallest, so rows and
 * columns line up, each building sits centred in its cell, and its reference sits underneath.
 * `aspect` is the width/height of the screen, so the sheet fills the view.
 */
export function layoutAtlas(bs: Bldg[], aspect = 1.2, gap = 20): AtlasLayout {
  const items = bs
    .slice()
    .sort((a, b) => a.ref.localeCompare(b.ref))
    .map((b) => {
      const xs = b.polys.flatMap((p) => p[0].map((q) => q[0]));
      const ys = b.polys.flatMap((p) => p[0].map((q) => q[1]));
      const minX = Math.min(...xs), maxX = Math.max(...xs), minY = Math.min(...ys), maxY = Math.max(...ys);
      return { b, cx: (minX + maxX) / 2, cy: (minY + maxY) / 2, w: Math.max(16, maxX - minX), h: Math.max(12, maxY - minY) };
    });
  const n = items.length;
  const label = 14; // band under each row for the references

  const measure = (cols: number) => {
    const rows = Math.ceil(n / cols);
    const colW = Array(cols).fill(0), rowH = Array(rows).fill(0);
    items.forEach((it, i) => {
      colW[i % cols] = Math.max(colW[i % cols], it.w);
      rowH[Math.floor(i / cols)] = Math.max(rowH[Math.floor(i / cols)], it.h);
    });
    const W = colW.reduce((s, w) => s + w + gap, -gap);
    const H = rowH.reduce((s, h) => s + h + label + gap, -gap);
    return { cols, rows, colW, rowH, W, H };
  };
  // Pick the column count whose sheet shape best matches the screen.
  let best = measure(1);
  for (let c = 2; c <= n; c++) {
    const m = measure(c);
    if (Math.abs(Math.log(m.W / m.H / aspect)) < Math.abs(Math.log(best.W / best.H / aspect))) best = m;
  }
  const { cols, colW, rowH, W, H } = best;
  const colX: number[] = [], rowY: number[] = [];
  colW.reduce((x, w, i) => ((colX[i] = x), x + w + gap), -W / 2);
  rowH.reduce((y, h, i) => ((rowY[i] = y), y - h - label - gap), H / 2);

  const offsets = new Map<number, XY>(), rank = new Map<number, number>();
  const labels: AtlasLayout['labels'] = [];
  items.forEach((it, i) => {
    const c = i % cols, r = Math.floor(i / cols);
    const tx = colX[c] + colW[c] / 2, ty = rowY[r] - rowH[r] / 2; // centre of the cell
    offsets.set(it.b.idx, [tx - it.cx, ty - it.cy]);
    labels.push({ idx: it.b.idx, text: it.b.ref, at: [tx, rowY[r] - rowH[r] - 2] });
    rank.set(it.b.idx, n > 1 ? i / (n - 1) : 0);
  });
  return { offsets, rank, labels, bounds: { minX: -W / 2 - gap, maxX: W / 2 + gap, minY: -H / 2 - gap, maxY: H / 2 + gap } };
}

/** Move a building's lng/lat geometry by a local-metre offset. */
export function translateFeature(f: Feature<Polygon | MultiPolygon>, d: XY, m: SiteModel): Feature<Polygon | MultiPolygon> {
  const dx = d[0] / m.frame.kx, dy = d[1] / m.frame.ky;
  const mv = (p: Position) => [p[0] + dx, p[1] + dy];
  const g = f.geometry;
  const geometry =
    g.type === 'Polygon'
      ? { type: 'Polygon' as const, coordinates: g.coordinates.map((r) => r.map(mv)) }
      : { type: 'MultiPolygon' as const, coordinates: g.coordinates.map((p) => p.map((r) => r.map(mv))) };
  return { ...f, geometry };
}

export const ease = (t: number) => (t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t));
