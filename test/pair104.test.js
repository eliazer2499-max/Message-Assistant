// 1.0.4: pairing goes straight to the QR code. Pure parts always run: the browser choice (never the "headless shell"
// Google refuses to sign in from), the normal user agent, the new "Google refused the sign-in" state. The browser parts
// drive a real headless Chromium against the fake Messages page (skipped without MSA_PLAYWRIGHT_PATH + MSA_CHROMIUM).
import { setupEnv, until } from './helpers.js';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
const DIR = setupEnv('pair104');
import test from 'node:test';
import assert from 'node:assert/strict';
const { pickBrowser, findFullChromium, isHeadlessShell, normalUserAgent, classifyPage, GoogleMessagesWeb } = await import('../src/channels/gmweb.js');
const { STATE_WORDS } = await import('../src/app.js');

function browsersDir(kinds) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'msa-browsers-'));
  for (const k of kinds) {
    const [dir, sub, bin] = k === 'shell' ? ['chromium_headless_shell-1243', 'chrome-headless-shell-linux64', 'chrome-headless-shell'] : [k, 'chrome-linux64', 'chrome'];
    fs.mkdirSync(path.join(root, dir, sub), { recursive: true }); fs.writeFileSync(path.join(root, dir, sub, bin), '');
  }
  return root;
}

test('the full Chromium build is picked, never the headless shell when the full one is there', () => {
  const both = browsersDir(['shell', 'chromium-1200', 'chromium-1243']);
  assert.equal(findFullChromium(both), path.join(both, 'chromium-1243', 'chrome-linux64', 'chrome'), 'the newest full build');
  assert.deepEqual(pickBrowser({ browsersPath: both }).executablePath, path.join(both, 'chromium-1243', 'chrome-linux64', 'chrome'));
  assert.equal(pickBrowser({ browsersPath: both }).kind, 'full');
  const shellPath = path.join(both, 'chromium_headless_shell-1243', 'chrome-headless-shell-linux64', 'chrome-headless-shell');
  assert.equal(isHeadlessShell(shellPath), true); assert.equal(isHeadlessShell('/usr/bin/chromium'), false);
  // MSA_CHROMIUM set to the shell: the full build next to it wins
  assert.equal(pickBrowser({ configured: shellPath, browsersPath: both }).kind, 'full');
  // MSA_CHROMIUM set to a full browser: used as is
  assert.deepEqual(pickBrowser({ configured: '/usr/bin/chromium', browsersPath: both }), { executablePath: '/usr/bin/chromium', kind: 'full', why: 'MSA_CHROMIUM' });
  // only the shell installed and configured: it is used (and said so); nothing configured: Playwright's full Chromium
  const shellOnly = browsersDir(['shell']);
  assert.equal(findFullChromium(shellOnly), null);
  assert.equal(pickBrowser({ configured: shellPath, browsersPath: shellOnly }).kind, 'shell');
  assert.deepEqual(pickBrowser({ browsersPath: shellOnly }), { channel: 'chromium', kind: 'full', why: "Playwright's full Chromium" });
  assert.deepEqual(pickBrowser({ browsersPath: '/nonexistent' }).channel, 'chromium');
});

test('the browser calls itself plain Chrome', () => {
  assert.equal(normalUserAgent('Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/153.0.8010.12 Safari/537.36'),
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36');
  const plain = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36';
  assert.equal(normalUserAgent(plain), plain);
  assert.doesNotMatch(normalUserAgent('HeadlessChrome/140.0.1.2'), /Headless/);
});

test('"This browser or app may not be secure" is its own state, with plain words', () => {
  const s = (o) => ({ url: '', body: '', convs: [], msgs: [], hasQr: false, title: '', ...o });
  assert.equal(classifyPage(s({ url: 'https://accounts.google.com/v3/signin/rejected?continue=x' })).state, 'signin_blocked');
  assert.equal(classifyPage(s({ url: 'https://accounts.google.com/v3/signin/identifier', body: 'Couldn’t sign you in\nThis browser or app may not be secure. Learn more' })).state, 'signin_blocked');
  assert.equal(classifyPage(s({ url: 'https://accounts.google.com/v3/signin/identifier', body: 'Sign in\nwith your Google Account' })).state, 'signed_out');
  assert.equal(classifyPage(s({ url: 'https://messages.google.com/web/welcome', body: 'Welcome to Google Messages\nSign in' })).state, 'signed_out');
  assert.equal(classifyPage(s({ url: 'https://messages.google.com/web/authentication', hasQr: true })).state, 'pairing');
  assert.match(STATE_WORDS.signin_blocked, /refused/);
  assert.match(STATE_WORDS.connected, /Paired ✓/);
  assert.match(STATE_WORDS.pairing, /QR code/);
});

const PW = process.env.MSA_PLAYWRIGHT_PATH, CHROME = process.env.MSA_CHROMIUM;
const canRun = PW && CHROME && fs.existsSync(CHROME);
import { fakeMessages } from './fake-gm.js';
const { st, fake } = fakeMessages();
test.after(() => { fake.close(); fake.closeAllConnections?.(); });

test('Start pairing: sign-in only if Google asks, then the QR code (chosen, kept fresh), then Paired ✓', { skip: canRun ? false : 'no Playwright/Chromium here', timeout: 120000 }, async () => {
  await new Promise(r => fake.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${fake.address().port}/web`;
  const d = new GoogleMessagesWeb({ dataDir: DIR, url: base, pollMs: 250, healthMs: 60000, qrMs: 300, settleMs: 150, qrSettleMs: 300,
    isSeen: () => false, markSeen: () => {}, needsBaseline: () => true, baselineDone: () => {}, launch: { executablePath: CHROME } });
  try {
    await d.start();
    await until(() => d.status().state === 'signed_out', 20000, 'signed_out');
    // not signed in to Google yet: Start pairing opens Google's sign-in box (one tap saved), and says sign-in is needed
    const r1 = await d.input({ type: 'pair' });
    assert.equal(r1.needsSignIn, true); assert.equal(st.signInClicks, 1);
    // signed in: the page offers the Google account or the QR code → the QR code is chosen by itself
    st.mode = 'auth'; st.choice = true; st.autoNav = true;   // like Google: the page moves to the chats by itself after the scan
    const r2 = await d.input({ type: 'pair' });
    assert.equal(r2.state, 'pairing'); assert.equal(st.qrChosen, true, '"Pair with QR code" was picked');
    await until(() => d.status().qr, 5000, 'QR picture');
    assert.match(d.status().qr, /^data:image\/png;base64,/);
    assert.doesNotMatch(d.page.url(), /#help/, 'the "Having trouble scanning" link was not the one pressed');
    await until(() => st.remember === true, 5000, '"Remember this computer" on');
    // Google rotates the code: the dashboard's picture follows within a few seconds
    const q1 = d.status().qr, at1 = d.status().qrAt;
    st.qrN++;
    await until(() => d.status().qr && d.status().qr !== q1, 8000, 'new QR picture');
    assert.ok(d.status().qrAt > at1);
    // the phone scanned it: the chats list shows → Paired ✓, QR gone
    st.mode = 'connected';
    await until(() => d.status().state === 'connected', 8000, 'connected');
    assert.ok(d.status().pairedAt > 0); assert.equal(d.status().qr, null);
    assert.equal(d.status().browser, 'full');
  } finally { await d.stop(); }
});
