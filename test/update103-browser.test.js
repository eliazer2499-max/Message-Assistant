// 1.0.3 with a real headless Chromium (skipped without one): Settings → Updates never stays on "Checking…", and the
// update source can be changed and reset from the page.
import { setupEnv } from './helpers.js';
const dataDir = setupEnv('upd103b', { MSA_UPDATE_CHECK_MS: '3000', MSA_TEST_DEFAULT_SOURCE: 'http://127.0.0.1:9/none' });
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
const canRun = process.env.MSA_PLAYWRIGHT_PATH && process.env.MSA_CHROMIUM && fs.existsSync(process.env.MSA_CHROMIUM);
let MODE = 'hang';
const fake = http.createServer((q, s) => {
  if (new URL(q.url, 'http://x').pathname !== '/docs/version.json') { s.writeHead(404); return s.end(); }
  if (MODE === 'hang') return;
  s.writeHead(200, { 'Content-Type': 'application/json' }); s.end(JSON.stringify({ version: '9.9.9', notes: 'Faster checks' }));
});

test('Settings → Updates in a phone-size browser: a hanging source ends in a clear error; Save/Reset the source', { skip: canRun ? false : 'no Playwright/Chromium here', timeout: 120000 }, async () => {
  await new Promise(r => fake.listen(0, '127.0.0.1', r));
  const FAKE = `http://127.0.0.1:${fake.address().port}/docs`;
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
    await p.click('#nav button[data-v="settings"]');
    // 1) the default source is unreachable here: the line must leave "Checking…" (on its own, within 15 s)
    await p.waitForFunction(() => !/Checking/.test(document.querySelector('#updVer').textContent), null, { timeout: 15000 });
    assert.equal(await p.textContent('#updVer'), 'Couldn\'t reach the update source');
    // 2) a source that hangs: Check now ends within 15 s, with the reason
    await p.selectOption('#usrc', 'custom'); assert.equal(await p.isVisible('#usrcLink'), true);
    await p.fill('#usrcLink', 'http://example.com/docs'); await p.click('#usrcSave');
    await p.waitForFunction(() => /https/.test(document.querySelector('#usrcMsg').textContent));
    assert.match(await p.textContent('#usrcMsg'), /must start with https/);
    await p.fill('#usrcLink', FAKE); await p.click('#usrcSave');
    await p.waitForFunction(() => /Saved/.test(document.querySelector('#usrcMsg').textContent));
    const t = Date.now();
    await p.waitForFunction(() => document.querySelector('#updVer').textContent === 'Checking…', null, { timeout: 5000 }).catch(() => {});
    await p.waitForFunction(() => document.querySelector('#updVer').textContent !== 'Checking…', null, { timeout: 15000 });
    assert.ok(Date.now() - t < 15000);
    assert.equal(await p.textContent('#updVer'), 'Couldn\'t reach the update source');
    assert.match(await p.textContent('#updSub'), /no answer in time/);
    assert.match(await p.textContent('#usrcOrder'), new RegExp(FAKE.replace('http://', '').replace(/[.]/g, '[.]') + '.*first'));
    // 3) the source answers: one tap on Check now shows the new version and turns Update now on
    MODE = 'ok'; await p.click('#updCheck');
    await p.waitForFunction(() => /available/.test(document.querySelector('#updVer').textContent), null, { timeout: 15000 });
    assert.equal(await p.textContent('#updVer'), '9.9.9 available — Update now');
    assert.equal(await p.isDisabled('#updNow'), false);
    // 4) Reset to default
    await p.click('#usrcReset');
    await p.waitForFunction(() => /default/.test(document.querySelector('#usrcMsg').textContent));
    assert.equal(await p.inputValue('#usrc'), 'default'); assert.equal(await p.isVisible('#usrcLink'), false);
    assert.ok(!fs.existsSync(path.join(dataDir, 'update-source')));
    assert.deepEqual(errors, []);
  } finally { await b.close(); await s.stop(); fake.closeAllConnections?.(); fake.close(); }
});
