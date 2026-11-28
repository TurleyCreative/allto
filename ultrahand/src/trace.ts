// Tracing a masterplan drawing by colour, in the browser.
//
// A rendered masterplan (a consultant's plan) draws each thing in a flat colour: white parcels,
// a lilac for commercial units, teal for ponds, and so on. Reading those shapes pixel by pixel is
// far more accurate than estimating their corners, so the drawing is traced here:
//  1. siteMask: the red line, if the drawing has one, found and filled, so the town around the site is left out.
//  2. palette: the drawing's colours grouped (k-means) and numbered; a strip of numbered swatches goes to
//     Claude with the drawing and its key, and Claude says what each colour is.
//  3. traceRegions: every patch of the chosen colours becomes an outline (in image pixels), simplified.

export interface Pixels { data: Uint8ClampedArray; w: number; h: number }
export type RGB = [number, number, number];

/** Draw an image (data URL) at most `maxSide` pixels long. */
export function loadPixels(src: string, maxSide = 1000): Promise<Pixels> {
  return new Promise((res, rej) => {
    const img = new Image();
    img.onload = () => {
      const k = Math.min(1, maxSide / Math.max(img.naturalWidth, img.naturalHeight));
      const w = Math.max(1, Math.round(img.naturalWidth * k)), h = Math.max(1, Math.round(img.naturalHeight * k));
      const c = document.createElement('canvas');
      c.width = w;
      c.height = h;
      const g = c.getContext('2d', { willReadFrequently: true })!;
      g.drawImage(img, 0, 0, w, h);
      res({ data: g.getImageData(0, 0, w, h).data, w, h });
    };
    img.onerror = () => rej(new Error('The drawing could not be read.'));
    img.src = src;
  });
}

function dilate(m: Uint8Array, w: number, h: number, n: number): Uint8Array {
  let a = m;
  for (let k = 0; k < n; k++) {
    const b = a.slice();
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        if (a[i]) continue;
        if ((x > 0 && a[i - 1]) || (x < w - 1 && a[i + 1]) || (y > 0 && a[i - w]) || (y < h - 1 && a[i + w])) b[i] = 1;
      }
    a = b;
  }
  return a;
}
function erode(m: Uint8Array, w: number, h: number, n: number): Uint8Array {
  let a = m;
  for (let k = 0; k < n; k++) {
    const b = a.slice();
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        if (!a[i]) continue;
        if (x === 0 || y === 0 || x === w - 1 || y === h - 1 || !a[i - 1] || !a[i + 1] || !a[i - w] || !a[i + w]) b[i] = 0;
      }
    a = b;
  }
  return a;
}

/**
 * The area inside the drawing's red line (1 inside), or null when there is no clear red line.
 * The line is thickened a little to close small gaps, then the outside is flood-filled from the edges.
 */
export function siteMask(p: Pixels): Uint8Array | null {
  const { data, w, h } = p, n = w * h;
  const red = new Uint8Array(n);
  let reds = 0;
  for (let i = 0; i < n; i++) {
    const r = data[i * 4], g = data[i * 4 + 1], b = data[i * 4 + 2];
    if (r > 140 && g < 130 && b < 130 && r - g > 50) { red[i] = 1; reds++; }
  }
  if (reds < n * 0.0008) return null;
  const wall = dilate(red, w, h, 2);
  const out = new Uint8Array(n), q = new Int32Array(n);
  let qh = 0, qt = 0;
  const push = (i: number) => { if (!wall[i] && !out[i]) { out[i] = 1; q[qt++] = i; } };
  for (let x = 0; x < w; x++) { push(x); push((h - 1) * w + x); }
  for (let y = 0; y < h; y++) { push(y * w); push(y * w + w - 1); }
  while (qh < qt) {
    const i = q[qh++], x = i % w;
    if (x > 0) push(i - 1);
    if (x < w - 1) push(i + 1);
    if (i >= w) push(i - w);
    if (i < n - w) push(i + w);
  }
  // Pieces the outside flood could not reach: the site, any separate parts of it, and holes
  // (land ringed by the red line inside the site, such as existing houses left out).
  const comp = new Int32Array(n), sizes = [0];
  for (let s = 0; s < n; s++) {
    if (out[s] || wall[s] || comp[s]) continue;
    const id = sizes.length;
    let c = 0;
    qh = qt = 0; comp[s] = id; q[qt++] = s;
    while (qh < qt) {
      const i = q[qh++], x = i % w;
      c++;
      for (const j of [x > 0 ? i - 1 : -1, x < w - 1 ? i + 1 : -1, i >= w ? i - w : -1, i < n - w ? i + w : -1])
        if (j >= 0 && !out[j] && !wall[j] && !comp[j]) { comp[j] = id; q[qt++] = j; }
    }
    sizes.push(c);
  }
  const biggest = sizes.indexOf(Math.max(...sizes.slice(1)));
  const hole = new Uint8Array(sizes.length);
  for (let id = 1; id < sizes.length; id++) {
    if (id === biggest) continue;
    if (sizes[id] < n * 0.0005) { hole[id] = 1; continue; } // specks inside the line work
    // step across the red line from this piece: does it land outside, or back in another piece of the site?
    const seen = new Uint8Array(n);
    let toOut = 0, toSite = 0;
    qh = qt = 0;
    for (let i = 0; i < n; i++) if (comp[i] === id) { seen[i] = 1; q[qt++] = i; }
    const depth = new Uint8Array(n);
    while (qh < qt) {
      const i = q[qh++], x = i % w;
      if (depth[i] >= 8) continue;
      for (const j of [x > 0 ? i - 1 : -1, x < w - 1 ? i + 1 : -1, i >= w ? i - w : -1, i < n - w ? i + w : -1]) {
        if (j < 0 || seen[j]) continue;
        seen[j] = 1;
        if (out[j]) toOut++;
        else if (comp[j] && comp[j] !== id) toSite++;
        else if (wall[j]) { depth[j] = depth[i] + 1; q[qt++] = j; }
      }
    }
    if (toSite > toOut) hole[id] = 1;
  }
  let inside: Uint8Array = new Uint8Array(n), count = 0;
  for (let i = 0; i < n; i++) if (comp[i] && !hole[comp[i]]) { inside[i] = 1; count++; }
  if (count < n * 0.02 || count > n * 0.95) return null; // no closed line: use the whole drawing
  inside = dilate(inside, w, h, 3); // give back the width of the line
  return inside;
}

/** The drawing's main colours (k-means), with each pixel's group and each group's share of the site. */
export function palette(p: Pixels, mask: Uint8Array | null, k = 16): { colours: RGB[]; share: number[]; labels: Uint8Array } {
  const { data, w, h } = p, n = w * h;
  let seed = 12345;
  const rand = () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 4294967296);
  const idx: number[] = [];
  for (let i = 0; i < n; i++) if (!mask || mask[i]) idx.push(i);
  const S = Math.min(24000, idx.length), samp = new Float32Array(S * 3);
  // Group in a space that weighs hue over lightness, so a small patch of a distinct colour
  // (teal ponds, lilac roofs) is not swallowed by the many shades of green around it.
  const feat = (r: number, g: number, b: number, o: Float32Array, j: number) => {
    o[j] = (r + g + b) / 3;
    o[j + 1] = (r - g) * 2;
    o[j + 2] = (b - (r + g) / 2) * 2;
  };
  const f = new Float32Array(3);
  for (let s = 0; s < S; s++) {
    const i = idx[Math.floor(rand() * idx.length)];
    feat(data[i * 4], data[i * 4 + 1], data[i * 4 + 2], samp, s * 3);
  }
  // k-means++ start
  const cent = new Float32Array(k * 3), dist = new Float32Array(S).fill(Infinity);
  let first = Math.floor(rand() * S);
  for (let c = 0; c < k; c++) {
    if (c > 0) {
      let tot = 0;
      for (let s = 0; s < S; s++) {
        const j = (c - 1) * 3, dr = samp[s * 3] - cent[j], dg = samp[s * 3 + 1] - cent[j + 1], db = samp[s * 3 + 2] - cent[j + 2];
        dist[s] = Math.min(dist[s], dr * dr + dg * dg + db * db);
        tot += dist[s];
      }
      let r = rand() * tot;
      first = 0;
      for (let s = 0; s < S; s++) { r -= dist[s]; if (r <= 0) { first = s; break; } }
    }
    cent[c * 3] = samp[first * 3]; cent[c * 3 + 1] = samp[first * 3 + 1]; cent[c * 3 + 2] = samp[first * 3 + 2];
  }
  const nearest = (r: number, g: number, b: number) => {
    let best = 0, bd = Infinity;
    for (let c = 0; c < k; c++) {
      const dr = r - cent[c * 3], dg = g - cent[c * 3 + 1], db = b - cent[c * 3 + 2], d = dr * dr + dg * dg + db * db;
      if (d < bd) { bd = d; best = c; }
    }
    return best;
  };
  const lab = new Uint8Array(S);
  for (let it = 0; it < 20; it++) {
    const sum = new Float64Array(k * 3), cnt = new Uint32Array(k);
    for (let s = 0; s < S; s++) {
      const c = (lab[s] = nearest(samp[s * 3], samp[s * 3 + 1], samp[s * 3 + 2]));
      sum[c * 3] += samp[s * 3]; sum[c * 3 + 1] += samp[s * 3 + 1]; sum[c * 3 + 2] += samp[s * 3 + 2]; cnt[c]++;
    }
    for (let c = 0; c < k; c++) if (cnt[c]) { cent[c * 3] = sum[c * 3] / cnt[c]; cent[c * 3 + 1] = sum[c * 3 + 1] / cnt[c]; cent[c * 3 + 2] = sum[c * 3 + 2] / cnt[c]; }
  }
  const labels = new Uint8Array(n), cnt = new Uint32Array(k), rgb = new Float64Array(k * 3);
  let inMask = 0;
  for (let i = 0; i < n; i++) {
    feat(data[i * 4], data[i * 4 + 1], data[i * 4 + 2], f, 0);
    const c = (labels[i] = nearest(f[0], f[1], f[2]));
    if (!mask || mask[i]) { cnt[c]++; inMask++; rgb[c * 3] += data[i * 4]; rgb[c * 3 + 1] += data[i * 4 + 1]; rgb[c * 3 + 2] += data[i * 4 + 2]; }
  }
  // Largest groups first, renumbered so 0 is the most common colour.
  const order = [...Array(k).keys()].sort((a, b) => cnt[b] - cnt[a]), rank = new Uint8Array(k);
  order.forEach((c, r) => (rank[c] = r));
  for (let i = 0; i < n; i++) labels[i] = rank[labels[i]];
  return {
    colours: order.map((c) => (cnt[c] ? [0, 1, 2].map((j) => Math.round(rgb[c * 3 + j] / cnt[c])) : [0, 0, 0]) as RGB),
    share: order.map((c) => (inMask ? cnt[c] / inMask : 0)),
    labels,
  };
}

/** A strip of numbered colour swatches (PNG data URL), to show Claude alongside the drawing. */
export function swatchImage(colours: RGB[], share: number[]): string {
  const cols = 4, cw = 170, ch = 110, rows = Math.ceil(colours.length / cols);
  const c = document.createElement('canvas');
  c.width = cols * cw;
  c.height = rows * ch;
  const g = c.getContext('2d')!;
  g.fillStyle = '#ffffff';
  g.fillRect(0, 0, c.width, c.height);
  colours.forEach((rgb, i) => {
    const x = (i % cols) * cw, y = Math.floor(i / cols) * ch;
    g.fillStyle = `rgb(${rgb.join(',')})`;
    g.fillRect(x + 6, y + 6, cw - 12, ch - 12);
    g.strokeStyle = '#000';
    g.lineWidth = 1;
    g.strokeRect(x + 6.5, y + 6.5, cw - 13, ch - 13);
    g.fillStyle = '#000';
    g.fillRect(x + 6, y + 6, 46, 30);
    g.fillStyle = '#fff';
    g.font = 'bold 22px sans-serif';
    g.fillText(String(i), x + 14, y + 29);
    g.fillStyle = '#000';
    g.fillRect(x + 6, y + ch - 30, 64, 24);
    g.fillStyle = '#fff';
    g.font = '15px sans-serif';
    g.fillText(`${Math.round(share[i] * 100)}%`, x + 12, y + ch - 12);
  });
  return c.toDataURL('image/png');
}

/** Outline of one connected patch (Moore-neighbour tracing), as pixel centres, clockwise on screen. */
function outline(lab: Int32Array, w: number, h: number, id: number, start: number): [number, number][] {
  // Moore-neighbour tracing, clockwise on screen. Directions count clockwise from east.
  const DX = [1, 1, 0, -1, -1, -1, 0, 1], DY = [0, 1, 1, 1, 0, -1, -1, -1];
  const at = (x: number, y: number) => x >= 0 && y >= 0 && x < w && y < h && lab[y * w + x] === id;
  const sx = start % w, sy = Math.floor(start / w);
  const step = (x: number, y: number, dir: number): number => {
    const s0 = dir % 2 ? dir + 6 : dir + 7; // look back past the outside first
    for (let k = 0; k < 8; k++) {
      const d = (s0 + k) % 8;
      if (at(x + DX[d], y + DY[d])) return d;
    }
    return -1;
  };
  const pts: [number, number][] = [[sx, sy]];
  // the start is the patch's top-left-most pixel, so nothing lies above it: begin as if heading east
  const d0 = step(sx, sy, 0);
  if (d0 < 0) return pts;
  let x = sx + DX[d0], y = sy + DY[d0], dir = d0;
  for (let guard = 0; guard < w * h * 2; guard++) {
    const d = step(x, y, dir);
    if (x === sx && y === sy && d === d0) break; // back at the start, about to repeat the first step
    pts.push([x, y]);
    x += DX[d]; y += DY[d]; dir = d;
  }
  if (pts.length > 1 && pts[pts.length - 1][0] === sx && pts[pts.length - 1][1] === sy) pts.pop();
  return pts;
}

/** Douglas–Peucker on an open polyline. */
function simplifyLine(p: [number, number][], eps: number): [number, number][] {
  if (p.length < 3) return p.slice();
  const keep = new Uint8Array(p.length);
  keep[0] = keep[p.length - 1] = 1;
  const stack: [number, number][] = [[0, p.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop()!;
    const [ax, ay] = p[a], [bx, by] = p[b], dx = bx - ax, dy = by - ay, L = Math.hypot(dx, dy) || 1;
    let best = -1, bd = 0;
    for (let i = a + 1; i < b; i++) {
      const d = Math.abs(dy * (p[i][0] - ax) - dx * (p[i][1] - ay)) / L;
      if (d > bd) { bd = d; best = i; }
    }
    if (best > 0 && bd > eps) { keep[best] = 1; stack.push([a, best], [best, b]); }
  }
  return p.filter((_, i) => keep[i]);
}
/** Douglas–Peucker on a closed ring (split at the point furthest from the first). */
export function simplifyRing(ring: [number, number][], eps: number): [number, number][] {
  if (ring.length < 4) return ring.slice();
  let far = 0, fd = 0;
  for (let i = 1; i < ring.length; i++) { const d = Math.hypot(ring[i][0] - ring[0][0], ring[i][1] - ring[0][1]); if (d > fd) { fd = d; far = i; } }
  const a = simplifyLine(ring.slice(0, far + 1), eps), b = simplifyLine([...ring.slice(far), ring[0]], eps);
  return [...a.slice(0, -1), ...b.slice(0, -1)];
}

export interface Region { ring: [number, number][]; px: number }
/**
 * Every patch of the chosen colour groups (inside the mask) as a simplified outline in pixels.
 * `open` px of erosion then dilation pulls apart patches that only touch at a corner or a thin line.
 */
export function traceRegions(p: Pixels, labels: Uint8Array, groups: number[], mask: Uint8Array | null, opts: { minPx: number; open?: number; close?: number; eps?: number; minFill?: number }): Region[] {
  const { w, h } = p, n = w * h, want = new Uint8Array(256);
  groups.forEach((g) => (want[g] = 1));
  let m: Uint8Array = new Uint8Array(n);
  for (let i = 0; i < n; i++) if (want[labels[i]] && (!mask || mask[i])) m[i] = 1;
  if (opts.close) m = erode(dilate(m, w, h, opts.close), w, h, opts.close);
  if (opts.open) m = dilate(erode(m, w, h, opts.open), w, h, opts.open);
  const lab = new Int32Array(n), q = new Int32Array(n), out: Region[] = [];
  let id = 0;
  for (let s = 0; s < n; s++) {
    if (!m[s] || lab[s]) continue;
    id++;
    let qh = 0, qt = 0, count = 0, minX = w, maxX = 0, minY = h, maxY = 0;
    lab[s] = id; q[qt++] = s;
    while (qh < qt) {
      const i = q[qh++], x = i % w, y = (i - x) / w;
      count++;
      if (x < minX) minX = x; if (x > maxX) maxX = x; if (y < minY) minY = y; if (y > maxY) maxY = y;
      const nb = [x > 0 ? i - 1 : -1, x < w - 1 ? i + 1 : -1, y > 0 ? i - w : -1, y < h - 1 ? i + w : -1];
      for (const j of nb) if (j >= 0 && m[j] && !lab[j]) { lab[j] = id; q[qt++] = j; }
    }
    if (count < opts.minPx) continue;
    if (opts.minFill && count / ((maxX - minX + 1) * (maxY - minY + 1)) < opts.minFill) continue; // rings and stray strips
    const ring = simplifyRing(outline(lab, w, h, id, s), opts.eps ?? 1.2);
    if (ring.length >= 3) out.push({ ring, px: count });
  }
  return out;
}

/** Each pixel's nearest colour from a palette (plain RGB distance), for an image at another size. */
export function labelWith(p: Pixels, colours: RGB[]): Uint8Array {
  const { data, w, h } = p, n = w * h, out = new Uint8Array(n), k = colours.length;
  const cache = new Map<number, number>();
  for (let i = 0; i < n; i++) {
    const r = data[i * 4], g = data[i * 4 + 1], b = data[i * 4 + 2], key = ((r >> 2) << 12) | ((g >> 2) << 6) | (b >> 2);
    let best = cache.get(key);
    if (best === undefined) {
      let bd = Infinity;
      best = 0;
      for (let c = 0; c < k; c++) {
        const dr = r - colours[c][0], dg = g - colours[c][1], db = b - colours[c][2], d = dr * dr + dg * dg + db * db;
        if (d < bd) { bd = d; best = c; }
      }
      cache.set(key, best);
    }
    out[i] = best;
  }
  return out;
}

/** Distance (in pixels) from each set pixel to the nearest unset one: a two-pass chamfer approximation. */
function distanceIn(m: Uint8Array, w: number, h: number): Float32Array {
  const d = new Float32Array(w * h), D = Math.SQRT2;
  for (let i = 0; i < w * h; i++) d[i] = m[i] ? 1e9 : 0;
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (!d[i]) continue;
      let v = d[i];
      if (x > 0) v = Math.min(v, d[i - 1] + 1); else v = Math.min(v, 1);
      if (y > 0) {
        v = Math.min(v, d[i - w] + 1);
        if (x > 0) v = Math.min(v, d[i - w - 1] + D);
        if (x < w - 1) v = Math.min(v, d[i - w + 1] + D);
      } else v = Math.min(v, 1);
      d[i] = v;
    }
  for (let y = h - 1; y >= 0; y--)
    for (let x = w - 1; x >= 0; x--) {
      const i = y * w + x;
      if (!d[i]) continue;
      let v = d[i];
      if (x < w - 1) v = Math.min(v, d[i + 1] + 1); else v = Math.min(v, 1);
      if (y < h - 1) {
        v = Math.min(v, d[i + w] + 1);
        if (x < w - 1) v = Math.min(v, d[i + w + 1] + D);
        if (x > 0) v = Math.min(v, d[i + w - 1] + D);
      } else v = Math.min(v, 1);
      d[i] = v;
    }
  return d;
}

/** Thin a mask to one-pixel centre lines (Zhang–Suen), in place. */
function thin(m: Uint8Array, w: number, h: number) {
  let cand: number[] = [];
  for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) if (m[y * w + x]) cand.push(y * w + x);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (x === 0 || y === 0 || x === w - 1 || y === h - 1) m[y * w + x] = 0;
  const del: number[] = [];
  for (let changed = true; changed; ) {
    changed = false;
    for (const step of [0, 1]) {
      del.length = 0;
      const next: number[] = [];
      for (const i of cand) {
        if (!m[i]) continue;
        next.push(i);
        const p2 = m[i - w], p3 = m[i - w + 1], p4 = m[i + 1], p5 = m[i + w + 1], p6 = m[i + w], p7 = m[i + w - 1], p8 = m[i - 1], p9 = m[i - w - 1];
        const B = p2 + p3 + p4 + p5 + p6 + p7 + p8 + p9;
        if (B < 2 || B > 6) continue;
        const A = +(!p2 && p3) + +(!p3 && p4) + +(!p4 && p5) + +(!p5 && p6) + +(!p6 && p7) + +(!p7 && p8) + +(!p8 && p9) + +(!p9 && p2);
        if (A !== 1) continue;
        if (step === 0 ? p2 * p4 * p6 || p4 * p6 * p8 : p2 * p4 * p8 || p2 * p6 * p8) continue;
        del.push(i);
      }
      for (const i of del) m[i] = 0;
      if (del.length) changed = true;
      cand = next;
    }
  }
}

/** Take the corner pixels out of stepped diagonals, so a line is one pixel per step (in place, sequential). */
function unstair(m: Uint8Array, w: number, h: number) {
  for (let y = 1; y < h - 1; y++)
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      if (!m[i]) continue;
      const N = m[i - w], E = m[i + 1], S = m[i + w], W = m[i - 1];
      if (!((N && E) || (E && S) || (S && W) || (W && N))) continue;
      // the set neighbours must stay joined to each other (8-connected) without this pixel
      const on: [number, number][] = [];
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) if ((dx || dy) && m[i + dy * w + dx]) on.push([dx, dy]);
      if (on.length < 2 || on.length > 4) continue;
      const grp = on.map((_, k) => k), root = (k: number): number => (grp[k] === k ? k : (grp[k] = root(grp[k])));
      for (let a = 0; a < on.length; a++)
        for (let b = a + 1; b < on.length; b++)
          if (Math.abs(on[a][0] - on[b][0]) <= 1 && Math.abs(on[a][1] - on[b][1]) <= 1) grp[root(a)] = root(b);
      if (on.every((_, k) => root(k) === root(0))) m[i] = 0;
    }
}

export interface RoadLine { pts: [number, number][]; closed: boolean }
export interface RoadRing { x: number; y: number; r: number } // a roundabout: centre and outer radius, in pixels
export interface Roads { lines: RoadLine[]; rings: RoadRing[] }
const N8: [number, number][] = [[-1, -1], [0, -1], [1, -1], [-1, 0], [1, 0], [-1, 1], [0, 1], [1, 1]];

/**
 * The drawing's roads as centre lines (in pixels): grey road surface (and any colours named as road) inside
 * the site is thinned to lines, joined at junctions, and pieces that run straight on through a junction are
 * chained into one street. Tuned on drawings about 2000 px across; sizes scale with the image.
 */
export function traceRoads(p: Pixels, mask: Uint8Array | null, labels: Uint8Array | null, roadGroups: number[], debug?: Record<string, unknown>): Roads {
  const { data, w, h } = p, n = w * h, f = Math.max(w, h) / 2000;
  const isRoad = new Uint8Array(256);
  roadGroups.forEach((g) => (isRoad[g] = 1));
  let road: Uint8Array = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    if (mask && !mask[i]) continue;
    const r = data[i * 4], g = data[i * 4 + 1], b = data[i * 4 + 2], mx = Math.max(r, g, b), mn = Math.min(r, g, b), v = (r + g + b) / 3;
    if ((mx - mn < 24 && v > 60 && v < 215 && b - r < 6) || (labels && isRoad[labels[i]])) road[i] = 1;
  }
  const rc = Math.max(1, Math.round(3 * f));
  road = erode(dilate(road, w, h, rc), w, h, rc); // bridge trees drawn over the road
  if (mask) for (let i = 0; i < n; i++) if (!mask[i]) road[i] = 0;
  // drop specks
  const seen = new Uint8Array(n), q = new Int32Array(n), minPx = 800 * f * f;
  for (let s = 0; s < n; s++) {
    if (!road[s] || seen[s]) continue;
    let qh = 0, qt = 0;
    seen[s] = 1; q[qt++] = s;
    while (qh < qt) {
      const i = q[qh++], x = i % w, y = (i - x) / w;
      for (const [dx, dy] of N8) {
        const X = x + dx, Y = y + dy, j = Y * w + X;
        if (X >= 0 && Y >= 0 && X < w && Y < h && road[j] && !seen[j]) { seen[j] = 1; q[qt++] = j; }
      }
    }
    if (qt < minPx) for (let k = 0; k < qt; k++) road[q[k]] = 0;
  }
  // roundabouts: small round islands with road all the way round
  const rings: RoadRing[] = [];
  {
    const lab = new Int32Array(n);
    let id = 0;
    for (let s0 = 0; s0 < n; s0++) {
      if (road[s0] || lab[s0] || (mask && !mask[s0])) continue;
      id++;
      let qh = 0, qt = 0, edge = false, sx = 0, sy = 0, roadRim = 0, rim = 0;
      lab[s0] = id; q[qt++] = s0;
      while (qh < qt && qt < 4000 * f * f) {
        const i = q[qh++], x = i % w, y = (i - x) / w;
        sx += x; sy += y;
        if (x === 0 || y === 0 || x === w - 1 || y === h - 1) edge = true;
        for (const j of [x > 0 ? i - 1 : -1, x < w - 1 ? i + 1 : -1, i >= w ? i - w : -1, i < n - w ? i + w : -1]) {
          if (j < 0) continue;
          if (road[j]) { roadRim++; rim++; continue; }
          if (mask && !mask[j]) { rim++; edge = true; continue; }
          if (!lab[j]) { lab[j] = id; q[qt++] = j; }
        }
      }
      if (qh < qt) { while (qh < qt) { const i = q[qh++], x = i % w; for (const j of [x > 0 ? i - 1 : -1, x < w - 1 ? i + 1 : -1, i >= w ? i - w : -1, i < n - w ? i + w : -1]) if (j >= 0 && !road[j] && !lab[j] && !(mask && !mask[j])) { lab[j] = id; q[qt++] = j; } } continue; } // too big
      const area = qt;
      if (edge || area < 50 * f * f || roadRim < rim * 0.97) continue;
      const cx = sx / area, cy = sy / area;
      let rmax = 0;
      for (let k = 0; k < qt; k++) { const i = q[k], x = i % w; rmax = Math.max(rmax, Math.hypot(x - cx, (i - x) / w - cy)); }
      if (area / (Math.PI * (rmax + 0.5) ** 2) < 0.75 || rmax > 30 * f) continue;
      // the ring road's width: walk out from the island until the road ends
      const ext: number[] = [];
      for (let a = 0; a < 16; a++) {
        const dx = Math.cos((a * Math.PI) / 8), dy = Math.sin((a * Math.PI) / 8);
        let t = rmax;
        while (t < rmax + 30 * f) { const X = Math.round(cx + dx * t), Y = Math.round(cy + dy * t); if (X < 0 || Y < 0 || X >= w || Y >= h || (!road[Y * w + X] && t > rmax + 1)) break; t++; }
        ext.push(t);
      }
      ext.sort((a, b) => a - b);
      rings.push({ x: cx, y: cy, r: ext[5] }); // a low-middle ray: arms joining the ring run on further
    }
  }
  // car parks and yards: grey areas far wider than a street
  const dt = distanceIn(road, w, h), wideR = Math.round(12 * f);
  let wide: Uint8Array = new Uint8Array(n);
  for (let i = 0; i < n; i++) if (dt[i] > 12 * f) wide[i] = 1;
  wide = dilate(wide, w, h, wideR);
  for (let i = 0; i < n; i++) if (wide[i]) road[i] = 0;
  if (debug) debug.road = road.slice();
  thin(road, w, h);
  unstair(road, w, h);
  const sk = road;
  if (debug) debug.sk0 = sk.slice();

  // --- the skeleton as a graph: junction clusters and line ends are nodes, the runs between them edges
  type End = number; // node id
  interface Edge { px: number[]; a: End; b: End }
  const build = () => {
    const deg = new Uint8Array(n);
    for (let i = 0; i < n; i++) {
      if (!sk[i]) continue;
      const x = i % w, y = (i - x) / w;
      let c = 0;
      for (const [dx, dy] of N8) { const X = x + dx, Y = y + dy; if (X >= 0 && Y >= 0 && X < w && Y < h && sk[Y * w + X]) c++; }
      deg[i] = c;
    }
    const node = new Int32Array(n).fill(-1), cx: number[] = [], cy: number[] = [], isEnd: boolean[] = [];
    for (let s = 0; s < n; s++) {
      if (!sk[s] || node[s] >= 0 || (deg[s] !== 1 && deg[s] < 3)) continue;
      const id = cx.length;
      if (deg[s] === 1) { node[s] = id; cx.push(s % w); cy.push(Math.floor(s / w)); isEnd.push(true); continue; }
      let qh = 0, qt = 0, sx = 0, sy = 0;
      node[s] = id; q[qt++] = s;
      while (qh < qt) {
        const i = q[qh++], x = i % w, y = (i - x) / w;
        sx += x; sy += y;
        for (const [dx, dy] of N8) {
          const X = x + dx, Y = y + dy, j = Y * w + X;
          if (X >= 0 && Y >= 0 && X < w && Y < h && sk[j] && deg[j] >= 3 && node[j] < 0) { node[j] = id; q[qt++] = j; }
        }
      }
      cx.push(sx / qt); cy.push(sy / qt); isEnd.push(false);
    }
    const used = new Uint8Array(n), edges: Edge[] = [];
    const nb = (i: number) => {
      const x = i % w, y = (i - x) / w, o: number[] = [];
      for (const [dx, dy] of N8) { const X = x + dx, Y = y + dy; if (X >= 0 && Y >= 0 && X < w && Y < h && sk[Y * w + X]) o.push(Y * w + X); }
      return o;
    };
    for (let s = 0; s < n; s++) {
      if (!sk[s] || node[s] < 0) continue;
      for (const first of nb(s)) {
        if (node[first] === node[s] || used[first]) continue;
        const px = [s, first];
        let prev = s, cur = first, end = node[first];
        if (end < 0) used[cur] = 1;
        while (end < 0) {
          const ns = nb(cur).filter((j) => j !== prev);
          // a node ends the run, but not the cluster it started from until it has gone somewhere
          const hit = ns.find((j) => node[j] >= 0 && (node[j] !== node[s] || px.length > 3));
          if (hit !== undefined) { px.push(hit); end = node[hit]; break; }
          // on a stepped line, go on to the pixel that leads away, not the corner beside the last one
          const cand = ns.filter((j) => node[j] < 0 && !used[j]);
          const px0 = prev % w, py0 = (prev - px0) / w;
          let nx: number | undefined, far = -1;
          for (const j of cand) { const x = j % w, y = (j - x) / w, d = (x - px0) ** 2 + (y - py0) ** 2; if (d > far) { far = d; nx = j; } }
          if (nx === undefined) {
            // stuck on a tangle: end the run here rather than lose it
            if (px.length > 3) { end = cx.length; cx.push(cur % w); cy.push(Math.floor(cur / w)); isEnd.push(true); }
            break;
          }
          for (const j of cand) if (j !== nx) used[j] = 1;
          prev = cur; cur = nx; used[cur] = 1; px.push(cur);
        }
        if (end < 0) continue;
        if (node[first] >= 0 && edges.some((e) => (e.a === end && e.b === node[s]) && e.px.length === 2)) continue;
        edges.push({ px, a: node[s], b: end });
      }
    }
    return { edges, cx, cy, isEnd };
  };
  const width = (e: Edge) => { const v = e.px.map((i) => dt[i]).sort((a, b) => a - b); return v[v.length >> 1] || 1; };
  let g = build();
  for (let it = 0; it < 5; it++) {
    let removed = 0;
    for (const e of g.edges) {
      const ea = g.isEnd[e.a], eb = g.isEnd[e.b], L = e.px.length;
      if ((ea !== eb && L < Math.max(25 * f, 5 * width(e))) || (ea && eb && L < 40 * f)) {
        for (let k = 0; k < e.px.length; k++) {
          const i = e.px[k];
          // keep the junction it hangs from (its road goes on through there); take the run and its loose end
          if ((k === 0 && !ea) || (k === e.px.length - 1 && !eb)) continue;
          const x = i % w, y = (i - x) / w;
          let c = 0;
          for (const [dx, dy] of N8) { const X = x + dx, Y = y + dy; if (X >= 0 && Y >= 0 && X < w && Y < h && sk[Y * w + X]) c++; }
          if (c <= 2) sk[i] = 0;
        }
        removed++;
      }
    }
    if (!removed) break;
    thin(sk, w, h);
    unstair(sk, w, h);
    g = build();
  }
  const { edges, cx, cy, isEnd } = g;
  if (debug) { debug.sk = sk.slice(); debug.edges = edges.map((e) => e.px); }

  // --- chain edges that run straight on through a junction
  const lines = edges.map((e) => {
    const pts = e.px.map((i) => [i % w, Math.floor(i / w)] as [number, number]);
    pts[0] = [cx[e.a], cy[e.a]];
    pts[pts.length - 1] = [cx[e.b], cy[e.b]];
    return pts;
  });
  const look = Math.max(4, Math.round(12 * f));
  const leave = (k: number, atStart: boolean) => {
    const p = lines[k], i = Math.min(p.length - 1, look);
    const [a, b] = atStart ? [p[0], p[i]] : [p[p.length - 1], p[p.length - 1 - i]];
    return Math.atan2(b[1] - a[1], b[0] - a[0]);
  };
  const at = new Map<number, [number, boolean][]>();
  edges.forEach((e, k) => {
    if (!isEnd[e.a]) (at.get(e.a) ?? at.set(e.a, []).get(e.a)!).push([k, true]);
    if (!isEnd[e.b]) (at.get(e.b) ?? at.set(e.b, []).get(e.b)!).push([k, false]);
  });
  const pair = new Map<string, [number, boolean]>(), key = (k: number, s: boolean) => k + (s ? 's' : 'e');
  for (const list of at.values()) {
    const c: [number, [number, boolean], [number, boolean]][] = [];
    for (let x = 0; x < list.length; x++)
      for (let y = x + 1; y < list.length; y++) {
        if (list[x][0] === list[y][0]) continue;
        let d = Math.abs(leave(list[x][0], list[x][1]) - leave(list[y][0], list[y][1]));
        d = Math.abs(((d + Math.PI) % (2 * Math.PI)) - Math.PI); // 0 when they leave in the same direction
        const turn = Math.PI - d;
        if (turn < (35 * Math.PI) / 180) c.push([turn, list[x], list[y]]);
      }
    c.sort((a, b) => a[0] - b[0]);
    const taken = new Set<string>();
    for (const [, u, v] of c) {
      if (taken.has(key(...u)) || taken.has(key(...v))) continue;
      taken.add(key(...u)); taken.add(key(...v));
      pair.set(key(...u), v); pair.set(key(...v), u);
    }
  }
  const done = new Uint8Array(lines.length), out: RoadLine[] = [];
  for (let k0 = 0; k0 < lines.length; k0++) {
    if (done[k0]) continue;
    // back up to the start of the chain
    let k = k0, s = true;
    const seenK = new Set([k0]);
    for (;;) {
      const pr = pair.get(key(k, s));
      if (!pr || seenK.has(pr[0])) break;
      seenK.add(pr[0]);
      k = pr[0]; s = !pr[1];
    }
    const chain: [number, number][] = [];
    const startK = k;
    let closed = false;
    for (;;) {
      done[k] = 1;
      const p = s ? lines[k] : lines[k].slice().reverse();
      chain.push(...(chain.length ? p.slice(1) : p));
      const nx = pair.get(key(k, !s));
      if (!nx) break;
      if (done[nx[0]]) { closed = nx[0] === startK; break; }
      k = nx[0]; s = nx[1];
    }
    let len = 0;
    for (let i = 1; i < chain.length; i++) len += Math.hypot(chain[i][0] - chain[i - 1][0], chain[i][1] - chain[i - 1][1]);
    if (len < 20 * f) continue;
    if (rings.some((r) => chain.every(([x, y]) => Math.hypot(x - r.x, y - r.y) < r.r + 4 * f))) continue; // the roundabout's own ring
    const [fx, fy] = chain[0], [lx, ly] = chain[chain.length - 1];
    closed = closed && Math.hypot(fx - lx, fy - ly) < 3 * f + 2;
    out.push({ pts: closed ? simplifyRing(chain.slice(0, -1), 2 * f) : simplifyLine(chain, 2 * f), closed });
  }
  return { lines: out, rings };
}
