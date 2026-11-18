// 1.1.7: never silence. (a) A picture / voice note that cannot be sent gets 3 tries (not 6), and when it
// finally fails the person is TOLD in plain words — a missing file with no word reads as "the assistant is
// ignoring me". (b) One attach attempt is capped (~90 s): the Messages page is shared by everyone, and a
// hopeless attach must not sit on it while other people's messages wait behind it.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setupEnv, sleep } from './helpers.js';
const DIR = setupEnv('v118', { MSA_ADMIN_PHONE: '+16465550100' });
import test from 'node:test';
import assert from 'node:assert/strict';
const db = await import('../src/db.js');
db.openDb();
const users = await import('../src/users.js');
const outbox = await import('../src/outbox.js');
const { MockChannel } = await import('../src/channels/mock.js');
const { GoogleMessagesWeb } = await import('../src/channels/gmweb.js');
const u = users.arrive({ phone: '+16465550196', name: 'Yossi', text: 'hi' }).user;

test('a file that cannot be sent: 3 tries, then the person is told in words', async () => {
  const ch = new MockChannel(); await ch.start();
  outbox.attachChannel(ch);
  db.run('UPDATE users SET conv_id=? WHERE id=?', ch.convFor(u.phone), u.id);
  ch.failNext = 3;                                   // exactly the media item's 3 tries; the note itself can go out
  const id = outbox.enqueueText({ userId: u.id, text: '', media: '/tmp/pic.png', mediaUrl: 'https://msg.example.com/m/t/p.png', kind: 'reply' });
  for (let i = 0; i < 60; i++) { await outbox.drain(); await sleep(30); const r = db.get('SELECT status, tries FROM outbox WHERE id=?', id); if (r.status === 'failed') break; }
  const row = db.get('SELECT status, tries FROM outbox WHERE id=?', id);
  assert.equal(row.status, 'failed');
  assert.equal(row.tries, 3, 'media gets 3 tries, not 6');
  for (let i = 0; i < 40; i++) { await outbox.drain(); await sleep(20); if (ch.sent.some(s => /would not go through/.test(s.text || ''))) break; }
  const note = ch.sent.find(s => /would not go through/.test(s.text || ''));
  assert.ok(note, 'the person was told the file did not go through: ' + JSON.stringify(ch.sent));
  assert.ok(!ch.sent.some(s => /example\.com/.test(s.text || '')), 'still never a link');
  outbox.attachChannel(null);
});

test('one attach attempt is capped: a page that stages nothing gives up at the deadline, naming it', async () => {
  const d = new GoogleMessagesWeb({ dataDir: DIR, isSeen: () => true, markSeen: () => {}, needsBaseline: () => false, baselineDone: () => {}, attachDeadlineMs: 50 });
  const loc = { first: () => loc, count: async () => 0, click: async () => {}, press: async () => {} };
  d.page = { locator: () => loc, evaluate: async () => false, waitForEvent: async () => { throw new Error('timeout'); }, keyboard: { press: async () => {} } };
  d.snap = async () => ({ msgs: [] });
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'msa-118-')), 'pic.png');
  fs.writeFileSync(f, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64'));
  const t0 = Date.now();
  await assert.rejects(() => d.attachAndSend(f), /out of time/);
  assert.ok(Date.now() - t0 < 20000, 'it gave up promptly instead of sitting on the page for minutes');
});
