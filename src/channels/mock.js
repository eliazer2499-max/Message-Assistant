// An in-memory stand-in for Google Messages (tests, and MSA_CHANNEL=mock for trying the dashboard without a phone).
// Same surface as the real driver (gmweb.js): start/stop/status/send/screen/input + 'message' and 'state' events.
import { EventEmitter } from 'node:events';

export class MockChannel extends EventEmitter {
  constructor() {
    super();
    this.state = 'stopped'; this.since = Date.now(); this.detail = '';
    this.sent = [];            // { convId, phone, text, ts }
    this.convs = new Map();    // phone → convId
    this.failNext = 0;         // tests: make the next N sends fail
    this.n = 0;
  }
  async start() { this.setState('connected'); }
  async stop() { this.setState('stopped'); }
  setState(s, detail = '') { const prev = this.state; if (prev === s && detail === this.detail) return; this.state = s; this.detail = detail; this.since = Date.now(); this.emit('state', { state: s, prev, detail }); }
  status() { return { state: this.state, since: this.since, detail: this.detail, qr: null, driver: 'mock', queue: 0 }; }
  convFor(phone) { if (!this.convs.has(phone)) this.convs.set(phone, String(1000 + this.convs.size)); return this.convs.get(phone); }
  /** Tests: someone texts the assistant's number. */
  inject({ phone, text, name = '', convId = null, extId = null }) {
    const c = convId || this.convFor(phone);
    const m = { convId: c, phone, name: name || phone, text, extId: extId || `mock-${c}-${++this.n}`, ts: Date.now() };
    this.emit('message', m);
    return m;
  }
  async send({ convId = null, phone = null, text, media = null, mediaUrl = null }) {
    if (this.state !== 'connected') { const e = new Error('Messages is not connected'); e.notConnected = true; throw e; }
    if (this.failNext > 0) { this.failNext--; throw new Error('send failed (mock)'); }
    const c = convId || (phone ? this.convFor(phone) : null);
    if (!c) throw new Error('no conversation');
    const p = phone || [...this.convs.entries()].find(([, v]) => v === c)?.[0] || '';
    this.sent.push({ convId: c, phone: p, text, ts: Date.now(), ...(media ? { media, mediaUrl } : {}) });
    return { ok: true, convId: c };
  }
  async screen() { return null; }
  async input() { return { ok: true }; }
  async restart() { this.setState('connected'); return { ok: true }; }
  async signOut() { this.setState('signed_out'); return { ok: true }; }
}
