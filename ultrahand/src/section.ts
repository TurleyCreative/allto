// Site section from LIDAR: ground (terrain model) and the surface above it (buildings and trees),
// at true scale, with the red line extent and any proposed blocks the line crosses.

export interface SectionPoint { d: number; ground: number | null; surface: number | null; inSite: boolean; proposed: { top: number; base: number; colour: string; name: string } | null }

const f1 = (n: number) => (Math.round(n * 10) / 10).toString();

export function sectionSVG(pts: SectionPoint[], opts: { title: string; width?: number }): string {
  const W = opts.width ?? 1600, padL = 70, padR = 30, padT = 60, padB = 60;
  const len = pts[pts.length - 1]?.d ?? 0;
  const gs = pts.map((p) => p.ground).filter((v): v is number => v != null);
  if (!gs.length || len < 2) return '<svg xmlns="http://www.w3.org/2000/svg"/>';
  const tops = pts.map((p) => Math.max(p.surface ?? -Infinity, p.proposed && p.ground != null ? p.ground + p.proposed.top : -Infinity));
  const zMin = Math.floor(Math.min(...gs) - 6), zMax = Math.ceil(Math.max(...gs, ...tops.filter(isFinite)) + 8);
  const s = (W - padL - padR) / len; // true scale: the same metres across and up
  const H = Math.max(300, Math.round((zMax - zMin) * s) + padT + padB);
  const X = (d: number) => padL + d * s;
  const Y = (z: number) => H - padB - (z - zMin) * s;
  const out: string[] = [];
  out.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family="'Plus Jakarta Sans', Helvetica, Arial, sans-serif"><rect width="${W}" height="${H}" fill="#fff"/>`);
  out.push(`<text x="${padL}" y="28" font-size="16" font-weight="700" fill="#141414">${opts.title}</text>`);
  out.push(`<text x="${padL}" y="46" font-size="11.5" fill="#6f6e6a">Environment Agency LIDAR, 1 m: ground (terrain model) and surface (buildings and trees). True scale, heights in metres above ordnance datum.</text>`);

  // Height grid
  const step = zMax - zMin > 60 ? 10 : 5;
  for (let z = Math.ceil(zMin / step) * step; z <= zMax; z += step) {
    out.push(`<line x1="${padL}" x2="${W - padR}" y1="${f1(Y(z))}" y2="${f1(Y(z))}" stroke="#ecebe7" stroke-width="1"/>`);
    out.push(`<text x="${padL - 8}" y="${f1(Y(z) + 4)}" font-size="10.5" text-anchor="end" fill="#6f6e6a">${z} m</text>`);
  }

  // Surface above the ground (buildings and trees): dark where it stands more than 2.5 m proud.
  let run: SectionPoint[] = [];
  const flush = () => {
    if (run.length > 1) {
      const top = run.map((p) => `${f1(X(p.d))} ${f1(Y(p.surface!))}`).join(' L');
      const bot = [...run].reverse().map((p) => `${f1(X(p.d))} ${f1(Y(p.ground!))}`).join(' L');
      out.push(`<path d="M${top} L${bot}Z" fill="#3b3a38"/>`);
    }
    run = [];
  };
  for (const p of pts) (p.ground != null && p.surface != null && p.surface - p.ground > 2.5 ? run.push(p) : flush());
  flush();

  // Ground
  const ground = pts.filter((p) => p.ground != null);
  out.push(`<path d="M${f1(X(ground[0].d))} ${f1(Y(zMin))} L${ground.map((p) => `${f1(X(p.d))} ${f1(Y(p.ground!))}`).join(' L')} L${f1(X(ground[ground.length - 1].d))} ${f1(Y(zMin))}Z" fill="#e9e8e4" stroke="#141414" stroke-width="1.4"/>`);

  // Proposed blocks crossing the line
  let pr: SectionPoint[] = [];
  const flushP = () => {
    if (pr.length > 1 && pr[0].proposed) {
      const b = pr[0].proposed, g = Math.min(...pr.map((p) => p.ground ?? Infinity));
      const x0 = X(pr[0].d), x1 = X(pr[pr.length - 1].d);
      out.push(`<rect x="${f1(x0)}" y="${f1(Y(g + b.top))}" width="${f1(x1 - x0)}" height="${f1((b.top - b.base) * s)}" fill="${b.colour}" fill-opacity="0.55" stroke="${b.colour}" stroke-width="1.5"/>`);
      out.push(`<text x="${f1((x0 + x1) / 2)}" y="${f1(Y(g + b.top) - 6)}" font-size="11" text-anchor="middle" fill="#141414">${b.name}</text>`);
    }
    pr = [];
  };
  for (const p of pts) {
    if (p.proposed && (!pr.length || pr[0].proposed?.name === p.proposed.name)) pr.push(p);
    else (flushP(), p.proposed && pr.push(p));
  }
  flushP();

  // Red line extent along the ground
  let rl: SectionPoint[] = [];
  const flushR = () => {
    if (rl.length > 1) out.push(`<line x1="${f1(X(rl[0].d))}" x2="${f1(X(rl[rl.length - 1].d))}" y1="${f1(H - padB + 14)}" y2="${f1(H - padB + 14)}" stroke="#d7262e" stroke-width="4"/>`);
    rl = [];
  };
  for (const p of pts) (p.inSite ? rl.push(p) : flushR());
  flushR();

  // Distance scale and ends
  const dstep = len > 600 ? 100 : len > 250 ? 50 : 25;
  for (let d = 0; d <= len; d += dstep) out.push(`<text x="${f1(X(d))}" y="${H - padB + 34}" font-size="10.5" text-anchor="middle" fill="#6f6e6a">${d} m</text>`);
  out.push(`<text x="${padL}" y="${f1(Y(zMax) + 4)}" font-size="16" font-weight="700" fill="#141414">A</text>`);
  out.push(`<text x="${W - padR}" y="${f1(Y(zMax) + 4)}" font-size="16" font-weight="700" text-anchor="end" fill="#141414">A′</text>`);
  out.push(`<g font-size="11" fill="#141414" transform="translate(${W - padR - 360} ${H - 16})"><rect width="12" height="8" y="-8" fill="#3b3a38"/><text x="18">Buildings and trees</text><rect x="140" width="12" height="8" y="-8" fill="#e9e8e4" stroke="#141414"/><text x="158">Ground</text><rect x="215" width="16" height="4" y="-6" fill="#d7262e"/><text x="236">Red line</text></g>`);
  out.push('</svg>');
  return out.join('');
}
