// 1.0.6: the browser Google accepts for sign-in. Checked live on 2026-11-09 (made-up addresses, no real account):
// 1.0.4 faked navigator.webdriver with a script and Google refused the sign-in ("This browser or app may not be
// secure"); without the script it went on to the account lookup. 1.0.6 never fakes the flag and runs the full build
// VISIBLE on a virtual screen (Xvfb) as a plain program it attaches to; without Xvfb it falls back to "basic".
// The browser parts run when MSA_PLAYWRIGHT_PATH + MSA_CHROMIUM are set (and Xvfb for the visible ones).
import { setupEnv, until } from './helpers.js';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
const DIR = setupEnv('b106');
import test from 'node:test';
import assert from 'node:assert/strict';
const G = await import('../src/channels/gmweb.js');
const { chooseMode, visibleArgs, findXvfb, freePort, waitDevToolsPort, GoogleMessagesWeb } = G;
const SRC = fs.readFileSync(new URL('../src/channels/gmweb.js', import.meta.url), 'utf8');

test('never fakes navigator.webdriver (the 1.0.4 script Google refused)', () => {
  assert.doesNotMatch(SRC, /defineProperty\([^)]*['"]webdriver['"]/);
  assert.doesNotMatch(SRC, /addInitScript\([^)]*webdriver/);
});
test('mode: visible when a virtual screen is there, basic otherwise, never visible with the headless shell', () => {
  assert.equal(chooseMode({ kind: 'full', xvfb: '/usr/bin/Xvfb' }).mode, 'visible');
  assert.equal(chooseMode({ kind: 'full', xvfb: null }).mode, 'basic');
  assert.match(chooseMode({ kind: 'full', xvfb: null }).why, /Xvfb/);
  assert.equal(chooseMode({ kind: 'shell', xvfb: '/usr/bin/Xvfb' }).mode, 'basic');
  assert.equal(chooseMode({ wanted: 'basic', kind: 'full', xvfb: '/usr/bin/Xvfb' }).mode, 'basic');
  const d = chooseMode({ kind: 'full', xvfb: null, display: ':5' }); assert.equal(d.mode, 'visible'); assert.equal(d.display, ':5');
});
test('the visible browser is started like a normal browser: no automation or headless switches, a fixed local port', () => {
  const a = visibleArgs('/x/gm-profile', [], 41234);
  assert.ok(a.includes('--user-data-dir=/x/gm-profile'));
  assert.ok(a.includes('--remote-debugging-port=41234'), 'a fixed port (port 0 makes the browser report itself as automated)');
  assert.ok(a.includes('--remote-debugging-address=127.0.0.1'), 'local only');
  for (const bad of ['--enable-automation', '--headless', '--remote-debugging-pipe', '--disable-extensions', '--disable-component-update', '--disable-background-networking'])
    assert.ok(!a.some(x => x.startsWith(bad)), 'no ' + bad);
});
test('finding Xvfb and a free port', async () => {
  const fake = path.join(DIR, 'Xvfb'); fs.writeFileSync(fake, '#!/bin/sh\n'); fs.chmodSync(fake, 0o755);
  assert.equal(findXvfb({ MSA_XVFB: fake }), fake);
  const p = await freePort(); assert.ok(p > 1024 && p < 65536);
  assert.equal(await waitDevToolsPort(DIR, null, 300, 0), null, 'no port file → gives up');
  fs.writeFileSync(path.join(DIR, 'DevToolsActivePort'), '45678\n/devtools/browser/x\n');
  assert.equal(await waitDevToolsPort(DIR, null, 300, 0), 45678);
});
test('the installer: "installed" means the full build, and Xvfb is installed on install and update', () => {
  const sh = fs.readFileSync(new URL('../install.sh', import.meta.url), 'utf8');
  assert.match(sh, /elif full_chromium && \[ "\$UPDATE" = 1 \]/);
  assert.doesNotMatch(sh, /ls -d "\$BROWSERS"\/chromium-\*\/ >\/dev\/null 2>&1 && \[ "\$UPDATE" = 1 \]/, 'the old "any chromium folder" skip is gone');
  assert.match(sh, /apt-get[^\n]*install -y[^\n]*xvfb/);
  const fn = sh.match(/^full_chromium\(\) \{.*\}$/m)[0];
  const root = path.join(DIR, 'browsers');
  const check = () => spawnSync('bash', ['-c', `BROWSERS='${root}'; ${fn}; full_chromium && echo yes || echo no`], { encoding: 'utf8' }).stdout.trim();
  fs.mkdirSync(path.join(root, 'chromium_headless_shell-1243/chrome-headless-shell-linux64'), { recursive: true });
  fs.writeFileSync(path.join(root, 'chromium_headless_shell-1243/chrome-headless-shell-linux64/chrome-headless-shell'), '');
  fs.mkdirSync(path.join(root, 'chromium-1243'), { recursive: true });
  assert.equal(check(), 'no', 'only the shell (and an empty chromium folder) → install');
  fs.mkdirSync(path.join(root, 'chromium-1243/chrome-linux64'), { recursive: true }); fs.writeFileSync(path.join(root, 'chromium-1243/chrome-linux64/chrome'), '');
  assert.equal(check(), 'yes');
});
test('the dashboard says which browser runs', () => {
  const app = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8'), html = fs.readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
  assert.match(html, /id="browserLine"/); assert.match(html, /id="diagBrowser"/);
  const fns = new Function(app.match(/function browserWords[\s\S]*?\n}\n(?=\/\/ -{5})/)[0] + '; return { browserWords, browserDiag };')();
  assert.equal(fns.browserWords({ mode: 'visible', label: 'full (visible)' }), 'Browser: full (visible)');
  assert.equal(fns.browserWords({ mode: 'basic', label: 'basic' }), 'Browser: basic');
  assert.match(fns.browserDiag({ mode: 'visible', label: 'full (visible)', version: '153', screen: ':3' }), /^Browser: full \(visible\) · Chromium 153 · virtual screen :3$/);
  assert.match(fns.browserDiag({ mode: 'basic', label: 'basic', why: 'no virtual screen (Xvfb) on this server; Update now installs it' }), /Browser: basic · .*Xvfb/);
  assert.equal(fns.browserDiag(null), 'Browser: not started');
});

// ---------------- with a real browser ----------------
const PW = process.env.MSA_PLAYWRIGHT_PATH, CHROME = process.env.MSA_CHROMIUM;
const canRun = PW && CHROME && fs.existsSync(CHROME);
const hasX = !!findXvfb();
import { fakeMessages } from './fake-gm.js';
const { st, fake } = fakeMessages();
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
async function withFake(fn) { await new Promise(r => fake.listen(0, '127.0.0.1', r)); try { return await fn(`http://127.0.0.1:${fake.address().port}/web`); } finally { fake.close(); fake.closeAllConnections?.(); } }
const newDriver = (base, extra = {}) => new GoogleMessagesWeb({ dataDir: fs.mkdtempSync(path.join(DIR, 'd-')), url: base, pollMs: 300, healthMs: 500, settleMs: 100,
  isSeen: () => false, markSeen: () => {}, needsBaseline: () => false, baselineDone: () => {}, launch: { executablePath: CHROME }, ...extra });

test('visible: a real window on a virtual screen, webdriver false by itself, picture + taps work, all of it stops', { skip: canRun && hasX ? false : 'needs Playwright/Chromium and Xvfb', timeout: 120000 }, () => withFake(async (base) => {
  st.mode = 'welcome';
  const d = newDriver(base);
  try {
    await d.start();
    await until(() => d.status().state === 'signed_out', 30000, 'signed_out');
    const b = d.status().browserInfo;
    assert.equal(b.mode, 'visible'); assert.equal(b.label, 'full (visible)'); assert.match(b.screen, /^:\d+$/); assert.equal(b.automatedFlag, false);
    const fp = await d.page.evaluate(() => ({ wd: navigator.webdriver, ua: navigator.userAgent, real: outerHeight > innerHeight, native: String(Object.getOwnPropertyDescriptor(Navigator.prototype, 'webdriver')?.get) }));
    assert.equal(fp.wd, false); assert.doesNotMatch(fp.ua, /Headless/); assert.ok(fp.real, 'a real window (browser bars above the page)');
    assert.match(fp.native, /\[native code\]/, 'the flag is the browser\'s own, not a script');
    const cmd = fs.readFileSync(`/proc/${d.proc.pid}/cmdline`, 'utf8');
    assert.doesNotMatch(cmd, /--enable-automation|--headless|--remote-debugging-pipe/);
    const jpg = await d.screen(); assert.ok(jpg && jpg[0] === 0xff && jpg.length > 1000, 'the live picture');
    const v = await d.viewSize(); assert.ok(v.width >= 1000 && v.height >= 600, 'the real page size: ' + JSON.stringify(v));
    const clicksBefore = st.signInClicks;
    const pos = await d.page.evaluate(() => { const r = [...document.querySelectorAll('button')].find(x => /sign in/i.test(x.innerText)).getBoundingClientRect(); return { x: (r.x + r.width / 2) / innerWidth, y: (r.y + r.height / 2) / innerHeight }; });
    await d.input({ type: 'click', x: pos.x, y: pos.y });
    await until(() => st.signInClicks > clicksBefore, 5000, 'the tap landed on Sign in');
    const chrome = d.proc.pid, xv = d.xvfb.pid;
    await d.restart();
    assert.ok(!alive(chrome), 'Restart browser closes the old browser'); assert.ok(d.proc && d.proc.pid !== chrome);
    const chrome2 = d.proc.pid, xv2 = d.xvfb.pid; assert.notEqual(xv2, xv, 'and starts a fresh virtual screen');
    await d.stop();
    await until(() => !alive(chrome2) && !alive(xv2), 8000, 'browser and virtual screen gone after stop');
  } finally { await d.stop().catch(() => {}); }
}));

test('basic (no virtual screen): headless, the flag is still the browser\'s own; a broken Xvfb falls back to basic', { skip: canRun ? false : 'needs Playwright/Chromium', timeout: 120000 }, () => withFake(async (base) => {
  st.mode = 'welcome';
  const d = newDriver(base, { mode: 'basic' });
  try {
    await d.start(); await until(() => d.status().state === 'signed_out', 30000, 'signed_out');
    assert.equal(d.status().browserInfo.label, 'basic');
    const fp = await d.page.evaluate(() => ({ wd: navigator.webdriver, native: String(Object.getOwnPropertyDescriptor(Navigator.prototype, 'webdriver')?.get) }));
    assert.equal(fp.wd, false); assert.match(fp.native, /\[native code\]/);
  } finally { await d.stop().catch(() => {}); }
  const old = process.env.MSA_XVFB; process.env.MSA_XVFB = '/bin/false';
  const e = newDriver(base);
  try {
    await e.start(); await until(() => e.status().state === 'signed_out', 30000, 'signed_out (fallback)');
    const b = e.status().browserInfo; assert.equal(b.mode, 'basic'); assert.match(b.why, /did not start/);
  } finally { await e.stop().catch(() => {}); if (old === undefined) delete process.env.MSA_XVFB; else process.env.MSA_XVFB = old; }
}));
