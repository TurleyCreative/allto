/**
 * allto agent token service (Cloudflare Worker).
 *
 * The browser must never hold the agent's Direct Line secret. This Worker keeps it as a
 * Cloudflare secret and hands allto a short-lived Direct Line token instead, but only when the
 * request comes from an allowed allto address.
 *
 * Two ways to connect, set on the Worker:
 *   DIRECTLINE_SECRET       (secret)  Copilot Studio > Settings > Security > Web channel security.
 *                                     The Worker exchanges it for a token (about 1 hour).
 *   COPILOT_TOKEN_ENDPOINT  (var)     Copilot Studio > Channels > Mobile app > Token endpoint, for an
 *                                     agent without web channel security. The Worker relays it.
 * And:
 *   ALLOWED_ORIGINS   comma-separated sites allowed to ask (e.g. https://turleycreative.github.io)
 *   DIRECTLINE_DOMAIN regional Direct Line address (e.g. https://europe.directline.botframework.com)
 *
 * GET  /health  which mode is configured (no secrets)
 * POST /token   { token, conversationId?, expiresIn, directLineDomain, userId }
 * GET  /inspire-parcels?bbox=minx,miny,maxx,maxy   HM Land Registry INSPIRE Index Polygons as a
 *      256 px map tile (Web Mercator). The Land Registry map service doesn't allow browser requests,
 *      so allto asks through here; only that one service, only image tiles, cached for a day.
 */
const INSPIRE_WMS = 'https://inspire.landregistry.gov.uk/inspire/ows';

const json = (body, status, headers) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...headers } });

function cors(request, env) {
  const origin = request.headers.get('Origin') || '';
  const allowed = (env.ALLOWED_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (!allowed.includes(origin)) return null;
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '600',
    Vary: 'Origin',
  };
}

function directLineDomain(env) {
  return (env.DIRECTLINE_DOMAIN || 'https://directline.botframework.com').replace(/\/+$/, '');
}

/** Direct Line user ids must start with "dl_" when web channel security is on. */
function userId() {
  const b = new Uint8Array(12);
  crypto.getRandomValues(b);
  return 'dl_' + [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
}

/** fetch, with network failures turned into a plain message (no runtime internals). */
async function reach(what, url, init) {
  try {
    return await fetch(url, init);
  } catch {
    throw new Error(`Could not reach ${what}`);
  }
}

async function token(env) {
  const domain = directLineDomain(env);
  if (env.DIRECTLINE_SECRET) {
    const id = userId();
    const r = await reach('Direct Line', `${domain}/v3/directline/tokens/generate`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${env.DIRECTLINE_SECRET}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ user: { id: id } }),
    });
    if (!r.ok) throw new Error(`Direct Line answered ${r.status}`);
    const j = await r.json();
    return { token: j.token, conversationId: j.conversationId, expiresIn: j.expires_in, directLineDomain: domain, userId: id };
  }
  if (env.COPILOT_TOKEN_ENDPOINT) {
    const r = await reach('the Copilot Studio token endpoint', env.COPILOT_TOKEN_ENDPOINT);
    if (!r.ok) throw new Error(`Copilot Studio token endpoint answered ${r.status}`);
    const j = await r.json();
    return { token: j.token, conversationId: j.conversationId, expiresIn: j.expires_in, directLineDomain: domain, userId: userId() };
  }
  throw new Error('Not configured: set DIRECTLINE_SECRET or COPILOT_TOKEN_ENDPOINT on the Worker.');
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const headers = cors(request, env);

    if (url.pathname === '/health') {
      return json({ ok: true, mode: env.DIRECTLINE_SECRET ? 'directline-secret' : env.COPILOT_TOKEN_ENDPOINT ? 'copilot-token-endpoint' : 'not-configured', directLineDomain: directLineDomain(env) }, 200, headers || {});
    }
    if (url.pathname === '/inspire-parcels') {
      if (!headers) return json({ error: 'This site is not allowed to use this service.' }, 403);
      const bbox = (url.searchParams.get('bbox') || '').split(',').map(Number);
      if (bbox.length !== 4 || bbox.some((v) => !Number.isFinite(v)) || bbox[2] <= bbox[0] || bbox[3] <= bbox[1] || bbox[2] - bbox[0] > 20000)
        return json({ error: 'bbox must be minx,miny,maxx,maxy in metres (Web Mercator), up to 20 km wide' }, 400, headers);
      const q = new URLSearchParams({ service: 'WMS', version: '1.3.0', request: 'GetMap', layers: 'inspire:CP.CadastralParcel', styles: '', format: 'image/png', transparent: 'true', crs: 'EPSG:3857', width: '256', height: '256', bbox: bbox.join(',') });
      const r = await reach('the Land Registry map service', `${INSPIRE_WMS}?${q}`, { cf: { cacheTtl: 86400, cacheEverything: true } }).catch((e) => e);
      if (r instanceof Error || !r.ok || !/^image\//.test(r.headers.get('content-type') || '')) return json({ error: r instanceof Error ? r.message : `Land Registry answered ${r.status}` }, 502, headers);
      return new Response(r.body, { status: 200, headers: { ...headers, 'Content-Type': r.headers.get('content-type'), 'Cache-Control': 'public, max-age=86400' } });
    }
    if (url.pathname !== '/token') return json({ error: 'Not found' }, 404, headers || {});
    if (!headers) return json({ error: 'This site is not allowed to ask for a token.' }, 403);
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers });
    if (request.method !== 'POST' && request.method !== 'GET') return json({ error: 'Use POST' }, 405, headers);

    try {
      return json(await token(env), 200, headers);
    } catch (e) {
      // Never echo the secret or the upstream body back to the browser.
      return json({ error: e.message }, 502, headers);
    }
  },
};
