// 1.0.7 + typing-box fix: the outbox never calls a text "sent" until Google Messages shows it; it checks again later and never types it twice.
import { setupEnv, until, sleep } from './helpers.js';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const MOCK = path.join(path.dirname(fileURLToPath(import.meta.url)), 'mock-model.js');
setupEnv('outbox107', { MSA_MOCK_MODULE: MOCK, MSA_ADMIN_PHONE: '+16465550100' });
import test from 'node:test';
import assert from 'node:assert/strict';
const { main } = await import('../src/server.js');
const { MockChannel } = await import('../src/channels/mock.js');
const db = await import('../src/db.js');
const ob = await import('../src/outbox.js');
const users = await import('../src/users.js');
const { approveAndWelcome } = await import('../src/router.js');
ob._setCheckScale(0.01);          // checks after 0.15 s, 0.3 s, ... instead of 15 s, 30 s, ...

const ch = new MockChannel();
const app = await main({ channel: ch, port: 0 });
test.after(() => app.stop());
const P = '+17185550007';
const typed = (t) => ch.sent.filter(s => s.text === t).length;
let u;
test('setup', async () => {
  ch.inject({ phone: P, text: 'hi' });
  u = await until(() => users.userByPhone(P));
  approveAndWelcome(u.id, 'admin');
  await until(() => ch.sent.some(s => s.phone === P));
});

test('left the box but not shown as sent: waits as "unconfirmed", then confirmed by a later look (typed once)', async () => {
  ch.unconfirmNext = 1; ch.checks = 0; ch.confirmAs = (n) => (n < 2 ? 'pending' : 'sent');
  const id = ob.enqueueText({ userId: u.id, text: 'slow phone text', kind: 'notice' });
  await until(() => db.get('SELECT status FROM outbox WHERE id=?', id).status === 'unconfirmed', 5000, 'unconfirmed');
  assert.ok(ob.pending() >= 1, 'counted as waiting on the dashboard');
  await until(() => db.get('SELECT status FROM outbox WHERE id=?', id).status === 'sent', 10000, 'confirmed later');
  const row = db.get('SELECT * FROM outbox WHERE id=?', id);
  assert.equal(row.tries, 1, 'not typed a second time'); assert.ok(row.checks >= 1);
  assert.equal(ch.pendingTexts.filter(t => t === 'slow phone text').length, 1);
});

test('not in the chat at all on the later look: sent again (counts as a try)', async () => {
  ch.unconfirmNext = 1; ch.checks = 0; ch.confirmAs = 'missing';
  const id = ob.enqueueText({ userId: u.id, text: 'lost text', kind: 'notice' });
  await until(() => db.get('SELECT status FROM outbox WHERE id=?', id).status === 'sent', 10000, 'resent');
  assert.equal(db.get('SELECT tries FROM outbox WHERE id=?', id).tries, 2); assert.equal(typed('lost text'), 1);
});

test('still "sending" after every look: failed and reported, never marked sent', async () => {
  ch.unconfirmNext = 1; ch.checks = 0; ch.confirmAs = 'pending';
  const id = ob.enqueueText({ userId: u.id, text: 'never leaves', kind: 'notice' });
  await until(() => db.get('SELECT status FROM outbox WHERE id=?', id).status === 'failed', 30000, 'gave up');
  const row = db.get('SELECT * FROM outbox WHERE id=?', id);
  assert.match(row.error, /still "sending"/); assert.equal(row.checks, ob.CHECK_AFTER_MS.length);
  assert.ok(db.get("SELECT COUNT(*) AS n FROM audit WHERE action='outbox.failed' AND detail LIKE ?", `#${id} %`).n === 1);
  assert.equal(typed('never leaves'), 0);
});
