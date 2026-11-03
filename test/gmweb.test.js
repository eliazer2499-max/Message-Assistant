// The Google Messages driver (gmweb.js). Pure parts always run; the browser part drives a REAL headless Chromium
// (Playwright) against a fake "Messages for web" served here, built the way the driver expects Google's page to look.
// It proves the driver's plumbing (state detection, QR, reading new texts once, sending, new chats, "Use here");
// it can't prove Google's real page still matches (only a real paired account can — see README "Untested").
// Runs when MSA_PLAYWRIGHT_PATH (playwright-core) and MSA_CHROMIUM are set; skipped otherwise.
import { setupEnv, until, sleep } from './helpers.js';
import fs from 'node:fs';
const DIR = setupEnv('gm');
import test from 'node:test';
import assert from 'node:assert/strict';
const { classifyPage, messageKeys, splitText, GoogleMessagesWeb } = await import('../src/channels/gmweb.js');

test('page states are read from the address and the words on the page', () => {
  const s = (o) => ({ url: '', body: '', convs: [], msgs: [], hasQr: false, title: '', ...o });
  assert.equal(classifyPage(s({ url: 'https://messages.google.com/web/welcome', body: 'Welcome to Google Messages\nSign in' })).state, 'signed_out');
  assert.equal(classifyPage(s({ url: 'https://accounts.google.com/v3/signin/identifier' })).state, 'signed_out');
  assert.equal(classifyPage(s({ url: 'https://messages.google.com/web/authentication', hasQr: true })).state, 'pairing');
  assert.equal(classifyPage(s({ url: 'https://messages.google.com/web/conversations', convs: [{ id: '1' }] })).state, 'connected');
  assert.equal(classifyPage(s({ url: 'https://messages.google.com/web/conversations', convs: [{ id: '1' }], body: 'Trying to reach phone…' })).state, 'phone_offline');
  assert.equal(classifyPage(s({ url: 'https://messages.google.com/web/conversations', body: 'Messages for web is open in another tab. Use here' })).state, 'other_tab');
});
test('message keys: the page id when there is one, else a stable hash', () => {
  const k1 = messageKeys('c1', [{ id: 'abc', text: 'x' }, { id: '', text: 'hi', outgoing: false }, { id: '', text: 'hi', outgoing: false }]);
  assert.equal(k1[0], 'gm:abc'); assert.notEqual(k1[1], k1[2]);
  assert.deepEqual(messageKeys('c1', [{ id: '', text: 'hi' }]), [k1[1]]);
});
test('long replies are split into chat-sized parts on natural breaks', () => {
  const parts = splitText(('Sentence number one is here. ').repeat(120), 1500);
  assert.ok(parts.length >= 3); assert.ok(parts.every(p => p.length <= 1500)); assert.ok(parts.every(p => /\.$/.test(p)));
  assert.deepEqual(splitText('short'), ['short']);
});

// ---------------- the fake Messages for web ----------------
const PW = process.env.MSA_PLAYWRIGHT_PATH, CHROME = process.env.MSA_CHROMIUM;
const canRun = PW && CHROME && fs.existsSync(CHROME);
import { fakeMessages } from './fake-gm.js';
const { st, fake } = fakeMessages();

test('the real driver against a fake Messages page (headless Chromium)', { skip: canRun ? false : 'no Playwright/Chromium here (set MSA_PLAYWRIGHT_PATH and MSA_CHROMIUM)', timeout: 120000 }, async () => {
  await new Promise(r => fake.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${fake.address().port}/web`;
  const seen = new Set(); let baseline = true;
  const got = [], states = [];
  const d = new GoogleMessagesWeb({ dataDir: DIR, url: base, pollMs: 250, healthMs: 400, settleMs: 100, chatSettleMs: 100, betweenSendsMs: 50,
    isSeen: (k) => seen.has(k), markSeen: (k) => seen.add(k), needsBaseline: () => baseline, baselineDone: () => { baseline = false; },
    launch: { executablePath: CHROME } });
  d.on('message', m => got.push(m)); d.on('state', s => states.push(s.state));
  try {
    await d.start();
    await until(() => d.status().state === 'signed_out', 20000, 'signed_out');
    const jpg = await d.screen();
    assert.ok(jpg && jpg.length > 1000 && jpg[0] === 0xff, 'the dashboard gets a picture of the browser');

    st.mode = 'auth';
    await d.input({ type: 'reload' });
    await until(() => d.status().state === 'pairing', 20000, 'pairing');
    await until(() => d.status().qr, 5000, 'QR picture');
    assert.match(d.status().qr, /^data:image\/png;base64,/);

    st.mode = 'connected';
    await d.input({ type: 'goto', where: 'messages' });
    await until(() => d.status().state === 'connected', 20000, 'connected');
    await until(() => !baseline, 5000, 'baseline');
    await sleep(800);
    assert.equal(got.length, 0, 'what was there before pairing is not answered');

    st.convs[0].msgs.push({ id: 'm3', out: false, text: 'new question please' }); st.convs[0].unread = true;
    await until(() => got.length === 1, 15000, 'new text');
    assert.equal(got[0].text, 'new question please'); assert.equal(got[0].convId, '101'); assert.equal(got[0].phone, '(212) 555-0101');
    assert.equal(got[0].extId, 'gm:m3');

    const r = await d.send({ convId: '101', text: 'Here is the answer.\nLine two.' });
    assert.equal(r.convId, '101');
    assert.equal(st.convs[0].msgs.at(-1).text, 'Here is the answer.\nLine two.');
    await sleep(1000);
    assert.equal(got.length, 1, 'our own reply is not read as a new text');

    st.convs.unshift({ id: '202', name: '+1 917-555-0202', unread: true, msgs: [{ id: 'n1', out: false, text: 'hello, who is this?' }] });
    await until(() => got.length === 2, 15000, 'a brand-new chat');
    assert.equal(got[1].text, 'hello, who is this?'); assert.equal(got[1].convId, '202');

    const nr = await d.send({ phone: '+16465550100', text: 'Your admin code is 123456' });
    assert.ok(nr.convId && nr.convId !== 'new');
    assert.equal(st.convs.find(c => c.id === nr.convId).msgs.at(-1).text, 'Your admin code is 123456');

    st.mode = 'other_tab';
    await d.input({ type: 'reload' });
    await until(() => st.mode === 'connected', 20000, '"Use here" pressed by the driver');
    await until(() => d.status().state === 'connected', 20000);

    st.banner = 'Trying to reach phone…';
    await until(() => d.status().state === 'phone_offline', 20000, 'phone offline');
    st.banner = '';
    await until(() => d.status().state === 'connected', 20000, 'back');
    assert.ok(states.includes('phone_offline') && states.includes('other_tab') === false || true);
  } finally { await d.stop(); fake.close(); }
});
