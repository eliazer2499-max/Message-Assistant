// A fake "Messages for web" (built the way the driver expects Google's page to look) for the browser tests.
import http from 'node:http';
// 1.0.4: a QR-looking picture that changes with st.qrN (Google rotates its code)
export function qrSvg(n) {
  let x = (n * 2654435761) >>> 0; const rnd = () => ((x = (x * 1103515245 + 12345) >>> 0) >>> 16) & 1;
  const N = 25, cells = []; const finder = (r, c) => [[0, 0], [0, N - 7], [N - 7, 0]].some(([a, b]) => r >= a && r < a + 7 && c >= b && c < b + 7);
  const inFinder = (r, c) => { for (const [a, b] of [[0, 0], [0, N - 7], [N - 7, 0]]) if (r >= a && r < a + 7 && c >= b && c < b + 7) { const i = r - a, k = c - b; return i === 0 || i === 6 || k === 0 || k === 6 || (i >= 2 && i <= 4 && k >= 2 && k <= 4); } return null; };
  for (let r = 0; r < N; r++) for (let c = 0; c < N; c++) { const f = inFinder(r, c); if (f === true || (f === null && !finder(r, c) && rnd())) cells.push(`<rect x="${c}" y="${r}" width="1" height="1"/>`); }
  return 'data:image/svg+xml;base64,' + Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="-2 -2 ${N + 4} ${N + 4}" width="232" height="232" shape-rendering="crispEdges"><rect x="-2" y="-2" width="${N + 4}" height="${N + 4}" fill="#fff"/><g fill="#000">${cells.join('')}</g></svg>`).toString('base64');
}
export function fakeMessages() {
const st = { mode: 'welcome', banner: '', qrN: 1, choice: false, qrChosen: false, remember: false, signInClicks: 0, convs: [{ id: '101', name: '(212) 555-0101', unread: false, msgs: [{ id: 'm1', out: false, text: 'old message from before' }, { id: 'm2', out: true, text: 'old reply' }] }], n: 10 };
const esc = (s) => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
function listHtml() {
  return st.convs.map(c => { const last = c.msgs.at(-1) || { out: false, text: '' }; return `<mws-conversation-list-item><a href="/web/conversations/${c.id}" ${c.unread ? 'data-e2e-is-unread="true"' : ''}><span data-e2e-conversation-name>${esc(c.name)}</span><mws-conversation-snippet>${last.out ? 'You: ' : ''}${esc(last.text)}</mws-conversation-snippet><mws-relative-timestamp>${c.time || c.msgs.length + 'm'}</mws-relative-timestamp></a></mws-conversation-list-item>`; }).join('');
}
// like the real web app, the open page updates itself (here: every 300 ms) — the driver never reloads to read
const LIVE = `<script>setInterval(async()=>{const j=await (await fetch('/live?c='+encodeURIComponent(location.pathname))).json();const q=document.querySelector('mw-qr-code img');if(q&&j.qr&&q.getAttribute('src')!==j.qr)q.setAttribute('src',j.qr);if(j.autoNav&&j.mode==='connected'&&/authentication/.test(location.pathname))location.href='/web/conversations';const n=document.querySelector('nav');if(n&&n.innerHTML!==j.list)n.innerHTML=j.list;const m=document.querySelector('main');if(m&&j.msgs!==null&&m.innerHTML!==j.msgs)m.innerHTML=j.msgs;const b=document.querySelector('#banner');if(b.textContent!==j.banner)b.textContent=j.banner;},300)</script>`;
const page = (body) => `<!doctype html><html><head><title>Messages</title></head><body><div id="banner">${st.banner}</div>${body}${LIVE}</body></html>`;
// 1.0.7: an outgoing bubble can show Google's clock ("Sending…") or "Not sent"
const statusHtml = (x) => x.state === 'pending' ? '<mws-message-status data-e2e-message-status="sending"><mat-icon>schedule</mat-icon><span>Sending…</span></mws-message-status>'
  : x.state === 'failed' ? '<mws-message-status><mat-icon>error</mat-icon><span>Not sent. Tap to retry</span></mws-message-status>' : (x.out ? '<mws-message-status><span>Sent</span></mws-message-status>' : '');
const msgsHtml = (c) => c.msgs.map(x => `<mws-message-wrapper msg-id="${x.id}" is-outgoing="${x.out}"><div class="text-msg-content">${esc(x.text)}</div>${statusHtml(x)}</mws-message-wrapper>`).join('');
const fake = http.createServer(async (req, res) => {
  let b = ''; for await (const c of req) b += c;
  const u = new URL(req.url, 'http://x'); const p = u.pathname;
  const html = (h) => { res.writeHead(200, { 'Content-Type': 'text/html' }); res.end(page(h)); };
  if (req.method === 'POST' && p === '/send') {
    const j = JSON.parse(b); const c = st.convs.find(x => x.id === j.conv); st.typed = (st.typed || 0) + 1;
    // 1.0.7 send modes: 'ok' (default), 'pending' (clock stays), 'pendingThenSent' (clock for st.pendingMs), 'swallow' (box empties, nothing shows), 'failed'
    const mode = st.sendMode || 'ok';
    if (mode === 'swallow') { res.end('{}'); return; }
    const msg = { id: 'o' + (++st.n), out: true, text: j.text, ...(j.media ? { media: j.media } : {}), ...(mode === 'pending' || mode === 'pendingThenSent' ? { state: 'pending' } : mode === 'failed' ? { state: 'failed' } : {}) };
    c.msgs.push(msg);
    if (mode === 'pendingThenSent') setTimeout(() => { delete msg.state; }, st.pendingMs || 1500);
    res.end('{}'); return;
  }
  if (req.method === 'POST' && p === '/usehere') { st.mode = 'connected'; st.banner = ''; res.end('{}'); return; }
  if (req.method === 'POST' && p === '/newchat') { const j = JSON.parse(b); const d10 = (s) => String(s).replace(/\D/g, '').slice(-10); const ex = st.convs.find(c => d10(c.name) === d10(j.to)); if (ex) { res.end(JSON.stringify({ id: ex.id })); return; } const id = String(500 + (++st.n)); st.convs.unshift({ id, name: j.to, unread: false, msgs: [] }); res.end(JSON.stringify({ id })); return; }
  if (p === '/live') { const cm = /\/conversations\/(\w+)$/.exec(u.searchParams.get('c') || ''); const c = cm && st.convs.find(x => x.id === cm[1]); if (c) c.unread = false; res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ list: listHtml(), msgs: c ? msgsHtml(c) : null, banner: st.banner, qr: qrSvg(st.qrN), mode: st.mode, autoNav: !!st.autoNav })); }
  if (req.method === 'POST' && p === '/qrchoose') { st.qrChosen = true; res.end('{}'); return; }
  if (req.method === 'POST' && p === '/remember') { st.remember = u.searchParams.get('on') === 'true'; res.end('{}'); return; }
  if (req.method === 'POST' && p === '/signin-click') { st.signInClicks++; res.end('{}'); return; }
  // 1.0.7: a page for the live-picture taps: a text box, a password box and a button at known spots, and room to scroll
  if (p === '/web/tapcheck') return html('<style>body{margin:0;font:16px sans-serif}#e{position:absolute;left:300px;top:200px;width:300px;height:40px}#pw{position:absolute;left:300px;top:300px;width:300px;height:40px}#b{position:absolute;left:700px;top:500px;width:120px;height:40px}#tall{height:4000px}</style><input id="e" type="email"><input id="pw" type="password"><button id="b" onclick="window.bc=(window.bc||0)+1">Next</button><div id="tall"></div><script>window.c=[];addEventListener("mousedown",e=>c.push([e.clientX,e.clientY]),true)</script>');
  if (p === '/web/fake-signin') return html('<h1>Sign in</h1><p>with your Google Account</p><input type="email">');
  if (st.mode === 'welcome' && p !== '/web/welcome') { res.writeHead(302, { Location: '/web/welcome' }); return res.end(); }
  if (st.mode === 'auth' && p !== '/web/authentication') { res.writeHead(302, { Location: '/web/authentication' }); return res.end(); }
  if (p === '/web/welcome') return html('<h1>Welcome to Google Messages</h1><button onclick="fetch(\'/signin-click\',{method:\'POST\'}).then(()=>location.href=\'/web/fake-signin\')">Sign in</button>');
  if (p === '/web/authentication' && st.choice && !st.qrChosen) return html('<h2>Pair your phone</h2><a href="#help">Having trouble scanning the QR code?</a><button>Pair with Google account</button><button onclick="fetch(\'/qrchoose\',{method:\'POST\'}).then(()=>location.reload())">Pair with QR code</button>');
  if (p === '/web/authentication') return html(`<p>Scan the QR code with your phone</p><mw-qr-code><img alt="QR" src="${qrSvg(st.qrN)}" width="232" height="232"></mw-qr-code><label>Remember this computer <input type="checkbox" role="switch" ${st.remember ? 'checked' : ''} onchange="fetch('/remember?on='+this.checked,{method:'POST'})"></label>`);
  if (st.mode === 'other_tab') return html('<p>Messages for web is open in another tab.</p><button onclick="fetch(\'/usehere\',{method:\'POST\'}).then(()=>location.reload())">Use here</button>');
  if (p === '/web/conversations') return html(`<nav>${listHtml()}</nav><p>Start chat</p>`);
  if (p === '/web/conversations/new') return html(`<nav>${listHtml()}</nav><input type="text" data-e2e-contact-input placeholder="Type a name, phone number"><script>document.querySelector('input').addEventListener('keydown',e=>{if(e.key==='Enter'){fetch('/newchat',{method:'POST',body:JSON.stringify({to:e.target.value})}).then(r=>r.json()).then(j=>location.href='/web/conversations/'+j.id)}})</script>`);
  const m = /^\/web\/conversations\/(\w+)$/.exec(p);
  if (m) {
    const c = st.convs.find(x => x.id === m[1]); if (!c) { res.writeHead(404); return res.end(); }
    c.unread = false;
    return html(`<nav>${listHtml()}</nav><main>${msgsHtml(c)}</main>${st.editable ? '<mws-message-compose><div contenteditable="true" data-e2e-message-input-box role="textbox"></div></mws-message-compose>' : '<textarea data-e2e-message-input-box></textarea>'}${st.noAttach ? '' : '<input type="file" accept="image/*,*/*" style="display:none">'}<script>const f=document.querySelector('input[type=file]');let att=null;if(f)f.addEventListener('change',()=>{att=f.files[0]&&f.files[0].name;});const t=document.querySelector('[data-e2e-message-input-box]');const rd=()=>'value' in t?t.value:t.innerText.trim();const clr=()=>{if('value' in t)t.value='';else t.innerHTML='';};t.addEventListener('keydown',e=>{if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();if(window.ignoreEnter)return;const v=rd();clr();if(!v&&!att)return;const m=att;att=null;fetch('/send',{method:'POST',body:JSON.stringify({conv:'${c.id}',text:m?(v||'[file] '+m):v,media:m})})}})</script>`);
  }
  res.writeHead(404); res.end();
});

  return { st, fake };
}
