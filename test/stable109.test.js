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
  const g = new GoogleMessagesWeb({ dataDir: dir });          // defaults: reload after 90 s, restart after 6 min (at most every 15 min)
  let loads = 0, restarts = 0;
  g.page = { isClosed: () => false, goto: async () => { loads++; } };
  g.closeBrowser = async () => { restarts++; }; g.ensureBrowser = async () => {};
  const realNow = Date.now; let t = realNow.call(Date);
  Date.now = () => t;
  try {
    assert.equal(await g.selfHeal('connected'), false);
    assert.equal(await g.selfHeal('phone_offline'), false);   // just went down
    t += 60000; assert.equal(await g.selfHeal('phone_offline'), false); assert.equal(loads, 0, 'not yet (60 s)');
    t += 40000; assert.equal(await g.selfHeal('phone_offline'), true); assert.equal(loads, 1, 'reloaded after 90 s');
    t += 30000; assert.equal(await g.selfHeal('phone_offline'), false); assert.equal(loads, 1, 'not again within 2 min');
    t += 240000; assert.equal(await g.selfHeal('phone_offline'), true); assert.equal(restarts, 1, 'browser restarted after 6 min');
    t += 130000; assert.equal(await g.selfHeal('phone_offline'), true); assert.equal(restarts, 1, 'not restarted again within 15 min'); assert.equal(loads, 2);
    assert.equal(await g.selfHeal('signed_out'), false); assert.equal(g.badSince, 0);
  } finally { Date.now = realNow; }
});
