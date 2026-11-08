// 1.0.3: (1) Settings → Updates: a check ALWAYS ends (up to date / available / a short error), even when the source
// hangs, answers 404, sends a broken version.json or stalls halfway; (2) the update source can be changed in the
// dashboard and with `sudo messageassistant update-source show|set|reset`, https only, and the ROOT updater uses the
// saved address too (sha256 still checked, still no downgrades).
import { setupEnv, client, until } from './helpers.js';
const dataDir = setupEnv('upd103', { MSA_UPDATE_CHECK_MS: '1500', MSA_TEST_DEFAULT_SOURCE: 'http://127.0.0.1:9/none' });
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const VERSION = fs.readFileSync(path.join(APP, 'VERSION'), 'utf8').trim();

// one stand-in update source; its behaviour is switched per test
let MODE = 'ok', SRCVER = '9.9.9', HITS = 0;
const fake = http.createServer((q, s) => {
  if (new URL(q.url, 'http://x').pathname !== '/docs/version.json') { s.writeHead(404); return s.end(); }
  HITS++;
  if (MODE === 'hang') return;
  if (MODE === '404') { s.writeHead(404); return s.end('no'); }
  if (MODE === 'badjson') { s.writeHead(200, { 'Content-Type': 'application/json' }); return s.end('<html>not json'); }
  if (MODE === 'stall') { s.writeHead(200, { 'Content-Type': 'application/json' }); return s.write('{"version":'); }
  s.writeHead(200, { 'Content-Type': 'application/json' }); s.end(JSON.stringify({ version: SRCVER, notes: 'n' }));
});
await new Promise(r => fake.listen(0, '127.0.0.1', r));
const FAKE = `http://127.0.0.1:${fake.address().port}/docs`;
test.after(() => { fake.closeAllConnections?.(); fake.close(); });
const upd = await import('../src/updates.js');

test('update source: https only, cleaned up, a GitHub repo link means its /docs folder', () => {
  assert.equal(upd.checkSource(' https://updates.example.com/docs/ '), 'https://updates.example.com/docs');
  assert.equal(upd.checkSource('https://updates.example.com/docs/version.json'), 'https://updates.example.com/docs');
  assert.equal(upd.checkSource('https://github.com/someone/Message-Assistant'), 'https://raw.githubusercontent.com/someone/Message-Assistant/main/docs');
  assert.equal(upd.checkSource('https://github.com/someone/Message-Assistant.git'), 'https://raw.githubusercontent.com/someone/Message-Assistant/main/docs');
  assert.equal(upd.checkSource('https://github.com/someone/repo/tree/beta/dist'), 'https://raw.githubusercontent.com/someone/repo/beta/dist');
  for (const bad of ['http://updates.example.com', 'ftp://x.example.com', 'javascript:alert(1)', 'https://user:pw@x.example.com/d', 'https://x.example.com/a b', 'https://x.example.com/?q=1', 'https://localhost/x', '', 'https://x.example.com/' + 'a'.repeat(400)])
    assert.throws(() => upd.checkSource(bad), /https|valid|address|long/, bad);
  assert.throws(() => upd.checkSource('http://updates.example.com'), /must start with https/);
});

test('a check always ends: hang, 404, broken JSON and a stalled answer each end with a short reason, fast', async () => {
  upd.resetSource();
  process.env.MSA_UPDATE_SOURCE = FAKE;
  for (const [mode, why] of [['hang', /no answer in time/], ['404', /no version\.json there \(404\)/], ['badjson', /version\.json is not valid/], ['stall', /no answer in time/]]) {
    MODE = mode;
    const t = Date.now(); const i = await upd.info({ fresh: true }); const ms = Date.now() - t;
    assert.ok(ms < 1500 + 1500, `${mode}: took ${ms} ms`);
    assert.equal(i.state, 'error', mode); assert.equal(i.words, 'Couldn\'t reach the update source');
    assert.match(i.detail, why, mode); assert.equal(i.latest, null);
  }
  MODE = 'ok'; SRCVER = '9.9.9';
  let i = await upd.info({ fresh: true });
  assert.equal(i.state, 'available'); assert.equal(i.words, '9.9.9 available — Update now'); assert.equal(i.checked_from, FAKE.replace('http://', ''));
  SRCVER = VERSION; i = await upd.info({ fresh: true });
  assert.equal(i.state, 'up_to_date'); assert.equal(i.words, `Up to date (${VERSION})`);
  SRCVER = '0.0.1'; i = await upd.info({ fresh: true });
  assert.equal(i.state, 'up_to_date', 'an OLDER version at the source is "up to date", never a downgrade'); assert.equal(i.update_available, false);
  delete process.env.MSA_UPDATE_SOURCE;
});

test('two checks at the same time share one look at the source', async () => {
  process.env.MSA_UPDATE_SOURCE = FAKE; MODE = 'hang';
  HITS = 0; const t = Date.now(); const [a, b] = await Promise.all([upd.info({ fresh: true }), upd.info({ fresh: true })]);
  assert.equal(HITS, 1, 'one request to the source'); assert.equal(a.state, 'error'); assert.equal(b.state, 'error'); assert.ok(Date.now() - t < 3000);
  MODE = 'ok'; delete process.env.MSA_UPDATE_SOURCE;
});

test('"Update now" that never started on the server is reported, not "starting…" forever', async () => {
  upd.requestNow();
  let i = await upd.info(); assert.equal(i.pending, true); assert.equal(i.stuck, false);
  const old = (Date.now() - 10 * 60 * 1000) / 1000; fs.utimesSync(path.join(dataDir, 'update-request'), old, old);
  i = await upd.info(); assert.equal(i.pending, false); assert.equal(i.stuck, true);
  fs.rmSync(path.join(dataDir, 'update-request'));
});

test('dashboard: save / show / reset the update source (admin only, CSRF, audit), and Check uses it first', async () => {
  const { main } = await import('../src/server.js');
  const { setPassword } = await import('../src/adminauth.js');
  const s = await main({ port: 0, host: '127.0.0.1' });
  try {
    setPassword('correct horse battery', 'admin');
    const anon = client(`http://127.0.0.1:${s.port}`);
    assert.equal((await anon.post('/api/update/source', { url: 'https://evil.example.com' })).status, 401);
    const c = client(`http://127.0.0.1:${s.port}`);
    assert.equal((await c.post('/api/login/password', { username: 'admin', password: 'correct horse battery' })).status, 200);
    let r = await c.post('/api/update/source', { url: 'http://updates.example.com' });
    assert.equal(r.status, 400); assert.match(r.data.error, /must start with https/);
    assert.ok(!fs.existsSync(path.join(dataDir, 'update-source')));
    r = await c.post('/api/update/source', { url: 'https://updates.example.com/docs/' });
    assert.equal(r.status, 200); assert.equal(r.data.source, 'https://updates.example.com/docs');
    assert.equal(fs.readFileSync(path.join(dataDir, 'update-source'), 'utf8'), 'https://updates.example.com/docs\n');
    assert.deepEqual(r.data.sources, ['https://updates.example.com/docs', upd.GITHUB_DOCS], 'his address first, then the default');
    MODE = 'ok'; SRCVER = '9.9.9';
    r = await c.post('/api/update/source', { url: FAKE });                       // (test mode allows a local http stand-in)
    let u = (await c.post('/api/update/check')).data;
    assert.equal(u.state, 'available'); assert.equal(u.source, FAKE); assert.equal(u.checked_from, FAKE.replace('http://', ''));
    u = (await c.get('/api/update')).data; assert.equal(u.source_default, upd.GITHUB_DOCS);
    r = await c.post('/api/update/source/reset'); assert.equal(r.status, 200); assert.equal(r.data.source, '');
    assert.ok(!fs.existsSync(path.join(dataDir, 'update-source')));
    u = (await c.post('/api/update/check')).data; assert.equal(u.state, 'error', 'back on the (unreachable in tests) default');
    const { all } = await import('../src/db.js');
    assert.ok(all("SELECT detail FROM audit WHERE action = 'update.source'").length >= 2);
    c.forgetCsrf(); assert.equal((await c.post('/api/update/source', { url: 'https://x.example.com' })).status, 403, 'CSRF protected');
  } finally { await s.stop(); }
});

test('CLI: update-source show | set <url> | reset', () => {
  const run = (...a) => spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', path.join(APP, 'src', 'cli.js'), 'update-source', ...a], { env: { ...process.env, MSA_TEST_MODE: '1' }, encoding: 'utf8', timeout: 30000 });
  let o = run('show'); assert.equal(o.status, 0, o.stderr); assert.match(o.stdout, /\(default\)/);
  o = run('set', 'http://plain.example.com'); assert.equal(o.status, 1); assert.match(o.stdout, /Not changed: The address must start with https/);
  o = run('set', 'https://updates.example.com/docs'); assert.equal(o.status, 0); assert.match(o.stdout, /saved: https:\/\/updates\.example\.com\/docs/);
  assert.match(run('show').stdout, /Update source: https:\/\/updates\.example\.com\/docs\nTried in this order: https:\/\/updates\.example\.com\/docs  →/);
  o = run('reset'); assert.equal(o.status, 0); assert.match(o.stdout, /reset to the default/);
  assert.ok(!fs.existsSync(path.join(dataDir, 'update-source')));
});

// ---------- the root updater reads the saved address ----------
const T = fs.mkdtempSync(path.join(dataDir, 'u-')), R = path.join(T, 'render');
const ren = spawnSync('bash', [path.join(APP, 'install.sh')], { env: { ...process.env, DRY_RUN: '1', MSA_RENDER_DIR: R, MSA_DOMAIN: 'msg.example.com', MSA_SKIP_BROWSER: '1' }, encoding: 'utf8', timeout: 60000 });
const OPT = path.join(T, 'opt'), DATA = path.join(T, 'data'), ETC = path.join(T, 'etc');
const skip = ren.status === 0 ? false : 'install.sh did not render';
const render = (allowLocalHttp) => {
  let u = fs.readFileSync(path.join(R, 'usr/local/sbin/messageassistant-update'), 'utf8')
    .replaceAll('/opt/messageassistant', OPT).replaceAll('/var/lib/messageassistant', DATA).replaceAll('/etc/messageassistant', ETC)
    .replaceAll('/run/messageassistant-update.lock', path.join(T, 'lock')).replace(/chown [^ ]+ /g, 'true ')
    .replaceAll('https://raw.githubusercontent.com/eliazer2499-max/Message-Assistant/main/docs', 'http://127.0.0.1:9/none');
  // the real check is https only; to reach the local stand-in, the test lets http://127.0.0.1 through as well
  if (allowLocalHttp) u = u.replace("grep -Eq '^https://[A-Za-z0-9.-]+[.][A-Za-z]{2,}(:[0-9]{1,5})?", "grep -Eq '^(http://127[.]0[.]0[.]1|https://[A-Za-z0-9.-]+[.][A-Za-z]{2,})(:[0-9]{1,5})?");
  const f = path.join(T, allowLocalHttp ? 'updater-local.sh' : 'updater.sh'); fs.writeFileSync(f, u); return f;
};
let REL = { version: '9.9.9', badSha: false };
const files = new Map();
function makeRelease() {
  const w = fs.mkdtempSync(path.join(T, 'rel-')), d = path.join(w, 'messageassistant');
  fs.mkdirSync(d); fs.writeFileSync(path.join(d, 'VERSION'), REL.version + '\n');
  fs.writeFileSync(path.join(d, 'install.sh'), `echo "installer ran" >> ${T}/installs.log\nmkdir -p ${OPT}/releases/${REL.version} && echo ${REL.version} > ${OPT}/releases/${REL.version}/VERSION && ln -sfn ${OPT}/releases/${REL.version} ${OPT}/current\n`);
  spawnSync('tar', ['-czf', path.join(w, 'app.tgz'), '-C', w, 'messageassistant']);
  const tgz = fs.readFileSync(path.join(w, 'app.tgz'));
  const sha = REL.badSha ? 'f'.repeat(64) : crypto.createHash('sha256').update(tgz).digest('hex');
  files.clear();
  files.set('/rel/version.json', JSON.stringify({ version: REL.version, sha256: sha }));
  files.set(`/rel/messageassistant-${REL.version}.tar.gz`, tgz);
  files.set(`/rel/messageassistant-${REL.version}.tar.gz.sha256`, sha + '  x\n');
}
const rsrv = http.createServer((q, s) => { const b = files.get(new URL(q.url, 'http://x').pathname); if (!b) { s.writeHead(404); return s.end(); } s.end(b); });
await new Promise(r => rsrv.listen(0, '127.0.0.1', r));
const RSRC = `http://127.0.0.1:${rsrv.address().port}/rel`;
test.after(() => rsrv.close());
function freshServer(cur = VERSION) {
  for (const d of [OPT, DATA]) fs.rmSync(d, { recursive: true, force: true }); fs.rmSync(path.join(T, 'installs.log'), { force: true });
  fs.mkdirSync(path.join(OPT, 'releases', cur), { recursive: true }); fs.writeFileSync(path.join(OPT, 'releases', cur, 'VERSION'), cur + '\n');
  fs.symlinkSync(path.join(OPT, 'releases', cur), path.join(OPT, 'current'));
  fs.mkdirSync(DATA, { recursive: true }); fs.mkdirSync(ETC, { recursive: true }); fs.writeFileSync(path.join(ETC, 'env'), '');
}
const runUpdater = (script) => new Promise((resolve) => {
  const c = spawn('bash', [script], { env: { PATH: process.env.PATH, INVOCATION_ID: 'test' } });   // no MSA_SOURCE: only the saved address
  let out = ''; c.stdout.on('data', b => out += b); c.stderr.on('data', b => out += b);
  const k = setTimeout(() => c.kill('SIGKILL'), 60000); c.on('close', (status) => { clearTimeout(k); resolve({ status, out }); });
});
const current = () => fs.readFileSync(path.join(OPT, 'current', 'VERSION'), 'utf8').trim();
const installed = () => fs.existsSync(path.join(T, 'installs.log'));

test('root updater: installs from the SAVED update source (sha256-checked)', { skip }, async () => {
  freshServer(); REL = { version: '9.9.9', badSha: false }; makeRelease();
  fs.writeFileSync(path.join(DATA, 'update-source'), RSRC + '\n');
  const o = await runUpdater(render(true));
  assert.equal(o.status, 0, o.out); assert.ok(installed(), o.out); assert.equal(current(), '9.9.9');
  assert.match(o.out, new RegExp('newest at ' + RSRC.replace(/[.]/g, '[.]') + ': 9\\.9\\.9'));
});

test('root updater: the saved source still cannot downgrade, and a bad sha256 is refused', { skip }, async () => {
  freshServer(); REL = { version: '0.0.1', badSha: false }; makeRelease();
  fs.writeFileSync(path.join(DATA, 'update-source'), RSRC + '\n');
  let o = await runUpdater(render(true));
  assert.equal(o.status, 0); assert.match(o.out, /Up to date/); assert.ok(!installed()); assert.equal(current(), VERSION);
  freshServer(); REL = { version: '9.9.9', badSha: true }; makeRelease();
  fs.writeFileSync(path.join(DATA, 'update-source'), RSRC + '\n');
  o = await runUpdater(render(true));
  assert.notEqual(o.status, 0); assert.match(o.out, /did not match its sha256; not installing/); assert.ok(!installed()); assert.equal(current(), VERSION);
});

test('root updater: a saved address that is not https (or has junk in it) is ignored', { skip }, async () => {
  for (const bad of [RSRC, 'https://x.example.com/$(touch /tmp/pwned-msa)', 'file:///etc/passwd']) {
    freshServer(); REL = { version: '9.9.9', badSha: false }; makeRelease();
    fs.writeFileSync(path.join(DATA, 'update-source'), bad + '\n');
    const o = await runUpdater(render(false));
    assert.match(o.out, /Ignoring the saved update source/, bad); assert.ok(!installed(), bad); assert.equal(current(), VERSION);
  }
  assert.ok(!fs.existsSync('/tmp/pwned-msa'));
});

test('installer: the helper knows update-source (passes it to the app CLI) and lists it', { skip }, () => {
  const h = fs.readFileSync(path.join(R, 'usr/local/bin/messageassistant'), 'utf8');
  assert.match(h, /\|check-update\|update-source\|portal\) shift_cmd/);
  assert.match(h, /update-source show\|set <url>\|reset/);
});
