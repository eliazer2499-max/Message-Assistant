// Shared test setup: a fresh data folder, test mode, the in-memory Messages channel. Import this FIRST.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
export function setupEnv(name, extra = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'msa-' + name + '-'));
  Object.assign(process.env, { MSA_TEST_MODE: '1', MSA_DATA_DIR: dir, MSA_CHANNEL: 'mock', MSA_TICK_MS: '100', MSA_DROP_ALERT_MS: '150' }, extra);
  process.on('exit', () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} });
  return dir;
}
export const sleep = (ms) => new Promise(r => setTimeout(r, ms));
export async function until(fn, ms = 5000, what = 'condition') {
  const end = Date.now() + ms;
  while (Date.now() < end) { const v = await fn(); if (v) return v; await sleep(20); }
  throw new Error('timed out waiting for ' + what);
}
/** A tiny HTTP client that keeps the admin cookie + CSRF token. */
export function client(base) {
  let cookie = '', csrf = '';
  const c = async (method, p, body) => {
    const r = await fetch(base + p, { method, headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}), ...(csrf ? { 'X-CSRF-Token': csrf } : {}) }, body: body ? JSON.stringify(body) : undefined });
    const sc = r.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0];
    const ct = r.headers.get('content-type') || '';
    const data = ct.includes('json') ? await r.json() : await r.text();
    if (data && data.csrf) csrf = data.csrf;
    return { status: r.status, data };
  };
  c.get = (p) => c('GET', p); c.post = (p, b = {}) => c('POST', p, b);
  c.state = () => ({ cookie, csrf }); c.forgetCsrf = () => { csrf = ''; };
  return c;
}
