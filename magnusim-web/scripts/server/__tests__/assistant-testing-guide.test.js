// docs/TESTING.md, the guide for writing tests, names every Assistant route that asks for this
// account's proof (its entry in the assistant-routes.ts header can answer 403 launch_proof),
// and the terminal client's launch check, so a test written from it sends the proof each needs.
// SPDX-License-Identifier: GPL-3.0-or-later
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const WEB = fileURLToPath(new URL('../../../', import.meta.url));
const read = (rel) => readFileSync(WEB + rel, 'utf8');

/** The routes whose entry in the header of assistant-routes.ts mentions the launch proof. */
function proofRoutes() {
  const header = read('scripts/server/assistant-routes.ts').split('*/')[0];
  const entries = [];
  for (const line of header.split(/\r?\n/)) {
    const m = /^\s*\*\s+(?:GET|POST)\s+(\/api\/\S+)/.exec(line);
    if (m) entries.push({ path: m[1], text: line });
    else if (entries.length) entries.at(-1).text += `\n${line}`;
  }
  return entries.filter((e) => /launch[_ ]proof/.test(e.text)).map((e) => e.path);
}

/** Whether the guide names `path` (not only as the start of a longer path). */
const names = (doc, path) => new RegExp(`${path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\w/:-])`).test(doc);

test('docs/TESTING.md names every route that needs the launch proof, and the launch check', () => {
  const routes = proofRoutes();
  // The header is read right: an agent turn and each agent Settings call that starts or allows one.
  for (const r of ['/api/assistant/turns', '/api/assistant/test', '/api/assistant/agents/custom', '/api/assistant/agents/allow', '/api/assistant/agents/test', '/api/assistant/agents/sign-in']) {
    assert.ok(routes.includes(r), `the routes header marks ${r} as needing the proof (found: ${routes.join(', ')})`);
  }
  const doc = read('docs/TESTING.md');
  const missing = [...routes, '/api/assistant/launch/check'].filter((r) => !names(doc, r));
  assert.deepEqual(missing, [], 'docs/TESTING.md says nothing of these routes');
});
