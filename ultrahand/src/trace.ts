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
