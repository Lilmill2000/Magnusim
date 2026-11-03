// The installer's licence check (desktop/scripts/notices.mjs): what may ship with a
// GPL-3.0-or-later app, a package with no licence or an incompatible one failing the build,
// and where each package's licence text comes from when it has no plain LICENSE file.
// SPDX-License-Identifier: GPL-3.0-or-later
import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cadSection, compatible, copiedFromWords, licenceRows, noticesText, productionPackages } from '../scripts/notices.mjs';

const ROOT = mkdtempSync(join(tmpdir(), 'magnusim-cad-notices-'));
after(() => rmSync(ROOT, { recursive: true, force: true }));

/** A package `name` (at `json.version`, else 1.0.0) in a node_modules folder `under` the test's folder. */
function pkg(name, json, licenceText, under = '') {
  const dir = join(ROOT, under, name);
  const version = json.version || '1.0.0';
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name, ...json, version }));
  if (licenceText) writeFileSync(join(dir, 'LICENSE'), licenceText);
  return { name, version, dir };
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

  it('reads every licence file, whatever its suffix: a dual licence gives both texts, and a folder is no licence file', () => {
    const f = pkg('f', { license: 'MIT OR Apache-2.0' });
    writeFileSync(join(f.dir, 'LICENSE-MIT.txt'), 'MIT for f');
    writeFileSync(join(f.dir, 'LICENSE-APACHE'), 'Apache for f');
    mkdirSync(join(f.dir, 'license-tools'));
    const g = pkg('g', { license: 'BSD-2-Clause' });
    writeFileSync(join(g.dir, 'LICENSE.BSD'), 'BSD for g');
    const rows = licenceRows([f, g]);
    assert.equal(rows[0].text, 'Apache for f\n\nMIT for f');
    assert.equal(rows[1].text, 'BSD for g');
  });

  it("gives a platform's binary package its main package's licence (esbuild's, rollup's)", () => {
    pkg('esbuild', { license: 'MIT' }, 'MIT License\n\nCopyright (c) 2020 Evan Wallace');
    pkg('rollup', { license: 'MIT' }, 'Rollup core license');
    const rows = licenceRows([pkg('@esbuild/linux-x64', { license: 'MIT' }), pkg('@rollup/rollup-win32-x64-msvc', { license: 'MIT' })]);
    assert.deepEqual(
      rows.map((r) => r.text),
      ['MIT License\n\nCopyright (c) 2020 Evan Wallace', 'Rollup core license'],
    );
  });

  it('reads a licence from the licence file a package states it in, never from a third-party notice beside it', () => {
    const gpl = pkg('gpl2', {}, 'GNU GENERAL PUBLIC LICENSE\nVersion 2, June 1991');
    writeFileSync(join(gpl.dir, 'LICENSE-THIRD-PARTY.txt'), 'Permission is hereby granted, free of charge, to any person obtaining a copy');
    assert.throws(() => licenceRows([gpl]), /gpl2@1\.0\.0: no licence/);
  });

  it("takes a README's licence section when it holds a copyright, and adds a file's own notice (seedrandom's alea)", () => {
    const s = pkg('seedrandom', { license: 'MIT', version: '3.0.5' });
    writeFileSync(join(s.dir, 'README.md'), 'seedrandom.js\n=============\n\nSeeded random.\n\nLICENSE (MIT)\n-------------\n\nCopyright 2019 David Bau.\n\nPermission is hereby granted\n');
    mkdirSync(join(s.dir, 'lib'));
    writeFileSync(join(s.dir, 'lib', 'alea.js'), '// A port of an algorithm by Johannes Baagøe\n\n// Copyright (C) 2010 by Johannes Baagøe\n//\n// Permission is hereby granted\n\n\n(function(global) {\n// not this\n');
    const h = pkg('h', { license: 'MIT' });
    writeFileSync(join(h.dir, 'README.md'), '# h\r\n\r\n## Install\r\n\r\nnpm i h\r\n\r\n## License\r\n\r\nCopyright (c) 2024 H People\r\n\r\nMIT\r\n\r\n## Thanks\r\n\r\nnot this\r\n');
    const rows = licenceRows([s, h]);
    assert.equal(rows.find((r) => r.name === 'h').text, '## License\n\nCopyright (c) 2024 H People\n\nMIT');
    assert.equal(
      rows.find((r) => r.name === 'seedrandom').text,
      'LICENSE (MIT)\n-------------\n\nCopyright 2019 David Bau.\n\nPermission is hereby granted\n\nlib/alea.js:\n\nA port of an algorithm by Johannes Baagøe\n\nCopyright (C) 2010 by Johannes Baagøe\n\nPermission is hereby granted',
    );
  });

  it("gives a package that names MIT and ships no text of it MIT's notice, saying so; fails a licence that asks for its notice with no text", () => {
    const i = pkg('i', { license: 'MIT', author: { name: 'I Author' } });
    writeFileSync(join(i.dir, 'README.md'), '# i\n\n## License\n\nMIT (http://www.opensource.org/licenses/mit-license.php)\n');
    const [row] = licenceRows([i]);
    assert.match(row.text, /^This package ships no licence text\. Its package\.json gives its licence as MIT and its author as I Author; the MIT licence reads:\n\nPermission is hereby granted, free of charge,[\s\S]*SOFTWARE\.$/);
    assert.throws(() => licenceRows([pkg('j', { license: 'BSD-3-Clause' })]), /j@1\.0\.0: BSD-3-Clause, and no licence text in the package/);
    assert.equal(licenceRows([pkg('k', { license: 'CC0-1.0' })])[0].text, '');
  });

  it("adds the licence texts of code a package carries from elsewhere, and fails when the package's version or file is not the one checked", () => {
    const vtk = pkg('@kitware/vtk.js', { license: 'BSD-3-Clause', version: '32.14.0' }, 'Copyright (c) Kitware');
    writeFileSync(join(vtk.dir, 'macros2.js'), '// From : fixed-data-table\n');
    const sw = pkg('standardwebhooks', { license: 'MIT', version: '1.1.1' }, 'MIT for sw');
    mkdirSync(join(sw.dir, 'dist'));
    writeFileSync(join(sw.dir, 'dist', 'timing_safe_equal.js'), '"use strict";\n');
    const [v, s] = licenceRows([vtk, sw]);
    assert.match(v.text, /^Copyright \(c\) Kitware\n\nnormalizeWheel in macros2\.js, from Facebook's fixed-data-table \(Copyright \(c\) 2015, Facebook, Inc\.\):\n\nBSD License\n\nFor FixedDataTable software\n/);
    assert.match(s.text, /^MIT for sw\n\ndist\/timing_safe_equal\.js, from the Deno standard library [^\n]*:\n\nMIT License\n\nCopyright 2018-2022 the Deno authors\./);
    assert.throws(() => licenceRows([pkg('standardwebhooks', { license: 'MIT', version: '1.2.0' }, 'MIT', 'newer')]), /standardwebhooks@1\.2\.0: its own notices \(OWN_NOTICES[^)]*\) were checked at 1\.1\.1/);
    assert.throws(() => licenceRows([pkg('@kitware/vtk.js', { license: 'BSD-3-Clause', version: '32.14.0' }, 'BSD', 'moved')]), /@kitware\/vtk\.js@32\.14\.0: no notice for macros2\.js [^:]*: the package has no such file/);
  });

  const WEB = fileURLToPath(new URL('../../', import.meta.url));
  it('gives every npm package the app ships a licence text, with the notices of the code they carry from elsewhere', { skip: !existsSync(join(WEB, 'node_modules', 'seedrandom')) && 'run npm ci in magnusim-web first' }, () => {
    const rows = licenceRows([
      ...productionPackages(join(WEB, 'package-lock.json'), join(WEB, 'node_modules')),
      ...productionPackages(join(WEB, 'bundled-plugins', 'cad', 'package-lock.json'), join(WEB, 'bundled-plugins', 'cad', 'node_modules')),
    ]);
    assert.deepEqual(rows.filter((r) => !r.text).map((r) => `${r.name} ${r.licence}`), []);
    const text = (name) => rows.find((r) => r.name === name)?.text || '';
    for (const part of ['Copyright 2019 David Bau', 'lib/alea.js:', 'Copyright (C) 2010 by Johannes Baagøe']) assert.ok(text('seedrandom').includes(part), part);
    assert.ok(text('@kitware/vtk.js').includes('For FixedDataTable software'), 'vtk.js: fixed-data-table');
    assert.ok(text('standardwebhooks').includes('Copyright 2018-2022 the Deno authors.'), 'standardwebhooks: Deno');
    for (const part of ['Copyright (c) 2020 Evan Wallace', 'Copyright (c) 2009 The Go Authors']) assert.ok(text('@esbuild/win32-x64').includes(part), part);
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

  it('names the Magnusim CAD repository and the Magnusim commit its code was copied from, for a build from a release export', () => {
    const base = { version: '0.5.0', repo: 'https://example.org/cad', cad: 'OCCT', rows: [], electron: '44.9.3' };
    const sha = 'f'.repeat(40);
    const text = noticesText({ ...base, commit: '', copiedFrom: { repo: 'https://example.org/magnusim', commit: sha, changed: 0 } });
    assert.ok(text.includes(`Its source is the\nMagnusim CAD repository, https://example.org/cad, whose code is copied from\nMagnusim, https://example.org/magnusim, at commit\n${sha}.\n`), text.slice(0, 400));
    assert.ok(!text.includes('Magnusim repository'), 'not "the Magnusim repository" as its source');
    assert.match(noticesText({ ...base, copiedFrom: { repo: 'https://example.org/magnusim', commit: sha, changed: 2 } }).replace(/\n/g, ' '), / \(with 2 files changed from that commit\)\./);
    const tagged = noticesText({ ...base, copiedFrom: { repo: 'https://example.org/magnusim', label: 'v0.5.0', commit: sha, changed: 0 } });
    assert.ok(tagged.replace(/\n/g, ' ').includes(`copied from Magnusim v0.5.0, https://example.org/magnusim, at commit ${sha}.`), tagged.slice(0, 400));
  });

  it("names a development snapshot by Magnusim's development version and date, with no commit", () => {
    const text = noticesText({ version: '0.5.0-dev', repo: 'https://github.com/Lilmill2000/Magnusim-CAD', cad: 'OCCT', rows: [], electron: '44.9.3', commit: '', copiedFrom: { repo: 'https://github.com/Lilmill2000/Magnusim', label: 'development version 0.5.0-dev (2026-10-29)', commit: '', changed: 0 } });
    assert.ok(
      text.includes("Its source is the\nMagnusim CAD repository, https://github.com/Lilmill2000/Magnusim-CAD, whose\ncode is copied from Magnusim's development version 0.5.0-dev (2026-10-29),\nhttps://github.com/Lilmill2000/Magnusim.\n"),
      text.slice(0, 500),
    );
    assert.ok(!/commit/.test(text.split('It ships the software below')[0]), 'no commit named');
    for (const line of text.split('Its source is the\n')[1].split('\n\n')[0].split('\n')) assert.ok(line.length <= 78, line);
    assert.equal(copiedFromWords({ repo: 'R', label: 'development version 1 (2026-01-01)', changed: 3 }), "Magnusim's development version 1 (2026-01-01), R (with 3 files changed from it)");
  });
});

describe("Magnusim CAD's installer notices, from the repository's CAD section", () => {
  it('name what mk32.wasm holds since kernel API 8: Analysis Situs and its four copyright holders, in the kernel bullet', () => {
    const section = cadSection(fileURLToPath(new URL('../../../THIRD_PARTY_NOTICES.md', import.meta.url)));
    const kernel = /^- `workspace\/kernel\/mk32\.wasm`:([\s\S]*?)(?=^- )/m.exec(section);
    assert.ok(kernel, section.slice(0, 400));
    const bullet = kernel[1].replace(/\s+/g, ' ');
    for (const part of ['Open CASCADE Technology 7.9.3', "Analysis Situs 2026.1.1's asiAlgo", 'BSD-3-Clause', 'Sergey Slyadnev', 'OPEN CASCADE SAS', 'Quaoar Studio LLC', 'Julia Slyadneva', "OCCT's LGPL-2.1"]) assert.ok(bullet.includes(part), part);
    assert.ok(!/holds none of their code|No kernel op calls them yet/.test(section), 'the API 7 wording is gone');
    const text = noticesText({ version: '0.5.0', commit: 'abc123', repo: 'https://example.org/repo', cad: section, rows: [], electron: '44.9.3' });
    assert.ok(text.replace(/\s+/g, ' ').includes("Analysis Situs 2026.1.1's asiAlgo"), 'the installer text names Analysis Situs');
  });
});
