// 1.0.9: stability — what counts as old history after a restart, and the browser's self-healing steps.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const { staleCutoff, readAlive, GoogleMessagesWeb } = await import('../src/channels/gmweb.js');

test('old-history cutoff: looks back to when the app was last alive (max 3 days)', () => {
  const n = Date.now(), M = 600000, D = 86400000;
  assert.equal(staleCutoff({ startedAt: n }), n - M);
  assert.equal(staleCutoff({ startedAt: n, prevAlive: n - 2 * D }), n - 2 * D - M);
  assert.equal(staleCutoff({ startedAt: n, prevAlive: n - 30 * D }), n - 3 * D - M);
  assert.equal(staleCutoff({ startedAt: n, prevAlive: n + 5000 }), n - M);
});
test('readAlive: a missing or broken file is 0', () => {
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'alive-')), 'gm-alive.json');
  assert.equal(readAlive(f), 0); fs.writeFileSync(f, 'nope'); assert.equal(readAlive(f), 0);
  fs.writeFileSync(f, JSON.stringify({ at: 12345 })); assert.equal(readAlive(f), 12345);
});
test('self-heal: reload first, then restart the browser; a human-only state resets it', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'heal-'));
  const g = new GoogleMessagesWeb({ dataDir: dir, reloadAfterMs: 0, reloadEveryMs: 0, restartAfterMs: 50, restartEveryMs: 100000 });
  let loads = 0, restarts = 0;
  g.page = { isClosed: () => false, goto: async () => { loads++; } };
  g.closeBrowser = async () => { restarts++; }; g.ensureBrowser = async () => {};
  assert.equal(await g.selfHeal('connected'), false);
  assert.equal(await g.selfHeal('phone_offline'), false);            // just went down: nothing yet (reloadAfter 0 needs > 0 ms)
  await new Promise(r => setTimeout(r, 10));
  assert.equal(await g.selfHeal('phone_offline'), true); assert.equal(loads, 1);
  await new Promise(r => setTimeout(r, 60));
  assert.equal(await g.selfHeal('phone_offline'), true); assert.equal(restarts, 1);
  assert.equal(await g.selfHeal('phone_offline'), true); assert.equal(restarts, 1, 'not restarted again within 15 min');
  assert.equal(await g.selfHeal('signed_out'), false); assert.equal(g.badSince, 0);
});
