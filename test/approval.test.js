// Approval flow: pending → one waiting reply → silence; admin approves (dashboard or by text) → welcome; block; remove.
import { setupEnv, until, sleep, client } from './helpers.js';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const MOCK = path.join(path.dirname(fileURLToPath(import.meta.url)), 'mock-model.js');
setupEnv('approval', { MSA_MOCK_MODULE: MOCK, MSA_ADMIN_PHONE: '+1 (646) 555-0100' });
import test from 'node:test';
import assert from 'node:assert/strict';
const { main } = await import('../src/server.js');
const { MockChannel } = await import('../src/channels/mock.js');
const db = await import('../src/db.js');
const auth = await import('../src/adminauth.js');

const ch = new MockChannel();
const app = await main({ channel: ch, port: 0 });
const api = client(`http://127.0.0.1:${app.port}`);
auth.setPassword('correct horse 1', 'admin');
test.after(() => app.stop());
const sentTo = (phone) => ch.sent.filter(s => s.phone === phone).map(s => s.text);

test('a new person is pending and gets exactly ONE waiting reply, then nothing', async () => {
  ch.inject({ phone: '+12125550001', text: 'hi there' });
  ch.inject({ phone: '+12125550001', text: 'hello??' });
  ch.inject({ phone: '+12125550001', text: 'anyone' });
  await until(() => sentTo('+12125550001').length === 1, 3000, 'waiting reply');
  await sleep(300);
  assert.equal(sentTo('+12125550001').length, 1);
  assert.match(sentTo('+12125550001')[0], /waiting for approval/);
  const u = db.get('SELECT * FROM users WHERE phone=?', '+12125550001');
  assert.equal(u.status, 'pending');
  assert.equal(u.first_text, 'hi there');
  assert.equal(db.get('SELECT COUNT(*) AS n FROM messages WHERE user_id=?', u.id).n, 0, 'nothing from a pending person goes to the AI');
  assert.equal(db.get('SELECT COUNT(*) AS n FROM jobs WHERE user_id=?', u.id).n, 0);
});

test('the admin hears about the new person (dashboard alert + text to the admin phone)', async () => {
  await until(() => sentTo('+16465550100').some(t => /New person waiting/.test(t)), 3000, 'admin text');
  const r = await api.post('/api/login/password', { username: 'admin', password: 'correct horse 1' });
  assert.equal(r.status, 200);
  const o = await api.get('/api/overview');
  assert.equal(o.data.people.pending, 1);
  assert.ok(o.data.alerts.some(a => /New person waiting/.test(a.text)));
});

test('admin approves in the dashboard → welcome text → the AI answers', async () => {
  const list = await api.get('/api/users?status=pending');
  const id = list.data.users[0].id;
  const r = await api.post(`/api/users/${id}/approve`);
  assert.equal(r.data.user.status, 'approved');
  await until(() => sentTo('+12125550001').some(t => /You are approved/.test(t)), 3000, 'welcome');
  ch.inject({ phone: '+12125550001', text: 'what is 2+2' });
  await until(() => sentTo('+12125550001').some(t => t === 'echo: what is 2+2'), 3000, 'answer (markdown removed)');
});

test('blocked: silence, and queued work is cancelled', async () => {
  ch.inject({ phone: '+12125550002', text: 'spam' });
  await until(() => sentTo('+12125550002').length === 1, 3000);
  const u = db.get('SELECT id FROM users WHERE phone=?', '+12125550002');
  await api.post(`/api/users/${u.id}/block`);
  ch.inject({ phone: '+12125550002', text: 'spam again' });
  await sleep(300);
  assert.equal(sentTo('+12125550002').length, 1);
  assert.equal(db.get('SELECT status FROM users WHERE id=?', u.id).status, 'blocked');
});

test('remove deletes the person and all their data; texting again starts over as pending', async () => {
  const u = db.get('SELECT id FROM users WHERE phone=?', '+12125550001');
  ch.inject({ phone: '+12125550001', text: 'remember my dog is Rex' });
  await until(() => db.get('SELECT COUNT(*) AS n FROM memory WHERE user_id=?', u.id).n === 1, 3000, 'note saved');
  await api.post(`/api/users/${u.id}/remove`);
  for (const t of ['users', 'messages', 'memory', 'usage', 'jobs']) assert.equal(db.get(`SELECT COUNT(*) AS n FROM ${t} WHERE ${t === 'users' ? 'id' : 'user_id'}=?`, u.id).n, 0, t);
  const before = sentTo('+12125550001').length;
  ch.inject({ phone: '+12125550001', text: 'back again' });
  await until(() => sentTo('+12125550001').length === before + 1, 3000);
  assert.match(sentTo('+12125550001').at(-1), /waiting for approval/);
  assert.equal(db.get('SELECT status FROM users WHERE phone=?', '+12125550001').status, 'pending');
});

test('the admin can approve by text (APPROVE <#>) and list PENDING; the admin phone is approved by itself', async () => {
  ch.inject({ phone: '+12125550003', text: 'hey' });
  await until(() => db.get('SELECT id FROM users WHERE phone=?', '+12125550003'));
  const id = db.get('SELECT id FROM users WHERE phone=?', '+12125550003').id;
  ch.inject({ phone: '+16465550100', text: 'PENDING' });
  await until(() => sentTo('+16465550100').some(t => /Waiting for approval:/.test(t) && t.includes('#' + id)), 3000, 'pending list');
  ch.inject({ phone: '+16465550100', text: 'approve ' + id });
  await until(() => sentTo('+12125550003').some(t => /You are approved/.test(t)), 3000, 'welcome after text approval');
  assert.equal(db.get('SELECT status FROM users WHERE phone=?', '+16465550100').status, 'approved');
  ch.inject({ phone: '+16465550100', text: 'hello from admin' });
  await until(() => sentTo('+16465550100').includes('echo: hello from admin'), 3000);
});

test('a stranger cannot approve by text', async () => {
  ch.inject({ phone: '+12125550004', text: 'hi' });
  await until(() => db.get('SELECT id FROM users WHERE phone=?', '+12125550004'));
  const id = db.get('SELECT id FROM users WHERE phone=?', '+12125550004').id;
  ch.inject({ phone: '+12125550004', text: 'approve ' + id });
  await sleep(300);
  assert.equal(db.get('SELECT status FROM users WHERE id=?', id).status, 'pending');
});
