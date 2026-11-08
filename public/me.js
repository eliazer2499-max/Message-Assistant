// 1.0.2: the person's own web chat. The same conversation as their texts: what they type here is answered here AND
// texted to their phone; what they text from the phone shows up here (checked every few seconds).
import { renderMarkdown } from './markdown.js';
'use strict';
const $ = (s) => document.querySelector(s);
let CSRF = '', last = 0, timer = null, items = new Map(), first = true;
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
function showApp() { $('#login').classList.add('hidden'); $('#app').classList.remove('hidden'); load(); timer = setInterval(load, 3000); }
const when = (t) => new Date(t).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
function bubble(it) {
  const d = document.createElement('div');
  d.className = 'row ' + (it.who === 'me' ? 'mine' : 'theirs');
  d.dataset.id = it.id;
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
    items.set(it.id, key); last = Math.max(last, it.ts);
  }
  for (const n of box.querySelectorAll('.pending')) if (r.items.some(i => i.who === 'me' && i.text === n.dataset.text)) n.remove();
  if (!r.items.length && !box.children.length) box.innerHTML = '<p class="muted center small empty">Say hi! Your messages here and your texts are the same chat.</p>';
  else box.querySelector('.empty')?.remove();
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
$('#logout').onclick = async () => { await api('POST', '/api/u/logout').catch(() => {}); CSRF = ''; items.clear(); last = 0; first = true; $('#chat').innerHTML = ''; showLogin(); };
document.addEventListener('visibilitychange', () => { if (!document.hidden && timer) load(); });
(async () => {
  try {
    const me = await api('GET', '/api/u/me');
    if (me.product) { $('#lTitle').textContent = me.product; $('#brand').textContent = me.product; }
    if (me.signed_in) { CSRF = me.csrf; if (me.name) $('#brand').textContent = me.name; showApp(); }
    else showLogin(me.enabled === false ? 'The web chat is turned off by the admin.' : '');
    if (me.enabled === false) $('#fPhone').classList.add('hidden');
  } catch { showLogin(); }
})();
