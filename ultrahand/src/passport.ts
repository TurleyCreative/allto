// Building passport: a one-sheet A3 record of a single building, built from open data.
import * as turf from '@turf/turf';
import type { SiteModel, Bldg } from './model';
import { GREEN } from './model';
import { renderAxo, groundLayers, LOOK, type AxoBuilding } from './axo';
import { fmtArea, fmtDist, type LocalPoly, type XY } from './geo';
import { describe } from './planning';
import { CAT_LABEL, fetchBuildingAt, reverseGeocode, walkTimes, type Poi, type PoiCat } from './osm';

const esc = (s: unknown) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1).replace(/_/g, ' ');

export function useLabel(tags: Record<string, string> | undefined, tileType: string): string {
  const t = tags ?? {};
  const v = t.amenity || t.shop || t.office || t.tourism || t.leisure || t.healthcare || (t.building && t.building !== 'yes' ? t.building : '') || (tileType !== 'building' && tileType !== 'yes' ? tileType : '');
  return v ? cap(v) : 'Use not recorded';
}

export interface PassportCtx { model: SiteModel; pois: Poi[]; token: string; place: string; lpa: string | null }

export async function openPassport(b: Bldg, ctx: PassportCtx, host: HTMLElement) {
  host.innerHTML = `<div class="pp-toolbar"><span>Building passport · ${b.ref}</span><span class="pp-status">Gathering walking times and records…</span><button data-act="print">Print / save PDF</button><button data-act="close">Close</button></div><div class="pp-sheet"><p class="pp-loading">Building the passport for ${b.ref}…</p></div>`;
  host.hidden = false;
  host.querySelector<HTMLButtonElement>('[data-act=close]')!.onclick = () => (host.hidden = true);
  host.querySelector<HTMLButtonElement>('[data-act=print]')!.onclick = () => window.print();

  const [osm, addr, needs] = await Promise.all([
    fetchBuildingAt(b.ll[0], b.ll[1]),
    reverseGeocode(b.ll[0], b.ll[1], ctx.token),
    everydayNeeds(b, ctx).catch(() => null),
  ]);
  const tags = osm?.tags ?? {};
  const use = useLabel(tags, b.type);
  const name = tags.name || b.places[0];
  const street = addr?.street ?? tags['addr:street'] ?? '';
  const place = addr?.place ?? ctx.place;
  const today = new Date().toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });

  const { plan, mass, neighbours } = drawings(b, ctx.model);

  const heightLine = b.heightKnown
    ? `Height ${b.h.toFixed(1)} m${b.minH > 0 ? ` (from ${b.minH.toFixed(1)} m)` : ''}, ${b.heightSource === 'lidar' ? `measured from Environment Agency LIDAR${b.groundM != null ? `; ground ${b.groundM.toFixed(1)} m AOD` : ''}` : 'from OpenStreetMap via Mapbox'}`
    : 'Height not recorded: drawn at 6 m';
  const levels = tags['building:levels'] ? `${tags['building:levels']} storeys recorded` : '';

  const prot: string[] = [];
  for (const l of b.listed) prot.push(`Listed building: ${esc(describe(l))}`);
  for (const d of b.designations) prot.push(`${esc(datasetName(d.properties?.dataset))}: ${esc(describe(d))}`);
  if (b.inSite) prot.unshift('<b class="red">Inside the red line</b>');
  if (ctx.lpa) prot.push(`Local planning authority: ${esc(ctx.lpa)}`);

  const needsHtml = needs
    ? `<p>Everyday needs within 10 minutes' walk: <b>${needs.within10} of ${needs.rows.length}</b></p><p>${needs.rows
        .map((r) => (r.min == null ? `${CAT_LABEL[r.cat]}: none found nearby` : `${CAT_LABEL[r.cat]}: about ${Math.max(1, Math.round(r.min))} minute${Math.round(r.min) === 1 ? '' : 's'} (${esc(r.name)})`))
        .join(' · ')}</p>`
    : '<p>Walking times could not be fetched.</p>';

  const evidence: string[] = [];
  if (osm) evidence.push(`OpenStreetMap ${esc(osm.id)}`);
  const keyTags = ['name', 'building', 'building:levels', 'start_date', 'architect', 'heritage', 'addr:housenumber', 'addr:street', 'roof:shape', 'building:material'];
  const shown = keyTags.filter((k) => tags[k]).map((k) => `${k}=${esc(tags[k])}`);
  evidence.push(shown.length ? shown.join(' · ') : 'No name or use recorded on the OpenStreetMap building');
  if (!tags.name && b.places.length) evidence.push(`Named from places mapped inside the footprint: ${b.places.map(esc).join(', ')}`);

  host.querySelector('.pp-status')!.textContent = '';
  host.querySelector('.pp-sheet')!.innerHTML = `
  <header class="pp-head">
    <div><h1>${b.ref} ${esc(name || use)}</h1><p>${esc(use)}${street ? ` · ${esc(street)}` : ''}${place ? `, ${esc(place)}` : ''}</p></div>
    <div class="pp-meta">Building passport · allto: Ultrahand<br>${esc([street, place].filter(Boolean).join(', '))}<br>${today}</div>
  </header>
  <div class="pp-grid">
    <div class="pp-col">
      <section><h2>Plan, among its neighbours</h2><div class="pp-fig">${plan}</div></section>
      <section><h2>Mass, at the measured heights, and the neighbours within 45 m</h2><div class="pp-fig">${mass}</div></section>
    </div>
    <div class="pp-col">
      <section><h2>Identity and form</h2>
        <p>${esc(use)}</p>
        <p>Date: ${esc(tags.start_date ?? 'not recorded')}</p>
        <p>Footprint ${fmtArea(b.area)}</p>
        <p>${heightLine}</p>${levels ? `<p>${levels}</p>` : ''}
        <p>Neighbours within 45 m: ${neighbours}</p>
      </section>
      <section><h2>Protection and planning</h2>${prot.length ? prot.map((p) => `<p>${p}</p>`).join('') : '<p>No designations recorded on planning.data.gov.uk</p>'}</section>
      <section><h2>Getting about</h2>${needs?.transport ?? '<p>—</p>'}</section>
    </div>
    <div class="pp-col">
      <section><h2>Everyday needs</h2>${needsHtml}</section>
      <section><h2>Evidence</h2>${evidence.map((e) => `<p>${e}</p>`).join('')}</section>
    </div>
  </div>
  <footer class="pp-foot">
    <p><b>Sources and licences.</b> Everything on this sheet is drawn from published open data; nothing is invented. Drawn from open data. Not a measured survey or a flood risk assessment.</p>
    <p>Geometry and heights: © Mapbox © OpenStreetMap contributors. Where OpenStreetMap records no height, the building is drawn at 6 m and marked so.</p>
    <p>Designations: planning.data.gov.uk (DLUHC, Historic England, Environment Agency, Natural England, councils), fetched ${new Date().toISOString().slice(0, 10)}.</p>
    <p>Walking times: Mapbox Directions Matrix, walking profile, to the nearest places mapped in OpenStreetMap (shops, schools, health, parks, transport). Places missing from the map are missing here too.</p>
  </footer>`;
}

const DS_NAMES: Record<string, string> = {
  'conservation-area': 'Conservation area', 'flood-risk-zone': 'Flood risk', 'scheduled-monument': 'Scheduled monument', 'park-and-garden': 'Registered park and garden',
  'world-heritage-site': 'World heritage site', 'tree-preservation-zone': 'Tree preservation order area', 'site-of-special-scientific-interest': 'SSSI',
  'ancient-woodland': 'Ancient woodland', 'local-nature-reserve': 'Local nature reserve', 'green-belt': 'Green belt', 'article-4-direction-area': 'Article 4 direction',
};
const datasetName = (d: string) => DS_NAMES[d] ?? d;

function drawings(b: Bldg, m: SiteModel) {
  // Plan: north up, 70 m around the building, clipped to a rectangle.
  const xs = b.polys.flatMap((p) => p[0].map((q) => q[0])), ys = b.polys.flatMap((p) => p[0].map((q) => q[1]));
  const cx = (Math.min(...xs) + Math.max(...xs)) / 2, cy = (Math.min(...ys) + Math.max(...ys)) / 2;
  const half = Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys)) / 2 + 55;
  const rect: LocalPoly = [[[cx - half * 1.6, cy - half], [cx + half * 1.6, cy - half], [cx + half * 1.6, cy + half], [cx - half * 1.6, cy + half]] as XY[]];
  const near = m.buildings.filter((o) => o.polys.some((p) => p[0].some((q) => Math.abs(q[0] - cx) < half * 1.8 && Math.abs(q[1] - cy) < half * 1.2)));
  const planB: AxoBuilding[] = near.map((o) => ({
    polys: o.polys, z0: 0, z1: 0,
    look: o === b ? LOOK.selected : { roof: '#c6c5c1', wallLight: '#c6c5c1', wallDark: '#c6c5c1', stroke: '#9d9c97', strokeWidth: 0.6 },
  }));
  const plan = renderAxo(
    { buildings: planB, clip: [rect], ground: groundLayers(m, GREEN), frame: { minX: cx - half * 1.6, maxX: cx + half * 1.6, minY: cy - half, maxY: cy + half } },
    { bearing: 0, mode: 'ortho', pitch: 0, width: 560, padding: 8, groundColor: '#e7e6e2', north: true, scaleBar: true, clipBuildings: true },
  );

  // Mass: the building and neighbours within 45 m, measured heights.
  const ring = turf.buffer(b.feature, 45, { units: 'meters' });
  const neigh = m.buildings.filter((o) => o !== b && ring && turf.booleanIntersects(o.feature, ring));
  const massB: AxoBuilding[] = [b, ...neigh].map((o) => ({ polys: o.polys, z0: o.minH, z1: o.h, look: o === b ? LOOK.selected : LOOK.context }));
  const mass = renderAxo({ buildings: massB }, { bearing: 30, mode: 'ortho', pitch: 55, width: 560, padding: 16, scaleBar: false, north: true });
  return { plan, mass, neighbours: neigh.length };
}

async function everydayNeeds(b: Bldg, ctx: PassportCtx) {
  const cats: PoiCat[] = ['shop', 'school', 'health', 'park', 'bus', 'rail'];
  const d = (p: Poi) => turf.distance(b.ll, [p.lon, p.lat], { units: 'meters' });
  const picks: { cat: PoiCat; poi: Poi; dist: number }[] = [];
  for (const c of cats) {
    ctx.pois.filter((p) => p.cat === c).map((p) => ({ cat: c, poi: p, dist: d(p) })).sort((x, y) => x.dist - y.dist).slice(0, c === 'bus' ? 2 : 4).forEach((x) => picks.push(x));
  }
  const times = await walkTimes(b.ll, picks.map((p) => [p.poi.lon, p.poi.lat]), ctx.token);
  const best = (c: PoiCat) => {
    let r: { min: number | null; name: string; dist: number } = { min: null, name: '', dist: 0 };
    picks.forEach((p, i) => {
      if (p.cat !== c) return;
      const t = times[i] ?? (p.dist * 1.3) / 80;
      if (r.min == null || t < r.min) r = { min: t, name: p.poi.name, dist: p.dist };
    });
    return { cat: c, ...r };
  };
  const rows = (['shop', 'school', 'health', 'park'] as PoiCat[]).map(best);
  const bus = best('bus'), rail = best('rail');
  const transportRow = { ...([bus, rail].filter((x) => x.min != null).sort((x, y) => x.min! - y.min!)[0] ?? bus), cat: 'bus' as PoiCat };
  rows.push(transportRow);
  const within10 = rows.filter((r) => r.min != null && r.min <= 10).length;
  const transport = [
    rail.min != null ? `<p>Nearest station or tram stop: ${esc(rail.name)}, about ${Math.round(rail.min)} minutes' walk (${fmtDist(rail.dist)} as the crow flies)</p>` : '<p>No station within the area searched</p>',
    bus.min != null ? `<p>Nearest bus stop: ${esc(bus.name)}, about ${Math.max(1, Math.round(bus.min))} minute${Math.round(bus.min) <= 1 ? '' : 's'}</p>` : '',
  ].join('');
  return { rows, within10, transport };
}
