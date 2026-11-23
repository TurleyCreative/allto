/**
 * allto on Cloudflare: one Worker serves the whole app and its few server-side routes.
 *
 * Who gets in
 *   - Cloudflare Access in front (Zero Trust): Turley staff sign in with their @turley.co.uk address and a
 *     one-time code. When ACCESS_TEAM_DOMAIN and ACCESS_AUD are set, this Worker also checks the Access login
 *     itself on every server route, so nothing relies on Access alone.
 *   - Ultrahand is open to everyone at Turley. Consultation and Present are locked for now: /consultation and
 *     /present need a key (TEAM_KEY, a Worker secret). A correct key sets a signed, HttpOnly cookie for 30 days,
 *     tied to the person's Access login.
 *
 * Routes
 *   GET  /health                     what is configured (no secrets)
 *   GET  /me                         { email, unlocked } for the signed-in person
 *   POST /token                      Direct Line token for the Ultrahand site agent
 *   GET  /inspire-parcels?bbox=…     HM Land Registry INSPIRE parcels map tile (Ultrahand)
 *   POST /unlock                     check the key, set the cookie
 *   GET  /lock                       forget the key on this browser
 *   everything else                  the app (static files); /consultation/* and /present/* behind the key
 *
 * Settings: ALLOWED_ORIGINS, DIRECTLINE_DOMAIN, COPILOT_TOKEN_ENDPOINT, ACCESS_TEAM_DOMAIN, ACCESS_AUD (vars);
 *           DIRECTLINE_SECRET, TEAM_KEY (secrets).
 */

const INSPIRE_WMS = 'https://inspire.landregistry.gov.uk/inspire/ows';
const KEY_COOKIE = 'allto_key';
const KEY_DAYS = 30;

const json = (body, status, headers = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...headers } });

// ------------------------------------------------------------------ who is asking

/** CORS headers for an allowed cross-site caller, {} for the app's own pages, null for anyone else. */
function siteHeaders(request, env) {
  const url = new URL(request.url);
  const origin = request.headers.get('Origin') || '';
  if (origin === url.origin || (!origin && request.headers.get('Sec-Fetch-Site') === 'same-origin')) return { Vary: 'Origin' };
  const allowed = (env.ALLOWED_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (!origin || !allowed.includes(origin)) return null;
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Credentials': 'true',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '600',
    Vary: 'Origin',
  };
}

const b64urlBytes = (s) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4)), (c) => c.charCodeAt(0));
const b64urlJson = (s) => JSON.parse(new TextDecoder().decode(b64urlBytes(s)));

let certCache = { at: 0, keys: [] };
async function accessKeys(team) {
  if (Date.now() - certCache.at < 3600_000 && certCache.keys.length) return certCache.keys;
  const r = await fetch(`https://${team}/cdn-cgi/access/certs`);
  if (!r.ok) throw new Error('Could not read the Access signing keys');
  certCache = { at: Date.now(), keys: (await r.json()).keys || [] };
  return certCache.keys;
}

function cookie(request, name) {
  const m = (request.headers.get('Cookie') || '').match(new RegExp(`(?:^|;\\s*)${name}=([^;]+)`));
  return m ? decodeURIComponent(m[1]) : null;
}

/**
 * The Access login, checked here too. { ok, email }. When Access isn't configured on the Worker yet,
 * ok is true with no email (Access at the edge, if switched on, still applies).
 */
async function accessLogin(request, env) {
  if (!env.ACCESS_TEAM_DOMAIN || !env.ACCESS_AUD) return { ok: true, email: null, configured: false };
  const jwt = request.headers.get('Cf-Access-Jwt-Assertion') || cookie(request, 'CF_Authorization');
  if (!jwt) return { ok: false, configured: true };
  try {
    const [h, p, s] = jwt.split('.');
    const header = b64urlJson(h), payload = b64urlJson(p);
    const jwk = (await accessKeys(env.ACCESS_TEAM_DOMAIN)).find((k) => k.kid === header.kid);
    if (!jwk) return { ok: false, configured: true };
    const key = await crypto.subtle.importKey('jwk', jwk, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
    const good = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, b64urlBytes(s), new TextEncoder().encode(`${h}.${p}`));
    const aud = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
    const fresh = payload.exp * 1000 > Date.now();
    const issuer = payload.iss === `https://${env.ACCESS_TEAM_DOMAIN}`;
    return good && fresh && issuer && aud.includes(env.ACCESS_AUD) ? { ok: true, email: payload.email || null, configured: true } : { ok: false, configured: true };
  } catch {
    return { ok: false, configured: true };
  }
}

// ------------------------------------------------------------------ the key for Consultation and Present

async function hmac(secret, text) {
  const k = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', k, new TextEncoder().encode(text)));
  return [...sig].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function sameString(a, b) {
  // Constant time for equal lengths, so a wrong key can't be found character by character.
  const x = new TextEncoder().encode(a), y = new TextEncoder().encode(b);
  let d = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) d |= (x[i % x.length] ?? 0) ^ (y[i % y.length] ?? 0);
  return d === 0;
}

async function keyCookieValue(env, email, expires) {
  return `${expires}.${await hmac(env.TEAM_KEY, `allto-key|${email || ''}|${expires}`)}`;
}

/** Has this browser (and this person) unlocked Consultation and Present? True when no key is set. */
async function hasKey(request, env, email) {
  if (!env.TEAM_KEY) return true;
  const v = cookie(request, KEY_COOKIE);
  if (!v) return false;
  const [exp, sig] = v.split('.');
  if (!exp || !sig || Number(exp) < Date.now()) return false;
  return sameString(sig, (await keyCookieValue(env, email, Number(exp))).split('.')[1]);
}

const LOCKED = /^\/(consultation|present)(\/|$)/;
const safeNextOf = (next) => (LOCKED.test(next) && !next.includes('//') ? next : '/consultation/index.html');

function unlockPage(message = '', next = '/consultation/index.html') {
  const safeNext = safeNextOf(next);
  const which = safeNext.startsWith('/present') ? 'Present' : 'Consultation';
  return new Response(
    `<!doctype html><html lang="en-GB"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>allto: ${which}</title><link rel="icon" href="/shared/allto-logo.svg">
<link href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;600;700&display=swap" rel="stylesheet">
<style>
*{box-sizing:border-box}body{margin:0;font:15px/1.55 'Plus Jakarta Sans',Helvetica,Arial,sans-serif;color:#141414;background:#fff}
header{display:flex;align-items:center;gap:22px;height:64px;padding:0 24px;border-bottom:1px solid #e2e1dc}
header img{height:22px}header a{color:#9a9994;text-decoration:none;font-weight:600;font-size:13.5px}
main{max-width:440px;margin:12vh auto 0;padding:0 24px}h1{font-size:26px;margin:0 0 8px;letter-spacing:-.01em}
p{color:#3b3a37;margin:0 0 20px}label{display:block;font-size:12.5px;font-weight:600;color:#6f6e6a;margin-bottom:6px}
input{width:100%;padding:12px;border:1px solid #141414;font:inherit;font-size:15px}
button{margin-top:12px;width:100%;padding:12px;background:#141414;color:#fff;border:0;font:inherit;font-weight:700;cursor:pointer}
.err{color:#d7262e;font-size:13.5px;margin:10px 0 0}.fine{font-size:12.5px;color:#6f6e6a;margin-top:22px}
</style></head><body>
<header><a href="/index.html"><img src="/shared/allto-logo.svg" alt="allto*"></a>${['Consultation', 'Present', 'Ultrahand'].map((n) => `<a href="/${n.toLowerCase()}/index.html"${n === which ? ' style="color:#141414;border-bottom:2px solid #141414;padding-bottom:3px"' : ''}>${n}</a>`).join('')}</header>
<main><h1>${which}</h1><p>Consultation and Present are open to the team that uses them for now. Enter the key to carry on. Ultrahand is open to everyone at Turley.</p>
<form method="post" action="/unlock"><input type="hidden" name="next" value="${safeNext.replace(/"/g, '')}">
<label for="k">Key</label><input id="k" name="key" type="password" autocomplete="current-password" autofocus required>
<button type="submit">Open ${which}</button>${message ? `<p class="err">${message}</p>` : ''}</form>
<p class="fine">Remembered on this browser for ${KEY_DAYS} days. Ask the allto team for the key.</p></main></body></html>`,
    { status: message ? 401 : 200, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' } },
  );
}

// ------------------------------------------------------------------ agent token

async function reach(what, url, init) {
  try {
    return await fetch(url, init);
  } catch {
    throw new Error(`Could not reach ${what}`);
  }
}

const directLineDomain = (env) => (env.DIRECTLINE_DOMAIN || 'https://directline.botframework.com').replace(/\/+$/, '');

function userId() {
  const b = new Uint8Array(12);
  crypto.getRandomValues(b);
  return 'dl_' + [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
}

async function token(env) {
  const domain = directLineDomain(env);
  if (env.DIRECTLINE_SECRET) {
    const id = userId();
    const r = await reach('Direct Line', `${domain}/v3/directline/tokens/generate`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${env.DIRECTLINE_SECRET}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ user: { id } }),
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

// ------------------------------------------------------------------ routes


export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;
    const headers = siteHeaders(request, env);

    if (path === '/health') {
      return json(
        {
          ok: true,
          mode: env.DIRECTLINE_SECRET ? 'directline-secret' : env.COPILOT_TOKEN_ENDPOINT ? 'copilot-token-endpoint' : 'not-configured',
          directLineDomain: directLineDomain(env),
          access: env.ACCESS_TEAM_DOMAIN && env.ACCESS_AUD ? 'checked' : 'not-configured',
          consultationAndPresentKey: env.TEAM_KEY ? 'required' : 'not-set',
        },
        200,
        headers || {},
      );
    }

    if (request.method === 'OPTIONS') return headers ? new Response(null, { status: 204, headers }) : json({ error: 'Not allowed' }, 403);

    const login = await accessLogin(request, env);
    if (!login.ok) return json({ error: 'Sign in to allto first.' }, 401, headers || {});

    if (path === '/me') return json({ email: login.email, unlocked: await hasKey(request, env, login.email) }, 200, headers || {});

    if (path === '/unlock' && request.method === 'POST') {
      const form = await request.formData().catch(() => null);
      const next = safeNextOf(String(form?.get('next') || ''));
      if (!env.TEAM_KEY) return Response.redirect(new URL(next, url).href, 303);
      if (!form || !sameString(String(form.get('key') || ''), env.TEAM_KEY)) {
        await new Promise((r) => setTimeout(r, 600)); // slow down guessing
        return unlockPage('That key is not right.', next);
      }
      const expires = Date.now() + KEY_DAYS * 86400_000;
      return new Response(null, {
        status: 303,
        headers: {
          Location: new URL(next, url).href,
          'Set-Cookie': `${KEY_COOKIE}=${encodeURIComponent(await keyCookieValue(env, login.email, expires))}; Path=/; Max-Age=${KEY_DAYS * 86400}; HttpOnly; Secure; SameSite=Lax`,
          'Cache-Control': 'no-store',
        },
      });
    }
    if (path === '/lock') {
      return new Response(null, { status: 303, headers: { Location: new URL('/index.html', url).href, 'Set-Cookie': `${KEY_COOKIE}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax` } });
    }

    // Consultation and Present need the key; Ultrahand (and its token and parcels) are open to all of Turley.
    const unlocked = LOCKED.test(path) ? await hasKey(request, env, login.email) : true;

    if (path === '/inspire-parcels') {
      if (!headers) return json({ error: 'This site is not allowed to use this service.' }, 403);
      const bbox = (url.searchParams.get('bbox') || '').split(',').map(Number);
      if (bbox.length !== 4 || bbox.some((v) => !Number.isFinite(v)) || bbox[2] <= bbox[0] || bbox[3] <= bbox[1] || bbox[2] - bbox[0] > 20000)
        return json({ error: 'bbox must be minx,miny,maxx,maxy in metres (Web Mercator), up to 20 km wide' }, 400, headers);
      const q = new URLSearchParams({ service: 'WMS', version: '1.3.0', request: 'GetMap', layers: 'inspire:CP.CadastralParcel', styles: '', format: 'image/png', transparent: 'true', crs: 'EPSG:3857', width: '256', height: '256', bbox: bbox.join(',') });
      const r = await reach('the Land Registry map service', `${INSPIRE_WMS}?${q}`, { cf: { cacheTtl: 86400, cacheEverything: true } }).catch((e) => e);
      if (r instanceof Error || !r.ok || !/^image\//.test(r.headers.get('content-type') || '')) return json({ error: r instanceof Error ? r.message : `Land Registry answered ${r.status}` }, 502, headers);
      return new Response(r.body, { status: 200, headers: { ...headers, 'Content-Type': r.headers.get('content-type'), 'Cache-Control': 'private, max-age=86400' } });
    }

    if (path === '/token') {
      if (!headers) return json({ error: 'This site is not allowed to ask for a token.' }, 403);
      if (request.method !== 'POST' && request.method !== 'GET') return json({ error: 'Use POST' }, 405, headers);
      try {
        return json(await token(env), 200, headers);
      } catch (e) {
        return json({ error: e.message }, 502, headers); // never the secret or the upstream body
      }
    }

    // The app itself.
    if (LOCKED.test(path) && !unlocked) return unlockPage('', /\/(consultation|present)\/?$/.test(path) ? `${path.replace(/\/$/, '')}/index.html` : path);
    if (!env.ASSETS) return json({ error: 'Not found' }, 404, headers || {});
    const res = await env.ASSETS.fetch(request);
    if (LOCKED.test(path)) {
      const h = new Headers(res.headers);
      h.set('Cache-Control', 'private, no-store'); // never cache the locked pages at the edge
      return new Response(res.body, { status: res.status, headers: h });
    }
    return res;
  },
};
