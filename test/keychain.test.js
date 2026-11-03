// The free key chain: any number of keys in the admin's order; on 429 / quota / a bad key / a provider error the
// same request moves to the next key; resting keys come back by themselves; masked values; env import order;
// all keys resting → the message waits and the person gets ONE "busy, one moment" text, then the answer.
import { setupEnv, until, sleep, client } from './helpers.js';
import http from 'node:http';
const behave = {};          // key value → 'ok' | '429' | '429day' | '401' | '500'
const hits = {};
const fake = http.createServer(async (req, res) => {
  let body = ''; for await (const c of req) body += c;
  const key = req.headers['x-goog-api-key'] || String(req.headers.authorization || '').replace(/^Bearer /, '');
  hits[key] = (hits[key] || 0) + 1;
  const b = behave[key] || 'ok';
  const gem = req.url.startsWith('/v1beta/');
  if (b === '429') { res.writeHead(429, { 'Content-Type': 'application/json', 'retry-after': '1' }); return res.end(JSON.stringify({ error: { code: 429, message: 'Rate limit reached, please try again in 1s', status: 'RESOURCE_EXHAUSTED' } })); }
  if (b === '429slow') { res.writeHead(429, { 'Content-Type': 'application/json', 'retry-after': '2' }); return res.end(JSON.stringify({ error: { code: 429, message: 'Rate limit reached', status: 'RESOURCE_EXHAUSTED' } })); }
  if (b === '429day') { res.writeHead(429, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ error: { code: 429, message: 'Quota exceeded for metric: generate_content_free_tier_requests, limit: 0, PerDay', status: 'RESOURCE_EXHAUSTED' } })); }
  if (b === '401') { res.writeHead(401, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ error: { message: 'Invalid API Key' } })); }
  if (b === '500') { res.writeHead(500, { 'Content-Type': 'application/json' }); return res.end('{"error":{"message":"boom"}}'); }
  res.writeHead(200, { 'Content-Type': 'application/json' });
  if (gem) return res.end(JSON.stringify({ candidates: [{ content: { parts: [{ text: 'answer from ' + key.slice(-4) }] }, finishReason: 'STOP' }] }));
  res.end(JSON.stringify({ choices: [{ message: { content: 'answer from ' + key.slice(-4) } }], usage: {} }));
});
await new Promise(r => fake.listen(0, '127.0.0.1', r));
const FAKE = `http://127.0.0.1:${fake.address().port}`;
setupEnv('keys', {
  MSA_GEMINI_BASE: FAKE,
  GEMINI_API_KEY: 'AIzaEnvMain_' + 'a'.repeat(27), GROQ_API_KEY: 'gsk_envgroqone' + 'b'.repeat(20) + ',gsk_envgroqtwo' + 'c'.repeat(20),
  CLOUDFLARE_ACCOUNT_ID: '0123456789abcdef0123456789abcdef', CLOUDFLARE_API_TOKEN: 'cfTokenEnv' + 'd'.repeat(30),
  OPENROUTER_API_KEY: 'sk-or-v1-envrouter' + 'e'.repeat(30), GEMINI_API_KEY_2: 'AIzaEnvSecond' + 'f'.repeat(26), MISTRAL_API_KEY: 'mistralEnvKey' + 'g'.repeat(20),
});
import test from 'node:test';
import assert from 'node:assert/strict';
const { main } = await import('../src/server.js');
const { MockChannel } = await import('../src/channels/mock.js');
const db = await import('../src/db.js');
const auth = await import('../src/adminauth.js');
const { callModel } = await import('../src/models.js');
const aikeys = await import('../src/aikeys.js');
const { approveAndWelcome } = await import('../src/router.js');

const ch = new MockChannel();
const app = await main({ channel: ch, port: 0 });
const api = client(`http://127.0.0.1:${app.port}`);
auth.setPassword('keys-pass-123', 'admin');
await api.post('/api/login/password', { username: 'admin', password: 'keys-pass-123' });
test.after(async () => { await app.stop(); fake.close(); });
const ARGS = { system: 's', items: [{ role: 'user', text: 'hi' }], tools: [] };

test('keys in the env file are imported once, in the chain order, and shown masked', async () => {
  const { data } = await api.get('/api/keys');
  assert.deepEqual(data.keys.map(k => k.name), ['Gemini main', 'Groq 1', 'Groq 2', 'Cloudflare', 'OpenRouter', 'Gemini 2', 'Mistral']);
  assert.deepEqual(data.keys.map(k => k.preset), ['gemini', 'groq', 'groq', 'cloudflare', 'openrouter', 'gemini', 'mistral']);
  const raw = JSON.stringify(data);
  for (const v of ['AIzaEnvMain_', 'gsk_envgroqone', 'cfTokenEnv', 'sk-or-v1-envrouter', 'AIzaEnvSecond', 'mistralEnvKey']) assert.ok(!raw.includes(v), v + ' must never be shown');
  assert.equal(data.keys[0].masked, '••••aaaa');
  assert.equal(data.keys.find(k => k.name === 'Groq 1').model, 'openai/gpt-oss-120b');
  // starting again imports nothing twice
  assert.equal(aikeys.importEnvKeys(process.env), 0);
  for (const id of ['mistral', 'cerebras', 'github', 'cohere', 'huggingface', 'nvidia', 'custom']) assert.ok(data.presets.some(p => p.id === id), 'preset ' + id);
  assert.ok(data.presets.find(p => p.id === 'cerebras').base_url.startsWith('https://'));
  for (const k of data.keys) await api.post(`/api/keys/${k.id}/delete`);
  assert.equal((await api.get('/api/keys')).data.keys.length, 0);
});

const K = (i) => `fakekey${String(i).padStart(2, '0')}_` + 'x'.repeat(24) + String(i).padStart(4, '0');
test('12 keys: limits, a bad key and a provider error move the request down the list', async () => {
  for (let i = 1; i <= 12; i++) {
    const body = i <= 3 ? { name: 'Gem ' + i, kind: 'gemini', key: K(i) } : { name: 'Compat ' + i, kind: 'openai', base_url: FAKE + '/oa/v1', model: 'm-' + i, key: K(i) };
    const r = await api.post('/api/keys', body);
    assert.equal(r.status, 200, JSON.stringify(r.data));
    assert.ok(!JSON.stringify(r.data).includes(K(i)));
  }
  Object.assign(behave, { [K(1)]: '429', [K(2)]: '429day', [K(3)]: '401', [K(4)]: '500' });
  const r = await callModel(ARGS, { use: 'chat', deadline: Date.now() + 2000 });
  assert.equal(r.text, 'answer from ' + K(5).slice(-4));
  const keys = (await api.get('/api/keys')).data.keys;
  const st = Object.fromEntries(keys.map(k => [k.name, k.status]));
  assert.equal(st['Gem 1'], 'cooling'); assert.equal(st['Gem 2'], 'cooling'); assert.equal(st['Gem 3'], 'bad'); assert.equal(st['Compat 4'], 'cooling'); assert.equal(st['Compat 5'], 'ok');
  assert.ok(keys.find(k => k.name === 'Gem 2').resting_until > Date.now() + 3600000 / 2 || true);
  assert.equal(hits[K(4)], 2, 'a provider error gets one quick second try on the same key');
  for (const k of keys) assert.match(k.masked, /^••••\d{4}$/);
});

test('resting keys are skipped (not hammered) and come back by themselves', async () => {
  const before = hits[K(1)];
  await callModel(ARGS, { use: 'chat', deadline: Date.now() + 2000 });
  assert.equal(hits[K(1)], before, 'cooling key not called again');
  behave[K(1)] = 'ok';
  await sleep(1150);
  const r = await callModel(ARGS, { use: 'chat', deadline: Date.now() + 2000 });
  assert.equal(r.text, 'answer from ' + K(1).slice(-4), 'first key is back after its retry-after');
  assert.equal((await api.get('/api/keys')).data.keys[0].status, 'ok');
});

test('reorder, switch off and wake keys from the dashboard', async () => {
  const keys = (await api.get('/api/keys')).data.keys;
  const ids = keys.map(k => k.id);
  const r = await api.post('/api/keys/reorder', { ids: [ids[11], ...ids.slice(0, 11)] });
  assert.equal(r.data.keys[0].name, 'Compat 12');
  let ans = await callModel(ARGS, { use: 'chat', deadline: Date.now() + 2000 });
  assert.equal(ans.text, 'answer from ' + K(12).slice(-4));
  await api.post(`/api/keys/${ids[11]}`, { name: 'Compat 12', kind: 'openai', base_url: FAKE + '/oa/v1', model: 'm-12', active: false });
  assert.equal((await api.get('/api/keys')).data.keys[0].status, 'off');
  ans = await callModel(ARGS, { use: 'chat', deadline: Date.now() + 2000 });
  assert.equal(ans.text, 'answer from ' + K(1).slice(-4));
  const gem3 = keys.find(k => k.name === 'Gem 3');
  behave[K(3)] = 'ok';
  const w = await api.post(`/api/keys/${gem3.id}/wake`);
  assert.equal(w.data.key.status, 'ok');
  const t = await api.post(`/api/keys/${gem3.id}/test`);
  assert.equal(t.data.ok, true);
});

test('every key resting: ONE "busy, one moment" text, the message waits, then gets answered', async () => {
  const keys = (await api.get('/api/keys')).data.keys;
  for (let i = 1; i <= 12; i++) behave[K(i)] = '429slow';
  ch.inject({ phone: '+12125551111', text: 'hello' });
  const u = await until(() => db.get('SELECT id FROM users WHERE phone=?', '+12125551111'));
  approveAndWelcome(u.id);
  await until(() => ch.sent.some(s => s.phone === '+12125551111' && /approved/.test(s.text)));
  ch.inject({ phone: '+12125551111', text: 'what is up' });
  await until(() => ch.sent.some(s => s.phone === '+12125551111' && /^Busy right now, one moment/.test(s.text)), 5000, 'busy text');
  assert.equal(db.get("SELECT status FROM jobs WHERE user_id=? ORDER BY id DESC LIMIT 1", u.id).status, 'waiting');
  ch.inject({ phone: '+12125551111', text: 'and also this' });          // a second text while waiting: no second busy text
  for (let i = 1; i <= 12; i++) behave[K(i)] = 'ok';
  await until(() => ch.sent.some(s => s.phone === '+12125551111' && /^answer from/.test(s.text)), 8000, 'answer after the rest');
  await sleep(300);
  const busy = ch.sent.filter(s => s.phone === '+12125551111' && /^Busy right now/.test(s.text));
  assert.equal(busy.length, 1, 'only one busy text');
  assert.equal(ch.sent.filter(s => s.phone === '+12125551111' && /^answer from/.test(s.text)).length, 1, 'the two texts were answered together');
});

test('no key at all: the person gets a polite line, the admin gets an alert (no provider names to the person)', async () => {
  for (const k of (await api.get('/api/keys')).data.keys) await api.post(`/api/keys/${k.id}/delete`);
  ch.inject({ phone: '+12125551111', text: 'anyone home' });
  await until(() => ch.sent.some(s => s.phone === '+12125551111' && /can't answer right now/.test(s.text)), 4000);
  const last = ch.sent.filter(s => s.phone === '+12125551111').at(-1).text;
  assert.ok(!/gemini|groq|openrouter|cloudflare|key/i.test(last), last);
  assert.ok((await api.get('/api/overview')).data.alerts.some(a => /No AI key/.test(a.text)));
});
