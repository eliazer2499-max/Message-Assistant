// 1.1.15: the 👍👍👍 bug (FLS: "I'm getting a lot of reaction thumbs up messages… one, two, three").
// A reaction that couldn't land went out as a lone-emoji text; Google shows a lone emoji without a
// readable text bubble, so the confirm check judged it "missing" and the outbox re-sent it (up to 6
// tries) — fixed then by making reaction texts fire-and-forget and rationing reactions to one per
// person per 10 minutes. 1.1.22: FLS reversed both policies — "react to messages, not send a
// reaction" and "react more often". A reaction that can't land now sends NO text at all (it is
// dropped quietly, leaving only the Activity line), and the 10-minute rationing is gone; the only
// queue rule left is that a person's newest PENDING reaction replaces an unsent older one.
import { setupEnv } from './helpers.js';
setupEnv('v127', {});
import test from 'node:test';
import assert from 'node:assert/strict';

test('a reaction that cannot land sends NO text — it is dropped quietly, with the reason in Activity', async () => {
  const db = await import('../src/db.js'); db.openDb();
  const r = db.run("INSERT INTO users(phone, conv_id, name, status, created) VALUES('+12125550199', 'c9', 'T', 'approved', ?)", Date.now());
  const uid = Number(r.lastInsertRowid);
  const { MockChannel } = await import('../src/channels/mock.js');
  const mock = new MockChannel(); await mock.start();
  let sendAttempts = 0; const realSend = mock.send.bind(mock); mock.send = async (a) => { sendAttempts++; return realSend(a); };
  const outbox = await import('../src/outbox.js');
  outbox.attachChannel(mock, {});
  mock.reactResult = { ok: false, reason: 'SMS chat — no reactions there' };
  outbox.enqueueReaction({ userId: uid, emoji: '👍' });
  await outbox.drain();
  await outbox.drain();
  assert.equal((mock.reactions || []).length, 1, 'the real reaction was attempted once');
  assert.equal(sendAttempts, 0, 'no text was typed for the missed reaction — not once, not ever');
  assert.equal(db.get("SELECT COUNT(*) AS n FROM outbox WHERE kind='reaction'").n, 0, 'no reaction text exists in the outbox');
  const rows = db.all("SELECT detail FROM audit WHERE action='reaction.not_landed'");
  assert.equal(rows.length, 1, 'the miss left exactly one Activity line');
  assert.match(rows[0].detail, /SMS chat/, 'the line carries the reason');
});

test('reactions are not rationed: consecutive messages each get one; a pending one is replaced by the newest', async () => {
  const db = await import('../src/db.js');
  const r2 = db.run("INSERT INTO users(phone, conv_id, name, status, created) VALUES('+12125550198', 'c8', 'T2', 'approved', ?)", Date.now());
  const uid = Number(r2.lastInsertRowid);
  const { MockChannel } = await import('../src/channels/mock.js');
  const mock = new MockChannel(); await mock.start();
  const outbox = await import('../src/outbox.js');
  outbox.attachChannel(mock, {});
  mock.reactResult = { ok: true, convId: 'c8' };
  outbox.enqueueReaction({ userId: uid, emoji: '🔍' });
  await outbox.drain();
  assert.equal((mock.reactions || []).length, 1, 'the first reaction went out');
  outbox.enqueueReaction({ userId: uid, emoji: '🎵' });
  await outbox.drain();
  assert.equal((mock.reactions || []).length, 2, 'the very next message gets its reaction too — no 10-minute window');
  outbox.enqueueReaction({ userId: uid, emoji: '⏰' });
  outbox.enqueueReaction({ userId: uid, emoji: '❤️' });
  await outbox.drain();
  assert.equal((mock.reactions || []).length, 3, 'of two queued back-to-back, only the newest goes out');
  assert.equal(mock.reactions[2].emoji, '❤️', 'the newest pending reaction replaced the older one');
});
