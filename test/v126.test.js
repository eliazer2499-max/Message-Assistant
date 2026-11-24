// 1.1.14: reactions on ANY message (FLS's choice). RCS chats get the real reaction, VERIFIED on the page;
// an SMS chat (its composer says "Text message") — or any chat where the reaction cannot land — got the
// emoji as a tiny text instead (FLS's 1.1.14 choice, reversed in 1.1.22: a missed reaction now sends
// nothing at all). Plus the brain guard: a question never takes the one-call fast path (plainChat),
// which could only guess at "who won the game".
import { setupEnv, until } from './helpers.js';
import fs from 'node:fs';
import { fakeMessages } from './fake-gm.js';
const { st, fake } = fakeMessages();
const canRun = process.env.MSA_PLAYWRIGHT_PATH && process.env.MSA_CHROMIUM && fs.existsSync(process.env.MSA_CHROMIUM);
await new Promise(r => fake.listen(0, '127.0.0.1', r));
const dataDir = setupEnv('v126', { MSA_CHANNEL: 'web', MSA_GM_URL: `http://127.0.0.1:${fake.address().port}/web`, MSA_POLL_MS: '300', MSA_HEALTH_MS: '500' });
import test from 'node:test';
import assert from 'node:assert/strict';
test.after(() => { fake.close(); fake.closeAllConnections?.(); });

test('outbox: a reaction that cannot land sends nothing at all; a landed one sends nothing either', async () => {
  const db = await import('../src/db.js'); db.openDb();
  const r = db.run("INSERT INTO users(phone, conv_id, name, status, created) VALUES('+12125550101', 'c1', 'Test', 'approved', ?)", Date.now());
  const uid = Number(r.lastInsertRowid);
  const { MockChannel } = await import('../src/channels/mock.js');
  const mock = new MockChannel(); await mock.start();
  const outbox = await import('../src/outbox.js');
  outbox.attachChannel(mock, {});
  mock.reactResult = { ok: false, reason: 'SMS chat — no reactions there' };
  outbox.enqueueReaction({ userId: uid, emoji: '🔍' });
  await outbox.drain();
  assert.ok(!mock.sent.some(s => s.text === '🔍'), '1.1.22: a missed reaction is NOT sent as a text: ' + JSON.stringify(mock.sent));
  mock.reactResult = { ok: true, convId: 'c1' };
  outbox.enqueueReaction({ userId: uid, emoji: '🎵' });
  await outbox.drain();
  assert.ok(!mock.sent.some(s => s.text === '🎵'), 'a landed reaction sends no text');
});

test('plainChat: questions never take the fast path, small talk still does', async () => {
  const { plainChat } = await import('../src/agent.js');
  assert.equal(plainChat('who won the game'), false);
  assert.equal(plainChat('what time is it in london'), false);
  assert.equal(plainChat('how do i reset my router'), false);
  assert.equal(plainChat('thanks!'), true);
  assert.equal(plainChat('good night'), true);
});

test('driver: an RCS chat gets a verified real reaction; an SMS chat reports ok:false', { skip: canRun ? false : 'no Playwright/Chromium here', timeout: 120000 }, async () => {
  st.mode = 'connected'; st.rcs = undefined; st.noAttach = false;
  const { GoogleMessagesWeb } = await import('../src/channels/gmweb.js');
  const seen = new Set();
  const gm = new GoogleMessagesWeb({ dataDir, isSeen: (id) => seen.has(id), markSeen: (id) => seen.add(id), needsBaseline: () => false, baselineDone: () => {}, reactSettleMs: 200 });
  await gm.start();
  try {
    await until(() => gm.status().state === 'connected', 40000, 'connected');
    const conv = () => st.convs.find(c => c.id === '101');
    const res1 = await gm.react({ convId: '101', emoji: '🔍' });
    assert.equal(res1.ok, true, 'the RCS reaction landed and verified: ' + JSON.stringify(res1));
    assert.equal(conv().msgs.find(m => m.id === 'm1').reaction, '🔍');
    st.rcs = false;
    const res2 = await gm.react({ convId: '101', emoji: '🎵' });
    assert.equal(res2.ok, false, 'an SMS chat reports no reaction: ' + JSON.stringify(res2));
    assert.match(res2.reason || '', /SMS/);
    assert.equal(conv().msgs.find(m => m.id === 'm1').reaction, '🔍', 'no blind tapping happened on the SMS chat');
  } finally { await gm.stop(); }
});
