// A fake "Messages for web" (built the way the driver expects Google's page to look) for the browser tests.
import http from 'node:http';
export function fakeMessages() {
const st = { mode: 'welcome', banner: '', convs: [{ id: '101', name: '(212) 555-0101', unread: false, msgs: [{ id: 'm1', out: false, text: 'old message from before' }, { id: 'm2', out: true, text: 'old reply' }] }], n: 10 };
const esc = (s) => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
function listHtml() {
  return st.convs.map(c => { const last = c.msgs.at(-1) || { out: false, text: '' }; return `<mws-conversation-list-item><a href="/web/conversations/${c.id}" ${c.unread ? 'data-e2e-is-unread="true"' : ''}><span data-e2e-conversation-name>${esc(c.name)}</span><mws-conversation-snippet>${last.out ? 'You: ' : ''}${esc(last.text)}</mws-conversation-snippet><mws-relative-timestamp>${c.msgs.length}m</mws-relative-timestamp></a></mws-conversation-list-item>`; }).join('');
}
// like the real web app, the open page updates itself (here: every 300 ms) — the driver never reloads to read
const LIVE = `<script>setInterval(async()=>{const j=await (await fetch('/live?c='+encodeURIComponent(location.pathname))).json();const n=document.querySelector('nav');if(n&&n.innerHTML!==j.list)n.innerHTML=j.list;const m=document.querySelector('main');if(m&&j.msgs!==null&&m.innerHTML!==j.msgs)m.innerHTML=j.msgs;const b=document.querySelector('#banner');if(b.textContent!==j.banner)b.textContent=j.banner;},300)</script>`;
const page = (body) => `<!doctype html><html><head><title>Messages</title></head><body><div id="banner">${st.banner}</div>${body}${LIVE}</body></html>`;
const msgsHtml = (c) => c.msgs.map(x => `<mws-message-wrapper msg-id="${x.id}" is-outgoing="${x.out}"><div class="text-msg-content">${esc(x.text)}</div></mws-message-wrapper>`).join('');
const fake = http.createServer(async (req, res) => {
  let b = ''; for await (const c of req) b += c;
  const u = new URL(req.url, 'http://x'); const p = u.pathname;
  const html = (h) => { res.writeHead(200, { 'Content-Type': 'text/html' }); res.end(page(h)); };
  if (req.method === 'POST' && p === '/send') { const j = JSON.parse(b); const c = st.convs.find(x => x.id === j.conv); c.msgs.push({ id: 'o' + (++st.n), out: true, text: j.text, ...(j.media ? { media: j.media } : {}) }); res.end('{}'); return; }
  if (req.method === 'POST' && p === '/usehere') { st.mode = 'connected'; st.banner = ''; res.end('{}'); return; }
  if (req.method === 'POST' && p === '/newchat') { const j = JSON.parse(b); const d10 = (s) => String(s).replace(/\D/g, '').slice(-10); const ex = st.convs.find(c => d10(c.name) === d10(j.to)); if (ex) { res.end(JSON.stringify({ id: ex.id })); return; } const id = String(500 + (++st.n)); st.convs.unshift({ id, name: j.to, unread: false, msgs: [] }); res.end(JSON.stringify({ id })); return; }
  if (p === '/live') { const cm = /\/conversations\/(\w+)$/.exec(u.searchParams.get('c') || ''); const c = cm && st.convs.find(x => x.id === cm[1]); if (c) c.unread = false; res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ list: listHtml(), msgs: c ? msgsHtml(c) : null, banner: st.banner })); }
  if (st.mode === 'welcome' && p !== '/web/welcome') { res.writeHead(302, { Location: '/web/welcome' }); return res.end(); }
  if (st.mode === 'auth' && p !== '/web/authentication') { res.writeHead(302, { Location: '/web/authentication' }); return res.end(); }
  if (p === '/web/welcome') return html('<h1>Welcome to Google Messages</h1><button>Sign in</button>');
  if (p === '/web/authentication') return html('<p>Scan the QR code with your phone</p><mw-qr-code><img alt="QR" src="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAAFUlEQVR42mO8IyLCgA0wMeAAg1MCANDoARQXWCREAAAAAElFTkSuQmCC" width="120" height="120"></mw-qr-code>');
  if (st.mode === 'other_tab') return html('<p>Messages for web is open in another tab.</p><button onclick="fetch(\'/usehere\',{method:\'POST\'}).then(()=>location.reload())">Use here</button>');
  if (p === '/web/conversations') return html(`<nav>${listHtml()}</nav><p>Start chat</p>`);
  if (p === '/web/conversations/new') return html(`<nav>${listHtml()}</nav><input type="text" data-e2e-contact-input placeholder="Type a name, phone number"><script>document.querySelector('input').addEventListener('keydown',e=>{if(e.key==='Enter'){fetch('/newchat',{method:'POST',body:JSON.stringify({to:e.target.value})}).then(r=>r.json()).then(j=>location.href='/web/conversations/'+j.id)}})</script>`);
  const m = /^\/web\/conversations\/(\w+)$/.exec(p);
  if (m) {
    const c = st.convs.find(x => x.id === m[1]); if (!c) { res.writeHead(404); return res.end(); }
    c.unread = false;
    return html(`<nav>${listHtml()}</nav><main>${msgsHtml(c)}</main><textarea data-e2e-message-input-box></textarea>${st.noAttach ? '' : '<input type="file" accept="image/*,*/*" style="display:none">'}<script>const f=document.querySelector('input[type=file]');let att=null;if(f)f.addEventListener('change',()=>{att=f.files[0]&&f.files[0].name;});const t=document.querySelector('textarea');t.addEventListener('keydown',e=>{if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();const v=t.value;t.value='';if(!v&&!att)return;const m=att;att=null;fetch('/send',{method:'POST',body:JSON.stringify({conv:'${c.id}',text:m?(v||'[file] '+m):v,media:m})})}})</script>`);
  }
  res.writeHead(404); res.end();
});

  return { st, fake };
}
