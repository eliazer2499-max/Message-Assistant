// 1.0.4 dashboard, phone size, real headless Chromium (skipped without one): Connect → Start pairing → the QR code
// shows big (chosen by itself when Google offers a choice), refreshes, then "Paired ✓". No "Sign-in page" button.
import { setupEnv, until, sleep } from './helpers.js';
import fs from 'node:fs';
import { fakeMessages } from './fake-gm.js';
const { st, fake } = fakeMessages();
await new Promise(r => fake.listen(0, '127.0.0.1', r));
setupEnv('pair104b', { MSA_CHANNEL: 'web', MSA_GM_URL: `http://127.0.0.1:${fake.address().port}/web`, MSA_HEALTH_MS: '800', MSA_QR_MS: '400' });
import test from 'node:test';
import assert from 'node:assert/strict';
const canRun = process.env.MSA_PLAYWRIGHT_PATH && process.env.MSA_CHROMIUM && fs.existsSync(process.env.MSA_CHROMIUM);
test.after(() => { fake.close(); fake.closeAllConnections?.(); });

test('Connect in a phone-size browser: Start pairing → sign-in only when Google asks → QR code → Paired ✓', { skip: canRun ? false : 'no Playwright/Chromium here', timeout: 150000 }, async () => {
  const { main } = await import('../src/server.js');
  const { setPassword } = await import('../src/adminauth.js');
  const s = await main({ port: 0, host: '127.0.0.1' });
  const pw = await import(process.env.MSA_PLAYWRIGHT_PATH);
  const b = await (pw.chromium ? pw : pw.default).chromium.launch({ executablePath: process.env.MSA_CHROMIUM, args: ['--no-sandbox'] });
  try {
    setPassword('correct horse battery', 'admin');
    const p = await (await b.newContext({ viewport: { width: 390, height: 844 } })).newPage();
    const errors = []; p.on('pageerror', e => errors.push(e.message));
    await p.goto(`http://127.0.0.1:${s.port}/`);
    await p.click('#loginTabs button[data-t="password"]');
    await p.fill('#lUser', 'admin'); await p.fill('#lPass', 'correct horse battery');
    await p.click('#fPass button[type=submit]'); await p.waitForSelector('#app:not(.hidden)');
    await p.click('#nav button[data-v="connect"]');
    assert.equal(await p.locator('[data-act="signin"]').count(), 0, 'no separate sign-in button');
    assert.match(await p.textContent('#pairSteps'), /Device pairing → QR code scanner/);
    // not signed in to Google: Start pairing opens Google's sign-in, the note says why, the live picture opens by itself
    await p.waitForFunction(() => /signed in once/.test(document.querySelector('#cState').textContent), null, { timeout: 30000 });
    await p.click('#gmPair');
    await until(() => st.signInClicks === 1, 20000, 'Sign in pressed by Start pairing');
    await p.waitForSelector('#signinNote:not(.hidden)');
    await p.waitForFunction(() => document.querySelector('#liveCard').open === true, null, { timeout: 10000 });
    // signed in: Start pairing → the QR code, "QR code" chosen by itself, no live picture needed
    st.mode = 'auth'; st.choice = true; st.autoNav = true;   // like Google: the page moves to the chats by itself after the scan
    await p.waitForFunction(() => !document.querySelector('#gmPair').disabled);
    await p.click('#gmPair');
    await p.waitForSelector('#qrCard:not(.hidden) #qrImg[src^="data:image/png"]', { timeout: 20000 });
    assert.equal(st.qrChosen, true);
    assert.equal(await p.isVisible('#signinNote'), false);
    assert.equal(await p.textContent('#gmPair'), 'New QR code');
    // Google rotates the code: the picture in the dashboard follows
    const first = await p.getAttribute('#qrImg', 'src');
    st.qrN++;
    await p.waitForFunction((f) => document.querySelector('#qrImg').getAttribute('src') !== f, first, { timeout: 15000 });
    // scanned → Paired ✓, the QR code and the steps go away
    st.mode = 'connected';
    await p.waitForSelector('#pairedBox:not(.hidden)', { timeout: 30000 });
    assert.match(await p.textContent('#pairedBox'), /Paired ✓/);
    assert.equal(await p.isVisible('#qrCard'), false); assert.equal(await p.isVisible('#pairSteps'), false); assert.equal(await p.isVisible('#gmPair'), false);
    const box = await p.evaluate(() => document.documentElement.scrollWidth);
    assert.ok(box <= 390, 'no sideways scrolling on a phone');
    assert.deepEqual(errors, []);
  } finally { await b.close(); await s.stop?.(); }
});
