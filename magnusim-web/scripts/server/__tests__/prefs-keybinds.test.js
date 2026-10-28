// The person's keys for the app's own commands in the app prefs (Settings → Keybinds): POST
// /api/prefs stores the whole `keybinds` value when its shape is right, refuses it otherwise, and
// GET /api/prefs (publicPrefs) gives it back; junk in the file reads as none.
import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ROOT = mkdtempSync(join(tmpdir(), 'magnusim-prefs-keybinds-'));
const LOCAL = join(ROOT, 'local.json');
process.env.MAGNUSIM_LOCAL_JSON = LOCAL;

const { cleanAppKeybinds, publicPrefs, resetPrefsCache } = await import('../../prefs.js');
const { handlePrefsApi } = await import('../../w32-prefs.js');

after(() => rmSync(ROOT, { recursive: true, force: true }));

async function prefsApi(method, body) {
  let out = null;
  await handlePrefsApi({ method }, {}, new URL('http://127.0.0.1/api/prefs'), ['api', 'prefs'], {
    sendJson: (_res, status, b) => {
      out = { status, body: b };
    },
    readJsonBody: async () => body,
  });
  return out;
}

describe('the app keybinds in /api/prefs', () => {
  it('stores the whole value, keeps the other prefs, and GET gives it back', async () => {
    writeFileSync(LOCAL, JSON.stringify({ units: 'Imperial', wsl_distro: 'Ubuntu' }));
    resetPrefsCache();
    assert.deepEqual(publicPrefs().keybinds, {});
    const set = await prefsApi('POST', { keybinds: { 'app.assistant': ['Ctrl+KeyK', 'F9'] } });
    assert.equal(set.status, 200);
    assert.deepEqual(set.body.prefs.keybinds, { 'app.assistant': ['Ctrl+KeyK', 'F9'] });
    const got = await prefsApi('GET');
    assert.deepEqual(got.body.keybinds, { 'app.assistant': ['Ctrl+KeyK', 'F9'] });
    assert.equal(got.body.units, 'Imperial');
    const file = JSON.parse(readFileSync(LOCAL, 'utf8'));
    assert.equal(file.wsl_distro, 'Ubuntu');
    // No key at all is kept as [] (the person cleared it).
    assert.deepEqual((await prefsApi('POST', { keybinds: { 'app.assistant': [] } })).body.prefs.keybinds, { 'app.assistant': [] });
    // {} and null both put the defaults back.
    assert.deepEqual((await prefsApi('POST', { keybinds: {} })).body.prefs.keybinds, {});
    await prefsApi('POST', { keybinds: { 'app.assistant': ['Alt+KeyA'] } });
    assert.deepEqual((await prefsApi('POST', { keybinds: null })).body.prefs.keybinds, {});
    // A save of something else leaves them as they are.
    await prefsApi('POST', { keybinds: { 'app.assistant': ['Alt+KeyA'] } });
    assert.deepEqual((await prefsApi('POST', { units: 'Metric' })).body.prefs.keybinds, { 'app.assistant': ['Alt+KeyA'] });
  });

  it('refuses a value of the wrong shape and changes nothing', async () => {
    await prefsApi('POST', { keybinds: { 'app.assistant': ['Ctrl+KeyK'] } });
    for (const bad of [
      [],
      'Ctrl+KeyK',
      { 'app.close': ['Ctrl+KeyK'] },
      { 'sketch.line': ['KeyL'] },
      { 'app.assistant': 'Ctrl+KeyK' },
      { 'app.assistant': ['Ctrl+KeyK', 'Ctrl+KeyL', 'Ctrl+KeyM', 'Ctrl+KeyN', 'Ctrl+KeyO'] },
      { 'app.assistant': [1] },
      { 'app.assistant': ['Shift+Ctrl+KeyK'] },
      { 'app.assistant': ['Ctrl+<script>'] },
      { 'app.assistant': ['x'.repeat(40)] },
    ]) {
      const r = await prefsApi('POST', { keybinds: bad });
      assert.equal(r.status, 400, JSON.stringify(bad));
      assert.equal(r.body.ok, false);
    }
    assert.deepEqual(publicPrefs().keybinds, { 'app.assistant': ['Ctrl+KeyK'] });
  });

  it('reads junk in the file as no keys of the person', () => {
    for (const junk of ['Ctrl+KeyK', [], { 'app.assistant': 'F9' }, { other: ['F9'] }]) {
      writeFileSync(LOCAL, JSON.stringify({ keybinds: junk }));
      resetPrefsCache();
      assert.deepEqual(publicPrefs().keybinds, {}, JSON.stringify(junk));
    }
    assert.equal(cleanAppKeybinds(null), null);
    assert.deepEqual(cleanAppKeybinds({ 'app.assistant': ['Ctrl+Alt+Shift+Meta+F12'] }), { 'app.assistant': ['Ctrl+Alt+Shift+Meta+F12'] });
  });
});
