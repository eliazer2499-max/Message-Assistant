// Per-user isolation: notes, history, reminders, settings, usage and browser cookies belong to one person only.
import { setupEnv, until, sleep, client } from './helpers.js';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
const MOCK = path.join(path.dirname(fileURLToPath(import.meta.url)), 'mock-model.js');
const DIR = setupEnv('iso', { MSA_MOCK_MODULE: MOCK });
import test from 'node:test';
import assert from 'node:assert/strict';
const { main } = await import('../src/server.js');
const { MockChannel } = await import('../src/channels/mock.js');
const db = await import('../src/db.js');
const auth = await import('../src/adminauth.js');
const { approveAndWelcome } = await import('../src/router.js');
const { execTool } = await import('../src/tools/index.js');
const { systemPrompt } = await import('../src/agent.js');
const users = await import('../src/users.js');
const B = await import('../src/browser.js');
const mock = await import(MOCK);

const ch = new MockChannel();
const app = await main({ channel: ch, port: 0 });
const api = client(`http://127.0.0.1:${app.port}`);
auth.setPassword('iso-pass-1234', 'admin');
await api.post('/api/login/password', { username: 'admin', password: 'iso-pass-1234' });
test.after(() => app.stop());
const A = '+13105550001', Bp = '+13105550002';
const said = (p) => ch.sent.filter(s => s.phone === p).map(s => s.text);
let ua, ub;

test('two approved people', async () => {
  for (const p of [A, Bp]) ch.inject({ phone: p, text: 'hi' });
  ua = await until(() => users.userByPhone(A)); ub = await until(() => users.userByPhone(Bp));
  approveAndWelcome(ua.id); approveAndWelcome(ub.id);
  await until(() => said(A).length === 2 && said(Bp).length === 2);
});

test('notes: A\'s secret is never seen by B (tools, prompt, NOTES command, dashboard)', async () => {
  ch.inject({ phone: A, text: 'remember my code word is BLUEBIRD' });
  await until(() => said(A).some(t => /done memory_save/.test(t)));
  ch.inject({ phone: Bp, text: 'what do you remember' });
  await until(() => said(Bp).some(t => /done memory_recall/.test(t)));
  assert.ok(!said(Bp).join('\n').includes('BLUEBIRD'));
  assert.ok(systemPrompt(users.userById(ua.id)).includes('BLUEBIRD'));
  assert.ok(!systemPrompt(users.userById(ub.id)).includes('BLUEBIRD'));
  const bCalls = mock.calls.filter(c => c.items.some(i => i.role === 'user' && /what do you remember/.test(i.text)));
  assert.ok(bCalls.length && bCalls.every(c => !JSON.stringify(c).includes('BLUEBIRD')), 'B\'s model input never carries A\'s note or A\'s words');
  ch.inject({ phone: Bp, text: 'NOTES' });
  await until(() => said(Bp).some(t => /no notes about you/.test(t)));
  const noteId = db.get('SELECT id FROM memory WHERE user_id=?', ua.id).id;
  const r = await execTool('memory_forget', { id: noteId }, { userId: ub.id });
  assert.equal(r.deleted, 0, 'B cannot delete A\'s note even with its id');
  assert.equal(db.get('SELECT COUNT(*) AS n FROM memory WHERE user_id=?', ua.id).n, 1);
  const detail = await api.get(`/api/users/${ub.id}`);
  assert.equal(detail.data.notes.length, 0);
  assert.ok(!JSON.stringify(detail.data).includes('BLUEBIRD'));
});

test('history: each person\'s AI input holds only their own conversation', async () => {
  ch.inject({ phone: A, text: 'my flight is UA 123' });
  await until(() => said(A).some(t => t === 'echo: my flight is UA 123'));
  ch.inject({ phone: Bp, text: 'hello again' });
  await until(() => said(Bp).some(t => t === 'echo: hello again'));
  const last = mock.calls.filter(c => c.items.at(-1).text === 'hello again').at(-1);
  assert.ok(last);
  assert.ok(!JSON.stringify(last.items).includes('UA 123'));
  assert.ok(!JSON.stringify(last.items).includes('BLUEBIRD'));
});

test('reminders: B can\'t see or cancel A\'s reminder', async () => {
  ch.inject({ phone: A, text: 'remind me to call the dentist' });
  await until(() => said(A).some(t => /done reminder_add/.test(t)));
  const rid = db.get('SELECT id FROM reminders WHERE user_id=?', ua.id).id;
  ch.inject({ phone: Bp, text: 'cancel reminder ' + rid });
  await until(() => said(Bp).some(t => /done reminder_cancel/.test(t)));
  assert.ok(said(Bp).some(t => /"cancelled":0/.test(t)));
  assert.equal(db.get('SELECT active FROM reminders WHERE id=?', rid).active, 1);
  const listB = await execTool('reminder_list', {}, { userId: ub.id });
  assert.equal(listB.reminders.length, 0);
});

test('settings and usage are per person', async () => {
  await execTool('my_settings', { name: 'Avi', timezone: 'Asia/Jerusalem' }, { userId: ua.id });
  assert.equal(users.userSettings(ua.id).timezone, 'Asia/Jerusalem');
  assert.deepEqual(users.userSettings(ub.id), {});
  assert.match(systemPrompt(users.userById(ua.id)), /Their name: Avi/);
  assert.doesNotMatch(systemPrompt(users.userById(ub.id)), /Avi/);
  const ta = users.usageOf(ua.id), tb = users.usageOf(ub.id);
  assert.equal(ta.messages, 3); assert.equal(tb.messages, 3);
});

test('browser: each person gets their own browser context and cookie file', async () => {
  const made = [];
  const fakePage = (n) => ({ isClosed: () => false, setDefaultTimeout() {}, url: () => 'about:blank' });
  B.setDriver({ chromium: { launch: async () => ({ isConnected: () => true, on() {}, close: async () => {},
    newContext: async (opts) => { const c = { opts, routes: [], route: async (re) => c.routes.push(String(re)), newPage: async () => fakePage(), storageState: async ({ path: p }) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, '{"cookies":[]}'); }, close: async () => {} }; made.push(c); return c; } }) } });
  const pa = await B.userPage(ua.id), pb = await B.userPage(ub.id);
  assert.notEqual(pa, pb);
  assert.equal(made.length, 2);
  await B.closeUser(ua.id); await B.closeUser(ub.id);
  assert.ok(fs.existsSync(path.join(DIR, 'browser-users', String(ua.id), 'state.json')));
  assert.ok(fs.existsSync(path.join(DIR, 'browser-users', String(ub.id), 'state.json')));
  await B.userPage(ua.id);
  assert.equal(made[2].opts.storageState, path.join(DIR, 'browser-users', String(ua.id), 'state.json'), 'A gets A\'s cookies back, never B\'s');
  assert.ok(made[0].routes.length, 'private addresses are blocked inside the browser');
  await B.closeUser(ua.id);
  B.forgetUser(ub.id);
  assert.ok(!fs.existsSync(path.join(DIR, 'browser-users', String(ub.id))));
});
