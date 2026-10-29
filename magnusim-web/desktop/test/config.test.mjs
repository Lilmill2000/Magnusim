// The desktop app's settings (desktop/config.mjs): where its projects and prefs go, what the
// server is told, and which addresses stay in its window.
// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { isAppUrl, isExternalUrl, serverEnv, windowBackground } from '../config.mjs';

const where = { documents: join('C:', 'Users', 'me', 'Documents'), userData: join('C:', 'Users', 'me', 'AppData', 'Roaming', 'Magnusim CAD') };

describe('serverEnv', () => {
  it("is the CAD edition, with projects in Documents\Magnusim CAD and prefs in the app's user data", () => {
    const env = serverEnv({ ...where, env: { PATH: 'x' } });
    assert.equal(env.MAGNUSIM_EDITION, 'cad');
    assert.equal(env.MAGNUSIM_PROJECTS_ROOT, join(where.documents, 'Magnusim CAD'));
    assert.equal(env.MAGNUSIM_LOCAL_JSON, join(where.userData, 'local.json'));
    assert.equal(env.PATH, 'x', "the rest of the app's environment goes with it");
    assert.equal(env.MAGNUSIM_ASSISTANT_HOME, undefined, "the Assistant's home follows MAGNUSIM_LOCAL_JSON: local.assistant in the app's own folder");
    // In the utility process's own environment it would start that process as Node (exit 9).
    assert.equal(env.ELECTRON_RUN_AS_NODE, undefined);
  });

  it("keeps a projects folder or prefs file the person set (Magnusim's, to share them)", () => {
    const env = serverEnv({ ...where, env: { MAGNUSIM_PROJECTS_ROOT: 'D:\Magnusim\projects', MAGNUSIM_LOCAL_JSON: 'D:\p.json', MAGNUSIM_EDITION: 'magnusim' } });
    assert.equal(env.MAGNUSIM_PROJECTS_ROOT, 'D:\Magnusim\projects');
    assert.equal(env.MAGNUSIM_LOCAL_JSON, 'D:\p.json');
    assert.equal(env.MAGNUSIM_EDITION, 'cad', 'never Magnusim');
  });
});

describe('addresses', () => {
  it("only the app's own server stays in its window", () => {
    assert.equal(isAppUrl('http://127.0.0.1:5123/#/p/x', 5123), true);
    assert.equal(isAppUrl('http://localhost:5123/', 5123), true);
    for (const url of ['http://127.0.0.1:5124/', 'https://127.0.0.1:5123/', 'http://example.org:5123/', 'file:///C:/x.html', 'not a url']) {
      assert.equal(isAppUrl(url, 5123), false, url);
    }
  });

  it('a web or mail link may open in the browser; a file, script or app link never', () => {
    for (const url of ['https://magnusim.example/docs', 'http://example.org', 'mailto:someone@example.org']) assert.equal(isExternalUrl(url), true, url);
    for (const url of ['file:///C:/Windows/system32/calc.exe', 'javascript:alert(1)', 'ms-settings:privacy', 'vscode://x', '']) assert.equal(isExternalUrl(url), false, url);
  });
});

describe('windowBackground', () => {
  it("is the page's background of the person's theme until the page paints; the system's when they match it", () => {
    assert.equal(windowBackground('light', true), '#f9fafb');
    assert.equal(windowBackground('dark', false), '#12151b');
    assert.equal(windowBackground('system', true), '#12151b');
    assert.equal(windowBackground('system', false), '#f9fafb');
    assert.equal(windowBackground('neon', true), '#f9fafb');
  });
});
