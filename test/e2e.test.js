// End to end: the whole app (dashboard + router + agent + outbox) with the REAL Google Messages driver in a real
// headless Chromium, against the fake Messages page. A stranger texts → one waiting reply typed into the page; the
// admin signs in with a code that the driver texts to his phone; approves; the person's next text gets an AI answer.
// Skipped without Playwright/Chromium (MSA_PLAYWRIGHT_PATH, MSA_CHROMIUM).
import { setupEnv, until, sleep, client } from './helpers.js';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fakeMessages } from './fake-gm.js';
const { st, fake } = fakeMessages();
const canRun = process.env.MSA_PLAYWRIGHT_PATH && process.env.MSA_CHROMIUM && fs.existsSync(process.env.MSA_CHROMIUM);
await new Promise(r => fake.listen(0, '127.0.0.1', r));
const MOCK = path.join(path.dirname(fileURLToPath(import.meta.url)), 'mock-model.js');
setupEnv('e2e', { MSA_CHANNEL: 'web', MSA_GM_URL: `http://127.0.0.1:${fake.address().port}/web`, MSA_POLL_MS: '300', MSA_HEALTH_MS: '500', MSA_MOCK_MODULE: MOCK, MSA_ADMIN_PHONE: '+16465550100' });
import test from 'node:test';
import assert from 'node:assert/strict';
test.after(() => { fake.close(); fake.closeAllConnections?.(); });

test('a real text round trip through the browser driver', { skip: canRun ? false : 'no Playwright/Chromium here', timeout: 150000 }, async () => {
  st.mode = 'connected';
  st.convs.length = 0;
  st.convs.push({ id: '301', name: '+1 646-555-0100', unread: false, msgs: [{ id: 'a0', out: false, text: 'old admin text' }] });
  const { main } = await import('../src/server.js');
  const db = await import('../src/db.js');
  const app = await main({ port: 0 });
  const api = client(`http://127.0.0.1:${app.port}`);
  try {
    await until(() => app.channel.status().state === 'connected', 30000, 'connected');
    await until(() => db.setting('gm_baseline_done') === '1', 10000, 'baseline');
    // a stranger texts
    st.convs.unshift({ id: '302', name: '(212) 555-0199', unread: true, msgs: [{ id: 's1', out: false, text: 'hi, is this the assistant?' }] });
    const conv = () => st.convs.find(c => c.id === '302');
    await until(() => conv().msgs.some(m => m.out && /waiting for approval/.test(m.text)), 40000, 'waiting reply typed into Messages');
    // admin signs in with a code texted through the same page
    const r = await api.post('/api/login/code', { phone: '6465550100' });
    assert.equal(r.status, 200);
    const admin = () => st.convs.find(c => c.id === '301');
    const codeMsg = await until(() => admin().msgs.find(m => m.out && /admin code is \d{6}/.test(m.text)), 40000, 'code text');
    const code = /(\d{6})/.exec(codeMsg.text)[1];
    assert.equal((await api.post('/api/login/verify', { phone: '+16465550100', code })).status, 200);
    const pend = (await api.get('/api/users?status=pending')).data.users;
    const u = pend.find(x => x.phone === '+12125550199');
    assert.ok(u, JSON.stringify(pend));
    await api.post(`/api/users/${u.id}/approve`);
    await until(() => conv().msgs.some(m => m.out && /You are approved/.test(m.text)), 40000, 'welcome');
    conv().msgs.push({ id: 's2', out: false, text: 'what is the capital of France' }); conv().unread = true;
    await until(() => conv().msgs.some(m => m.out && m.text === 'echo: what is the capital of France'), 40000, 'AI answer');
    assert.equal(conv().msgs.filter(m => m.out && /waiting for approval/.test(m.text)).length, 1);
    const shot = await fetch(`http://127.0.0.1:${app.port}/api/messages/screen`, { headers: { Cookie: api.state().cookie } });
    assert.equal(shot.status, 200); assert.equal(shot.headers.get('content-type'), 'image/jpeg');
  } finally { await app.stop(); fake.close(); }
});
