// A plugin's preferences for the user (host API 1.7, scripts/plugin-prefs.js): one file
// per plugin beside the machine prefs, a plugin reaches only its own, 64 KB at most.
import { after, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = mkdtempSync(join(tmpdir(), 'magnusim-plugin-prefs-'));
const WEB = join(root, 'web');
mkdirSync(WEB, { recursive: true });
// Never this PC's own prefs: the test names its own machine prefs file.
process.env.MAGNUSIM_LOCAL_JSON = join(root, 'local', 'test-local.json');
delete process.env.MAGNUSIM_PLUGIN_PREFS_DIR;
const prefs = await import('../plugin-prefs.js');
const { PREFS_MAX_BYTES, getPluginPref, pluginPrefsDir, readPluginPrefs, removePluginPref, setPluginPref } = prefs;

const DIR = join(root, 'local', '.magnusim-plugin-prefs');

beforeEach(() => rmSync(DIR, { recursive: true, force: true }));
after(() => rmSync(root, { recursive: true, force: true }));

/** @param {() => unknown} fn @param {string} code */
function refused(fn, code) {
  assert.throws(fn, (e) => e instanceof prefs.PluginPrefsError && e.code === code);
}

describe('plugin prefs', () => {
  it('live beside the machine prefs file (an e2e server names its own), or in MAGNUSIM_PLUGIN_PREFS_DIR', () => {
    assert.equal(pluginPrefsDir(WEB), DIR);
    process.env.MAGNUSIM_PLUGIN_PREFS_DIR = join(root, 'elsewhere');
    try {
      assert.equal(pluginPrefsDir(WEB), join(root, 'elsewhere'));
    } finally {
      delete process.env.MAGNUSIM_PLUGIN_PREFS_DIR;
    }
  });

  it('set, get and remove a JSON value; null for a pref there is none of; the last remove drops the file', () => {
    assert.equal(getPluginPref(WEB, 'cad', 'toolbar-layout'), null);
    const layout = { order: ['sketch', 'extrude', 'fillet'], hidden: ['loft'] };
    setPluginPref(WEB, 'cad', 'toolbar-layout', layout);
    setPluginPref(WEB, 'cad', 'last.units', 'mm');
    assert.deepEqual(getPluginPref(WEB, 'cad', 'toolbar-layout'), layout);
    assert.deepEqual(JSON.parse(readFileSync(join(DIR, 'cad.json'), 'utf8')), { 'toolbar-layout': layout, 'last.units': 'mm' });
    // null removes, as remove does.
    setPluginPref(WEB, 'cad', 'last.units', null);
    assert.equal(getPluginPref(WEB, 'cad', 'last.units'), null);
    removePluginPref(WEB, 'cad', 'toolbar-layout');
    removePluginPref(WEB, 'cad', 'toolbar-layout');
    assert.equal(existsSync(join(DIR, 'cad.json')), false);
  });

  it("a plugin's prefs are its own: the same name in another plugin is another value", () => {
    setPluginPref(WEB, 'cad', 'layout', 1);
    setPluginPref(WEB, 'airfoil', 'layout', 2);
    assert.equal(getPluginPref(WEB, 'cad', 'layout'), 1);
    assert.equal(getPluginPref(WEB, 'airfoil', 'layout'), 2);
    refused(() => setPluginPref(WEB, '../cad', 'layout', 3), 'invalid_plugin');
    refused(() => getPluginPref(WEB, 'CAD', 'layout'), 'invalid_plugin');
  });

  it('names follow the rule; a value must be JSON', () => {
    for (const bad of ['', 'Upper', '-lead', 'a/b', '..', 'x'.repeat(65), 7, null]) refused(() => setPluginPref(WEB, 'cad', bad, 1), 'invalid_key');
    refused(() => setPluginPref(WEB, 'cad', 'fn', () => 1), 'invalid_value');
    refused(() => setPluginPref(WEB, 'cad', 'n', 10n), 'invalid_value');
  });

  it('64 KB in all per plugin: past it the set is refused and nothing changes', () => {
    setPluginPref(WEB, 'cad', 'a', 'x'.repeat(40 * 1024));
    const before = readFileSync(join(DIR, 'cad.json'), 'utf8');
    refused(() => setPluginPref(WEB, 'cad', 'b', 'y'.repeat(30 * 1024)), 'too_large');
    assert.equal(readFileSync(join(DIR, 'cad.json'), 'utf8'), before);
    assert.equal(getPluginPref(WEB, 'cad', 'b'), null);
    // Replacing a value counts its new size, not both.
    setPluginPref(WEB, 'cad', 'a', 'z'.repeat(60 * 1024));
    assert.ok(Buffer.byteLength(readFileSync(join(DIR, 'cad.json'), 'utf8')) > 60 * 1024);
    assert.equal(PREFS_MAX_BYTES, 65536);
  });

  it('a file that cannot be read starts empty instead of failing every call', () => {
    mkdirSync(DIR, { recursive: true });
    writeFileSync(join(DIR, 'cad.json'), '{not json');
    assert.deepEqual(readPluginPrefs(WEB, 'cad'), {});
    setPluginPref(WEB, 'cad', 'k', true);
    assert.equal(getPluginPref(WEB, 'cad', 'k'), true);
  });
});
