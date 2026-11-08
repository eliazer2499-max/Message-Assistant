// 1.0.2: the root updater (/usr/local/sbin/messageassistant-update, rendered from install.sh) against a local
// stand-in release source: newer only (no downgrade), sha256 must match, a failed install leaves the running version,
// and "Update now" can start nothing but that one updater. Plus the once-a-day check (badge + one text, no install).
import { setupEnv, until } from './helpers.js';
const dataDir = setupEnv('updater');
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import { spawnSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const T = fs.mkdtempSync(path.join(dataDir, 'u-'));
const R = path.join(T, 'render');

// render install.sh's files (dry run: nothing on this machine changes)
const ren = spawnSync('bash', [path.join(APP, 'install.sh')], { env: { ...process.env, DRY_RUN: '1', MSA_RENDER_DIR: R, MSA_DOMAIN: 'msg.example.com', MSA_SKIP_BROWSER: '1' }, encoding: 'utf8', timeout: 60000 });
const OPT = path.join(T, 'opt'), DATA = path.join(T, 'data'), ETC = path.join(T, 'etc');
let updater = '';
if (ren.status === 0) {
  updater = fs.readFileSync(path.join(R, 'usr/local/sbin/messageassistant-update'), 'utf8')
    .replaceAll('/opt/messageassistant', OPT).replaceAll('/var/lib/messageassistant', DATA).replaceAll('/etc/messageassistant', ETC)
    .replaceAll('/run/messageassistant-update.lock', path.join(T, 'lock')).replace(/chown [^ ]+ /g, 'true ')
    .replaceAll('https://raw.githubusercontent.com/eliazer2499-max/Message-Assistant/main/docs', 'http://127.0.0.1:9/none');   // never the real repo in a test
  fs.writeFileSync(path.join(T, 'updater.sh'), updater);
}

// a release source: version.json + messageassistant-<v>.tar.gz (+ .sha256) whose install.sh just records the call
let REL = { version: '9.9.9', badSha: false, installExit: 0 };
const files = new Map();
function makeRelease() {
  const w = fs.mkdtempSync(path.join(T, 'rel-')), d = path.join(w, 'messageassistant');
  fs.mkdirSync(d);
  fs.writeFileSync(path.join(d, 'VERSION'), REL.version + '\n');
  fs.writeFileSync(path.join(d, 'install.sh'), `echo "installer ran: MSA_UPDATE=$MSA_UPDATE" >> ${T}/installs.log\nif [ ${REL.installExit} = 0 ]; then mkdir -p ${OPT}/releases/${REL.version} && echo ${REL.version} > ${OPT}/releases/${REL.version}/VERSION && ln -sfn ${OPT}/releases/${REL.version} ${OPT}/current; fi\nexit ${REL.installExit}\n`);
  spawnSync('tar', ['-czf', path.join(w, 'app.tgz'), '-C', w, 'messageassistant']);
  const tgz = fs.readFileSync(path.join(w, 'app.tgz'));
  const sha = REL.badSha ? 'f'.repeat(64) : crypto.createHash('sha256').update(tgz).digest('hex');
  files.clear();
  files.set('/version.json', JSON.stringify({ version: REL.version, sha256: sha, notes: 'test notes' }));
  files.set(`/messageassistant-${REL.version}.tar.gz`, tgz);
  files.set(`/messageassistant-${REL.version}.tar.gz.sha256`, sha + '  messageassistant-' + REL.version + '.tar.gz\n');
}
const srv = http.createServer((q, s) => { const b = files.get(new URL(q.url, 'http://x').pathname); if (!b) { s.writeHead(404); return s.end(); } s.end(b); });
await new Promise(r => srv.listen(0, '127.0.0.1', r));
const SRC = `http://127.0.0.1:${srv.address().port}`;
test.after(() => srv.close());

function freshServer(cur = '1.0.2') {
  fs.rmSync(OPT, { recursive: true, force: true }); fs.rmSync(DATA, { recursive: true, force: true }); fs.rmSync(path.join(T, 'installs.log'), { force: true });
  fs.mkdirSync(path.join(OPT, 'releases', cur), { recursive: true }); fs.writeFileSync(path.join(OPT, 'releases', cur, 'VERSION'), cur + '\n');
  fs.symlinkSync(path.join(OPT, 'releases', cur), path.join(OPT, 'current'));
  fs.mkdirSync(DATA, { recursive: true }); fs.mkdirSync(ETC, { recursive: true }); fs.writeFileSync(path.join(ETC, 'env'), '');
}
// async: the stand-in source runs in this same process
const runUpdater = () => new Promise((resolve) => {
  const c = spawn('bash', [path.join(T, 'updater.sh')], { env: { PATH: process.env.PATH, MSA_SOURCE: SRC, INVOCATION_ID: 'test' } });
  let out = ''; c.stdout.on('data', b => out += b); c.stderr.on('data', b => out += b);
  const k = setTimeout(() => c.kill('SIGKILL'), 60000);
  c.on('close', (status) => { clearTimeout(k); resolve({ status, stdout: out, stderr: '' }); });
});
const current = () => fs.readFileSync(path.join(OPT, 'current', 'VERSION'), 'utf8').trim();
const installed = () => fs.existsSync(path.join(T, 'installs.log'));
const status = () => JSON.parse(fs.readFileSync(path.join(DATA, 'update-status.json'), 'utf8'));
const skip = ren.status === 0 ? false : 'install.sh did not render: ' + (ren.stderr || '').slice(-200);

test('updater: a newer version is downloaded, sha256-checked and installed in update mode', { skip }, async () => {
  freshServer('1.0.2'); REL = { version: '1.0.3', badSha: false, installExit: 0 }; makeRelease();
  const o = await runUpdater();
  assert.equal(o.status, 0, o.stdout + o.stderr);
  assert.ok(installed(), o.stdout + o.stderr);
  assert.match(fs.readFileSync(path.join(T, 'installs.log'), 'utf8'), /MSA_UPDATE=1/);
  assert.equal(current(), '1.0.3');
});

test('updater: the same or an older version is never installed (no downgrade)', { skip }, async () => {
  for (const v of ['1.0.2', '1.0.1', '0.9.9']) {
    freshServer('1.0.2'); REL = { version: v, badSha: false, installExit: 0 }; makeRelease();
    const o = await runUpdater();
    assert.equal(o.status, 0); assert.match(o.stdout, /Up to date/); assert.ok(!installed(), v + ' must not install');
    assert.equal(current(), '1.0.2'); assert.equal(status().result, 'up_to_date');
  }
});

test('updater: a download that does not match its sha256 is refused; the running version stays', { skip }, async () => {
  freshServer('1.0.2'); REL = { version: '1.0.3', badSha: true, installExit: 0 }; makeRelease();
  const o = await runUpdater();
  assert.notEqual(o.status, 0);
  assert.match(o.stdout, /did not match its sha256; not installing/);
  assert.ok(!installed()); assert.equal(current(), '1.0.2'); assert.equal(status().result, 'failed');
});

test('updater: a failed install keeps the old version and says so', { skip }, async () => {
  freshServer('1.0.2'); REL = { version: '1.0.3', badSha: false, installExit: 1 }; makeRelease();
  const o = await runUpdater();
  assert.notEqual(o.status, 0);
  assert.ok(installed()); assert.equal(current(), '1.0.2');
  assert.equal(status().result, 'failed'); assert.match(status().message, /installer stopped/);
});

test('"Update now" can start only the one updater: the app writes a file, root runs a fixed command (no sudo for the app)', { skip }, async () => {
  const pathUnit = fs.readFileSync(path.join(R, 'etc/systemd/system/messageassistant-update.path'), 'utf8');
  const svc = fs.readFileSync(path.join(R, 'etc/systemd/system/messageassistant-update.service'), 'utf8');
  const app = fs.readFileSync(path.join(R, 'etc/systemd/system/messageassistant.service'), 'utf8');
  assert.match(pathUnit, /PathExists=\/var\/lib\/messageassistant\/update-request/);
  assert.match(pathUnit, /Unit=messageassistant-update\.service/);
  assert.deepEqual(svc.split('\n').filter(l => l.startsWith('ExecStart')), ['ExecStart=/usr/local/bin/messageassistant update --auto']);
  assert.match(app, /NoNewPrivileges=yes/, 'the app itself can never become root');
  assert.ok(!fs.existsSync(path.join(R, 'etc/sudoers.d')), 'no sudo rule is added');
  // the request file's content is never read as a command
  assert.match(updater, /rm -f "[^"]*update-request"/);
  assert.doesNotMatch(updater, /\$\(cat [^)]*update-request/);
});

test('once-a-day check: a badge and ONE text to the admin per new version (can be turned off); it never installs', async () => {
  const db = await import('../src/db.js'); db.openDb(':memory:');
  process.env.MSA_UPDATE_SOURCE = SRC;
  REL = { version: '7.0.0', badSha: false, installExit: 0 }; makeRelease();
  const upd = await import('../src/updates.js');
  const sent = [];
  let r = await upd.dailyCheck({ notify: (t) => sent.push(t) });
  assert.equal(r.available, true); assert.equal(sent.length, 1);
  assert.match(sent[0], /7\.0\.0 is available/); assert.match(sent[0], /Update now/);
  r = await upd.dailyCheck({ notify: (t) => sent.push(t) });
  assert.equal(sent.length, 1, 'not twice for the same version');
  assert.equal(upd.badge().available, true);
  const i = await upd.info(); assert.equal(i.notes, 'test notes');
  assert.ok(!fs.existsSync(path.join(dataDir, 'update-request')), 'nothing was started');
  db.setSetting('update_notify', '0');
  REL = { version: '7.0.1', badSha: false, installExit: 0 }; makeRelease();
  await upd.dailyCheck({ notify: (t) => sent.push(t) });
  assert.equal(sent.length, 1, 'off → no text');
  delete process.env.MSA_UPDATE_SOURCE;
});
