// Message routing with the mocked Google Messages adapter: duplicates, commands, daily limit, reminders,
// texts waiting while Messages is down, the admin alert when it drops, retries.
import { setupEnv, until, sleep, client } from './helpers.js';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const MOCK = path.join(path.dirname(fileURLToPath(import.meta.url)), 'mock-model.js');
setupEnv('route', { MSA_MOCK_MODULE: MOCK, MSA_ADMIN_PHONE: '+16465550100' });
import test from 'node:test';
import assert from 'node:assert/strict';
const { main } = await import('../src/server.js');
const { MockChannel } = await import('../src/channels/mock.js');
const db = await import('../src/db.js');
const auth = await import('../src/adminauth.js');
const { approveAndWelcome } = await import('../src/router.js');
const users = await import('../src/users.js');
const { tick } = await import('../src/scheduler.js');

const ch = new MockChannel();
const app = await main({ channel: ch, port: 0 });
const api = client(`http://127.0.0.1:${app.port}`);
auth.setPassword('route-pass-123', 'admin');
await api.post('/api/login/password', { username: 'admin', password: 'route-pass-123' });
test.after(() => app.stop());
const P = '+17185550001';
const said = () => ch.sent.filter(s => s.phone === P).map(s => s.text);
let u;

test('setup: one approved person', async () => {
  ch.inject({ phone: '(718) 555-0001', text: 'hi' });
  u = await until(() => users.userByPhone(P));
  assert.equal(u.phone, P, 'numbers are stored in one form');
  approveAndWelcome(u.id);
  await until(() => said().length === 2);
});

test('the same message delivered twice is answered once', async () => {
  ch.inject({ phone: P, text: 'only once', extId: 'gm:dup-1' });
  ch.inject({ phone: P, text: 'only once', extId: 'gm:dup-1' });
  await until(() => said().includes('echo: only once'));
  await sleep(250);
  assert.equal(said().filter(t => t === 'echo: only once').length, 1);
});

test('commands: HELP, STOP / START, RESET, NOTES, forget <n>', async () => {
  ch.inject({ phone: P, text: 'help' });
  await until(() => said().some(t => /tips:/.test(t)));
  ch.inject({ phone: P, text: 'STOP' });
  await until(() => said().some(t => /^Paused/.test(t)));
  const n = said().length;
  ch.inject({ phone: P, text: 'are you there' });
  await sleep(250);
  assert.equal(said().length, n, 'paused: no answer');
  ch.inject({ phone: P, text: 'start' });
  await until(() => said().some(t => /I'm back on/.test(t)));
  ch.inject({ phone: P, text: 'remember I like tea' });
  await until(() => said().some(t => /done memory_save/.test(t)));
  ch.inject({ phone: P, text: 'NOTES' });
  await until(() => said().some(t => /What I remember about you:\n\d+\. I like tea/.test(t)));
  const id = db.get('SELECT id FROM memory WHERE user_id=?', u.id).id;
  ch.inject({ phone: P, text: 'forget ' + id });
  await until(() => said().includes('Deleted that note.'));
  ch.inject({ phone: P, text: 'RESET' });
  await until(() => said().some(t => /^Fresh start/.test(t)));
  assert.equal(db.get('SELECT COUNT(*) AS n FROM messages WHERE user_id=?', u.id).n, 0);
});

test('daily limit: one notice, then quiet until tomorrow', async () => {
  db.run('UPDATE usage SET messages=0 WHERE user_id=?', u.id);
  await api.post(`/api/users/${u.id}`, { daily_limit: 2 });
  for (const t of ['one', 'two', 'three', 'four']) { ch.inject({ phone: P, text: 'msg ' + t }); await sleep(80); }
  await until(() => said().some(t => /today's limit of 2/.test(t)));
  await sleep(300);
  assert.equal(said().filter(t => /today's limit/.test(t)).length, 1);
  assert.ok(!said().includes('echo: msg four'));
  await api.post(`/api/users/${u.id}`, { daily_limit: '' });
  db.run('UPDATE usage SET messages=0 WHERE user_id=?', u.id);
});

test('reminders fire as texts, repeating ones move to the next time', async () => {
  db.run('INSERT INTO reminders(user_id, text, due, every_minutes, active, created) VALUES(?,?,?,?,1,?)', u.id, 'drink water', Date.now() - 1000, 60, Date.now());
  await tick();
  await until(() => said().includes('⏰ Reminder: drink water'));
  const r = db.get('SELECT * FROM reminders WHERE user_id=? AND text=?', u.id, 'drink water');
  assert.equal(r.active, 1); assert.ok(r.due > Date.now() + 50 * 60000);
});

test('Messages drops: texts wait (nothing lost), the admin gets an alert, then everything goes out', async () => {
  ch.setState('phone_offline', 'the phone is not reachable');
  ch.inject({ phone: P, text: 'while offline' });
  await sleep(400);
  assert.ok(!said().includes('echo: while offline'));
  assert.equal(db.get("SELECT COUNT(*) AS n FROM outbox WHERE status='queued' AND user_id=?", u.id).n, 1);
  const o = await api.get('/api/overview');
  assert.ok(o.data.alerts.some(a => /not connected: Phone not reachable/.test(a.text)), JSON.stringify(o.data.alerts));
  assert.equal(o.data.messages.state, 'phone_offline');
  ch.setState('connected');
  await until(() => said().includes('echo: while offline'));
  await until(async () => (await api.get('/api/overview')).data.alerts.some(a => /connected again/.test(a.text)));
});

test('a failed send is tried again (up to 3 times)', async () => {
  ch.failNext = 2;
  ch.inject({ phone: P, text: 'retry me' });
  await until(() => said().includes('echo: retry me'), 15000, 'sent on the 3rd try');
  const row = db.get("SELECT * FROM outbox WHERE text='echo: retry me'");
  assert.equal(row.status, 'sent'); assert.equal(row.tries, 3);
});

test('a contact name instead of a number still works (keyed by its chat)', async () => {
  ch.inject({ phone: 'Mom', name: 'Mom', convId: 'c-mom', text: 'hello' });
  const m = await until(() => db.get("SELECT * FROM users WHERE conv_id='c-mom'"));
  assert.equal(m.phone, 'conv:c-mom'); assert.equal(m.status, 'pending');
  await until(() => ch.sent.some(s => s.convId === 'c-mom' && /waiting for approval/.test(s.text)));
});
