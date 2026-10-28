// The person's look in the app prefs (Settings → Appearance): POST /api/prefs stores a theme, a
// text size and an icon size only from the lists Settings offers, refuses anything else (and saves
// nothing of that request), GET /api/prefs gives them back, and junk in the file reads as the
// defaults. The page's lists (src/theme/appearance.ts) are the server's.
import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ROOT = mkdtempSync(join(tmpdir(), 'magnusim-prefs-appearance-'));
const LOCAL = join(ROOT, 'local.json');
process.env.MAGNUSIM_LOCAL_JSON = LOCAL;

const { ICON_SCALES, TEXT_SCALES, THEMES, publicPrefs, resetPrefsCache, stampAppearance } = await import('../../prefs.js');
const { handlePrefsApi } = await import('../../w32-prefs.js');
const page = await import('../../../src/theme/appearance.ts');

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

const look = (p) => ({ theme: p.theme, text_scale: p.text_scale, icon_scale: p.icon_scale });

describe('the look in /api/prefs', () => {
  it('offers what the page offers', () => {
    assert.deepEqual([THEMES, TEXT_SCALES, ICON_SCALES], [[...page.THEMES], [...page.TEXT_SCALES], [...page.ICON_SCALES]]);
    writeFileSync(LOCAL, '{}');
    resetPrefsCache();
    assert.deepEqual(look(publicPrefs()), { ...page.DEFAULT_APPEARANCE });
  });

  it('stores each field on its own, keeps the other prefs, and GET gives them back', async () => {
    writeFileSync(LOCAL, JSON.stringify({ units: 'Imperial' }));
    resetPrefsCache();
    assert.equal((await prefsApi('POST', { theme: 'dark' })).status, 200);
    const sized = await prefsApi('POST', { text_scale: 1.15, icon_scale: 1.5 });
    assert.deepEqual(look(sized.body.prefs), { theme: 'dark', text_scale: 1.15, icon_scale: 1.5 });
    const got = await prefsApi('GET');
    assert.deepEqual(look(got.body), { theme: 'dark', text_scale: 1.15, icon_scale: 1.5 });
    assert.equal(got.body.units, 'Imperial');
    assert.deepEqual(look((await prefsApi('POST', { theme: 'system' })).body.prefs), { theme: 'system', text_scale: 1.15, icon_scale: 1.5 });
  });

  it('refuses a value Settings does not offer, and saves nothing of that request', async () => {
    // Not the defaults, so a field saved before the refusal would show.
    await prefsApi('POST', { theme: 'dark', text_scale: 1.15, icon_scale: 1.5, units: 'Metric' });
    const before = readFileSync(LOCAL, 'utf8');
    // Each bad one with a good field that differs from what is stored, before and after the bad one.
    for (const bad of [
      { theme: 'neon' },
      { theme: 1 },
      { text_scale: 2 },
      { text_scale: '1.15' },
      { icon_scale: 0 },
      { icon_scale: [1] },
      { units: 'Imperial', text_scale: 7 },
      { theme: 'light', icon_scale: 9 },
      { text_scale: 1.3, theme: 'neon' },
      { icon_scale: 1, text_scale: 0.5 },
    ]) {
      const r = await prefsApi('POST', bad);
      assert.equal(r.status, 400, JSON.stringify(bad));
      assert.equal(r.body.ok, false);
    }
    assert.equal(readFileSync(LOCAL, 'utf8'), before);
    const now = publicPrefs();
    assert.deepEqual(look(now), { theme: 'dark', text_scale: 1.15, icon_scale: 1.5 });
    assert.equal(now.units, 'Metric');
  });

  it('puts the stored look on the page as served (data-look on <html>, JSON the pre-paint script reads)', async () => {
    await prefsApi('POST', { theme: 'system', text_scale: 1.3, icon_scale: 0.85 });
    const page = '<!DOCTYPE html>\n<html lang="en">\n  <head></head>\n  <body><p>an <html> in text</p></body>\n</html>\n';
    const out = stampAppearance(page);
    const attr = /^<!DOCTYPE html>\n<html data-look="([^"]*)" lang="en">\n/.exec(out);
    assert.ok(attr, out);
    assert.deepEqual(JSON.parse(attr[1].replace(/&quot;/g, '"')), { theme: 'system', text_scale: 1.3, icon_scale: 0.85 });
    // Only the page's own <html>.
    assert.equal(out.split('data-look').length, 2);
    assert.ok(out.endsWith('<body><p>an <html> in text</p></body>\n</html>\n'));
  });

  it('reads junk in the file as the defaults', () => {
    writeFileSync(LOCAL, JSON.stringify({ theme: 'purple', text_scale: '1.3', icon_scale: 9 }));
    resetPrefsCache();
    assert.deepEqual(look(publicPrefs()), { theme: 'light', text_scale: 1, icon_scale: 1 });
  });
});
