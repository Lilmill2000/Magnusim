// The Assistant's home folder (Foundation spec 3.1): MAGNUSIM_ASSISTANT_HOME, else beside
// MAGNUSIM_LOCAL_JSON, else the user's application-data folder; nothing is computed or made
// when the modules load; and every e2e server gets a home of its own.
import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = mkdtempSync(join(tmpdir(), 'magnusim-assistant-home-'));
process.env.MAGNUSIM_PROJECTS_ROOT = join(ROOT, 'projects');
process.env.MAGNUSIM_LOCAL_JSON = join(ROOT, 'local.json');
process.env.MAGNUSIM_ASSISTANT_HOME = join(ROOT, 'home');

const WEB = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const KEY = Symbol.for('magnusim.assistant');

// Every Assistant module this commit adds: importing them computes and makes nothing.
await import('../assistant/state.ts');
await import('../assistant/access.ts');
await import('../assistant/files.ts');
await import('../assistant/redact.ts');
await import('../assistant/log.ts');
await import('../assistant/ledger.ts');
await import('../assistant/settings.ts');
await import('../assistant/types.ts');
const home = await import('../assistant/home.ts');

after(() => {
  try {
    rmSync(ROOT, { recursive: true, force: true });
  } catch {
    /* the OS temp cleaner takes it */
  }
});

describe('the Assistant home', () => {
  it('nothing is computed or made at import', () => {
    assert.equal(globalThis[KEY], undefined, 'no state until first use');
    assert.equal(existsSync(join(ROOT, 'home')), false, 'no folder made');
    assert.equal(existsSync(join(ROOT, 'local.assistant')), false);
    // Read at each call: a later change of the environment is seen.
    const before = process.env.MAGNUSIM_ASSISTANT_HOME;
    process.env.MAGNUSIM_ASSISTANT_HOME = join(ROOT, 'other');
    try {
      assert.equal(home.assistantHome(), resolve(ROOT, 'other'));
    } finally {
      process.env.MAGNUSIM_ASSISTANT_HOME = before;
    }
    assert.equal(home.assistantHome(), resolve(ROOT, 'home'));
  });

  it('MAGNUSIM_ASSISTANT_HOME wins (its legacy name too), resolved to an absolute path', () => {
    const env = { MAGNUSIM_ASSISTANT_HOME: 'rel/home', MAGNUSIM_LOCAL_JSON: join(ROOT, 'x.json'), APPDATA: join(ROOT, 'roaming') };
    assert.equal(home.assistantHome({ env, platform: 'win32' }), resolve('rel/home'));
    assert.equal(home.assistantHome({ env: { CFDDESK_ASSISTANT_HOME: join(ROOT, 'legacy') } }), resolve(ROOT, 'legacy'));
    assert.equal(home.assistantHomeIsOverridden({ env }), true);
    assert.equal(home.assistantHomeIsOverridden({ env: { MAGNUSIM_ASSISTANT_HOME: '  ' } }), false, 'blank is unset');
  });

  it('else beside MAGNUSIM_LOCAL_JSON: <name>.assistant, so no node test or dev server reaches the real folder', () => {
    const dir = join(ROOT, 'e2e');
    assert.equal(home.assistantHome({ env: { MAGNUSIM_LOCAL_JSON: join(dir, '.tmp-prefs-8730.json') } }), join(dir, '.tmp-prefs-8730.assistant'));
    assert.equal(home.assistantHome({ env: { MAGNUSIM_LOCAL_JSON: join(dir, 'Settings.JSON') } }), join(dir, 'Settings.assistant'));
    assert.equal(home.assistantHome({ env: { MAGNUSIM_LOCAL_JSON: join(dir, 'prefs') } }), join(dir, 'prefs.assistant'));
    assert.equal(home.assistantHome({ env: { CFDDESK_LOCAL_JSON: join(dir, 'old.json') } }), join(dir, 'old.assistant'));
    assert.equal(home.assistantHomeIsOverridden({ env: { MAGNUSIM_LOCAL_JSON: join(dir, 'p.json') } }), true);
  });

  it('else the platform default, outside the install folder', () => {
    const user = join(ROOT, 'user');
    assert.equal(home.assistantHome({ env: { APPDATA: join(ROOT, 'Roaming') }, platform: 'win32', home: user }), join(ROOT, 'Roaming', 'Magnusim'));
    assert.equal(home.assistantHome({ env: {}, platform: 'win32', home: user }), join(user, 'AppData', 'Roaming', 'Magnusim'));
    assert.equal(home.assistantHome({ env: {}, platform: 'darwin', home: user }), join(user, 'Library', 'Application Support', 'Magnusim'));
    assert.equal(home.assistantHome({ env: { XDG_CONFIG_HOME: join(ROOT, 'xdg') }, platform: 'linux', home: user }), join(ROOT, 'xdg', 'magnusim'));
    assert.equal(home.assistantHome({ env: {}, platform: 'linux', home: user }), join(user, '.config', 'magnusim'));
    assert.equal(home.assistantHomeIsOverridden({ env: {} }), false);
  });

  it("an installed app's home is never a test one (MAGNUSIM_PACKAGED), whatever sets it", () => {
    const local = join(ROOT, 'Roaming', 'Magnusim CAD', 'local.json');
    assert.equal(home.assistantHomeIsOverridden({ env: { MAGNUSIM_LOCAL_JSON: local } }), true, 'LOCAL_JSON alone: a test or dev folder');
    assert.equal(home.assistantHomeIsOverridden({ env: { MAGNUSIM_LOCAL_JSON: local, MAGNUSIM_PACKAGED: '1' } }), false, 'LOCAL_JSON in an installed app');
    assert.equal(home.assistantHomeIsOverridden({ env: { MAGNUSIM_ASSISTANT_HOME: join(ROOT, 'h'), MAGNUSIM_PACKAGED: '1' } }), false, 'ASSISTANT_HOME in an installed app');
    assert.equal(
      home.assistantHomeIsOverridden({ env: { MAGNUSIM_ASSISTANT_HOME: join(ROOT, 'h'), MAGNUSIM_LOCAL_JSON: local, MAGNUSIM_PACKAGED: '1' } }),
      false,
      'both, in an installed app',
    );
    assert.equal(home.assistantHomeIsOverridden({ env: { MAGNUSIM_LOCAL_JSON: local, MAGNUSIM_PACKAGED: ' ' } }), true, 'blank is unset');
    // Where the home is does not change: only whether it counts as a test one.
    assert.equal(home.assistantHome({ env: { MAGNUSIM_LOCAL_JSON: local, MAGNUSIM_PACKAGED: '1' } }), join(ROOT, 'Roaming', 'Magnusim CAD', 'local.assistant'));
  });

  it('secrets and data folders sit under the home', () => {
    const env = { MAGNUSIM_ASSISTANT_HOME: join(ROOT, 'h') };
    assert.equal(home.secretsDir({ env }), join(ROOT, 'h', 'secrets'));
    assert.equal(home.assistantDataDir({ env }), join(ROOT, 'h', 'assistant'));
  });
});

describe('every e2e server gets its own Assistant home and no inherited Assistant test switch', () => {
  const code = (rel) => readFileSync(join(WEB, rel), 'utf8');

  it('the suites webServer (e2e/support/app-config.js)', () => {
    const src = code('e2e/support/app-config.js');
    assert.match(src, /MAGNUSIM_ASSISTANT_HOME: join\(WEB_ROOT, 'e2e', `\.tmp-prefs\$\{own\}\.assistant`\)/);
    assert.match(src, /startsWith\('MAGNUSIM_TEST_ASSISTANT'\)/);
  });

  it('a second server (e2e/support/host-server.mjs)', () => {
    const src = code('e2e/support/host-server.mjs');
    assert.match(src, /MAGNUSIM_ASSISTANT_HOME: join\(tmp, 'assistant'\)/);
    const drop = src.search(/startsWith\('MAGNUSIM_TEST_ASSISTANT'\)/);
    const extra = src.indexOf('Object.entries(extraEnv)');
    assert.ok(drop > 0 && extra > drop, 'inherited switches are dropped before the env a spec passes');
  });

  it('git and Vite leave those folders alone', () => {
    assert.match(code('.gitignore'), /^e2e\/\.tmp-prefs\*\.assistant\/$/m);
    assert.match(code('vite.config.js'), /'\*\*\/\*\.assistant\/\*\*'/);
  });
});
