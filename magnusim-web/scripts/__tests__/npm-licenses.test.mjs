// Licence check for the app's runtime packages. Magnusim is GPL-3.0-or-later, and the
// app runs on every package package-lock.json lists outside the dev tree (an entry
// without "dev": true), so each of those must carry a licence that may be combined with
// it: the SPDX set python/tools/plugin_check.py accepts for a plugin (GPL_COMPATIBLE,
// copied below and kept equal to it by a test), read as an SPDX expression the same way
// (AND needs both sides, OR either one, WITH only adds a permission). A package that
// needs more than that is a named exception below, each checked by hand and still needed.
// SPDX-License-Identifier: GPL-3.0-or-later
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const WEB = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const LOCKFILE = join(WEB, 'package-lock.json');
const PLUGIN_CHECK = join(WEB, 'python', 'tools', 'plugin_check.py');

/** python/tools/plugin_check.py GPL_COMPATIBLE: SPDX ids that may be combined with GPL-3.0-or-later. */
const GPL_COMPATIBLE = new Set([
  'GPL-3.0-or-later', 'GPL-3.0-only', 'GPL-2.0-or-later', 'AGPL-3.0-or-later', 'AGPL-3.0-only',
  'LGPL-3.0-or-later', 'LGPL-3.0-only', 'LGPL-2.1-or-later', 'LGPL-2.1-only',
  'MIT', 'MIT-0', 'X11', 'BSD-2-Clause', 'BSD-3-Clause', '0BSD', 'ISC', 'Apache-2.0', 'Zlib',
  'MPL-2.0', 'Unlicense', 'CC0-1.0', 'BSL-1.0', 'PSF-2.0', 'Python-2.0', 'NCSA', 'UPL-1.0',
  'Artistic-2.0', 'BlueOak-1.0.0',
]);
/** python/tools/plugin_check.py SPDX_DEPRECATED: old spellings of ids in the set, accepted as they are. */
const SPDX_DEPRECATED = new Set(['GPL-3.0', 'GPL-3.0+', 'GPL-2.0+', 'LGPL-3.0', 'LGPL-3.0+', 'LGPL-2.1', 'LGPL-2.1+', 'AGPL-3.0']);

/**
 * Packages accepted although their lockfile licence alone is not. `lockfile` is what
 * package-lock.json says (null: no licence field), and the exception holds only while it
 * says exactly that (and, with `version`, only for that version).
 */
const EXCEPTIONS = [
  {
    // Browser-support data, not code (through browserslist). The FSF lists CC BY 4.0 as
    // compatible with GPLv3.
    name: 'caniuse-lite',
    lockfile: 'CC-BY-4.0',
  },
  {
    // MIT: 0.6.2 names its licence in the old `licenses` array, which npm does not copy
    // into the lockfile; its LICENSE file is MIT (through shelljs, from vtk.js).
    name: 'rechoir',
    version: '0.6.2',
    lockfile: null,
  },
];

/** Why an SPDX expression may not ship with Magnusim, or null when it may (plugin_check.license_problem). */
function licenceProblem(expr) {
  const text = String(expr ?? '').trim();
  if (!text) return 'no licence';
  const tokens = text.match(/\(|\)|[^\s()]+/g);
  let pos = 0;
  const notes = [];
  const atom = () => {
    if (pos >= tokens.length) throw new Error('ends early');
    const tok = tokens[pos];
    if (tok === '(') {
      pos += 1;
      const ok = exprOr();
      if (pos >= tokens.length || tokens[pos] !== ')') throw new Error("a '(' is not closed");
      pos += 1;
      return ok;
    }
    if (['AND', 'OR', 'WITH', ')'].includes(tok.toUpperCase())) throw new Error(`unexpected '${tok}'`);
    pos += 1;
    if (pos < tokens.length && tokens[pos].toUpperCase() === 'WITH') {
      const next = tokens[pos + 1];
      if (next === undefined || ['AND', 'OR', 'WITH'].includes(next.toUpperCase()) || next === '(' || next === ')') {
        throw new Error('WITH needs an exception id after it');
      }
      pos += 2; // an exception only adds permissions
    }
    if (GPL_COMPATIBLE.has(tok) || SPDX_DEPRECATED.has(tok)) return true;
    notes.push(`${tok} is not a GPL-compatible SPDX licence id this check knows`);
    return false;
  };
  const exprAnd = () => {
    let ok = atom();
    while (pos < tokens.length && tokens[pos].toUpperCase() === 'AND') {
      pos += 1;
      ok = atom() && ok;
    }
    return ok;
  };
  const exprOr = () => {
    let ok = exprAnd();
    while (pos < tokens.length && tokens[pos].toUpperCase() === 'OR') {
      pos += 1;
      ok = exprAnd() || ok;
    }
    return ok;
  };
  try {
    const ok = exprOr();
    if (pos < tokens.length) throw new Error(`unexpected '${tokens[pos]}'`);
    return ok ? null : notes.join('; ');
  } catch (e) {
    return `not an SPDX expression (${e.message})`;
  }
}

/** The package's name from its lockfile key (`node_modules/a/node_modules/@s/b` is `@s/b`). */
const nameOf = (key, entry) => {
  const at = key.lastIndexOf('node_modules/');
  return at < 0 ? (entry.name ?? key) : key.slice(at + 'node_modules/'.length);
};
const lockfileLicence = (entry) => (typeof entry.license === 'string' ? entry.license : null);

/** The exception that covers this lockfile entry, if any. */
const exceptionFor = (key, entry, exceptions) =>
  exceptions.find(
    (x) =>
      x.name === nameOf(key, entry) &&
      x.lockfile === lockfileLicence(entry) &&
      (x.version === undefined || x.version === entry.version),
  );

/** Every package the app installs outside the dev tree, as [lockfile key, entry]. */
const runtimePackages = (lock) =>
  // '' is the app itself; a link entry points at a folder listed under its own key.
  Object.entries(lock.packages ?? {}).filter(([key, entry]) => key !== '' && !entry.dev && !entry.link);

/** "key version: why" for each runtime package whose licence may not ship with Magnusim. */
function refusedPackages(lock, exceptions = EXCEPTIONS) {
  const refused = [];
  for (const [key, entry] of runtimePackages(lock)) {
    const problem = licenceProblem(lockfileLicence(entry));
    if (problem && !exceptionFor(key, entry, exceptions)) refused.push(`${key} ${entry.version}: ${problem}`);
  }
  return refused;
}

const lock = JSON.parse(readFileSync(LOCKFILE, 'utf8'));

describe('npm licences', () => {
  test("every runtime package in package-lock.json has a GPL-compatible licence", () => {
    assert.equal(lock.lockfileVersion, 3, 'package-lock.json is lockfile version 3 (entries carry "license")');
    const runtime = runtimePackages(lock);
    assert.ok(runtime.some(([key]) => key === 'node_modules/react'), 'the runtime packages include react');
    assert.ok(!runtime.some(([key]) => key === 'node_modules/eslint'), 'dev packages are left out');
    const refused = refusedPackages(lock);
    assert.deepEqual(refused, [], `Runtime packages whose licence may not ship with Magnusim (GPL-3.0-or-later):\n${refused.join('\n')}`);
  });

  test('every exception is still needed by package-lock.json', () => {
    for (const x of EXCEPTIONS) {
      const used = runtimePackages(lock).some(
        ([key, entry]) => exceptionFor(key, entry, [x]) && licenceProblem(lockfileLicence(entry)),
      );
      assert.ok(used, `the exception for ${x.name} covers no runtime package any more: remove it`);
    }
  });

  test('the licence set is the one python/tools/plugin_check.py accepts', () => {
    const py = readFileSync(PLUGIN_CHECK, 'utf8').replace(/\r\n/g, '\n');
    const block = (name, re) => {
      const m = re.exec(py);
      assert.ok(m, `${name} found in plugin_check.py`);
      return m[1];
    };
    const ids = [...block('GPL_COMPATIBLE', /^GPL_COMPATIBLE = frozenset\(\s*\{([\s\S]*?)\}\s*\)/m).matchAll(/"([^"]+)"/g)].map((m) => m[1]);
    assert.ok(ids.length > 10, 'GPL_COMPATIBLE parsed');
    assert.deepEqual([...GPL_COMPATIBLE].sort(), [...new Set(ids)].sort());
    const old = [...block('SPDX_DEPRECATED', /^SPDX_DEPRECATED = \{([\s\S]*?)^\}/m).matchAll(/"([^"]+)"\s*:/g)].map((m) => m[1]);
    assert.ok(old.length > 3, 'SPDX_DEPRECATED parsed');
    assert.deepEqual([...SPDX_DEPRECATED].sort(), [...new Set(old)].sort());
  });

  test('SPDX expressions are read as plugin_check.py reads them', () => {
    const fine = ['MIT', '(MIT AND Zlib)', '(WTFPL OR MIT)', 'MIT AND (Zlib OR GPL-2.0-only)', 'Apache-2.0 WITH LLVM-exception', 'GPL-3.0', 'BlueOak-1.0.0', 'mit OR MIT'];
    for (const expr of fine) assert.equal(licenceProblem(expr), null, expr);
    const refused = {
      '': /no licence/,
      'GPL-2.0-only': /GPL-2\.0-only is not/,
      '(MIT AND GPL-2.0-only)': /GPL-2\.0-only is not/,
      'CC-BY-4.0': /CC-BY-4\.0 is not/,
      'SEE LICENSE IN LICENSE.txt': /not an SPDX expression/,
      'MIT OR': /not an SPDX expression \(ends early\)/,
      '(MIT': /not an SPDX expression \(a '\(' is not closed\)/,
      'MIT WITH': /not an SPDX expression \(WITH needs/,
      mit: /mit is not/,
    };
    for (const [expr, why] of Object.entries(refused)) assert.match(String(licenceProblem(expr)), why, expr);
  });

  test('the check refuses a runtime package only, and an exception only for what it names', () => {
    const fake = {
      lockfileVersion: 3,
      packages: {
        '': { name: 'app', license: 'GPL-3.0-or-later' },
        'node_modules/dev-only': { version: '1.0.0', license: 'GPL-2.0-only', dev: true },
        'node_modules/dev-optional': { version: '1.0.0', license: 'GPL-2.0-only', devOptional: true },
        'node_modules/optional-bin': { version: '1.0.0', license: 'GPL-2.0-only', optional: true },
        'node_modules/a/node_modules/@s/nested': { version: '2.0.0', license: 'EPL-1.0' },
        'node_modules/no-field': { version: '1.0.0' },
        'node_modules/linked': { link: true, resolved: 'packages/linked' },
        'node_modules/caniuse-lite': { version: '1.0.1', license: 'CC-BY-4.0' },
        'node_modules/rechoir': { version: '0.6.2' },
        'node_modules/x/node_modules/rechoir': { version: '0.7.0' },
        'node_modules/x/node_modules/caniuse-lite': { version: '1.0.0', license: 'CC-BY-SA-4.0' },
        'node_modules/fine': { version: '1.0.0', license: '(MIT OR GPL-2.0-only)' },
      },
    };
    assert.deepEqual(refusedPackages(fake).sort(), [
      'node_modules/a/node_modules/@s/nested 2.0.0: EPL-1.0 is not a GPL-compatible SPDX licence id this check knows',
      'node_modules/dev-optional 1.0.0: GPL-2.0-only is not a GPL-compatible SPDX licence id this check knows',
      'node_modules/no-field 1.0.0: no licence',
      'node_modules/optional-bin 1.0.0: GPL-2.0-only is not a GPL-compatible SPDX licence id this check knows',
      'node_modules/x/node_modules/caniuse-lite 1.0.0: CC-BY-SA-4.0 is not a GPL-compatible SPDX licence id this check knows',
      'node_modules/x/node_modules/rechoir 0.7.0: no licence',
    ]);
  });

  test("the cloud provider packages the Assistant adds, and theirs, are accepted", () => {
    const word = (b64) => Buffer.from(b64, 'base64').toString('utf8');
    // As the registry lists them for the pinned versions (checked 2026-10-16).
    const added = {
      [`node_modules/${word('QGFudGhyb3BpYy1haS9zZGs=')}`]: 'MIT',
      [`node_modules/${word('b3BlbmFp')}`]: 'Apache-2.0',
      'node_modules/json-schema-to-ts': 'MIT',
      'node_modules/ts-algebra': 'MIT',
      'node_modules/@babel/runtime': 'MIT',
      'node_modules/standardwebhooks': 'MIT',
      'node_modules/@stablelib/base64': 'MIT',
      'node_modules/fast-sha256': 'Unlicense',
    };
    const fake = { lockfileVersion: 3, packages: { '': {} } };
    for (const [key, license] of Object.entries(added)) fake.packages[key] = { version: '1.0.0', license };
    assert.deepEqual(refusedPackages(fake, []), []);
  });
});
