// 1.0.7 + typing-box fix: Google's typing box is a contenteditable div now, and an emptied box is not proof of sending.
import { setupEnv, sleep, until } from './helpers.js';
const DIR = setupEnv('send107');
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { GoogleMessagesWeb, SELECTORS, newOutgoing, sameText } from '../src/channels/gmweb.js';
import { fakeMessages } from './fake-gm.js';

test('the typing box selector finds the new contenteditable box first, and old textareas still', () => {
  assert.match(SELECTORS.composer, /^\[data-e2e-message-input-box\], mws-message-compose \[contenteditable=true\], textarea\[data-e2e-message-input-box\], mws-message-compose textarea, textarea\.input, textarea$/);
});

test('a bubble counts as sent only when it is ours, new, carries the text and has no clock', () => {
  const before = { n: 1, ids: new Set(['a']) };
  const msgs = [{ id: 'a', outgoing: true, text: 'hello', status: '' }];
  assert.equal(newOutgoing(msgs, before, 'hello'), null, 'the old "hello" is not the new one');
  const m = newOutgoing([...msgs, { id: 'b', outgoing: true, text: 'hello  there', status: 'pending' }], before, 'hello there');
  assert.equal(m.id, 'b'); assert.equal(m.status, 'pending');
  assert.equal(newOutgoing([...msgs, { id: 'c', outgoing: false, text: 'hello there', status: '' }], before, 'hello there'), null, 'their text is not ours');
  assert.ok(sameText('Line one Line two', 'Line one Line two'));
});

const PW = process.env.MSA_PLAYWRIGHT_PATH, CHROME = process.env.MSA_CHROMIUM;
const canRun = PW && CHROME && fs.existsSync(CHROME);

test('the real driver: contenteditable box, clock state, swallowed text, not sent', { skip: canRun ? false : 'no Playwright/Chromium here (set MSA_PLAYWRIGHT_PATH and MSA_CHROMIUM)', timeout: 180000 }, async () => {
  const { st, fake } = fakeMessages();
  st.mode = 'connected'; st.editable = true;
  await new Promise(r => fake.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${fake.address().port}/web`;
  const seen = new Set(); let baseline = true;
  const d = new GoogleMessagesWeb({ dataDir: DIR, url: base, pollMs: 250, healthMs: 400, settleMs: 100, chatSettleMs: 100, betweenSendsMs: 50,
    sendConfirmMs: 1500, pendingWaitMs: 2500, sendPollMs: 100,
    isSeen: (k) => seen.has(k), markSeen: (k) => seen.add(k), needsBaseline: () => baseline, baselineDone: () => { baseline = false; },
    launch: { executablePath: CHROME } });
  try {
    await d.start();
    await until(() => d.status().state === 'connected', 30000, 'connected');
    const conv = st.convs[0];
    // 1. the new contenteditable typing box
    let r = await d.send({ convId: '101', text: 'typed into the new box' });
    assert.equal(r.convId, '101'); assert.equal(conv.msgs.at(-1).text, 'typed into the new box'); assert.equal(st.typed, 1);
    // 2. a clock for a moment, then sent: fine, and typed once
    st.sendMode = 'pendingThenSent'; st.pendingMs = 1200;
    r = await d.send({ convId: '101', text: 'clock for a moment' });
    assert.equal(r.ok, true); assert.equal(st.typed, 2);
    // 3. the clock stays: NOT reported as sent, and not typed again
    st.sendMode = 'pending';
    await assert.rejects(d.send({ convId: '101', text: 'waiting for the phone' }), (e) => e.unconfirmed === true && /sending/.test(e.message));
    assert.equal(st.typed, 3, 'typed once, not retyped');
    assert.equal(await d.confirmSent({ convId: '101', text: 'waiting for the phone' }), 'pending');
    delete conv.msgs.at(-1).state;          // the phone came back and it went
    assert.equal(await d.confirmSent({ convId: '101', text: 'waiting for the phone' }), 'sent');
    // 4. the box empties but the bubble never shows: NOT sent (1.0.7 used to call this sent)
    st.sendMode = 'swallow';
    await assert.rejects(d.send({ convId: '101', text: 'vanished text' }), (e) => e.unconfirmed === true && /emptied/.test(e.message));
    assert.equal(await d.confirmSent({ convId: '101', text: 'vanished text' }), 'missing');
    // 5. Google says "Not sent"
    st.sendMode = 'failed';
    await assert.rejects(d.send({ convId: '101', text: 'refused text' }), (e) => e.notSent === true);
    assert.equal(await d.confirmSent({ convId: '101', text: 'refused text' }), 'failed');
    // 6. words that mention sending are not a clock
    st.sendMode = 'ok';
    r = await d.send({ convId: '101', text: 'I am sending it now, it failed before' });
    assert.equal(r.ok, true);
  } finally { await d.stop(); fake.close(); }
});
