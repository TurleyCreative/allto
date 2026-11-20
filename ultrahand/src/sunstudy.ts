// Sun study sheet: shadows on the equinox and both solstices at 9:00, 12:00 and 15:00 (UK clock
// time), drawn as plans, with a sun-path diagram for the site's latitude.
import * as SunCalc from 'suncalc';
import { renderAxo, type AxoBuilding, type GroundPolys, type GroundLines } from './axo';
import type { LocalPoly, XY } from './geo';

const DAYS = [
  { label: '21 March', m: 2, d: 21, bst: false },
  { label: '21 June', m: 5, d: 21, bst: true },
  { label: '21 December', m: 11, d: 21, bst: false },
];
const HOURS = [9, 12, 15];

/** UK clock time on a day (BST in June), as an instant. */
const ukTime = (y: number, m: number, d: number, h: number, bst: boolean) => new Date(Date.UTC(y, m, d, h - (bst ? 1 : 0), 0));

const toSunOf = (azDeg: number): XY => [Math.sin((azDeg * Math.PI) / 180), Math.cos((azDeg * Math.PI) / 180)];

export function sunStudySVG(input: {
  lat: number;
  lng: number;
  buildings: AxoBuilding[];
  ground: (GroundPolys | GroundLines)[];
  clip: LocalPoly[];
  frame: { minX: number; minY: number; maxX: number; maxY: number };
  title: string;
  year?: number;
}): string {
  const year = input.year ?? new Date().getFullYear();
  const PW = 420, gap = 22, padL = 120, top = 96;
  const panels: string[] = [];
  let ph = 0;
  DAYS.forEach((day, r) =>
    HOURS.forEach((h, c) => {
      const p = SunCalc.getPosition(ukTime(year, day.m, day.d, h, day.bst), input.lat, input.lng);
      const svg = renderAxo(
        { buildings: input.buildings.map((b) => ({ ...b, z1: b.z1 })), clip: input.clip, ground: input.ground, frame: input.frame, shadows: p.altitude > 0 ? { toSun: toSunOf(p.azimuth), alt: p.altitude, opacity: 0.38 } : undefined },
        { bearing: 0, mode: 'ortho', pitch: 0, width: PW, padding: 6, groundColor: '#f4f3ef', clipBuildings: true },
      );
      const hgt = Number(/height="(\d+)"/.exec(svg)?.[1] ?? PW);
      ph = Math.max(ph, hgt);
      const x = padL + c * (PW + gap), y = top + r * (hgt + gap + 22);
      panels.push(svg.replace('<svg ', `<svg x="${x}" y="${y}" `));
      panels.push(`<text x="${x}" y="${y + hgt + 15}" font-size="11" fill="#6f6e6a">${p.altitude > 0 ? `Sun ${p.altitude.toFixed(0)}° up, from ${Math.round(p.azimuth)}°` : 'Sun below the horizon'}</text>`);
    }),
  );
  const rowH = ph + gap + 22;
  const pathX = padL + 3 * (PW + gap) + 10;
  const W = pathX + 440, H = Math.max(top + 3 * rowH + 40, 700);
  const out: string[] = [];
  out.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family="'Plus Jakarta Sans', Helvetica, Arial, sans-serif"><rect width="${W}" height="${H}" fill="#fff"/>`);
  out.push(`<text x="40" y="40" font-size="20" font-weight="700" fill="#141414">${input.title}</text>`);
  out.push(`<text x="40" y="62" font-size="12" fill="#6f6e6a">Shadows at UK clock time (British Summer Time in June). Plans, north up. Buildings at their recorded or measured heights.</text>`);
  HOURS.forEach((h, c) => out.push(`<text x="${padL + c * (PW + gap)}" y="${top - 10}" font-size="13" font-weight="700" fill="#141414">${String(h).padStart(2, '0')}:00</text>`));
  DAYS.forEach((d, r) => out.push(`<text x="40" y="${top + r * rowH + 18}" font-size="13" font-weight="700" fill="#141414">${d.label}</text>`));
  out.push(...panels);
  out.push(sunPath(input.lat, input.lng, year, pathX, top, 400));
  out.push('</svg>');
  return out.join('');
}

/** Sun-path diagram: the sky as a disc (horizon at the rim, overhead at the centre), north up. */
function sunPath(lat: number, lng: number, year: number, x0: number, y0: number, size: number): string {
  const R = size / 2 - 24, cx = x0 + size / 2, cy = y0 + size / 2;
  const P = (alt: number, az: number): XY => {
    const r = (R * (90 - alt)) / 90, a = (az * Math.PI) / 180;
    return [cx + r * Math.sin(a), cy - r * Math.cos(a)];
  };
  const o: string[] = [];
  o.push(`<text x="${x0}" y="${y0 - 10}" font-size="13" font-weight="700" fill="#141414">Sun path, ${lat.toFixed(2)}° N</text>`);
  for (const alt of [0, 15, 30, 45, 60, 75]) o.push(`<circle cx="${cx}" cy="${cy}" r="${(R * (90 - alt)) / 90}" fill="none" stroke="${alt ? '#e2e1dc' : '#141414'}" stroke-width="${alt ? 1 : 1.4}"/>`);
  for (const alt of [15, 30, 45, 60]) o.push(`<text x="${cx + 3}" y="${cy - (R * (90 - alt)) / 90 + 11}" font-size="9" fill="#9a9994">${alt}°</text>`);
  for (let az = 0; az < 360; az += 30) {
    const [x, y] = P(0, az);
    o.push(`<line x1="${cx}" y1="${cy}" x2="${x}" y2="${y}" stroke="#f0efea"/>`);
  }
  for (const [t, az] of [['N', 0], ['E', 90], ['S', 180], ['W', 270]] as [string, number][]) {
    const [x, y] = P(-9, az);
    o.push(`<text x="${x}" y="${y + 4}" font-size="12" font-weight="700" text-anchor="middle" fill="#141414">${t}</text>`);
  }
  const colours = ['#f08a1c', '#d7262e', '#2f6fd6'];
  DAYS.forEach((day, i) => {
    const pts: XY[] = [];
    for (let m = 0; m < 24 * 60; m += 10) {
      const p = SunCalc.getPosition(new Date(Date.UTC(year, day.m, day.d, 0, m)), lat, lng);
      if (p.altitude > 0) pts.push(P(p.altitude, p.azimuth));
    }
    if (pts.length > 1) o.push(`<path d="M${pts.map((q) => `${q[0].toFixed(1)} ${q[1].toFixed(1)}`).join(' L')}" fill="none" stroke="${colours[i]}" stroke-width="2.2"/>`);
    for (let h = 4; h <= 21; h++) {
      const p = SunCalc.getPosition(ukTime(year, day.m, day.d, h, day.bst), lat, lng);
      if (p.altitude <= 0) continue;
      const [x, y] = P(p.altitude, p.azimuth);
      o.push(`<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="2.6" fill="${colours[i]}"/>`);
      if (h % 3 === 0) o.push(`<text x="${(x + 5).toFixed(1)}" y="${(y - 4).toFixed(1)}" font-size="9" fill="#6f6e6a">${h}:00</text>`);
    }
  });
  DAYS.forEach((d, i) => o.push(`<g transform="translate(${x0 + 10} ${y0 + size + 16 + i * 18})"><rect width="16" height="3" y="-5" fill="${colours[i]}"/><text x="24" font-size="11.5" fill="#141414">${d.label}${d.m === 2 ? ' (and 21 September)' : ''}</text></g>`));
  return o.join('');
}
