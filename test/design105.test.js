// 1.0.5: one clean design for phone and desktop. The markup the new style needs is there (pure checks, always run),
// and in a real headless Chromium (skipped without one) nothing is wider than the screen at 360 and 430 px, tap targets
// are big enough, and on a desktop the dashboard has its navigation on the left and a sensible content width.
import { setupEnv } from './helpers.js';
setupEnv('design105', { MSA_TEST_DEFAULT_SOURCE: 'http://127.0.0.1:9/none' });
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
const canRun = process.env.MSA_PLAYWRIGHT_PATH && process.env.MSA_CHROMIUM && fs.existsSync(process.env.MSA_CHROMIUM);
let s;
test.before(async () => { const { main } = await import('../src/server.js'); s = await main({ port: 0, host: '127.0.0.1' }); });
test.after(async () => { await s.stop(); });
const get = (p) => fetch(`http://127.0.0.1:${s.port}${p}`);

test('sign-in pages and dashboard carry the 1.0.5 layout: brand panel, one sign-in card, icon navigation, link to the person\'s chat', async () => {
  const admin = await (await get('/')).text();
  assert.match(admin, /id="login" class="screen auth hidden"/);
  assert.match(admin, /class="authside"[\s\S]*class="card narrow authcard"/);
  assert.match(admin, /Admin sign-in/);
  assert.match(admin, /id="toPortal" class="authalt hidden"[^]*href="\/me"/);
  const nav = admin.slice(admin.indexOf('<nav id="nav">'), admin.indexOf('</nav>'));
  for (const [v, label] of [['home', 'Home'], ['people', 'People'], ['connect', 'Connect'], ['sites', 'Sites'], ['keys', 'AI keys'], ['settings', 'Settings']]) {
    assert.match(nav, new RegExp(`<button data-v="${v}"[^>]*><svg class="ic"[^]*?<span>${label}</span>`), v);
  }
  assert.ok(!/[🏠👥📱🌐🔑⚙]/u.test(nav), 'no emoji icons left in the navigation');
  for (const p of ['/', '/me']) assert.match(await (await get(p)).text(), /name="theme-color" content="#0f172a"/, p);
  const me = await (await get('/me')).text();
  assert.match(me, /class="screen auth hidden"[\s\S]*class="authside"[\s\S]*id="lTitle"[\s\S]*class="card narrow authcard"/);
  assert.match(me, /id="fPhone"[\s\S]*Text me a code[\s\S]*id="fCode"[\s\S]*6-digit code/);
  const css = await (await get('/style.css')).text();
  assert.match(css, /@media \(min-width:900px\)/);
  assert.match(css, /grid-template-columns:240px minmax\(0,1fr\)/);
  const js = await (await get('/app.js')).text();
  assert.match(js, /function checkPortal\(\)/);
});

test('phone (360 / 430 px) and desktop (1440 px): no sideways scrolling, big tap targets, desktop navigation on the left', { skip: canRun ? false : 'no Playwright/Chromium here', timeout: 180000 }, async () => {
  const { setPassword } = await import('../src/adminauth.js');
  const { setSetting } = await import('../src/db.js');
  setPassword('correct horse battery', 'admin'); setSetting('portal_enabled', '1');
  const pw = await import(process.env.MSA_PLAYWRIGHT_PATH);
  const b = await (pw.chromium ? pw : pw.default).chromium.launch({ executablePath: process.env.MSA_CHROMIUM, args: ['--no-sandbox'] });
  const base = `http://127.0.0.1:${s.port}`;
  // anything visible that sticks out past the right edge of the screen
  const overflow = (p) => p.evaluate(() => { const w = window.innerWidth; return { doc: document.documentElement.scrollWidth - w,
    els: [...document.querySelectorAll('body *')].filter(e => e.offsetParent !== null && !e.closest('.tabs,.activity,pre') && e.getBoundingClientRect().right > w + 1).map(e => e.tagName + '#' + e.id + '.' + e.className).slice(0, 5) }; });
  const small = (p) => p.evaluate(() => [...document.querySelectorAll('button, input:not([type=checkbox]), select')].filter(e => e.offsetParent !== null && !e.classList.contains('link'))
    .map(e => ({ id: e.id || e.textContent.trim().slice(0, 20), h: e.getBoundingClientRect().height })).filter(x => x.h < 36));
  const errors = [];
  try {
    for (const width of [360, 430, 1440]) {
      const phone = width < 600;
      const p = await (await b.newContext({ viewport: { width, height: phone ? 800 : 900 }, isMobile: phone, hasTouch: phone })).newPage();
      p.on('pageerror', e => errors.push(e.message));
      await p.goto(base + '/me'); await p.waitForSelector('#login:not(.hidden)');
      assert.deepEqual(await overflow(p), { doc: 0, els: [] }, `${width} /me`);
      assert.deepEqual(await small(p), [], `${width} /me tap targets`);
      await p.goto(base + '/'); await p.waitForSelector('#login:not(.hidden)');
      await p.waitForSelector('#toPortal:not(.hidden)', { timeout: 5000 });
      assert.deepEqual(await overflow(p), { doc: 0, els: [] }, `${width} /`);
      assert.deepEqual(await small(p), [], `${width} / tap targets`);
      const card = await p.locator('.authcard').boundingBox(), side = await p.locator('.authside').boundingBox();
      if (phone) assert.ok(side.y < card.y, 'phone: brand panel above the sign-in card');
      else assert.ok(side.x < card.x && Math.abs(side.y - 0) < 2, 'desktop: brand panel on the left, card on the right');
      await p.click('#loginTabs button[data-t="password"]');
      await p.fill('#lUser', 'admin'); await p.fill('#lPass', 'correct horse battery');
      await p.click('#fPass button[type=submit]'); await p.waitForSelector('#app:not(.hidden)');
      for (const v of ['home', 'people', 'connect', 'sites', 'keys', 'settings']) {
        await p.click(`#nav button[data-v="${v}"]`); await p.waitForSelector(`#v-${v}:not(.hidden)`); await p.waitForTimeout(250);
        assert.deepEqual(await overflow(p), { doc: 0, els: [] }, `${width} ${v}`);
      }
      const nav = await p.locator('#nav').boundingBox(), main = await p.locator('main').boundingBox();
      if (phone) { assert.ok(nav.y + nav.height >= (await p.evaluate(() => innerHeight)) - 1, 'phone: navigation at the bottom'); assert.ok(nav.height >= 56); }
      else { assert.ok(nav.x === 0 && nav.width >= 200 && nav.width <= 280, 'desktop: navigation on the left'); assert.ok(main.x >= nav.width && main.width <= 1180, 'desktop: content beside it, not wider than 1180 px'); }
      await p.context().close();
    }
    assert.deepEqual(errors, []);
  } finally { await b.close(); }
});
