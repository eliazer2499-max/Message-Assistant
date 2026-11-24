// 1.1.21: when a reaction can't land as a real one and the emoji goes as a tiny text instead, the
// reason used to be written ONLY to the server logs (journald) — which FLS cannot reach, since he
// cannot type in the server console. Every other failure class got a dashboard Activity line
// (media.incoming_failed cracked the voice-note case); reactions now get one too:
// audit 'reaction.as_text' with the emoji, the person, and the driver's reason.
import { setupEnv } from './helpers.js';
setupEnv('v132', {});
import test from 'node:test';
import assert from 'node:assert/strict';

test('a reaction that falls back to a text leaves its reason in the Activity log', async () => {
  const db = await import('../src/db.js'); db.openDb();
  const r = db.run("INSERT INTO users(phone, conv_id, name, status, created) VALUES('+12125550166', 'c7', 'Rea', 'approved', ?)", Date.now());
  const uid = Number(r.lastInsertRowid);
  const { MockChannel } = await import('../src/channels/mock.js');
  const mock = new MockChannel(); await mock.start();
  const outbox = await import('../src/outbox.js');
  outbox.attachChannel(mock, {});
  outbox._setReactionCooldown(0);
  mock.reactResult = { ok: false, reason: 'no react button on this page' };
  outbox.enqueueReaction({ userId: uid, emoji: '👍' });
  await outbox.drain();
  const rows = db.all("SELECT actor, detail FROM audit WHERE action='reaction.as_text'");
  assert.equal(rows.length, 1, 'exactly one Activity line for the fallback: ' + JSON.stringify(rows));
  assert.match(rows[0].detail, /👍/, 'the line names the emoji');
  assert.match(rows[0].detail, /no react button on this page/, 'the line carries the driver reason — the thing the next fix is built from');
  const sent = db.get("SELECT text, kind FROM outbox WHERE kind='reaction'");
  assert.equal(sent.text, '👍', 'the emoji still went as a text — the fallback itself is unchanged');
});

test('a reaction that lands as a real one leaves NO Activity line', async () => {
  const db = await import('../src/db.js');
  const r = db.run("INSERT INTO users(phone, conv_id, name, status, created) VALUES('+12125550165', 'c6', 'Reb', 'approved', ?)", Date.now());
  const uid = Number(r.lastInsertRowid);
  const { MockChannel } = await import('../src/channels/mock.js');
  const mock = new MockChannel(); await mock.start();
  const outbox = await import('../src/outbox.js');
  outbox.attachChannel(mock, {});
  outbox._setReactionCooldown(0);
  mock.reactResult = { ok: true, convId: 'c6' };
  const before = db.all("SELECT id FROM audit WHERE action='reaction.as_text'").length;
  outbox.enqueueReaction({ userId: uid, emoji: '🎵' });
  await outbox.drain();
  const after = db.all("SELECT id FROM audit WHERE action='reaction.as_text'").length;
  assert.equal(after, before, 'a landed reaction is silent in the Activity log');
});
