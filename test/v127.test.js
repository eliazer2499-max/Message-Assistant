// 1.1.15: the 👍👍👍 bug (FLS: "I'm getting a lot of reaction thumbs up messages… one, two, three").
// A reaction that can't land as a real one goes out as a lone-emoji text; Google shows a lone emoji
// without a readable text bubble, so the confirm check judged it "missing" and the outbox re-sent it
// (up to 6 tries). Reaction texts are now fire-and-forget (kind 'reaction': dropped on first failure,
// never re-sent, never alerted), and reactions are capped at one per person per 10 minutes.
import { setupEnv } from './helpers.js';
setupEnv('v127', {});
import test from 'node:test';
import assert from 'node:assert/strict';

test('an unconfirmable emoji reaction text is typed ONCE, never resent', async () => {
  const db = await import('../src/db.js'); db.openDb();
  const r = db.run("INSERT INTO users(phone, conv_id, name, status, created) VALUES('+12125550199', 'c9', 'T', 'approved', ?)", Date.now());
  const uid = Number(r.lastInsertRowid);
  const { MockChannel } = await import('../src/channels/mock.js');
  const mock = new MockChannel(); await mock.start();
  let attempts = 0; const realSend = mock.send.bind(mock); mock.send = async (a) => { attempts++; return realSend(a); };
  const outbox = await import('../src/outbox.js');
  outbox.attachChannel(mock, {});
  outbox._setReactionCooldown(0);
  mock.reactResult = { ok: false, reason: 'SMS chat — no reactions there' };
  mock.unconfirmNext = 1;              // the emoji text leaves the box but is never shown as sent
  mock.confirmAs = 'missing';          // …and looking at the chat can't find it (lone emoji, no text bubble)
  outbox.enqueueReaction({ userId: uid, emoji: '👍' });
  await outbox.drain();                // reaction → fallback text → unconfirmed
  db.run("UPDATE outbox SET check_at=0 WHERE status='unconfirmed'");
  await outbox.drain();                // the check says "missing" — before 1.1.15 this re-sent it, up to 6 times
  await outbox.drain();
  assert.equal(attempts, 1, 'the emoji text was typed exactly once, attempts=' + attempts);
  const row = db.get("SELECT status FROM outbox WHERE kind='reaction'");
  assert.equal(row.status, 'failed', 'the reaction row was dropped, not re-queued: ' + JSON.stringify(row));
});

test('reactions are capped: one per person per cooldown window', async () => {
  const db = await import('../src/db.js');
  const r2 = db.run("INSERT INTO users(phone, conv_id, name, status, created) VALUES('+12125550198', 'c8', 'T2', 'approved', ?)", Date.now());
  const uid = Number(r2.lastInsertRowid);
  const { MockChannel } = await import('../src/channels/mock.js');
  const mock = new MockChannel(); await mock.start();
  const outbox = await import('../src/outbox.js');
  outbox.attachChannel(mock, {});
  outbox._setReactionCooldown(600000);
  mock.reactResult = { ok: true, convId: 'c8' };
  outbox.enqueueReaction({ userId: uid, emoji: '🔍' });
  outbox.enqueueReaction({ userId: uid, emoji: '🎵' });
  outbox.enqueueReaction({ userId: uid, emoji: '⏰' });
  await outbox.drain();
  assert.equal((mock.reactions || []).length, 1, 'only the first reaction went out: ' + JSON.stringify(mock.reactions));
  outbox._setReactionCooldown(0);
  outbox.enqueueReaction({ userId: uid, emoji: '⏰' });
  await outbox.drain();
  assert.equal((mock.reactions || []).length, 2, 'after the window, reactions flow again');
});
