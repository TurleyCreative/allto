// People and place: Census 2021 (Nomis) and the English Index of Multiple Deprivation 2019, for the
// neighbourhoods (2021 Lower Layer Super Output Areas) that overlap the study area. All open data;
// ONS and Nomis both allow browser requests.
import * as turf from '@turf/turf';
import type { Feature, FeatureCollection, Polygon, MultiPolygon } from 'geojson';

const ONS = 'https://services1.arcgis.com/ESMARspQHYMw9BZ9/arcgis/rest/services';
const LSOA21 = `${ONS}/LSOA_2021_EW_BSC_V4_RUC/FeatureServer/0/query`;
const IMD19 = `${ONS}/Index_of_Multiple_Deprivation_Dec_2019_Lookup_in_England_2022/FeatureServer/0/query`;
const NOMIS = 'https://www.nomisweb.co.uk/api/v01/dataset';
const IMD_LSOAS = 32844; // neighbourhoods ranked in England, 2019

const TABLES = {
  residents: 'NM_2021_1', // TS001
  age: 'NM_2020_1', // TS007A five-year bands
  accommodation: 'NM_2062_1', // TS044
  cars: 'NM_2063_1', // TS045
  tenure: 'NM_2072_1', // TS054
  travel: 'NM_2078_1', // TS061
};

type Counts = Record<string, number>;

async function json(url: string) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${new URL(url).host} answered ${r.status}`);
  return r.json();
}

/** Category totals for a census table, summed over the neighbourhoods. */
async function table(id: string, codes: string[]): Promise<Counts> {
  const j = await json(`${NOMIS}/${id}.data.json?date=latest&geography=${codes.join(',')}&measures=20100`);
  const out: Counts = {};
  for (const o of j.obs ?? []) {
    const k = Object.keys(o).find((x) => x.startsWith('c2021_'));
    if (!k) continue;
    const name = o[k].description as string;
    out[name] = (out[name] ?? 0) + (o.obs_value?.value ?? 0);
  }
  return out;
}

const share = (c: Counts, keys: (string | RegExp)[], total: number) =>
  total ? Object.entries(c).filter(([k]) => keys.some((x) => (typeof x === 'string' ? k === x : x.test(k)))).reduce((s, [, v]) => s + v, 0) / total : 0;

export interface People {
  lsoas: { code: string; name: string; imdDecile: number | null; imdRank: number | null }[];
  areaHa: number;
  residents: number;
  households: number;
  densityPerHa: number;
  age: { under15: number; age15to64: number; over65: number };
  tenure: { owned: number; sharedOwnership: number; socialRented: number; privateRented: number };
  accommodation: { flats: number; terracedOrSemi: number; detached: number };
  noCar: number;
  travel: { home: number; walk: number; cycle: number; publicTransport: number; car: number };
  imd: { mostDeprivedDecile: number | null; leastDeprivedDecile: number | null; changedBoundaries: number };
  map: FeatureCollection;
}

export async function fetchPeople(study: Feature<Polygon | MultiPolygon>): Promise<People> {
  const [w, s, e, n] = turf.bbox(study);
  const g = await json(`${LSOA21}?geometry=${w},${s},${e},${n}&geometryType=esriGeometryEnvelope&inSR=4326&spatialRel=esriSpatialRelIntersects&outFields=LSOA21CD,LSOA21NM,Shape__Area&returnGeometry=true&outSR=4326&f=geojson`);
  const feats = ((g.features ?? []) as Feature<Polygon | MultiPolygon>[]).filter((f) => {
    try {
      return turf.booleanIntersects(f, study);
    } catch {
      return true;
    }
  });
  if (!feats.length) throw new Error('No census neighbourhoods found here (England and Wales only).');
  const codes = feats.slice(0, 80).map((f) => String(f.properties?.LSOA21CD));
  const areaHa = feats.slice(0, 80).reduce((a, f) => a + turf.area(f) / 10000, 0);

  const imdP = json(`${IMD19}?where=${encodeURIComponent(`LSOA11CD IN (${codes.map((c) => `'${c}'`).join(',')})`)}&outFields=LSOA11CD,IMD19&returnGeometry=false&f=json`).catch(() => ({ features: [] }));
  const [res, age, acc, cars, ten, tr, imd] = await Promise.all([
    table(TABLES.residents, codes),
    table(TABLES.age, codes),
    table(TABLES.accommodation, codes),
    table(TABLES.cars, codes),
    table(TABLES.tenure, codes),
    table(TABLES.travel, codes),
    imdP,
  ]);
  const rank = new Map<string, number>((imd.features ?? []).map((f: any) => [f.attributes.LSOA11CD, f.attributes.IMD19]));
  const decile = (r?: number) => (r ? Math.min(10, Math.ceil((r / IMD_LSOAS) * 10)) : null);

  const residents = res['Total: All usual residents'] ?? 0;
  const ageTotal = age['Total'] ?? 0;
  const households = ten['Total: All households'] ?? 0;
  const accTotal = acc['Total'] ?? 0;
  const workers = Object.entries(tr).find(([k]) => k.startsWith('Total'))?.[1] ?? 0;

  const lsoas = feats.slice(0, 80).map((f) => {
    const code = String(f.properties?.LSOA21CD);
    const r = rank.get(code) ?? null;
    return { code, name: String(f.properties?.LSOA21NM), imdRank: r, imdDecile: decile(r ?? undefined) };
  });
  const deciles = lsoas.map((l) => l.imdDecile).filter((d): d is number => d != null);

  return {
    lsoas,
    areaHa,
    residents,
    households,
    densityPerHa: areaHa ? residents / areaHa : 0,
    age: {
      under15: share(age, [/Aged 4 years and under/, /Aged 5 to 9/, /Aged 10 to 14/], ageTotal),
      age15to64: share(age, [/Aged (15|20|25|30|35|40|45|50|55|60) to/], ageTotal),
      over65: share(age, [/Aged (65|70|75|80) to/, /85 years and over/], ageTotal),
    },
    tenure: {
      owned: share(ten, ['Owned'], households),
      sharedOwnership: share(ten, ['Shared ownership'], households),
      socialRented: share(ten, ['Social rented'], households),
      privateRented: share(ten, ['Private rented'], households),
    },
    accommodation: {
      flats: share(acc, [/flats|converted|commercial building/i], accTotal),
      terracedOrSemi: share(acc, ['Terraced', 'Semi-detached'], accTotal),
      detached: share(acc, ['Detached'], accTotal),
    },
    noCar: share(cars, ['No cars or vans in household'], cars['Total: All households'] ?? 0),
    travel: {
      home: share(tr, ['Work mainly at or from home'], workers),
      walk: share(tr, ['On foot'], workers),
      cycle: share(tr, ['Bicycle'], workers),
      publicTransport: share(tr, ['Underground, metro, light rail, tram', 'Train', 'Bus, minibus or coach'], workers),
      car: share(tr, ['Driving a car or van', 'Passenger in a car or van', 'Taxi'], workers),
    },
    imd: {
      mostDeprivedDecile: deciles.length ? Math.min(...deciles) : null,
      leastDeprivedDecile: deciles.length ? Math.max(...deciles) : null,
      changedBoundaries: lsoas.filter((l) => l.imdDecile == null).length,
    },
    map: {
      type: 'FeatureCollection',
      features: feats.slice(0, 80).map((f, i) => ({ type: 'Feature', geometry: f.geometry, properties: { code: lsoas[i].code, name: lsoas[i].name, decile: lsoas[i].imdDecile ?? 0 } })),
    },
  };
}

/** Decile 1 (most deprived) dark to 10 (least deprived) pale. */
export const IMD_COLOURS = ['#000000', '#6d1a36', '#8a2846', '#a53d57', '#bd566a', '#d2717f', '#e28d96', '#eea9ae', '#f5c5c7', '#f9dfe0', '#fbf0f0'];
