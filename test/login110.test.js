// 1.1.0: sign-in is two separate doors (a phone number → its own chat page; the admin password → the dashboard only);
// the dashboard never shows a person's chat; one text per Google Messages outage (or none).
import { setupEnv, until, sleep, client } from './helpers.js';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ADMIN = '+16465550100', P = '+18455550145';
setupEnv('v110', { MSA_MOCK_MODULE: path.join(HERE, 'mock-model.js'), MSA_ADMIN_PHONE: ADMIN, MSA_PUBLIC_URL: 'https://msg.example.com', MSA_STABLE_MS: '300' });
import test from 'node:test';
import assert from 'node:assert/strict';
const { main } = await import('../src/server.js');
const { MockChannel } = await import('../src/channels/mock.js');
const auth = await import('../src/adminauth.js');
const users = await import('../src/users.js');
const alerts = await import('../src/alerts.js');
const { approveAndWelcome } = await import('../src/router.js');

const ch = new MockChannel();
const app = await main({ channel: ch, port: 0 });
const base = `http://127.0.0.1:${app.port}`;
test.after(async () => { await app.stop(); });
const texts = (p) => ch.sent.filter(s => s.phone === p && s.text).map(s => s.text);
const backTexts = () => texts(ADMIN).filter(t => /connected again/.test(t));
let u, api;

test('setup: an approved person who chatted, and the admin signed in with the password', async () => {
  ch.inject({ phone: P, text: 'my private question 4711' });
  u = await until(() => users.userByPhone(P));
  approveAndWelcome(u.id, 'admin');
  await until(() => texts(P).length >= 2, 5000, 'waiting + welcome');
  auth.setPassword('pass-110-abcdef', 'admin');
  api = client(base); assert.equal((await api.post('/api/login/password', { username: 'admin', password: 'pass-110-abcdef' })).status, 200);
});

test('the dashboard never shows a person\'s chat, and has no \"My chats\" door', async () => {
  const d = (await api.get('/api/users/' + u.id)).data;
  assert.equal('messages' in d, false);
  assert.equal(JSON.stringify(d).includes('4711'), false);
  const a = (await api.get('/api/activity')).data;
  assert.ok(a.outbox.length > 0); assert.ok(a.outbox.every(o => !('text' in o)), 'no text of what was sent to people');
  assert.notEqual((await api.post('/api/my-chats')).status, 200);
  assert.notEqual((await api.get('/api/u/me')).data.signed_in, true, 'the password sign-in is not a chat sign-in');
});

test('connection texts: a bad choice is refused, the choice is saved', async () => {
  assert.equal((await api.post('/api/settings', { connection_texts: 'bogus' })).status, 400);
  assert.equal((await api.post('/api/settings', { connection_texts: 'off' })).status, 200);
  assert.equal((await api.get('/api/settings')).data.settings.connection_texts, 'off');
});

test('connection texts "off": the dashboard hears it, the admin gets no text', async () => {
  alerts._resetAlertsForTest();
  const before = texts(ADMIN).length;
  ch.setState('phone_offline'); await sleep(400);
  ch.setState('connected'); await sleep(900);
  assert.equal(texts(ADMIN).length, before, 'no text at all');
  const o = (await api.get('/api/overview')).data;
  assert.ok(o.alerts.some(a => /connected again/.test(a.text)), 'still on the dashboard');
});

test('connection texts "once": a phone that goes on and off is ONE text, sent when it has stayed up', async () => {
  assert.equal((await api.post('/api/settings', { connection_texts: 'once' })).status, 200);
  alerts._resetAlertsForTest();
  const n0 = backTexts().length;
  ch.setState('phone_offline'); await sleep(400);
  for (let i = 0; i < 3; i++) { ch.setState('connected'); await sleep(100); ch.setState('phone_offline'); await sleep(250); }   // never up for 300 ms
  assert.equal(backTexts().length, n0, 'nothing while it keeps dropping');
  ch.setState('connected');
  await until(() => backTexts().length === n0 + 1, 5000, 'one text when steady');
  await sleep(700); assert.equal(backTexts().length, n0 + 1, 'and only one');
});

test('connection texts "every": the old way, a text at each return', async () => {
  assert.equal((await api.post('/api/settings', { connection_texts: 'every' })).status, 200);
  alerts._resetAlertsForTest();
  const n0 = backTexts().length;
  ch.setState('phone_offline'); await sleep(400);
  ch.setState('connected');
  await until(() => backTexts().length === n0 + 1, 5000, 'a text right away');
});
