// 1.1.12: vault_api — the assistant can use a person's saved API token (their GitHub token is the
// example FLS gave) against the service's API. The server attaches the secret; the model never sees
// it; another person cannot use an entry that is not theirs; a service that echoes the secret back
// has it scrubbed from the result.
import { setupEnv } from './helpers.js';
import http from 'node:http';
setupEnv('v124', { MSA_ADMIN_PHONE: '+16465550100', MSA_ALLOW_LOCAL: '1' });
import test from 'node:test';
import assert from 'node:assert/strict';
const { main } = await import('../src/server.js');
const users = await import('../src/users.js');
const VAULT = await import('../src/vault.js');
const { execTool } = await import('../src/tools/index.js');

const TOKEN = 'ghp_TESTTOKEN_123';
let seenAuth = null, seenPath = null;
const api = http.createServer((req, res) => {
  seenAuth = req.headers.authorization || null; seenPath = req.url;
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ repos: ['first-repo', 'second-repo'], debug_echo: TOKEN }));
});
await new Promise(r => api.listen(0, '127.0.0.1', r));
test.after(() => { api.close(); api.closeAllConnections?.(); });

function approvedUser(phone) {
  const r = users.arrive({ phone, convId: 'conv-' + phone, name: '', text: 'hi' });
  users.approve(r.user.id, 'test');
  return users.userById(r.user.id);
}

test('vault_api calls the API with the person\u2019s own token, and the token never reaches the model', async () => {
  const app = await main({ port: 0 });
  try {
    const u = approvedUser('+12125550199');
    VAULT.addEntry(u.id, { label: 'GitHub', kind: 'token', username: 'octo', secret: TOKEN });
    const url = `http://127.0.0.1:${api.address().port}/user/repos`;
    const r = await execTool('vault_api', { entry: 'GitHub', url }, { userId: u.id });
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.repos, ['first-repo', 'second-repo']);
    assert.equal(seenAuth, 'Bearer ' + TOKEN, 'the server attached the saved token');
    assert.equal(seenPath, '/user/repos');
    assert.ok(!JSON.stringify(r).includes(TOKEN), 'the token itself is scrubbed from what the model sees');
    assert.match(JSON.stringify(r), /the saved secret/, 'the echo was replaced, not leaked');

    // someone else's vault has no "GitHub" — the entry cannot be borrowed
    const other = approvedUser('+12125550198');
    const r2 = await execTool('vault_api', { entry: 'GitHub', url }, { userId: other.id });
    assert.match(r2.error || '', /No vault entry matches/);

    // basic auth for a username+password entry
    VAULT.addEntry(u.id, { label: 'Old service', kind: 'login', username: 'bob', secret: 'pw123' });
    const r3 = await execTool('vault_api', { entry: 'Old service', url, auth: 'basic' }, { userId: u.id });
    assert.equal(r3.status, 200);
    assert.equal(seenAuth, 'Basic ' + Buffer.from('bob:pw123').toString('base64'));
  } finally { await app.stop(); }
});
