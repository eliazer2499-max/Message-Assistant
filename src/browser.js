// The assistant's own web browser for users' questions and tasks ("look it up", "check this site", "fill this in").
// Separate from the Google Messages browser: its own Chromium process, and for EACH user a separate browser context
// (cookies and site data kept per user in <dataDir>/browser-users/<id>/state.json), so one user's logins and cookies
// are never seen by another. One step at a time per user; users take turns (round-robin), so one user can't hog it;
// each message has a browser time budget (Settings → browser_job_seconds) and each step a time limit.
import fs from 'node:fs';
import path from 'node:path';
import dns from 'node:dns/promises';
import net from 'node:net';
import { cfg } from './config.js';
import { setting, log } from './db.js';

export const VIEW = { width: 1000, height: 1400 };
const STEP_MS = 45000;
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

let driver = null;                 // tests: setDriver({ chromium }) with a fake
export function setDriver(d) { driver = d; }
async function playwright() {
  if (driver) return driver;
  const mod = await import(process.env.MSA_PLAYWRIGHT_PATH || 'playwright-core');
  return mod.chromium ? mod : mod.default;
}

// ---------- private addresses are never opened (the dashboard and other services live on this machine) ----------
const PRIVATE = (a) => /^(127\.|10\.|192\.168\.|169\.254\.|0\.|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.)/.test(a) || /^172\.(1[6-9]|2\d|3[01])\./.test(a) ||
  a === '::1' || a === '::' || /^f[cd]/i.test(a) || /^fe80/i.test(a) || /^::ffff:(127|10|192\.168)\./i.test(a);
export async function assertPublicUrl(u) {
  const url = new URL(u);
  if (!/^https?:$/.test(url.protocol)) throw new Refused('Only http(s) web addresses can be opened.');
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (/^localhost$|\.local$|\.internal$/i.test(host)) throw new Refused('That address is private; not opened.');
  if (cfg.testMode && process.env.MSA_ALLOW_LOCAL === '1') return url;
  const addrs = net.isIP(host) ? [host] : (await dns.lookup(host, { all: true })).map(a => a.address);
  if (addrs.some(PRIVATE)) throw new Refused('That address is private/internal; not opened.');
  return url;
}
export class Refused extends Error {}
export function cleanUrl(u) {
  let s = String(u || '').trim();
  if (!s) throw new Refused('Give a web address or search words.');
  if (/\s/.test(s) || !/[.:]/.test(s)) return 'https://html.duckduckgo.com/html/?q=' + encodeURIComponent(s);   // words → a search
  if (!/^[a-z]+:\/\//i.test(s)) s = 'https://' + s;
  let x; try { x = new URL(s); } catch { throw new Refused('That is not a web address: ' + u); }
  if (!/^https?:$/.test(x.protocol)) throw new Refused('Only http(s) addresses can be opened.');
  return x.href;
}

// ---------- the shared browser and one context per user ----------
let browser = null, launching = null;
const users = new Map();       // userId → { ctx, page, lastUsed, dir }
let idleTimer = null;
function userDir(id) { return path.join(cfg.dataDir, 'browser-users', String(Number(id))); }
async function getBrowser() {
  if (browser && browser.isConnected()) return browser;
  if (launching) return launching;
  launching = (async () => {
    const pw = await playwright();
    browser = await pw.chromium.launch({ headless: true, ignoreDefaultArgs: ['--enable-automation'],
      args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-blink-features=AutomationControlled', '--mute-audio'], ...(cfg.chromium ? { executablePath: cfg.chromium } : {}) });
    browser.on?.('disconnected', () => { browser = null; users.clear(); });
    return browser;
  })();
  try { return await launching; } finally { launching = null; }
}
export async function userPage(userId) {
  let u = users.get(userId);
  if (u && u.page && !u.page.isClosed()) { u.lastUsed = Date.now(); return u.page; }
  const b = await getBrowser();
  const dir = userDir(userId); fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const statePath = path.join(dir, 'state.json');
  const ctx = await b.newContext({ viewport: VIEW, locale: 'en-US', ...(fs.existsSync(statePath) ? { storageState: statePath } : {}),
    userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36' });
  // block literal private addresses for every request (pages can't reach this machine's own services)
  if (!(cfg.testMode && process.env.MSA_ALLOW_LOCAL === '1')) { try { await ctx.route(/^https?:\/\/(localhost|127\.|10\.|192\.168\.|169\.254\.|0\.0\.0\.0|\[::1\])/i, r => r.abort()); } catch {} }
  const page = await ctx.newPage();
  page.setDefaultTimeout(STEP_MS);
  u = { ctx, page, lastUsed: Date.now(), statePath, elements: 0 };
  users.set(userId, u);
  armIdle();
  return page;
}
async function saveState(u) { try { await u.ctx.storageState({ path: u.statePath }); fs.chmodSync(u.statePath, 0o600); } catch {} }
export async function closeUser(userId) {
  const u = users.get(userId); if (!u) return;
  users.delete(userId);
  await saveState(u); await u.ctx.close().catch(() => {});
  if (!users.size && browser) { const b = browser; browser = null; await b.close().catch(() => {}); }
}
export function forgetUser(userId) { closeUser(userId).catch(() => {}); fs.rmSync(userDir(userId), { recursive: true, force: true }); }
function armIdle() {
  if (idleTimer) return;
  idleTimer = setInterval(async () => {
    const t = Date.now();
    for (const [id, u] of users) if (t - u.lastUsed > 5 * 60000 && !u.busy) await closeUser(id);
    if (!users.size) { clearInterval(idleTimer); idleTimer = null; }
  }, cfg.testMode ? 500 : 30000);
  idleTimer.unref?.();
}
export async function shutdown() { for (const id of [...users.keys()]) await closeUser(id); if (browser) await browser.close().catch(() => {}); browser = null; }
export function stats() { return { open_users: users.size, running: running, waiting: waitingCount() }; }

// ---------- fair queue: users take turns; at most N steps run at once ----------
// The next step goes to the waiting user who was served LEAST recently, so a user with many steps can't hold the
// browser while others wait; one user never runs two steps at once (their page is one page).
const queues = new Map();    // userId → [jobs]
const lastServed = new Map();
const busyUsers = new Set();
let running = 0, served = 0, arrivals = 0;
function waitingCount() { let n = 0; for (const q of queues.values()) n += q.length; return n; }
export function inBrowserQueue(userId, fn) {
  return new Promise((resolve, reject) => {
    if (!queues.has(userId)) queues.set(userId, []);
    queues.get(userId).push({ fn, resolve, reject, at: ++arrivals });
    pump();
  });
}
function pump() {
  const limit = Math.max(1, Math.min(3, parseInt(setting('browser_parallel'), 10) || 1));
  while (running < limit) {
    let best = null;
    for (const [id, q] of queues) {
      if (!q.length || busyUsers.has(id)) continue;
      const key = [lastServed.has(id) ? lastServed.get(id) : -1, q[0].at];
      if (!best || key[0] < best.key[0] || (key[0] === best.key[0] && key[1] < best.key[1])) best = { id, key };
    }
    if (!best) break;
    const id = best.id, q = queues.get(id), job = q.shift();
    if (!q.length) queues.delete(id);
    lastServed.set(id, ++served); busyUsers.add(id); running++;
    const u = users.get(id); if (u) u.busy = true;
    Promise.resolve().then(job.fn).then(job.resolve, job.reject).finally(() => {
      running--; busyUsers.delete(id); const uu = users.get(id); if (uu) uu.busy = false; pump();
    });
  }
}

// ---------- reading a page (numbered links, buttons and boxes) ----------
function readScript({ from, max }) {
  let n = 0;
  document.querySelectorAll('[data-msa-n]').forEach(e => e.removeAttribute('data-msa-n'));
  const els = [];
  const vis = (e) => { const r = e.getBoundingClientRect(); const s = getComputedStyle(e); return r.width > 2 && r.height > 2 && s.visibility !== 'hidden' && s.display !== 'none'; };
  for (const e of document.querySelectorAll('a[href], button, input, textarea, select, [role="button"], [role="link"], [role="checkbox"], [role="tab"], [contenteditable="true"]')) {
    if (!vis(e) || els.length >= 120) continue;
    const id = ++n; e.setAttribute('data-msa-n', String(id));
    const tag = e.tagName.toLowerCase(); const type = (e.getAttribute('type') || '').toLowerCase();
    let label = (e.innerText || e.value || e.getAttribute('aria-label') || e.getAttribute('placeholder') || e.getAttribute('title') || e.getAttribute('name') || '').replace(/\s+/g, ' ').trim().slice(0, 80);
    if (type === 'password') label = (e.getAttribute('placeholder') || 'password') + ' (password box)';
    const kind = tag === 'a' ? 'link' : tag === 'select' ? 'dropdown' : tag === 'textarea' || (tag === 'input' && !['button', 'submit', 'checkbox', 'radio'].includes(type)) ? 'box' : type === 'checkbox' || type === 'radio' ? type : 'button';
    els.push(`[${id}] ${kind}: ${label || '(no label)'}${tag === 'a' ? ' → ' + (e.href || '').slice(0, 100) : ''}`);
  }
  const text = (document.body ? document.body.innerText : '').replace(/\n\s*\n+/g, '\n').trim();
  return { title: document.title, url: location.href, text: text.slice(from, from + max), more: text.length > from + max ? text.length - from - max : 0, elements: els };
}
export async function readPage(page, { from = 0, max = 6000 } = {}) {
  const r = await page.evaluate(readScript, { from, max });
  return { title: r.title, url: r.url, text: r.text, ...(r.more ? { more_text: `${r.more} more characters: browser_read with from=${from + max}` } : {}), elements: r.elements.join('\n') };
}
export async function el(page, n) {
  const loc = page.locator(`[data-msa-n="${Number(n)}"]`).first();
  if (!(await loc.count())) throw new Refused(`There is no element ${n} now. Call browser_read to get fresh numbers.`);
  return loc;
}
export async function settle(page) { await page.waitForLoadState('domcontentloaded', { timeout: 15000 }).catch(() => {}); await sleep(cfg.testMode ? 50 : 800); }
