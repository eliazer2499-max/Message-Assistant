// 1.0.7: the live picture on the Connect page takes taps and clicks at the exact spot, a tap on a text box types
// straight in from the phone's (or computer's) keyboard, and a swipe or the mouse wheel scrolls. The math is checked
// on its own; the rest runs with the real visible browser (Playwright + Chromium + Xvfb), skipped without them.
import { setupEnv, until, sleep } from './helpers.js';
import fs from 'node:fs';
import { fakeMessages } from './fake-gm.js';
const { st, fake } = fakeMessages();
await new Promise(r => fake.listen(0, '127.0.0.1', r));
const BASE = `http://127.0.0.1:${fake.address().port}/web`;
setupEnv('live107', { MSA_CHANNEL: 'web', MSA_GM_URL: BASE, MSA_HEALTH_MS: '1500', MSA_CHROMIUM: process.env.MSA_CHROMIUM || '' });
import test from 'node:test';
import assert from 'node:assert/strict';
const { tapToPage, findXvfb, markCleanExit } = await import('../src/channels/gmweb.js');
test.after(() => { fake.close(); fake.closeAllConnections?.(); });

const appJs = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
const helpers = new Function(appJs.match(/function picPoint[\s\S]*?\/\/ end of the live picture helpers/)[0] + '\n; return { picPoint, fieldAt, typedEdit };')();

test('a tap on the picture maps to the same spot of the page (border, any size, edges)', () => {
  const { picPoint } = helpers;
  // a 330 x 240 picture (a phone) with a 1 px border, at (29, 590)
  const rect = { left: 29, top: 590, width: 332, height: 242 };
  const p = picPoint(rect, 29 + 1 + 165, 590 + 1 + 120, 1, 1, 330, 240);
  assert.deepEqual(p, { x: 0.5, y: 0.5 });
  const q = picPoint(rect, 29 + 1 + 33, 590 + 1 + 24, 1, 1, 330, 240); assert.ok(Math.abs(q.x - 0.1) < 1e-9 && Math.abs(q.y - 0.1) < 1e-9);
  assert.deepEqual(picPoint(rect, 29, 590, 1, 1, 330, 240), { x: 0, y: 0 }, 'on the border: pulled to the edge');
  assert.equal(picPoint(rect, 500, 590, 1, 1, 330, 240), null, 'outside the picture: nothing');
  assert.equal(picPoint({ left: 0, top: 0, width: 0, height: 0 }, 1, 1, 0, 0, 0, 0), null, 'no picture yet');
  // the server side: fractions → the page's own size (1100 x 797 as the visible browser has), clamped
  assert.deepEqual(tapToPage({ x: 0.5, y: 0.5 }, { width: 1100, height: 797 }), { x: 550, y: 398.5 });
  assert.deepEqual(tapToPage({ x: 2, y: -1 }, { width: 1100, height: 797 }), { x: 1099, y: 0 });
  assert.deepEqual(tapToPage({ x: 'x', y: null }, { width: 1000, height: 800 }), { x: 500, y: 0 });
});

test('a tap on a text box is known in the tap itself; typing becomes backspaces + new letters', () => {
  const { fieldAt, typedEdit } = helpers;
  const fields = [{ x: 0.5, y: 0.35, w: 0.3, h: 0.07, kind: 'email' }, { x: 0.5, y: 0.5, w: 0.3, h: 0.07, kind: 'password' }];
  assert.equal(fieldAt(fields, { x: 0.6, y: 0.38 }).kind, 'email');
  assert.equal(fieldAt(fields, { x: 0.6, y: 0.53 }).kind, 'password');
  assert.equal(fieldAt(fields, { x: 0.2, y: 0.38 }), null);
  assert.equal(fieldAt(null, { x: 0.6, y: 0.38 }), null);
  assert.deepEqual(typedEdit('', 'abc'), { back: 0, text: 'abc' });
  assert.deepEqual(typedEdit('abc', 'ab'), { back: 1, text: '' });
  assert.deepEqual(typedEdit('helo', 'hello'), { back: 1, text: 'lo' });
  assert.deepEqual(typedEdit('teh ', 'the '), { back: 3, text: 'he ' }, 'a phone autocorrect');
  assert.deepEqual(typedEdit('same', 'same'), { back: 0, text: '' });
});

test('the profile is marked closed normally, so no old tabs come back', () => {
  const d = fs.mkdtempSync('/tmp/msa-prof-'); fs.mkdirSync(d + '/Default');
  fs.writeFileSync(d + '/Default/Preferences', JSON.stringify({ profile: { exit_type: 'Crashed', exited_cleanly: false, name: 'x' } }));
  assert.equal(markCleanExit(d), true);
  const j = JSON.parse(fs.readFileSync(d + '/Default/Preferences', 'utf8'));
  assert.equal(j.profile.exit_type, 'Normal'); assert.equal(j.profile.exited_cleanly, true); assert.equal(j.profile.name, 'x');
  assert.equal(markCleanExit(d), false, 'already clean'); assert.equal(markCleanExit(d + '/none'), false, 'no profile yet');
  fs.rmSync(d, { recursive: true, force: true });
});

const PW = process.env.MSA_PLAYWRIGHT_PATH, CHROME = process.env.MSA_CHROMIUM;
const canRun = PW && CHROME && fs.existsSync(CHROME) && !!findXvfb();
test('Connect on a phone and a computer: tap/click lands on the exact spot, a text box types straight in, swipe + wheel scroll', { skip: canRun ? false : 'needs Playwright/Chromium and Xvfb', timeout: 180000 }, async () => {
  st.mode = 'welcome';
  const { main } = await import('../src/server.js');
  const { setPassword } = await import('../src/adminauth.js');
  const s = await main({ port: 0, host: '127.0.0.1' });
  const pw = await import(PW); const chromium = (pw.chromium ? pw : pw.default).chromium;
  const b = await chromium.launch({ executablePath: CHROME, args: ['--no-sandbox'] });
  try {
    setPassword('correct horse battery', 'admin');
    await until(() => s.channel.page && s.channel.status().browserInfo?.mode === 'visible', 40000, 'the visible browser');
    const ch = s.channel;
    await ch.page.goto(BASE + '/tapcheck');
    const gp = () => ch.page;
    for (const kind of ['phone', 'desktop']) {
      const opts = kind === 'phone' ? { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true } : { viewport: { width: 1440, height: 900 } };
      const ctx = await b.newContext(opts); const p = await ctx.newPage();
      const errors = []; p.on('pageerror', e => errors.push(e.message)); p.on('dialog', d => { errors.push('alert: ' + d.message()); d.dismiss(); });
      await p.goto(`http://127.0.0.1:${s.port}/`);
      await p.click('#loginTabs button[data-t="password"]');
      await p.fill('#lUser', 'admin'); await p.fill('#lPass', 'correct horse battery');
      await p.click('#fPass button[type=submit]'); await p.waitForSelector('#app:not(.hidden)');
      await p.click('#nav button[data-v="connect"]');
      // the card may open by itself (Google wants a sign-in) at the same moment: a click would close it again, so set it open
      await sleep(600); await p.evaluate(() => { document.querySelector('#liveCard').open = true; });
      await gp().evaluate(() => { window.c = []; window.bc = 0; for (const i of document.querySelectorAll('input')) i.value = ''; scrollTo(0, 0); document.activeElement?.blur(); });
      await until(() => p.evaluate(() => live.fields.length >= 2), 15000, kind + ': the picture knows the text boxes');
      const img = p.locator('#screen'); await img.scrollIntoViewIfNeeded();
      const where = async (sel) => { const r = await gp().evaluate((q) => { const r = document.querySelector(q).getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2, W: innerWidth, H: innerHeight }; }, sel);
        const bx = await img.boundingBox(); return { page: r, x: bx.x + 1 + (r.x / r.W) * (bx.width - 2), y: bx.y + 1 + (r.y / r.H) * (bx.height - 2), bx }; };
      const tap = (x, y) => kind === 'phone' ? p.touchscreen.tap(x, y) : p.mouse.click(x, y);
      // 1. the button: the click lands on the very spot (a picture pixel is ~3 page pixels on a phone)
      let w = await where('#b'); await tap(w.x, w.y);
      await until(() => gp().evaluate(() => window.bc >= 1), 8000, kind + ': the tap pressed the button');
      const [cx, cy] = (await gp().evaluate(() => window.c)).at(-1);
      assert.ok(Math.abs(cx - w.page.x) <= 4 && Math.abs(cy - w.page.y) <= 4, `${kind}: landed at ${cx},${cy}, aimed ${w.page.x},${w.page.y}`);
      // 2. the email box: focused there, and the keyboard goes straight in (focus taken inside the tap itself)
      w = await where('#e'); await tap(w.x, w.y);
      assert.equal(await p.evaluate(() => document.activeElement.id), 'liveKeys', kind + ': the typing box has the keyboard right away');
      await until(() => gp().evaluate(() => document.activeElement?.id === 'e'), 8000, kind + ': the email box is focused in the server browser');
      assert.equal(await p.isVisible('#liveTyping'), true);
      await p.keyboard.type('someone@exampl', { delay: 20 }); await p.keyboard.press('Backspace'); await p.keyboard.type('le.com', { delay: 20 });
      await until(() => gp().evaluate(() => document.querySelector('#e').value === 'someone@example.com'), 10000, kind + ': typed into the email box');
      // 3. the password box: the typing box hides the letters too
      w = await where('#pw'); await tap(w.x, w.y);
      await until(() => gp().evaluate(() => document.activeElement?.id === 'pw'), 8000, kind + ': the password box is focused');
      await until(() => p.evaluate(() => document.querySelector('#liveKeys').type === 'password'), 5000, kind + ': hidden letters for a password');
      assert.equal(await p.inputValue('#liveKeys'), '', 'a fresh box for the new field');
      await p.keyboard.type('not-a-real-pass', { delay: 15 });
      await until(() => gp().evaluate(() => document.querySelector('#pw').value === 'not-a-real-pass'), 10000, kind + ': typed into the password box');
      await p.keyboard.press('Enter'); await sleep(600);
      // 4. a tap outside a box closes the typing box
      w = await where('#tall'); await tap(w.bx.x + 20, w.bx.y + w.bx.height * 0.9);
      await until(() => p.evaluate(() => document.querySelector('#liveTyping').classList.contains('hidden')), 8000, kind + ': typing box closes');
      // 5. scroll: a swipe up (phone) or the wheel (computer) moves the page
      const before = await gp().evaluate(() => scrollY); const bx = await img.boundingBox();
      if (kind === 'phone') {
        const c = await ctx.newCDPSession(p); const x = bx.x + bx.width / 2, y0 = bx.y + bx.height * 0.8, y1 = bx.y + bx.height * 0.3;
        await c.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y: y0 }] });
        for (let i = 1; i <= 6; i++) { await c.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y: y0 + (y1 - y0) * i / 6 }] }); await sleep(16); }
        await c.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
      } else { await p.mouse.move(bx.x + bx.width / 2, bx.y + bx.height / 2); await p.mouse.wheel(0, 300); }
      await until(() => gp().evaluate((b0) => scrollY > b0 + 100, before), 8000, kind + ': the page scrolled');
      // the old type box still works as a backup
      await gp().evaluate(() => { scrollTo(0, 0); document.querySelector('#e').value = ''; document.querySelector('#e').focus(); });
      await p.fill('#typeText', 'backup'); await p.click('#typeBtn');
      await until(() => gp().evaluate(() => document.querySelector('#e').value === 'backup'), 8000, kind + ': Send keys still works');
      assert.deepEqual(errors, [], kind + ': no page errors or alerts');
      if (kind === 'phone' && process.env.MSA_SHOT_DIR) await p.screenshot({ path: process.env.MSA_SHOT_DIR + '/live107-phone.png' });
      await ctx.close();
    }
    // a window the page opens (Google can) becomes what the picture shows and the taps reach; closing it comes back
    const main0 = ch.page;
    await main0.evaluate(() => window.open(location.href + '?popup=1', '_blank', 'popup'));
    await until(() => ch.page !== main0 && /popup=1/.test(ch.page.url()), 8000, 'the picture follows the new window');
    await ch.page.close(); await until(() => ch.page === main0, 5000, 'back to the page after the window closes');
    // a hard stop with extra tabs open: after the restart only one tab is left, the one the picture shows
    for (let i = 0; i < 2; i++) await (await ch.ctx.newPage()).goto(BASE + '/tapcheck');
    ch.proc.kill('SIGKILL'); await sleep(1500);
    await ch.restart();
    assert.equal(ch.ctx.pages().filter(x => !x.url().startsWith('devtools')).length, 1, 'one tab after the restart');
  } finally { await b.close(); await s.stop(); }
});
