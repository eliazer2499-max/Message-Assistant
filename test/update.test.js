// 1.0.1: starting through a symlinked "current" folder, and the dashboard's update controls.
import { setupEnv, client, until } from './helpers.js';
const dataDir = setupEnv('update');
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('newer(): only higher x.y.z versions count (no downgrades)', async () => {
  const { newer } = await import('../src/updates.js');
  assert.equal(newer('1.0.1', '1.0.0'), true);
  assert.equal(newer('1.0.10', '1.0.9'), true);
  assert.equal(newer('1.1.0', '1.0.99'), true);
  assert.equal(newer('1.0.0', '1.0.1'), false);
  assert.equal(newer('1.0.1', '1.0.1'), false);
  assert.equal(newer('garbage', '1.0.0'), false);
});

test('the server starts when run through a symlinked current/ folder (1.0.0 restart-looped here)', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'msa-layout-'));
  const rel = path.join(root, 'releases', '1.0.1');
  fs.mkdirSync(rel, { recursive: true });
  for (const x of ['src', 'public', 'VERSION', 'package.json']) fs.cpSync(path.join(APP, x), path.join(rel, x), { recursive: true });
  fs.symlinkSync(rel, path.join(root, 'current'));
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'msa-layout-data-'));
  const port = 20000 + Math.floor(Math.random() * 20000);
  const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', path.join(root, 'current', 'src', 'server.js')],
    { cwd: path.join(root, 'current'), env: { ...process.env, MSA_DATA_DIR: data, MSA_PORT: String(port), MSA_HOST: '127.0.0.1', MSA_CHANNEL: 'off', MSA_TEST_MODE: '1' }, stdio: 'ignore' });
  try {
    const j = await until(async () => { try { const r = await fetch(`http://127.0.0.1:${port}/healthz`); return r.ok ? r.json() : null; } catch { return null; } }, 15000, '/healthz through current/');
    assert.equal(j.ok, true);
    assert.equal(j.version, fs.readFileSync(path.join(APP, 'VERSION'), 'utf8').trim());
  } finally {
    child.kill('SIGTERM'); await new Promise(r => setTimeout(r, 300));
    fs.rmSync(root, { recursive: true, force: true }); fs.rmSync(data, { recursive: true, force: true });
  }
});

test('Settings → Updates: current/latest, Auto-update switch (default on), Update now', async () => {
  const src = http.createServer((req, res) => {
    if (req.url === '/docs/version.json') { res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end('{"version":"9.9.9","date":"2026-11-05"}'); }
    res.writeHead(404); res.end();
  });
  await new Promise(r => src.listen(0, '127.0.0.1', r));
  process.env.MSA_UPDATE_SOURCE = `http://127.0.0.1:${src.address().port}/docs`;
  const { main } = await import('../src/server.js');
  const { setPassword } = await import('../src/adminauth.js');
  const s = await main({ port: 0, host: '127.0.0.1' });
  try {
    setPassword('correct horse battery', 'admin');
    const c = client(`http://127.0.0.1:${s.port}`);
    assert.equal((await c.post('/api/login/password', { username: 'admin', password: 'correct horse battery' })).status, 200);
    let u = (await c.get('/api/update')).data;
    assert.equal(u.current, fs.readFileSync(path.join(APP, 'VERSION'), 'utf8').trim());
    assert.equal(u.latest, '9.9.9');
    assert.equal(u.update_available, true);
    assert.equal(u.auto, true, 'auto-update is on by default');
    u = (await c.post('/api/update/auto', { on: false })).data;
    assert.equal(u.auto, false);
    assert.equal(fs.readFileSync(path.join(dataDir, 'auto-update'), 'utf8').trim(), 'off');
    u = (await c.post('/api/update/auto', { on: true })).data;
    assert.equal(u.auto, true);
    assert.equal((await c.post('/api/update/now')).status, 200);
    assert.ok(fs.existsSync(path.join(dataDir, 'update-request')), 'Update now leaves the request file the .path unit watches');
    assert.equal((await c.get('/api/update')).data.pending, true);
    c.forgetCsrf();
    assert.equal((await c.post('/api/update/now')).status, 403, 'CSRF protected');
  } finally { await s.stop(); src.close(); }
});
