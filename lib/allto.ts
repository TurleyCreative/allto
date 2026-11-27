// Typed access to window.Allto (shared/allto.js) for the TypeScript pages.
export interface AlltoProject { name?: string; place?: string; redLine?: number[][]; updatedAt?: number; source?: string }
export interface AlltoProduct { id: string; label: string; path: string; blurb: string }
export interface AlltoApi {
  PRODUCTS: AlltoProduct[];
  ROOT: string;
  url(id: string): string;
  project(): AlltoProject;
  update(patch: Partial<AlltoProject>, source: string): AlltoProject;
  clear(): void;
  hasNews(product: string): boolean;
  markSeen(product: string): void;
  onChange(fn: (p: AlltoProject) => void): void;
  productLabel(id: string): string;
  mountSwitcher(host: HTMLElement | null, opts: { active?: string; theme?: string; logo?: boolean; file?: boolean }): HTMLElement | null;
  mountProjectChip(host: HTMLElement | null, opts?: { theme?: string }): HTMLElement | null;
  notify(msg: string): void;
  FILE_FORMAT: string;
  beforeSave(fn: () => void): void;
  saveFile(): Promise<string>;
  openFile(file: File): Promise<unknown>;
  pickFile(): void;
  playIntro(opts?: { force?: boolean }): void;
}
export const Allto = (window as any).Allto as AlltoApi;

const TOKEN = import.meta.env.VITE_MAPBOX_TOKEN as string;

/** A Mapbox static image of the red line, or null when there isn't one. */
export function redLineImage(p: AlltoProject, w = 640, h = 360): string | null {
  if (!p.redLine || p.redLine.length < 4 || !TOKEN) return null;
  const f = {
    type: 'Feature',
    properties: { stroke: '#d7262e', 'stroke-width': 3, fill: '#d7262e', 'fill-opacity': 0.08 },
    geometry: { type: 'Polygon', coordinates: [p.redLine.map((c) => [+c[0].toFixed(6), +c[1].toFixed(6)])] },
  };
  const overlay = `geojson(${encodeURIComponent(JSON.stringify(f))})`;
  return `https://api.mapbox.com/styles/v1/mapbox/light-v11/static/${overlay}/auto/${w}x${h}@2x?padding=80&access_token=${TOKEN}`;
}

export const esc = (s: unknown) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

export function when(p: AlltoProject) {
  return p.updatedAt ? `Last changed in ${Allto.productLabel(p.source ?? '')}, ${new Date(p.updatedAt).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}` : '';
}
