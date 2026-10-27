// The installer's licence check (desktop/scripts/notices.mjs): what may ship with a
// GPL-3.0-or-later app, and a package with no licence or an incompatible one failing the build.
// SPDX-License-Identifier: GPL-3.0-or-later
import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { compatible, licenceRows, noticesText } from '../scripts/notices.mjs';

const ROOT = mkdtempSync(join(tmpdir(), 'magnusim-cad-notices-'));
after(() => rmSync(ROOT, { recursive: true, force: true }));

function pkg(name, json, licenceText) {
  const dir = join(ROOT, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name, version: '1.0.0', ...json }));
  if (licenceText) writeFileSync(join(dir, 'LICENSE'), licenceText);
  return { name, version: '1.0.0', dir };
}

describe('compatible', () => {
  it('takes permissive, LGPL and GPL-3 licences, and SPDX OR/AND', () => {
    for (const x of ['MIT', 'ISC', 'Apache-2.0', 'BSD-3-Clause', 'LGPL-2.1-or-later', 'GPL-3.0-or-later', 'MPL-2.0', '(MIT OR Apache-2.0)', 'MIT AND Zlib', 'WTFPL OR MIT', 'CC-BY-4.0']) assert.equal(compatible(x), true, x);
  });
  it('refuses GPL-2.0-only, AGPL, proprietary and nothing', () => {
    for (const x of ['GPL-2.0-only', 'GPL-2.0', 'AGPL-3.0-or-later', 'SSPL-1.0', 'UNLICENSED', 'SEE LICENSE IN EULA.txt', '', 'MIT AND GPL-2.0-only']) assert.equal(compatible(x), false, x);
  });
});

describe('licenceRows', () => {
  it("reads a package's licence, npm's old licenses list, or an MIT licence file", () => {
    const rows = licenceRows([
      pkg('a', { license: 'MIT' }, 'MIT text'),
      pkg('b', { licenses: [{ type: 'MIT', url: 'x' }] }),
      pkg('c', {}, 'Permission is hereby granted, free of charge, to any person\nobtaining a copy of this software'),
    ]);
    assert.deepEqual(
      rows.map((r) => [r.name, r.licence]),
      [
        ['a', 'MIT'],
        ['b', 'MIT'],
        ['c', 'MIT'],
      ],
    );
    assert.equal(rows[0].text, 'MIT text');
  });

  it('fails on a package with no licence, or one that cannot ship with the app', () => {
    assert.throws(() => licenceRows([pkg('d', {})]), /d@1\.0\.0: no licence/);
    assert.throws(() => licenceRows([pkg('e', { license: 'AGPL-3.0-only' })]), /e@1\.0\.0: AGPL-3\.0-only cannot ship with GPL-3\.0-or-later/);
  });
});

describe('noticesText', () => {
  it("names the app's licence and source, the CAD components, Electron and Chromium, and each package with its text", () => {
    const text = noticesText({
      version: '0.5.0',
      commit: 'abc123',
      repo: 'https://example.org/repo',
      cad: 'OCCT 7.9.3 and PlaneGCS',
      rows: [{ name: 'react', version: '19.3.0', licence: 'MIT', text: 'Copyright Meta', homepage: '' }],
      electron: '44.9.3',
    });
    for (const part of ['GNU General Public License, version 3', 'https://example.org/repo, at commit abc123', 'OCCT 7.9.3 and PlaneGCS', 'kernel-build', 'Electron 44.9.3', 'LICENSES.chromium.html', 'react 19.3.0: MIT', 'Copyright Meta']) {
      assert.ok(text.includes(part), part);
    }
  });
});
