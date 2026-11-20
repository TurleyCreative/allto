// Tests for the token Worker, with Direct Line and Copilot Studio mocked. Run: node test.mjs
import assert from 'node:assert/strict';
import worker from './src/index.js';

const ORIGIN = 'https://turleycreative.github.io';
const base = { ALLOWED_ORIGINS: `${ORIGIN},http://localhost:5173`, DIRECTLINE_DOMAIN: 'https://europe.directline.botframework.com' };
const req = (path, { origin = ORIGIN, method = 'POST' } = {}) =>
  new Request(`https://allto-agent-token.example.workers.dev${path}`, { method, headers: origin ? { Origin: origin } : {} });

let calls = [];
globalThis.fetch = async (url, init = {}) => {
  calls.push({ url: String(url), init });
  if (String(url).endsWith('/v3/directline/tokens/generate')) {
    if (init.headers?.Authorization !== 'Bearer s3cret') return new Response('denied', { status: 403 });
    const body = JSON.parse(init.body);
    assert.match(body.user.id, /^dl_[0-9a-f]{24}$/);
    return Response.json({ token: 'dl-token', conversationId: 'conv-1', expires_in: 3600 });
  }
  if (String(url).startsWith('https://copilot.example/token')) return Response.json({ token: 'cs-token', expires_in: 3600 });
  return new Response('?', { status: 500 });
};

const results = [];
async function test(name, fn) {
  calls = [];
  try { await fn(); results.push(`ok   ${name}`); } catch (e) { results.push(`FAIL ${name}: ${e.message}`); process.exitCode = 1; }
}

await test('secret mode: allowed site gets a token, regional domain, CORS for that site', async () => {
  const r = await worker.fetch(req('/token'), { ...base, DIRECTLINE_SECRET: 's3cret' });
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.equal(j.token, 'dl-token');
  assert.equal(j.directLineDomain, 'https://europe.directline.botframework.com');
  assert.match(j.userId, /^dl_/);
  assert.equal(r.headers.get('Access-Control-Allow-Origin'), ORIGIN);
  assert.equal(r.headers.get('Cache-Control'), 'no-store');
  assert.equal(calls[0].url, 'https://europe.directline.botframework.com/v3/directline/tokens/generate');
});

await test('secret never appears in any response', async () => {
  for (const env of [{ ...base, DIRECTLINE_SECRET: 's3cret' }, { ...base, DIRECTLINE_SECRET: 'wrong' }]) {
    const t = await (await worker.fetch(req('/token'), env)).text();
    assert.ok(!t.includes('s3cret') && !t.includes('wrong'));
    const h = await (await worker.fetch(req('/health'), env)).text();
    assert.ok(!h.includes('s3cret') && !h.includes('wrong'));
  }
});

await test('other sites are refused, and no upstream call is made', async () => {
  const r = await worker.fetch(req('/token', { origin: 'https://evil.example' }), { ...base, DIRECTLINE_SECRET: 's3cret' });
  assert.equal(r.status, 403);
  assert.equal(r.headers.get('Access-Control-Allow-Origin'), null);
  assert.equal(calls.length, 0);
});

await test('requests with no Origin are refused', async () => {
  const r = await worker.fetch(req('/token', { origin: null }), { ...base, DIRECTLINE_SECRET: 's3cret' });
  assert.equal(r.status, 403);
});

await test('preflight from an allowed site', async () => {
  const r = await worker.fetch(req('/token', { method: 'OPTIONS' }), { ...base, DIRECTLINE_SECRET: 's3cret' });
  assert.equal(r.status, 204);
  assert.equal(r.headers.get('Access-Control-Allow-Methods'), 'GET, POST, OPTIONS');
});

await test('token endpoint mode relays Copilot Studio', async () => {
  const r = await worker.fetch(req('/token'), { ...base, COPILOT_TOKEN_ENDPOINT: 'https://copilot.example/token?api-version=x' });
  assert.equal(r.status, 200);
  assert.equal((await r.json()).token, 'cs-token');
});

await test('upstream refusal becomes a 502 without detail leaking', async () => {
  const r = await worker.fetch(req('/token'), { ...base, DIRECTLINE_SECRET: 'wrong' });
  assert.equal(r.status, 502);
  assert.match((await r.json()).error, /Direct Line answered 403/);
});

await test('not configured says so', async () => {
  const r = await worker.fetch(req('/token'), base);
  assert.equal(r.status, 502);
  assert.match((await r.json()).error, /Not configured/);
  const h = await (await worker.fetch(req('/health'), base)).json();
  assert.equal(h.mode, 'not-configured');
});

await test('network failure becomes a plain message', async () => {
  const real = globalThis.fetch;
  globalThis.fetch = async () => { throw new TypeError('internal: lookup failed'); };
  try {
    const r = await worker.fetch(req('/token'), { ...base, DIRECTLINE_SECRET: 's3cret' });
    assert.equal(r.status, 502);
    assert.equal((await r.json()).error, 'Could not reach Direct Line');
  } finally { globalThis.fetch = real; }
});

console.log(results.join('\n'));
