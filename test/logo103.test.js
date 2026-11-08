// 1.0.3: the logo can never fill the page again. On a phone, 1.0.2 showed the old 1.0.1 picture full width above
// Settings → Updates: the page was new, but the phone kept the old style and logo files. Every file is now asked for
// with ?v=<version>, every logo <img> has its own small size, and the page reloads once after an update.
import { setupEnv } from './helpers.js';
setupEnv('logo103', { MSA_TEST_DEFAULT_SOURCE: 'http://127.0.0.1:9/none' });
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const V = fs.readFileSync(path.join(ROOT, 'VERSION'), 'utf8').trim();
const canRun = process.env.MSA_PLAYWRIGHT_PATH && process.env.MSA_CHROMIUM && fs.existsSync(process.env.MSA_CHROMIUM);
// the 1.0.1 picture (teal ball): an SVG with no size of its own, which an unstyled <img> stretches to full width
const OLD_ICON = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512"><rect width="512" height="512" rx="112" fill="#07090d"/><circle cx="256" cy="256" r="150" fill="#0aa3c4"/></svg>';
const ALLOWED_BIG = ['screen', 'qrImg'];   // the live Messages picture and the QR code are meant to be big
let s;
test.before(async () => { const { main } = await import('../src/server.js'); s = await main({ port: 0, host: '127.0.0.1' }); });
test.after(async () => { await s.stop(); });
const get = (p) => fetch(`http://127.0.0.1:${s.port}${p}`);

test('pages ask for every file with ?v=<version>, logos have a small size of their own, pages are never cached', async () => {
  for (const p of ['/', '/me']) {
    const r = await get(p); const h = await r.text();
    assert.equal(r.headers.get('cache-control'), 'no-store', p);
    assert.ok(!h.includes('__V__'), p);
    for (const m of h.matchAll(/(?:href|src)="([^"]+\.(?:css|js|svg|png|webmanifest)[^"]*)"/g)) assert.ok(m[1].endsWith('?v=' + V), `${p}: ${m[1]}`);
    const logos = [...h.matchAll(/<img[^>]*class="logo[^"]*"[^>]*>/g)].map(m => m[0]);
    assert.ok(logos.length >= 2, p);
    for (const l of logos) { const w = +(l.match(/width="(\d+)"/) || [])[1], hh = +(l.match(/height="(\d+)"/) || [])[1]; assert.ok(w > 0 && w <= 96 && hh > 0 && hh <= 96, `${p}: ${l}`); }
  }
  const js = await (await get('/app.js?v=' + V)).text(); assert.ok(js.includes(`const PAGE_V = '${V}'`));
  assert.ok((await (await get('/me.js')).text()).includes(`./markdown.js?v=${V}`));
  const man = await (await get('/manifest.webmanifest')).json();
  assert.ok(man.icons.length >= 2); for (const i of man.icons) assert.ok(i.src.endsWith('?v=' + V), i.src);
  const fav = await get('/favicon.ico'); assert.equal(fav.status, 200); assert.equal(fav.headers.get('content-type'), 'image/png');
});

test('the app icon is logo C (blue + orange chat bubbles on navy) everywhere', () => {
  const svg = fs.readFileSync(path.join(ROOT, 'public/icon.svg'), 'utf8');
  for (const c of ['#0f172a', '#38bdf8', '#f59e0b']) assert.ok(svg.includes(c), c);
  assert.ok(!/radialGradient|#0aa3c4|#07090d/.test(svg), 'old 1.0.1 picture');
  for (const f of ['icon-192.png', 'icon-512.png']) {
    const b = fs.readFileSync(path.join(ROOT, 'public', f)); assert.equal(b.subarray(1, 4).toString(), 'PNG');
    const n = f.includes('192') ? 192 : 512; assert.equal(b.readUInt32BE(16), n); assert.equal(b.readUInt32BE(20), n);
  }
});

test('Settings in a phone-size browser: no picture wider than 96 px except the intended ones, even with an old cached style and logo; one reload after an update', { skip: canRun ? false : 'no Playwright/Chromium here', timeout: 120000 }, async () => {
  const { setPassword } = await import('../src/adminauth.js');
  setPassword('correct horse battery', 'admin');
  const pw = await import(process.env.MSA_PLAYWRIGHT_PATH);
  const b = await (pw.chromium ? pw : pw.default).chromium.launch({ executablePath: process.env.MSA_CHROMIUM, args: ['--no-sandbox'] });
  const bigPictures = (p) => p.evaluate((allowed) => [...document.querySelectorAll('img')].filter(i => i.offsetParent !== null)
    .map(i => ({ id: i.id, cls: i.className, w: i.getBoundingClientRect().width, h: i.getBoundingClientRect().height }))
    .filter(i => (i.w > 96 || i.h > 96) && !allowed.includes(i.id) && !/\bshot\b/.test(i.cls)), ALLOWED_BIG);
  const signIn = async (p) => {
    await p.goto(`http://127.0.0.1:${s.port}/`);
    await p.click('#loginTabs button[data-t="password"]');
    await p.fill('#lUser', 'admin'); await p.fill('#lPass', 'correct horse battery');
    await p.click('#fPass button[type=submit]'); await p.waitForSelector('#app:not(.hidden)');
  };
  try {
    // 1) normal: header logo 28 px, nothing big on Settings, the icon really is logo C
    const ctx = await b.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true });
    const p = await ctx.newPage(); const errors = []; p.on('pageerror', e => errors.push(e.message));
    await signIn(p);
    await p.click('#nav button[data-v="settings"]');
    await p.waitForFunction(() => !/Checking|Not checked/.test(document.querySelector('#updVer').textContent), null, { timeout: 15000 });
    const logo = await p.locator('header img.logo').boundingBox();
    assert.ok(logo.width <= 64 && logo.height <= 64, JSON.stringify(logo));
    assert.deepEqual(await bigPictures(p), []);
    const px = await p.evaluate(async () => {
      const im = new Image(); im.src = '/icon-192.png'; await im.decode();
      const c = document.createElement('canvas'); c.width = c.height = 192; const g = c.getContext('2d'); g.drawImage(im, 0, 0);
      const d = g.getImageData(0, 0, 192, 192).data; let blue = 0, orange = 0, teal = 0;
      for (let i = 0; i < d.length; i += 4) { const [r, gg, bb] = [d[i], d[i + 1], d[i + 2]];
        if (bb > 200 && gg > 150 && r < 100) blue++; if (r > 200 && gg > 120 && gg < 190 && bb < 60) orange++; if (r < 40 && gg > 140 && bb > 170 && gg < 200) teal++; }
      const m = 96 * 4 * 192 + 20 * 4; return { blue, orange, teal, edge: [d[m], d[m + 1], d[m + 2]] };
    });
    assert.ok(px.blue > 1000 && px.orange > 1000, JSON.stringify(px));
    assert.ok(px.edge[0] < 40 && px.edge[1] < 50 && px.edge[2] < 70, 'navy background ' + px.edge);
    assert.deepEqual(errors, []);
    await ctx.close();
    // 2) what his phone did with 1.0.2: the style file fails or is old, and the logo file is the old size-less picture.
    //    The logo must still stay small (its own width/height), and nothing else on Settings may fill the page.
    const ctx2 = await b.newContext({ viewport: { width: 390, height: 844 }, isMobile: true });
    await ctx2.route(/\/style\.css/, r => r.abort());
    await ctx2.route(/\/icon\.svg/, r => r.fulfill({ status: 200, contentType: 'image/svg+xml', body: OLD_ICON }));
    const p2 = await ctx2.newPage(); await signIn(p2);
    await p2.evaluate(() => document.querySelector('#nav button[data-v="settings"]').click());
    await p2.waitForTimeout(300);
    const l2 = await p2.locator('header img.logo').boundingBox();
    assert.ok(l2.width <= 96 && l2.height <= 96, JSON.stringify(l2));
    assert.deepEqual(await bigPictures(p2), []);
    await ctx2.close();
    // 3) the server runs a newer version than the page: the page reloads by itself exactly once
    const ctx3 = await b.newContext({ viewport: { width: 390, height: 844 } });
    const p3 = await ctx3.newPage(); await signIn(p3);
    let loads = 0; p3.on('load', () => loads++);
    await ctx3.route(/\/api\/overview/, async r => { const res = await r.fetch(); const j = await res.json(); j.version = '9.9.9'; await r.fulfill({ response: res, json: j }); });
    await p3.evaluate(() => document.querySelector('#nav button[data-v="home"]').click());
    await p3.waitForEvent('load', { timeout: 10000 });
    await p3.waitForTimeout(1500);
    await p3.evaluate(() => document.querySelector('#nav button[data-v="home"]').click()); await p3.waitForTimeout(1500);
    assert.equal(loads, 1);
    await ctx3.close();
  } finally { await b.close(); }
});
