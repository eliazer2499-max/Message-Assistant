// The Google Messages channel: a headless Chromium (Playwright) signed in to messages.google.com/web with the
// assistant's own Google account, paired with the phone that has RCS. ONE browser, ONE page, ONE worker queue:
// every action (read the list, open a chat, send, health check, dashboard screen) waits its turn, so the page is
// never driven twice at once. Reading is gentle: the conversation list is read every few seconds (MSA_POLL_MS,
// default 4 s) with one page.evaluate, and a chat is only opened when its preview changed or it is unread.
//
// Pairing (Google changed this in 2025-26): messages.google.com/web now starts with "Sign in" (a Google account),
// then pairs with the phone (QR code or a confirmation on the phone). The dashboard shows this browser live
// (a picture refreshed every second or two) and passes the admin's taps and typing to it, so he can sign in, scan the
// QR code or answer any prompt himself. The profile (cookies) is kept in <dataDir>/gm-profile, so it stays paired
// across restarts.
//
// Google's page can change. Every CSS selector lives in SELECTORS below, and <dataDir>/gm-selectors.json (same keys)
// overrides them without a new release.
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { cfg } from '../config.js';
import { log } from '../db.js';

export const SELECTORS = {
  convItem: 'mws-conversation-list-item',
  convLink: 'a[href*="/conversations/"]',
  convName: '[data-e2e-conversation-name], .name, h3, h2',
  convSnippet: 'mws-conversation-snippet, [data-e2e-conversation-snippet], .snippet-text',
  convTime: 'mws-relative-timestamp, [data-e2e-conversation-timestamp], .timestamp',
  convUnread: '[data-e2e-is-unread="true"], .unread, [aria-label*="Unread" i]',
  message: 'mws-message-wrapper',
  messageText: '.text-msg-content, [data-e2e-text-message-content], mws-text-message-part, .text-msg',
  messageIdAttr: 'msg-id',
  outgoingAttr: 'is-outgoing',
  composer: 'textarea[data-e2e-message-input-box], mws-message-compose textarea, textarea.input, textarea',
  sendButton: '[data-e2e-send-text-button], mws-message-send-button button, button[aria-label^="Send" i]',
  newChatInput: 'input[data-e2e-contact-input], mw-contact-chips-input input, input[type="text"]',
  newChatPick: 'mw-contact-selector-button button, [data-e2e-send-to-button], button[aria-label*="Send to" i]',
  qr: 'mw-qr-code img, mw-qr-code canvas, mw-qr-code, img[alt*="QR" i], canvas[aria-label*="QR" i]',
  useHere: 'button:has-text("Use here"), button:has-text("Use Here")',
  rememberToggle: 'mat-slide-toggle input, [role="switch"]',
};
export const TEXTS = {
  otherTab: /(open|opened|active) in (another|a different|other) (window|tab|browser)|use (messages )?here/i,
  phoneOff: /trying to (reach|connect to) (your )?phone|phone (is |isn't |is not )?(offline|not connected|disconnected)|check (your )?phone'?s? (connection|internet)|can'?t (reach|connect to) (your )?phone|reconnecting to (your )?phone/i,
  pairing: /scan (this|the) (qr )?code|pair with qr|pair your (phone|device)|device pairing|use your phone to scan|pair(ing)? (this )?(computer|browser)/i,
  signedOut: /^\s*sign in\b|welcome to google messages|sign in to (continue|messages)/im,
};
const VIEW = { width: 1100, height: 800 };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const PRIO = { send: 0, input: 1, screen: 2, health: 3, poll: 4 };

export function loadSelectors(dataDir = cfg.dataDir) {
  try { const o = JSON.parse(fs.readFileSync(path.join(dataDir, 'gm-selectors.json'), 'utf8')); return { ...SELECTORS, ...o }; } catch { return { ...SELECTORS }; }
}
/** Split a long reply into chat-sized parts (on paragraph / line / sentence ends where possible). */
export function splitText(text, max = 1500) {
  const out = []; let s = String(text || '').trim();
  while (s.length > max) {
    let cut = s.lastIndexOf('\n\n', max); if (cut < max * 0.5) cut = s.lastIndexOf('\n', max);
    if (cut < max * 0.5) cut = s.lastIndexOf('. ', max) + 1; if (cut < max * 0.5) cut = s.lastIndexOf(' ', max);
    if (cut < max * 0.3) cut = max;
    out.push(s.slice(0, cut).trim()); s = s.slice(cut).trim();
  }
  if (s) out.push(s);
  return out;
}

/** What the page shows, read in ONE evaluate (runs inside the page). */
function snapshotScript(sel) {
  const q = (root, s) => { try { return root.querySelector(s); } catch { return null; } };
  const qa = (root, s) => { try { return [...root.querySelectorAll(s)]; } catch { return []; } };
  const txt = (el) => (el ? (el.innerText || el.textContent || '') : '').replace(/\s+/g, ' ').trim();
  const items = qa(document, sel.convItem);
  const links = items.length ? items : qa(document, sel.convLink).map(a => a.closest('[role="option"], li, div') || a);
  const convs = [];
  for (const it of links.slice(0, 40)) {
    const a = it.matches && it.matches(sel.convLink) ? it : q(it, sel.convLink);
    const href = a ? a.getAttribute('href') || '' : '';
    const m = /\/conversations\/([^/?#]+)/.exec(href); if (!m || m[1] === 'new') continue;
    const nameEl = q(it, sel.convName);
    convs.push({ id: decodeURIComponent(m[1]), name: txt(nameEl), snippet: txt(q(it, sel.convSnippet)).slice(0, 300), time: txt(q(it, sel.convTime)),
      unread: !!(q(it, sel.convUnread) || (it.matches && it.matches(sel.convUnread)) || (a && a.getAttribute('data-e2e-is-unread') === 'true')) });
  }
  const msgs = qa(document, sel.message).slice(-40).map((w, i) => {
    const out = w.getAttribute(sel.outgoingAttr);
    const textEl = q(w, sel.messageText);
    return { id: w.getAttribute(sel.messageIdAttr) || '', outgoing: out === 'true' || (out === null && /outgoing/.test(w.className || '')), text: textEl ? (textEl.innerText || textEl.textContent || '').trim() : '' };
  });
  const cur = /\/conversations\/([^/?#]+)/.exec(location.pathname);
  return { url: location.href, title: document.title, body: (document.body ? document.body.innerText : '').slice(0, 3000), convs, msgs,
    current: cur ? decodeURIComponent(cur[1]) : null, hasQr: !!q(document, sel.qr), hasComposer: !!q(document, sel.composer) };
}

export function classifyPage(snap, sel = SELECTORS) {
  const url = String(snap.url || '');
  const body = String(snap.body || '');
  if (/accounts\.google\.com/.test(url)) return { state: 'signed_out', detail: 'Google sign-in page' };
  if (TEXTS.otherTab.test(body) && !snap.convs.length) return { state: 'other_tab', detail: 'Messages is open somewhere else' };
  if (/\/web\/(authentication|pair)/.test(url) || snap.hasQr || (TEXTS.pairing.test(body) && !snap.convs.length)) return { state: 'pairing', detail: 'waiting for the phone to pair' };
  if (/\/web\/welcome/.test(url) || (TEXTS.signedOut.test(body) && !snap.convs.length)) return { state: 'signed_out', detail: 'not signed in' };
  if (TEXTS.phoneOff.test(body)) return { state: 'phone_offline', detail: 'the phone is not reachable' };
  if (/\/web\/conversations/.test(url) || snap.convs.length) return { state: 'connected', detail: '' };
  return { state: 'unknown', detail: (snap.title || '').slice(0, 80) };
}

/** Message id: the page's own msg-id when it has one, else a hash of chat + text + how many identical texts came before. */
export function messageKeys(convId, msgs) {
  const count = new Map();
  return msgs.map(m => {
    if (m.id) return 'gm:' + m.id;
    const base = convId + '|' + (m.outgoing ? 'o' : 'i') + '|' + m.text;
    const n = (count.get(base) || 0) + 1; count.set(base, n);
    return 'gmh:' + crypto.createHash('sha256').update(base + '|' + n).digest('hex').slice(0, 24);
  });
}

export class GoogleMessagesWeb extends EventEmitter {
  /**
   * opts.isSeen(id) / opts.markSeen(id): the message-id store (the database); opts.baseline: true when no chat has
   * been read before (the first pairing): what is already there is marked read, not answered.
   */
  constructor(opts = {}) {
    super();
    this.opts = opts;
    this.dataDir = opts.dataDir || cfg.dataDir;
    this.profileDir = path.join(this.dataDir, 'gm-profile');
    this.sel = loadSelectors(this.dataDir);
    this.state = 'stopped'; this.since = Date.now(); this.detail = '';
    this.queue = []; this.running = false; this.ctx = null; this.page = null;
    this.sigs = new Map();          // convId → "snippet|time" last seen
    this.opened = new Set();        // chats read at least once since start
    this.lastSent = new Map();      // convId → last text we sent (our own message is not "new")
    this.timers = []; this.stopped = true; this.launchFails = 0; this.unknownSince = 0; this.lastUseHere = 0;
    this.pollMs = opts.pollMs || cfg.pollMs; this.healthMs = opts.healthMs || cfg.healthMs;
    this.url = opts.url || cfg.gmUrl;
  }

  // ---------- lifecycle ----------
  async start() {
    this.stopped = false;
    await this.ensureBrowser().catch(e => this.setState('error', 'browser did not start: ' + e.message));
    const quiet = (what) => (e) => { if (!this.stopped) log('gm', what, 'failed:', String(e.message).slice(0, 200)); };
    this.timers.push(setInterval(() => this.enqueue('health', () => this.health(), { dedupe: true, noEnsure: true }).catch(quiet('health')), this.healthMs));
    this.timers.push(setInterval(() => { if (this.state === 'connected') this.enqueue('poll', () => this.poll(), { dedupe: true }).catch(quiet('poll')); }, this.pollMs));
    this.enqueue('health', () => this.health(), { dedupe: true, noEnsure: true }).catch(quiet('health'));
  }
  async stop() {
    this.stopped = true;
    for (const t of this.timers) clearInterval(t); this.timers = [];
    for (const j of this.queue.splice(0)) j.reject(new Error('stopped'));
    await this.closeBrowser();
    this.setState('stopped');
  }
  async playwright() {
    if (this.opts.playwright) return this.opts.playwright;
    const mod = await import(process.env.MSA_PLAYWRIGHT_PATH || 'playwright-core');
    return mod.chromium ? mod : mod.default;
  }
  async ensureBrowser() {
    if (this.ctx && this.page && !this.page.isClosed()) return;
    await this.closeBrowser();
    const pw = await this.playwright();
    fs.mkdirSync(this.profileDir, { recursive: true, mode: 0o700 });
    for (const f of ['SingletonLock', 'SingletonSocket', 'SingletonCookie']) { try { fs.rmSync(path.join(this.profileDir, f), { force: true }); } catch {} }
    const launch = {
      headless: true, viewport: VIEW, locale: 'en-US',
      ignoreDefaultArgs: ['--enable-automation'],
      args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-blink-features=AutomationControlled', '--no-first-run', '--no-default-browser-check', '--mute-audio'],
      ...(cfg.chromium ? { executablePath: cfg.chromium } : {}),
      ...(this.opts.launch || {}),
    };
    if (this.ua) launch.userAgent = this.ua;
    this.ctx = await pw.chromium.launchPersistentContext(this.profileDir, launch);
    this.page = this.ctx.pages()[0] || await this.ctx.newPage();
    if (!this.ua && !launch.userAgent) {
      // headless Chromium calls itself "HeadlessChrome"; Google Messages gets the normal Chrome name instead
      const ua = await this.page.evaluate(() => navigator.userAgent).catch(() => '');
      if (/HeadlessChrome/.test(ua)) {
        this.ua = ua.replace(/HeadlessChrome/g, 'Chrome');
        await this.ctx.close().catch(() => {});
        this.ctx = await pw.chromium.launchPersistentContext(this.profileDir, { ...launch, userAgent: this.ua });
        this.page = this.ctx.pages()[0] || await this.ctx.newPage();
      } else this.ua = ua || null;
    }
    this.page.on('crash', () => { log('gm', 'page crashed'); this.page = null; });
    this.ctx.on('close', () => { this.ctx = null; this.page = null; });
    this.page.setDefaultTimeout(20000);
    await this.page.goto(this.url + '/conversations', { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(e => log('gm', 'open failed:', e.message));
    await sleep(this.opts.settleMs ?? 2500);
    this.launchFails = 0;
  }
  async closeBrowser() { const c = this.ctx; this.ctx = null; this.page = null; if (c) await c.close().catch(() => {}); }
  async restart() { return this.enqueue('input', async () => { await this.closeBrowser(); await this.ensureBrowser(); await this.health(); return { ok: true }; }, { noEnsure: true }); }
  /** Forget the Google sign-in and pairing (a fresh profile). */
  async signOut() {
    return this.enqueue('input', async () => {
      await this.closeBrowser();
      fs.rmSync(this.profileDir, { recursive: true, force: true });
      this.sigs.clear(); this.opened.clear();
      this.opts.onSignedOut?.();
      await this.ensureBrowser(); await this.health(); return { ok: true };
    }, { noEnsure: true });
  }

  // ---------- the one worker queue ----------
  enqueue(kind, fn, { dedupe = false, noEnsure = false } = {}) {
    if (dedupe) { const same = this.queue.find(j => j.kind === kind); if (same) return same.promise; }
    let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; });
    this.queue.push({ kind, fn, resolve, reject, promise, noEnsure, prio: PRIO[kind] ?? 5, at: Date.now() });
    this.queue.sort((a, b) => a.prio - b.prio || a.at - b.at);
    this.pump();
    return promise;
  }
  async pump() {
    if (this.running) return; this.running = true;
    try {
      while (this.queue.length && !this.stopped) {
        const j = this.queue.shift();
        try {
          if (!j.noEnsure) await this.ensureBrowser();
          j.resolve(await j.fn());
        } catch (e) {
          if (/Target (page, context or browser )?(has been )?closed|browser has disconnected|crash/i.test(String(e.message))) { this.page = null; }
          j.reject(e);
        }
      }
    } finally { this.running = false; }
  }

  // ---------- state ----------
  setState(state, detail = '') {
    const prev = this.state;
    if (prev === state && detail === this.detail) return;
    if (prev !== state) this.since = Date.now();
    this.state = state; this.detail = detail;
    if (prev !== state) { log('gm', `state ${prev} → ${state}${detail ? ' (' + detail + ')' : ''}`); this.emit('state', { state, prev, detail }); }
  }
  status() { return { state: this.state, since: this.since, detail: this.detail, qr: this.qrData || null, driver: 'google-messages-web', queue: this.queue.length }; }
  async snap() { return this.page.evaluate(snapshotScript, this.sel); }

  async health() {
    if (this.stopped) return;
    try { await this.ensureBrowser(); }
    catch (e) { this.launchFails++; this.setState('error', 'browser did not start: ' + String(e.message).slice(0, 160)); return; }
    let s;
    try { s = await this.snap(); } catch (e) { this.setState('error', 'page not readable: ' + String(e.message).slice(0, 120)); await this.closeBrowser(); return; }
    const c = classifyPage(s, this.sel);
    if (c.state === 'other_tab' && Date.now() - this.lastUseHere > 5 * 60000) {
      this.lastUseHere = Date.now();
      try { await this.page.locator(this.sel.useHere).first().click({ timeout: 5000 }); log('gm', 'pressed "Use here"'); await sleep(2000); return this.health(); } catch {}
    }
    if (c.state === 'pairing') await this.readQr(); else this.qrData = null;
    if (c.state === 'unknown') {
      if (!this.unknownSince) this.unknownSince = Date.now();
      if (Date.now() - this.unknownSince > 3 * 60000) { log('gm', 'page unclear for 3 min; reloading'); this.unknownSince = 0; await this.page.goto(this.url + '/conversations', { waitUntil: 'domcontentloaded' }).catch(() => {}); }
      return;
    }
    this.unknownSince = 0;
    if (c.state === 'connected' && !/\/conversations/.test(s.url)) await this.page.goto(this.url + '/conversations', { waitUntil: 'domcontentloaded' }).catch(() => {});
    this.setState(c.state, c.detail);
    if (c.state === 'connected') await this.poll(s);
  }
  async readQr() {
    try {
      const el = this.page.locator(this.sel.qr).first();
      if (await el.count()) { const png = await el.screenshot({ type: 'png', timeout: 5000 }); this.qrData = 'data:image/png;base64,' + png.toString('base64'); }
    } catch { /* the live screen still shows it */ }
  }

  // ---------- reading ----------
  /** One look at the chat list; open only the chats that changed. */
  async poll(given = null) {
    if (this.stopped || !this.page) return;
    const s = given || await this.snap();
    const c = classifyPage(s, this.sel);
    if (c.state !== 'connected') { this.setState(c.state, c.detail); return; }
    const baseline = this.opts.needsBaseline?.();
    const changed = [];
    this.names = this.names || new Map();
    for (const v of s.convs) {
      this.names.set(v.id, v.name);
      if (/,/.test(v.name) && !/^\+?[\d\s().-]+$/.test(v.name)) continue;         // group chats ("Ann, Bob") are not handled
      const sig = v.snippet + '|' + v.time;
      const before = this.sigs.get(v.id);
      this.sigs.set(v.id, sig);
      if (baseline) continue;
      if (v.unread || (before !== undefined && before !== sig)) {
        const mine = this.lastSent.get(v.id);
        if (!v.unread && mine && (mine.includes(v.snippet.replace(/^You:\s*/i, '')) || v.snippet.startsWith('You:'))) continue;   // our own reply
        changed.push(v);
      } else if (before === undefined && !this.firstListDone) { /* first look after start: remembered, not opened */ }
      else if (before === undefined) changed.push(v);            // a brand-new chat appeared at the top
    }
    this.firstListDone = true;
    if (baseline) { this.opts.baselineDone?.(s.convs.length); return; }
    if (process.env.MSA_GM_DEBUG) log('gm', 'poll', JSON.stringify(s.convs), 'changed', changed.map(v => v.id).join(','));
    for (const v of changed.slice(0, 5)) await this.readChat(v);
  }
  async openChat(id) {
    if (!this.page.url().includes('/conversations/' + encodeURIComponent(id)) && !this.page.url().includes('/conversations/' + id)) {
      await this.page.goto(this.url + '/conversations/' + encodeURIComponent(id), { waitUntil: 'domcontentloaded' });
    }
    await this.page.locator(this.sel.message).first().waitFor({ timeout: 10000 }).catch(() => {});
    await sleep(this.opts.chatSettleMs ?? 600);
  }
  async readChat(v) {
    await this.openChat(v.id);
    const s = await this.snap();
    const keys = messageKeys(v.id, s.msgs);
    const firstTime = !this.opened.has(v.id); this.opened.add(v.id);
    let fresh = [];
    if (firstTime) {
      // only the incoming messages after our last outgoing one (at most 3) count; older ones are history
      let i = s.msgs.length - 1; const run = [];
      while (i >= 0 && !s.msgs[i].outgoing) { run.unshift(i); i--; }
      const take = new Set(run.slice(-3));
      s.msgs.forEach((m, n) => { if (!take.has(n) || this.opts.isSeen?.(keys[n])) this.opts.markSeen?.(keys[n]); else fresh.push(n); });
    } else {
      s.msgs.forEach((m, n) => { if (!m.outgoing && !this.opts.isSeen?.(keys[n])) fresh.push(n); else this.opts.markSeen?.(keys[n]); });
    }
    for (const n of fresh) {
      const m = s.msgs[n];
      this.opts.markSeen?.(keys[n]);
      if (!m.text) continue;                     // pictures / stickers: not handled in 1.0
      this.emit('message', { convId: v.id, phone: v.name, name: v.name, text: m.text, extId: keys[n], ts: Date.now() });
    }
    // leave the chat (so the next incoming message shows as unread in the list)
    await this.page.goto(this.url + '/conversations', { waitUntil: 'domcontentloaded' }).catch(() => {});
  }

  // ---------- sending ----------
  send({ convId = null, phone = null, text }) {
    return this.enqueue('send', async () => {
      if (this.state !== 'connected') { const e = new Error('Messages is not connected (' + this.state + ')'); e.notConnected = true; throw e; }
      let id = convId;
      if (!id) id = await this.newChat(phone);
      await this.openChat(id);
      for (const part of splitText(text)) await this.typeAndSend(part);
      this.lastSent.set(id, String(text).slice(-200));
      // texts that came in while this chat was open (Google marks them read, so the list won't show them as new)
      const s = await this.snap();
      const keys = messageKeys(id, s.msgs), known = this.opened.has(id);
      s.msgs.forEach((m, n) => {
        const fresh = known && !m.outgoing && m.text && !this.opts.isSeen?.(keys[n]);
        this.opts.markSeen?.(keys[n]);
        if (fresh) this.emit('message', { convId: id, phone: this.names?.get(id) || phone || '', name: this.names?.get(id) || '', text: m.text, extId: keys[n], ts: Date.now() });
      });
      this.opened.add(id);
      const sig = s.convs.find(c => c.id === id); if (sig) this.sigs.set(id, sig.snippet + '|' + sig.time);
      await this.page.goto(this.url + '/conversations', { waitUntil: 'domcontentloaded' }).catch(() => {});
      return { ok: true, convId: id };
    });
  }
  async typeAndSend(part) {
    const box = this.page.locator(this.sel.composer).first();
    await box.waitFor({ timeout: 15000 });
    await box.fill(part);
    const before = (await this.snap()).msgs.filter(m => m.outgoing).length;
    await box.press('Enter');
    const ok = await this.waitOutgoing(before, 8000);
    if (!ok) {
      await this.page.locator(this.sel.sendButton).first().click({ timeout: 5000 }).catch(() => {});
      if (!await this.waitOutgoing(before, 8000)) throw new Error('the message did not appear as sent');
    }
    await sleep(this.opts.betweenSendsMs ?? 700);
  }
  async waitOutgoing(before, ms) {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      const s = await this.snap();
      if (s.msgs.filter(m => m.outgoing).length > before) return true;
      const val = await this.page.locator(this.sel.composer).first().inputValue().catch(() => 'x');
      if (val === '' && s.msgs.length) return true;      // box emptied: sent (the list may be virtualized)
      await sleep(300);
    }
    return false;
  }
  async newChat(phone) {
    if (!phone) throw new Error('no number to text');
    await this.page.goto(this.url + '/conversations/new', { waitUntil: 'domcontentloaded' });
    const box = this.page.locator(this.sel.newChatInput).first();
    await box.waitFor({ timeout: 15000 });
    await box.fill(String(phone));
    await sleep(1500);
    const pick = this.page.locator(this.sel.newChatPick).first();
    if (await pick.count()) await pick.click({ timeout: 5000 }).catch(() => box.press('Enter')); else await box.press('Enter');
    const end = Date.now() + 15000;
    while (Date.now() < end) {
      const m = /\/conversations\/([^/?#]+)/.exec(this.page.url());
      if (m && m[1] !== 'new') return decodeURIComponent(m[1]);
      await sleep(300);
    }
    throw new Error('could not start a chat with ' + phone);
  }

  // ---------- the dashboard's live view ----------
  screen() {
    return this.enqueue('screen', async () => this.page.screenshot({ type: 'jpeg', quality: 60, timeout: 10000 }), { dedupe: true });
  }
  input(b = {}) {
    return this.enqueue('input', async () => {
      const p = this.page;
      if (b.type === 'click') {
        const x = Math.max(0, Math.min(VIEW.width, Number(b.x) * VIEW.width)), y = Math.max(0, Math.min(VIEW.height, Number(b.y) * VIEW.height));
        await p.mouse.click(x, y);
      } else if (b.type === 'text') await p.keyboard.type(String(b.text || '').slice(0, 500), { delay: 30 });
      else if (b.type === 'key') { const k = String(b.key || ''); if (!/^(Enter|Tab|Escape|Backspace|Delete|ArrowUp|ArrowDown|ArrowLeft|ArrowRight|PageDown|PageUp|Space)$/.test(k)) throw new Error('key not allowed'); await p.keyboard.press(k === 'Space' ? ' ' : k); }
      else if (b.type === 'scroll') await p.mouse.wheel(0, Number(b.dy) > 0 ? 500 : -500);
      else if (b.type === 'goto') await p.goto(b.where === 'signin' ? this.url + '/welcome' : this.url + '/conversations', { waitUntil: 'domcontentloaded' });
      else if (b.type === 'reload') await p.reload({ waitUntil: 'domcontentloaded' });
      else if (b.type === 'back') await p.goBack({ waitUntil: 'domcontentloaded' }).catch(() => {});
      else throw new Error('unknown input');
      await sleep(400);
      return { ok: true };
    });
  }
}
