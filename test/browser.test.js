// The assistant's own browser: users take turns (one can't hog it), a time budget per message, private addresses
// refused, and (when a Chromium is available) the real tools on a local page.
import { setupEnv, until, sleep } from './helpers.js';
import http from 'node:http';
import fs from 'node:fs';
setupEnv('browser');
import test from 'node:test';
import assert from 'node:assert/strict';
const B = await import('../src/browser.js');
const db = await import('../src/db.js');
const { loadMasterKey } = await import('../src/crypto.js');
const { cfg } = await import('../src/config.js');
loadMasterKey(cfg.dataDir); db.openDb();
const { execTool } = await import('../src/tools/index.js');

test('users take turns: a second person does not wait behind all of the first person\'s steps', async () => {
  const order = [];
  const job = (u, n) => B.inBrowserQueue(u, async () => { order.push(`${u}.${n}`); await sleep(30); });
  const all = [job(1, 1), job(1, 2), job(1, 3), job(2, 1), job(3, 1)];
  await Promise.all(all);
  assert.deepEqual(order.slice(0, 3), ['1.1', '2.1', '3.1'], order.join(' '));
  assert.deepEqual(order.slice(3), ['1.2', '1.3']);
});

test('time budget per message: once used up, browser tools stop and say so', async () => {
  db.setSetting('browser_job_seconds', '30');
  const r = await execTool('browser_read', {}, { userId: 1, browserMs: 31000 });
  assert.match(r.error, /Browser time for this message is used up/);
});

test('switched off by the admin → a clear answer', async () => {
  db.setSetting('browser_enabled', '0');
  const r = await execTool('browser_open', { url: 'example.com' }, { userId: 1 });
  assert.match(r.error, /switched off/);
  db.setSetting('browser_enabled', '1');
});

test('private and local addresses are refused; words become a web search', async () => {
  for (const u of ['http://127.0.0.1:8788/api/users', 'http://localhost/', 'http://192.168.1.1/', 'http://[::1]/', 'file:///etc/passwd']) {
    await assert.rejects(B.assertPublicUrl(u), /private|Only http/, u);
  }
  assert.match(B.cleanUrl('best pizza in Monsey'), /^https:\/\/html\.duckduckgo\.com\/html\/\?q=best%20pizza%20in%20Monsey$/);
  assert.equal(B.cleanUrl('example.com/a'), 'https://example.com/a');
  const r = await execTool('web_fetch', { url: 'http://127.0.0.1:1/' }, { userId: 1 });
  assert.match(r.error, /private/);
});

const PW = process.env.MSA_PLAYWRIGHT_PATH, CHROME = process.env.MSA_CHROMIUM;
test('real browser tools on a local page (open, read, type + submit, click, screenshot)', { skip: PW && CHROME && fs.existsSync(CHROME) ? false : 'no Playwright/Chromium here', timeout: 90000 }, async () => {
  process.env.MSA_ALLOW_LOCAL = '1'; cfg.chromium = CHROME;
  const site = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    res.writeHead(200, { 'Content-Type': 'text/html' });
    if (u.pathname === '/result') return res.end(`<h1>Results for ${String(u.searchParams.get('q')).replace(/</g, '')}</h1><a href="/detail">Open detail</a>`);
    if (u.pathname === '/detail') return res.end('<h1>Detail page</h1><p>The answer is 42.</p>');
    res.end('<h1>Test shop</h1><form action="/result"><input name="q" placeholder="Search"><button>Go</button></form>');
  });
  await new Promise(r => site.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${site.address().port}`;
  const ctx = { userId: 7, browserMs: 0 };
  try {
    let r = await execTool('browser_open', { url: base + '/' }, ctx);
    assert.equal(r.title, ''); assert.match(r.text, /Test shop/);
    const box = /\[(\d+)\] box: Search/.exec(r.elements); assert.ok(box, r.elements);
    r = await execTool('browser_type', { element: Number(box[1]), text: 'blue socks', submit: true }, ctx);
    assert.match(r.text, /Results for blue socks/);
    const link = /\[(\d+)\] link: Open detail/.exec(r.elements);
    r = await execTool('browser_click', { element: Number(link[1]) }, ctx);
    assert.match(r.text, /The answer is 42/);
    assert.match(r.url, /\/detail$/);
    r = await execTool('browser_type', { element: 1, text: '4111 1111 1111 1111' }, ctx);
    assert.match(r.error, /card number/);
    r = await execTool('browser_screenshot', {}, ctx);
    assert.ok(r._see && r._see[0].mime === 'image/jpeg' && r._see[0].data.length > 1000, 'the AI gets the picture');
    assert.ok(ctx.browserMs > 0);
    assert.equal(db.get('SELECT browser_ms FROM usage WHERE user_id=7').browser_ms > 0, true);
  } finally { await B.shutdown(); site.close(); }
});
