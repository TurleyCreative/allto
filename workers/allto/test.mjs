// Tests for the allto Worker, with Direct Line, the Land Registry, Access and static files stood in for.
// Run: node test.mjs
import assert from 'node:assert/strict';
import worker from './src/index.js';

const APP = 'https://allto.example.workers.dev';
const PAGES = 'https://turleycreative.github.io';
const TEAM = 'turley.cloudflareaccess.com', AUD = 'aud-123';

// A real RSA key pair stands in for Access's signing key.
const kp = await crypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify']);
const pub = { ...(await crypto.subtle.exportKey('jwk', kp.publicKey)), kid: 'k1' };
const b64u = (b) => Buffer.from(b).toString('base64url');
async function jwt(claims, { kid = 'k1', key = kp.privateKey } = {}) {
  const h = b64u(JSON.stringify({ alg: 'RS256', kid })), p = b64u(JSON.stringify(claims));
  const s = new Uint8Array(await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(`${h}.${p}`)));
  return `${h}.${p}.${b64u(s)}`;
}
const good = () => jwt({ aud: [AUD], iss: `https://${TEAM}`, exp: Math.floor(Date.now() / 1000) + 600, email: 'a.person@turley.co.uk' });

let calls = [];
let lastClaude = null, claudeStop = 'end_turn';
const claudeDraft = { summary: 'A small terrace by a green.', streets: [{ name: 'Mill Street', type: 'residential', points: [[100, 800], [900, 800]] }],
  open_spaces: [{ name: 'Green', type: 'park', outline: [[100, 100], [400, 100], [400, 400], [100, 400]] }],
  blocks: [{ name: 'Terrace', use: 'residential', storeys: 2, outline: [[500, 500], [800, 500], [800, 600], [500, 600]] }], trees: [[200, 600]] };
globalThis.fetch = async (url, init = {}) => {
  const u = String(url);
  calls.push(u);
  if (u === `https://${TEAM}/cdn-cgi/access/certs`) return Response.json({ keys: [pub] });
  if (u.endsWith('/v3/directline/tokens/generate')) {
    if (init.headers?.Authorization !== 'Bearer s3cret') return new Response('denied', { status: 403 });
    return Response.json({ token: 'dl-token', conversationId: 'c1', expires_in: 3600 });
  }
  if (u.startsWith('https://inspire.landregistry.gov.uk/inspire/ows?')) return new Response(new Uint8Array([137, 80, 78, 71]), { headers: { 'Content-Type': 'image/png' } });
  if (u.startsWith('https://api.anthropic.com/v1/messages')) {
    const hd = new Headers(init.headers);
    lastClaude = { body: JSON.parse(init.body), key: hd.get('x-api-key') || (hd.get('authorization') || '').replace(/^Bearer /, ''), beta: hd.get('anthropic-beta') };
    if (lastClaude.key !== 'sk-test') return Response.json({ type: 'error', error: { type: 'authentication_error', message: 'bad key' } }, { status: 401 });
    return Response.json({ id: 'msg_1', type: 'message', role: 'assistant', model: 'claude-opus-5-5', stop_reason: claudeStop, stop_sequence: null,
      content: [{ type: 'text', text: JSON.stringify(claudeDraft) }], usage: { input_tokens: 1200, output_tokens: 300 } });
  }
  return new Response('?', { status: 500 });
};
const ASSETS = { fetch: async (req) => new Response(`file ${new URL(req.url).pathname}`, { headers: { 'Content-Type': 'text/html', 'Cache-Control': 'public, max-age=60' } }) };
const base = { ALLOWED_ORIGINS: PAGES, DIRECTLINE_DOMAIN: 'https://europe.directline.botframework.com', DIRECTLINE_SECRET: 's3cret', TEAM_KEY: 'open sesame', ASSETS };
const withAccess = { ...base, ACCESS_TEAM_DOMAIN: TEAM, ACCESS_AUD: AUD };

function req(path, { method = 'GET', origin = APP, cookie, jwt: token, body, sameOrigin = false } = {}) {
  const h = new Headers();
  if (origin) h.set('Origin', origin);
  if (sameOrigin) h.set('Sec-Fetch-Site', 'same-origin');
  if (cookie) h.set('Cookie', cookie);
  if (token) h.set('Cf-Access-Jwt-Assertion', token);
  return new Request(APP + path, { method, headers: h, body });
}
const form = (o) => { const f = new FormData(); for (const [k, v] of Object.entries(o)) f.set(k, v); return f; };
async function unlock(env, opts = {}) {
  const r = await worker.fetch(req('/unlock', { method: 'POST', body: form({ key: 'open sesame', next: '/present/index.html' }), ...opts }), env);
  return { r, cookie: (r.headers.get('Set-Cookie') || '').split(';')[0] };
}

const results = [];
async function test(name, fn) {
  calls = [];
  try { await fn(); results.push(`ok   ${name}`); } catch (e) { results.push(`FAIL ${name}: ${e.message}`); process.exitCode = 1; }
}

await test('Ultrahand and the files it runs on are open without the key', async () => {
  for (const p of ['/ultrahand/index.html', '/ultrahand/', '/shared/allto.js', '/assets/ultrahand-abc.js']) {
    const r = await worker.fetch(req(p, { origin: null }), base);
    assert.equal(r.status, 200, p);
    assert.equal(await r.text(), `file ${p}`);
  }
});

await test('everything else asks for the key and serves no files without it', async () => {
  for (const p of ['/', '/index.html', '/consultation/index.html', '/consultation/', '/present/index.html', '/present', '/examples/thompsons-yard.html', '/robots.txt']) {
    const r = await worker.fetch(req(p, { origin: null }), base);
    const t = await r.text();
    assert.equal(r.status, 200, p);
    assert.match(t, /needs a key/);
    assert.ok(!t.startsWith('file '), p);
  }
});

await test('wrong key: refused, slowed, no cookie', async () => {
  const t = Date.now();
  const r = await worker.fetch(req('/unlock', { method: 'POST', body: form({ key: 'nope', next: '/consultation/index.html' }) }), base);
  assert.equal(r.status, 401);
  assert.equal(r.headers.get('Set-Cookie'), null);
  assert.ok(Date.now() - t >= 500);
});

await test('right key: cookie set (HttpOnly, Secure), then Consultation and Present open, not cached', async () => {
  const { r, cookie } = await unlock(base);
  assert.equal(r.status, 303);
  assert.equal(r.headers.get('Location'), `${APP}/present/index.html`);
  assert.match(r.headers.get('Set-Cookie'), /HttpOnly; Secure; SameSite=Lax/);
  for (const p of ['/consultation/index.html', '/present/index.html']) {
    const page = await worker.fetch(req(p, { origin: null, cookie }), base);
    assert.equal(await page.text(), `file ${p}`);
    assert.equal(page.headers.get('Cache-Control'), 'private, no-store');
  }
});

await test('a forged or expired cookie does not open them; changing the key locks everyone out', async () => {
  const forged = `allto_key=${encodeURIComponent(`${Date.now() + 1e9}.${'0'.repeat(64)}`)}`;
  assert.match(await (await worker.fetch(req('/present/index.html', { cookie: forged }), base)).text(), /needs a key/);
  const { cookie } = await unlock(base);
  assert.match(await (await worker.fetch(req('/present/index.html', { cookie }), { ...base, TEAM_KEY: 'new key' })).text(), /needs a key/);
});

await test('unlock only redirects to locked pages on this site', async () => {
  for (const next of ['https://evil.example/', '//evil.example/present/', '/\\evil.example', '/ultrahand/index.html']) {
    const r = await worker.fetch(req('/unlock', { method: 'POST', body: form({ key: 'open sesame', next }) }), base);
    assert.equal(r.headers.get('Location'), `${APP}/index.html`, next);
  }
  const r = await worker.fetch(req('/unlock', { method: 'POST', body: form({ key: 'open sesame', next: '/examples/thompsons-yard.html' }) }), base);
  assert.equal(r.headers.get('Location'), `${APP}/examples/thompsons-yard.html`);
});

await test('with no key set, everything but Ultrahand stays shut (fails closed)', async () => {
  const noKey = { ...base, TEAM_KEY: undefined };
  const page = await worker.fetch(req('/consultation/index.html', { origin: null }), noKey);
  assert.match(await page.text(), /No key has been set up yet/);
  const r = await worker.fetch(req('/unlock', { method: 'POST', body: form({ key: '', next: '/index.html' }) }), noKey);
  assert.equal(r.headers.get('Set-Cookie'), null);
  assert.equal(await (await worker.fetch(req('/ultrahand/index.html', { origin: null }), noKey)).text(), 'file /ultrahand/index.html');
});

await test('agent token for the app itself (same origin) and allowed sites; others refused', async () => {
  const own = await worker.fetch(req('/token', { method: 'POST' }), base);
  assert.equal(own.status, 200);
  assert.equal((await own.json()).token, 'dl-token');
  const sameSite = await worker.fetch(req('/token', { method: 'POST', origin: null, sameOrigin: true }), base);
  assert.equal(sameSite.status, 200);
  const pages = await worker.fetch(req('/token', { method: 'POST', origin: PAGES }), base);
  assert.equal(pages.status, 200);
  assert.equal(pages.headers.get('Access-Control-Allow-Origin'), PAGES);
  assert.equal((await worker.fetch(req('/token', { method: 'POST', origin: 'https://evil.example' }), base)).status, 403);
});

await test('secret never appears in any response', async () => {
  for (const p of ['/token', '/health', '/me']) assert.ok(!(await (await worker.fetch(req(p, { method: p === '/token' ? 'POST' : 'GET' }), base)).text()).includes('s3cret'));
  assert.ok(!(await (await worker.fetch(req('/health'), base)).text()).includes('open sesame'));
});

await test('parcels tile for the app; bad boxes rejected; only the Land Registry is called', async () => {
  const r = await worker.fetch(req('/inspire-parcels?bbox=-251350,7068650,-250850,7069150', { origin: null, sameOrigin: true }), base);
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('Content-Type'), 'image/png');
  assert.equal((await worker.fetch(req('/inspire-parcels?bbox=0,0,50000,50000'), base)).status, 400);
  assert.ok(calls.every((c) => c.startsWith('https://inspire.landregistry.gov.uk/')));
});

await test('with Access configured: no login, a bad login or an expired login is refused', async () => {
  assert.equal((await worker.fetch(req('/token', { method: 'POST' }), withAccess)).status, 401);
  const other = await crypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify']);
  const forged = await jwt({ aud: [AUD], iss: `https://${TEAM}`, exp: Math.floor(Date.now() / 1000) + 600, email: 'x@turley.co.uk' }, { key: other.privateKey });
  assert.equal((await worker.fetch(req('/token', { method: 'POST', jwt: forged }), withAccess)).status, 401);
  const expired = await jwt({ aud: [AUD], iss: `https://${TEAM}`, exp: Math.floor(Date.now() / 1000) - 10, email: 'x@turley.co.uk' });
  assert.equal((await worker.fetch(req('/token', { method: 'POST', jwt: expired }), withAccess)).status, 401);
  const wrongAud = await jwt({ aud: ['other'], iss: `https://${TEAM}`, exp: Math.floor(Date.now() / 1000) + 600 });
  assert.equal((await worker.fetch(req('/token', { method: 'POST', jwt: wrongAud }), withAccess)).status, 401);
});

await test('with Access configured: a good login works, /me says who, and the key is tied to that person', async () => {
  const token = await good();
  assert.equal((await worker.fetch(req('/token', { method: 'POST', jwt: token }), withAccess)).status, 200);
  const me = await (await worker.fetch(req('/me', { jwt: token }), withAccess)).json();
  assert.deepEqual(me, { email: 'a.person@turley.co.uk', unlocked: false });
  const { cookie } = await unlock(withAccess, { jwt: token });
  assert.equal(await (await worker.fetch(req('/present/index.html', { jwt: token, cookie }), withAccess)).text(), 'file /present/index.html');
  const someoneElse = await jwt({ aud: [AUD], iss: `https://${TEAM}`, exp: Math.floor(Date.now() / 1000) + 600, email: 'b.other@turley.co.uk' });
  assert.match(await (await worker.fetch(req('/present/index.html', { jwt: someoneElse, cookie }), withAccess)).text(), /needs a key/);
});

await test('/draft-masterplan reads a drawing through Claude, and only with the key set', async () => {
  const body = JSON.stringify({ image: 'iVBORw0KGgo=', mediaType: 'image/png', note: 'Phase 1 only' });
  const off = await worker.fetch(req('/draft-masterplan', { method: 'POST', body }), base);
  assert.equal(off.status, 503);
  const env = { ...base, ANTHROPIC_API_KEY: 'sk-test' };
  const r = await worker.fetch(req('/draft-masterplan', { method: 'POST', body }), env);
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.deepEqual(j.draft, claudeDraft);
  assert.equal(lastClaude.body.model, 'claude-opus-5-5');
  assert.equal(lastClaude.body.fallbacks, 'default');
  assert.match(lastClaude.beta, /server-side-fallback-2026-07-01/);
  assert.equal(lastClaude.body.output_config.format.type, 'json_schema');
  assert.equal(lastClaude.body.messages[0].content[0].source.media_type, 'image/png');
  assert.match(lastClaude.body.messages[0].content[1].text, /Phase 1 only/);
  assert.ok(!(await (await worker.fetch(req('/health'), env)).text()).includes('sk-test'));
  // bad input, refusal, wrong key, other sites
  assert.equal((await worker.fetch(req('/draft-masterplan', { method: 'POST', body: '{}' }), env)).status, 400);
  claudeStop = 'refusal';
  assert.equal((await worker.fetch(req('/draft-masterplan', { method: 'POST', body }), env)).status, 422);
  claudeStop = 'end_turn';
  const bad = await worker.fetch(req('/draft-masterplan', { method: 'POST', body }), { ...base, ANTHROPIC_API_KEY: 'wrong' });
  assert.equal(bad.status, 502);
  assert.ok(!(await bad.text()).includes('wrong'));
  assert.equal((await worker.fetch(req('/draft-masterplan', { method: 'POST', body, origin: 'https://evil.example' }), env)).status, 403);
});

await test('health reports configuration without secrets', async () => {
  const h = await (await worker.fetch(req('/health'), withAccess)).json();
  assert.deepEqual([h.mode, h.access, h.consultationAndPresentKey], ['directline-secret', 'checked', 'required']);
});

console.log(results.join('\n'));
