// Settings → Assistant when keys can't be stored on this PC (Foundation spec 3.7): the
// key protector test switch stands in for Windows blocking the helper that encrypts keys.
// The step says so, with no key field; a local server is still offered; the test-switch
// line names the switch; and a key sent anyway is refused with nothing written.
// SPDX-License-Identifier: GPL-3.0-or-later
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { startHost } from './support/host-server.mjs';
import { assistantStatus, chooseProvider, openAssistantStep } from './support/assistant.js';
import { expect, test } from './support/stress.js';

const BLOCKED_TEXT =
  "Windows blocked the helper Magnusim uses to encrypt keys, so keys can't be saved on this PC. A local server still works.";

let host;

test.beforeAll(async () => {
  test.setTimeout(180_000);
  host = await startHost({
    name: 'assistant-keys-off',
    env: { MAGNUSIM_TEST_ASSISTANT: '1', MAGNUSIM_TEST_ASSISTANT_PROTECTOR: 'blocked' },
  });
});

test.afterAll(() => {
  if (host) host.stop();
});

test('keys that cannot be stored: no key field, the reason, the local server still offered, the switch named', async ({ page, request }) => {
  await page.goto(`${host.base}/#/`);
  const pane = await openAssistantStep(page);
  await expect(pane.locator('[data-assistant-test-provider]')).toHaveText('Test switches in use: key protector (blocked).');

  await chooseProvider(page, 'anthropic');
  await expect(pane.locator('[data-assistant-storage]')).toHaveText(BLOCKED_TEXT);
  await expect(pane.locator('[data-assistant-key-status]')).toHaveText('No key');
  await expect(pane.locator('[data-assistant-key-input]')).toHaveCount(0);
  await expect(pane.locator('[data-assistant-key-save]')).toHaveCount(0);

  // A local server still works (its optional token can't be stored either).
  await chooseProvider(page, 'openai_compatible');
  await expect(pane.locator('[data-assistant-endpoint]')).toHaveValue('http://127.0.0.1:1234/v1');
  await expect(pane.locator('[data-assistant-key-input]')).toHaveCount(0);
  await expect(pane.locator('[data-assistant-privacy-local]')).toBeVisible();

  const status = await assistantStatus(request, host.base);
  expect(status.storage).toEqual({ kind: 'unavailable', reason: 'blocked', note: BLOCKED_TEXT });
  expect(status.test_protector).toBe('blocked');

  // A key sent anyway is refused, and nothing is written.
  const r = await request.post(`${host.base}/api/assistant/key`, { data: { provider: 'anthropic', key: 'sk-ant-e2e-blocked-0123456789' } });
  expect(r.status()).toBe(409);
  expect((await r.json()).code).toBe('storage_unavailable');
  for (const name of ['keys.json', 'master.json']) {
    expect(existsSync(join(host.tmp, 'assistant', 'secrets', name)), name).toBe(false);
  }
  // A cloud turn refused with storage_unavailable comes with the turns route (the agent loop's commit).
});
