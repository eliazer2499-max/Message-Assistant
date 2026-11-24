// 1.1.21: when a reaction couldn't land as a real one and the emoji went as a tiny text instead, the
// reason used to be written ONLY to the server logs (journald) — which FLS cannot reach, since he
// cannot type in the server console. 1.1.21 put it in the dashboard Activity log ('reaction.as_text').
// 1.1.22: the text fallback itself is gone (FLS: "react to messages, not send a reaction"), so the
// line is renamed 'reaction.not_landed' — it is now the ONLY trace of a missed reaction, and it
// names the step that failed (SMS chat / no react button / emoji not in the picker / did not land).
import { setupEnv } from './helpers.js';
setupEnv('v132', {});
import test from 'node:test';
import assert from 'node:assert/strict';

test('a reaction that does not land leaves its reason in the Activity log — and sends no text', async () => {
  const db = await import('../src/db.js'); db.openDb();
  const r = db.run("INSERT INTO users(phone, conv_id, name, status, created) VALUES('+12125550166', 'c7', 'Rea', 'approved', ?)", Date.now());
  const uid = Number(r.lastInsertRowid);
  const { MockChannel } = await import('../src/channels/mock.js');
  const mock = new MockChannel(); await mock.start();
  const outbox = await import('../src/outbox.js');
  outbox.attachChannel(mock, {});
  mock.reactResult = { ok: false, reason: 'no react button on this page' };
  outbox.enqueueReaction({ userId: uid, emoji: '👍' });
  await outbox.drain();
  const rows = db.all("SELECT actor, detail FROM audit WHERE action='reaction.not_landed'");
  assert.equal(rows.length, 1, 'exactly one Activity line for the miss: ' + JSON.stringify(rows));
  assert.match(rows[0].detail, /👍/, 'the line names the emoji');
  assert.match(rows[0].detail, /no react button on this page/, 'the line carries the driver reason — the thing the landing fix is built from');
  assert.equal(db.get("SELECT COUNT(*) AS n FROM outbox WHERE kind='reaction'").n, 0, 'no reaction text was queued — the fallback is gone');
});

test('a reaction that lands as a real one leaves NO Activity line', async () => {
  const db = await import('../src/db.js');
  const r = db.run("INSERT INTO users(phone, conv_id, name, status, created) VALUES('+12125550165', 'c6', 'Reb', 'approved', ?)", Date.now());
  const uid = Number(r.lastInsertRowid);
  const { MockChannel } = await import('../src/channels/mock.js');
  const mock = new MockChannel(); await mock.start();
  const outbox = await import('../src/outbox.js');
  outbox.attachChannel(mock, {});
  mock.reactResult = { ok: true, convId: 'c6' };
  const before = db.all("SELECT id FROM audit WHERE action='reaction.not_landed'").length;
  outbox.enqueueReaction({ userId: uid, emoji: '🎵' });
  await outbox.drain();
  const after = db.all("SELECT id FROM audit WHERE action='reaction.not_landed'").length;
  assert.equal(after, before, 'a landed reaction is silent in the Activity log');
});
