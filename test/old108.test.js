// 1.0.8 (Abish, Nov 12 2026): after a restart, 1.0.6 answered an OLD unread spam chat (last text Oct 29) as if it was new:
// a pending person, a "waiting for approval" text and 3 admin alerts. Chats whose last message is from before the start
// (minus 10 minutes) are left alone; a new text in them later is answered as usual.
import { setupEnv, sleep, until } from './helpers.js';
const DIR = setupEnv('old108');
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { GoogleMessagesWeb } from '../src/channels/gmweb.js';
import { fakeMessages } from './fake-gm.js';
const PW = process.env.MSA_PLAYWRIGHT_PATH, CHROME = process.env.MSA_CHROMIUM;
const canRun = PW && CHROME && fs.existsSync(CHROME);

test('restart: an old unread chat is not answered; a fresh one is; a new text in the old chat is', { skip: canRun ? false : 'no Playwright/Chromium here (set MSA_PLAYWRIGHT_PATH and MSA_CHROMIUM)', timeout: 120000 }, async () => {
  const { st, fake } = fakeMessages();
  st.mode = 'connected';
  st.convs = [
    { id: '301', name: '+1 737-259-0673', unread: true, time: 'Oct 29', msgs: [{ id: 's1', out: false, text: 'Stop2End' }, { id: 's2', out: false, text: 'Stop' }] },
    { id: '302', name: '(212) 555-0102', unread: true, time: 'Now', msgs: [{ id: 'f1', out: false, text: 'are you there?' }] },
  ];
  await new Promise(r => fake.listen(0, '127.0.0.1', r));
  const seen = new Set(); const got = [];
  const d = new GoogleMessagesWeb({ dataDir: DIR, url: `http://127.0.0.1:${fake.address().port}/web`, pollMs: 250, healthMs: 400, settleMs: 100, chatSettleMs: 100, betweenSendsMs: 50,
    isSeen: (k) => seen.has(k), markSeen: (k) => seen.add(k), needsBaseline: () => false, baselineDone: () => {}, launch: { executablePath: CHROME } });
  d.on('message', m => got.push(m));
  try {
    await d.start();
    await until(() => d.status().state === 'connected', 30000, 'connected');
    await until(() => got.some(m => m.convId === '302'), 15000, 'the fresh chat is read');
    await sleep(2500);
    assert.deepEqual(got.map(m => m.text), ['are you there?'], 'the Oct 29 spam is left alone (it stays unread in Google)');
    st.convs[0].msgs.push({ id: 's3', out: false, text: 'hello, real question' }); st.convs[0].time = 'Now';
    await until(() => got.some(m => m.text === 'hello, real question'), 15000, 'a new text in the old chat');
    assert.equal(got.filter(m => m.convId === '301').length, 1, 'only the new text, not the old ones');
  } finally { await d.stop(); fake.close(); }
});
