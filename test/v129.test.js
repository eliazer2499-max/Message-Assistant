// 1.1.16 design fixes (from FLS's dashboard screenshot, 2026-11-22): the Home Alerts card grew down the
// whole page when the phone flapped (dozens of repeated alerts), stranding the other cards; and on wide
// screens the content hugged the left, leaving a dead empty zone on the right. Pure CSS checks.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const css = fs.readFileSync(new URL('../public/style.css', import.meta.url), 'utf8');

test('the Alerts list scrolls inside its card instead of taking over the home page', () => {
  assert.match(css, /#alerts \{ max-height:min\(520px, 62vh\); overflow-y:auto;/);
});

test('wide screens: the content column is centered, and so are the narrower People / AI keys views', () => {
  assert.match(css, /main \{ grid-column:2; grid-row:3; width:100%; max-width:1180px; margin:0 auto;/);
  assert.match(css, /#v-people, #v-keys \{ max-width:880px; margin-inline:auto; \}/);
});
