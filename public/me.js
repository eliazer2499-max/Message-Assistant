// 1.0.2: the person's own web chat. The same conversation as their texts: what they type here is answered here AND
// texted to their phone; what they text from the phone shows up here (checked every few seconds).
import { renderMarkdown } from './markdown.js?v=__V__';
'use strict';
const $ = (s) => document.querySelector(s);
let CSRF = '', last = 0, timer = null, items = new Map(), first = true, ME = null, firstTs = 0, oldest = 0;
const msg = (n, t, ok = false) => { n.textContent = t || ''; n.className = 'msg ' + (t ? (ok ? 'ok' : 'err') : '') + (n.id === 'sendMsg' ? ' center' : ''); };
async function api(method, path, body) {
  const r = await fetch(path, { method, headers: { 'Content-Type': 'application/json', ...(CSRF ? { 'X-CSRF-Token': CSRF } : {}) }, body: body ? JSON.stringify(body) : undefined, credentials: 'same-origin' });
  const data = (r.headers.get('content-type') || '').includes('json') ? await r.json() : null;
  if (r.status === 401 && !path.includes('/login')) { showLogin(); throw new Error((data && data.error) || 'Please sign in'); }
  if (!r.ok) throw new Error((data && data.error) || ('Error ' + r.status));
  if (data && data.csrf) CSRF = data.csrf;
  return data;
}
function showLogin(text) { $('#app').classList.add('hidden'); $('#login').classList.remove('hidden'); clearInterval(timer); timer = null; if (text) msg($('#loginMsg'), text); }
function showApp() { $('#login').classList.add('hidden'); $('#app').classList.remove('hidden'); fillMe(); load(); timer = setInterval(load, 3000); view(location.hash === '#accounts' ? 'accounts' : 'chats'); }
// 1.0.8: who is signed in, access end, Manage system (admin), Connected accounts
const day = (t) => new Date(t).toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric', year: new Date(t).getFullYear() === new Date().getFullYear() ? undefined : 'numeric' });
function fillMe() {
  if (!ME) return;
  const nm = ME.name || 'You';
  $('#meName').textContent = nm; $('#mePhone').textContent = ME.phone || ''; $('#meAvatar').textContent = (nm.trim()[0] || '?').toUpperCase();
  $('#manage').classList.toggle('hidden', !ME.is_admin);
  const a = $('#meAccess');
  if (ME.access_ended) { a.textContent = 'Your access has ended. Please contact the admin.'; a.className = 'access ended'; }
  else if (ME.access_until) { a.textContent = 'Your access is until ' + new Date(ME.access_until).toLocaleDateString([], { month: 'long', day: 'numeric', year: 'numeric' }) + '.'; a.className = 'access'; }
  else a.className = 'access hidden';
  oldest = ME.oldest || 0;
  accounts(ME);
}
function view(v) {
  for (const b of document.querySelectorAll('#meNav button')) b.classList.toggle('on', b.dataset.v === v);
  $('#v-chats').classList.toggle('hidden', v !== 'chats'); $('#v-accounts').classList.toggle('hidden', v !== 'accounts');
  document.body.dataset.view = v;
  if (v === 'accounts') { history.replaceState(null, '', '#accounts'); api('GET', '/api/u/connections').then(accounts).catch(() => {}); }
  else { history.replaceState(null, '', location.pathname); const c = $('#chat'); c.scrollTop = c.scrollHeight; }
}
for (const b of document.querySelectorAll('#meNav button')) b.onclick = () => view(b.dataset.v);
function accounts(r) {
  const list = (r.connections || []).filter(c => c.provider === 'google');
  $('#accCount').textContent = list.length ? String(list.length) : '';
  $('#gList').innerHTML = list.map(c => `<div class="accrow"><span class="dot ${c.status === 'connected' ? 'ok' : 'bad'}"></span><div class="grow"><b>${escapeText(c.account || 'Google account')}</b><div class="muted small">${c.status === 'connected' ? 'Connected' + (c.last_used ? ' · used ' + when(c.last_used) : '') : escapeText(c.error || 'Connect again')}</div></div><button class="ghost small" data-rm="${c.id}" type="button">Disconnect</button></div>`).join('');
  for (const b of document.querySelectorAll('[data-rm]')) b.onclick = async () => { if (!confirm('Disconnect this Google account?')) return; try { await api('POST', `/api/u/connections/${b.dataset.rm}/remove`); accounts(await api('GET', '/api/u/connections')); msg($('#accMsg'), 'Disconnected.', true); } catch (er) { msg($('#accMsg'), er.message); } };
  const ready = r.google_ready !== false;
  $('#gConnect').classList.toggle('hidden', !ready); $('#gNotReady').classList.toggle('hidden', ready);
  $('#gConnect').textContent = list.length ? 'Connect another Google account' : 'Connect Google';
}
$('#gConnect').onclick = async () => { try { const r = await api('POST', '/api/u/connect/google'); location.href = r.url; } catch (er) { msg($('#accMsg'), er.message); } };
$('#manage').onclick = async () => { try { const r = await api('POST', '/api/u/manage'); location.href = r.go || '/'; } catch (er) { alert(er.message); } };
$('#earlier').onclick = async () => {
  const box = $('#chat'), h = box.scrollHeight;
  let r; try { r = await api('GET', '/api/u/chat?before=' + firstTs); } catch { return; }
  const anchor = $('#earlier').nextSibling;
  for (const it of r.items) { if (items.has(it.id)) continue; box.insertBefore(bubble(it), anchor); items.set(it.id, it.id + ':' + (it.status || '')); firstTs = Math.min(firstTs || it.ts, it.ts); }
  if (!r.items.length) firstTs = oldest;
  daySeps(); box.scrollTop = box.scrollHeight - h; showEarlier();
};
function showEarlier() { $('#earlier').classList.toggle('hidden', !(oldest && firstTs && oldest < firstTs)); }
function daySeps() {
  const box = $('#chat'); box.querySelectorAll('.daysep').forEach(n => n.remove());
  let prev = '';
  for (const n of box.querySelectorAll('.row[data-ts]')) { const d = day(Number(n.dataset.ts)); if (d !== prev) { const s = document.createElement('div'); s.className = 'daysep'; s.textContent = d; n.before(s); prev = d; } }
}
const when = (t) => new Date(t).toLocaleString([], { hour: 'numeric', minute: '2-digit' });
function bubble(it) {
  const d = document.createElement('div');
  d.className = 'row ' + (it.who === 'me' ? 'mine' : 'theirs');
  d.dataset.id = it.id; d.dataset.ts = it.ts;
  let inner = '';
  if (it.img) inner += `<a href="${it.img}" target="_blank" rel="noopener"><img class="pic" src="${it.img}" alt="Picture"></a>`;
  if (it.text) inner += `<div class="b">${it.who === 'me' ? escapeText(it.text) : renderMarkdown(it.text)}</div>`;
  inner += `<div class="t">${when(it.ts)}${it.who === 'bot' && it.status === 'sending' ? ' · sending' : ''}</div>`;
  d.innerHTML = inner;
  return d;
}
const escapeText = (s) => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])).replace(/\n/g, '<br>');
async function load() {
  if (document.hidden && last) return;
  let r; try { r = await api('GET', '/api/u/chat?after=' + Math.max(0, last - 120000)); } catch { return; }
  const box = $('#chat'); const atEnd = box.scrollHeight - box.scrollTop - box.clientHeight < 80;
  let added = false;
  for (const it of r.items) {
    const key = it.id + ':' + (it.status || '');
    if (items.get(it.id) === key) continue;
    const old = box.querySelector(`[data-id="${it.id}"]`);
    const node = bubble(it);
    const stick = atEnd || !last;
    node.querySelectorAll('img').forEach(i => i.addEventListener('load', () => { if (stick) box.scrollTop = box.scrollHeight; }));
    if (old) old.replaceWith(node); else { box.appendChild(node); added = true; }
    items.set(it.id, key); last = Math.max(last, it.ts); firstTs = firstTs ? Math.min(firstTs, it.ts) : it.ts;
  }
  for (const n of box.querySelectorAll('.pending')) if (r.items.some(i => i.who === 'me' && i.text === n.dataset.text)) n.remove();
  if (r.oldest) oldest = r.oldest;
  if (added || first) { daySeps(); showEarlier(); }
  if (!r.items.length && !box.querySelector('.row')) box.insertAdjacentHTML('beforeend', '<p class="muted center small empty">Say hi! Your messages here and your texts are the same chat.</p>'); else box.querySelector('.empty')?.remove();
  if ((added && atEnd) || first) box.scrollTop = box.scrollHeight;
  first = false;
}
$('#compose').onsubmit = async (e) => {
  e.preventDefault();
  const t = $('#text').value.trim(); if (!t) return;
  $('#sendBtn').disabled = true;
  try {
    await api('POST', '/api/u/send', { text: t });
    $('#text').value = ''; msg($('#sendMsg'), '');
    await load(); $('#chat').scrollTop = $('#chat').scrollHeight;
  } catch (er) { msg($('#sendMsg'), er.message); }
  finally { $('#sendBtn').disabled = false; $('#text').focus(); }
};
$('#text').addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); $('#compose').requestSubmit(); } });
$('#fPhone').onsubmit = async (e) => {
  e.preventDefault();
  try { const r = await api('POST', '/api/u/login/code', { phone: $('#lPhone').value }); msg($('#loginMsg'), r.message, true); $('#fPhone').classList.add('hidden'); $('#fCode').classList.remove('hidden'); $('#lCode').focus(); }
  catch (er) { msg($('#loginMsg'), er.message); }
};
$('#codeBack').onclick = () => { $('#fCode').classList.add('hidden'); $('#fPhone').classList.remove('hidden'); };
$('#fCode').onsubmit = async (e) => { e.preventDefault(); try { await api('POST', '/api/u/login/verify', { phone: $('#lPhone').value, code: $('#lCode').value }); $('#lCode').value = ''; showApp(); } catch (er) { msg($('#loginMsg'), er.message); } };
$('#logout').onclick = async () => { await api('POST', '/api/u/logout').catch(() => {}); CSRF = ''; items.clear(); last = 0; first = true; $('#chat').querySelectorAll('.row,.daysep,.empty').forEach(n => n.remove()); firstTs = 0; showLogin(); };
document.addEventListener('visibilitychange', () => { if (!document.hidden && timer) load(); });
(async () => {
  try {
    const me = await api('GET', '/api/u/me');
    if (me.product) { $('#lTitle').textContent = me.product; $('#brand').textContent = me.product; }
    if (me.signed_in) { CSRF = me.csrf; ME = me; showApp(); }
    else showLogin(me.enabled === false ? 'The web chat is turned off by the admin.' : '');
    if (me.enabled === false) $('#fPhone').classList.add('hidden');
    const q = new URLSearchParams(location.search);
    if (q.get('connected') === 'google') { setTimeout(() => msg($('#accMsg'), 'Google is connected ✓', true), 300); history.replaceState(null, '', location.pathname + '#accounts'); }
    if (q.get('connect_error')) { setTimeout(() => msg($('#accMsg'), q.get('connect_error')), 300); history.replaceState(null, '', location.pathname + '#accounts'); }
  } catch (e) { console.error('start:', e && e.message); showLogin(); }
})();
