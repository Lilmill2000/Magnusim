// Vendor names stay in the assistant's own files. The Assistant talks to a cloud provider
// or a local server; only its provider code, its tests, the package files and the third
// party notices may name one. Everything else the repository tracks (docs, templates, SDK
// comments, SECURITY.md, ROADMAP.md, README.md) stays vendor-neutral, and no coding tool's
// own files (settings folders, instruction files) are tracked at all.
//
// The check runs over every tracked file from the repository's top level. Binary files are
// skipped by content, as `git grep -I` does. The words are base64 here, so this file passes
// its own check.
// SPDX-License-Identifier: GPL-3.0-or-later
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const decode = (b64) => Buffer.from(b64, 'base64').toString('utf8');
const mixedCase = (s) => s[0].toUpperCase() + s.slice(1).toLowerCase();
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// The vendor words, case-insensitive, as whole words: no letter right before or after, so
// an underscore or a digit next to the word still counts. The short model-family word also
// needs no digit before it.
const WORD_RES = [
  'KD88IVthLXpdKShjbGF1ZGV8YW50aHJvcGljfG9wZW5haXxjaGF0Z3B0fGNvcGlsb3QpKD8hW2Etel0p',
  'KD88IVthLXowLTldKWdwdCg/IVthLXpdKQ==',
].map((b64) => new RegExp(decode(b64), 'i'));
const namesVendor = (text) => WORD_RES.some((re) => re.test(text));

// Paths refused anywhere, even among the allowed files: two coding tools' settings folders,
// and the instruction files coding tools read.
const REFUSED_DIRS = decode('KF58LylcLihjbGF1ZGV8Y3Vyc29yKSgvfCQp');
const REFUSED_NAMES = [
  'LmN1cnNvcnJ1bGVz',
  'QUdFTlRTLm1k',
  'bGxtcy50eHQ=',
  'Y29waWxvdC1pbnN0cnVjdGlvbnMubWQ=',
  'Q0xBVURFLm1k',
  'R0VNSU5JLm1k',
  'LndpbmRzdXJmcnVsZXM=',
].map((b64) => escapeRe(decode(b64)));
const REFUSED_PATH = new RegExp(`${REFUSED_DIRS}|(^|/)(${REFUSED_NAMES.join('|')})$`, 'i');

/** Files whose contents may name a vendor (repository-relative; `*` stays within a folder). */
const ALLOWED_CONTENT = [
  'magnusim-web/scripts/server/assistant/**',
  'magnusim-web/scripts/server/assistant-routes.ts',
  'magnusim-web/scripts/server/__tests__/assistant-*',
  'magnusim-web/scripts/__tests__/assistant-*',
  'magnusim-web/src/assistant/**',
  'magnusim-web/src/panels/prefs/AssistantStep*',
  'magnusim-web/e2e/assistant-*.spec.js',
  // Magnusim CAD's desktop app: its coding-agent test drives the known agents' rows.
  'magnusim-web/e2e-desktop/assistant-*.spec.ts',
  'magnusim-web/e2e/support/fake-llm.mjs',
  'magnusim-web/e2e/support/assistant.js',
  // The Magnusim CAD export, its self-check and that check's test: they name AI tools' files and vendors to keep them out of the copy.
  'magnusim-web/scripts/export-cad-repo.mjs',
  'magnusim-web/scripts/export-cad-repo/self-check.mjs',
  'magnusim-web/scripts/__tests__/export-cad-self-check.test.mjs',
  'magnusim-web/package.json',
  'magnusim-web/package-lock.json',
  'THIRD_PARTY_NOTICES.md',
];
/** Files whose path may name a vendor: only the provider adapters. */
const ALLOWED_NAMES = ['magnusim-web/scripts/server/assistant/providers/*'];

const globRe = (pattern) =>
  new RegExp(`^${pattern.split('**').map((part) => part.split('*').map(escapeRe).join('[^/]*')).join('.*')}$`);
const CONTENT_OK = ALLOWED_CONTENT.map(globRe);
const NAME_OK = ALLOWED_NAMES.map(globRe);
const allowed = (res, path) => res.some((re) => re.test(path));

// As `git grep -I`: a NUL byte in the first 8000 bytes makes a file binary.
const isBinary = (buf) => buf.subarray(0, 8000).includes(0);

/**
 * Every vendor name and coding-tool file among `paths` (repository-relative, `/`-separated,
 * under `root`), as "path: why" or "path:line: text".
 */
function vendorHits(root, paths) {
  const hits = [];
  for (const path of paths) {
    if (REFUSED_PATH.test(path)) {
      hits.push(`${path}: a coding tool's file`);
      continue;
    }
    if (!allowed(NAME_OK, path) && namesVendor(path)) hits.push(`${path}: the path names a vendor`);
    if (allowed(CONTENT_OK, path)) continue;
    const file = join(root, path);
    let buf;
    try {
      // A tracked submodule is a folder; a file deleted from the working tree is not read.
      if (!statSync(file).isFile()) continue;
      buf = readFileSync(file);
    } catch (e) {
      if (e?.code === 'ENOENT') continue;
      throw e;
    }
    if (isBinary(buf)) continue;
    buf
      .toString('utf8')
      .split('\n')
      .forEach((line, i) => {
        if (namesVendor(line)) hits.push(`${path}:${i + 1}: ${line.trim().slice(0, 160)}`);
      });
  }
  return hits;
}

/** The repository's top level, or why it cannot be found. */
function repoTop() {
  const r = spawnSync('git', ['rev-parse', '--show-toplevel'], { cwd: HERE, encoding: 'utf8', windowsHide: true });
  if (r.error) return { why: `git is not available (${r.error.code ?? r.error.message})` };
  if (r.status !== 0) {
    const said = r.stderr.trim().split('\n')[0];
    return { why: `not a git checkout, for example the portable zip${said ? ` (git: ${said})` : ''}` };
  }
  return { dir: r.stdout.trim() };
}

/** Every tracked path, repository-relative. */
function trackedFiles(top) {
  const r = spawnSync('git', ['ls-files', '-z', '--full-name'], {
    cwd: top,
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
    windowsHide: true,
  });
  assert.equal(r.status, 0, `git ls-files failed: ${r.stderr}`);
  return r.stdout.split('\0').filter(Boolean);
}

const TOP = repoTop();
const TMP = mkdtempSync(join(tmpdir(), 'magnusim-vendor-names-'));
after(() => {
  try {
    rmSync(TMP, { recursive: true, force: true });
  } catch {
    // A temp folder left behind is harmless.
  }
});

describe('vendor names stay in the assistant\'s own files', () => {
  test('no tracked file names a vendor outside them, and no coding tool\'s file is tracked', { skip: TOP.why ?? false }, () => {
    const files = trackedFiles(TOP.dir);
    assert.ok(files.includes('magnusim-web/package.json') && files.includes('README.md'), 'git listed the whole repository');
    const hits = vendorHits(TOP.dir, files);
    assert.deepEqual(
      hits,
      [],
      `Vendor names outside the assistant's own files (write "cloud provider" or "local server"; ALLOWED_CONTENT lists the files that may name one):\n${hits.join('\n')}`,
    );
  });

  test('this file passes its own check', () => {
    const own = readFileSync(fileURLToPath(import.meta.url), 'utf8');
    assert.deepEqual(own.split('\n').filter(namesVendor), []);
  });

  test('the check finds names in text and paths, refuses coding-tool files, and lets allowed and binary files through', () => {
    const w = {
      a: decode('Y2xhdWRl'),
      b: decode('YW50aHJvcGlj'),
      c: decode('b3BlbmFp'),
      d: decode('Y2hhdGdwdA=='),
      e: decode('Q29waWxvdA=='),
      g: decode('Z3B0'),
    };
    const files = {
      // Found: each word, any case, next to a non-letter.
      'magnusim-web/src/app/a.ts': `const model = '${w.a}-opus';\n`,
      'magnusim-web/docs/b.md': `Line one.\nSet ${w.c}_compatible here.\n`,
      'README.md': `Works with ${w.g.toUpperCase()}-6 and ${w.g}4o.\n`,
      'magnusim-web/templates/c.md': `Made with ${w.e}.\n`,
      'ROADMAP.md': `${w.d.toUpperCase()} support\n`,
      'magnusim-web/scripts/d.js': `// ${w.b.toUpperCase()}\n`,
      // Not found: the word inside a longer word.
      'magnusim-web/src/app/fine.ts': `${w.a}tte, ${w.b}ally, ${w.d}s, x${w.g}, 0${w.g}3, ${w.g}x\n`,
      // Text past the binary window: still text.
      'magnusim-web/src/app/late-nul.txt': Buffer.concat([Buffer.from(`${w.c}\n`), Buffer.alloc(9000, 0x20), Buffer.from([0])]),
      // Binary (a NUL early on): skipped.
      'bundled-plugins/x/archive.bin': Buffer.concat([Buffer.from([0x50, 0x4b, 0, 0]), Buffer.from(` ${w.a} `)]),
      // Allowed contents.
      'magnusim-web/src/assistant/x.ts': `${w.a} ${w.c}\n`,
      'magnusim-web/scripts/server/assistant/prices.ts': `${w.a}\n`,
      'magnusim-web/scripts/server/assistant-routes.ts': `${w.b}\n`,
      'magnusim-web/scripts/server/__tests__/assistant-loop.test.js': `${w.b}\n`,
      'magnusim-web/scripts/__tests__/assistant-boundaries.test.mjs': `${w.b}\n`,
      'magnusim-web/src/panels/prefs/AssistantStep.test.tsx': `${w.c}\n`,
      'magnusim-web/e2e/assistant-settings.spec.js': `${w.c}\n`,
      'magnusim-web/e2e/support/fake-llm.mjs': `${w.c}\n`,
      'magnusim-web/e2e/support/assistant.js': `${w.c}\n`,
      'magnusim-web/package.json': `"${w.c}"\n`,
      'magnusim-web/package-lock.json': `"${w.c}"\n`,
      'THIRD_PARTY_NOTICES.md': `${w.b}\n`,
      // Allowed path names (and contents): the provider adapters only.
      [`magnusim-web/scripts/server/assistant/providers/${w.c}-compatible.ts`]: `${w.c}\n`,
      // Not allowed: a provider's name one folder below the adapters (its contents still may).
      [`magnusim-web/scripts/server/assistant/providers/sub/${w.c}.ts`]: 'export {};\n',
      // Not allowed: one level too deep (`*` stays within a folder), or the right name in the wrong folder.
      'magnusim-web/e2e/sub/assistant-settings.spec.js': `${w.c}\n`,
      'magnusim-web/e2e/assistant-old/x.spec.js': `${w.c}\n`,
      'magnusim-web/THIRD_PARTY_NOTICES.md': `${w.b}\n`,
      // A path that names a vendor, with clean contents.
      [`magnusim-web/src/${w.b}.ts`]: 'export {};\n',
      [`magnusim-web/scripts/server/assistant/${w.b}.ts`]: 'export {};\n',
      // Coding-tool files: refused anywhere, also in the allowed folders.
      [`.${w.a}/settings.json`]: '{}\n',
      [`magnusim-web/.${decode('Y3Vyc29y')}/rules/x.mdc`]: 'x\n',
      [`.${decode('Y3Vyc29y')}rules`]: 'x\n',
      [`magnusim-web/${decode('QUdFTlRTLm1k')}`]: 'x\n',
      [`docs/${decode('bGxtcy50eHQ=')}`]: 'x\n',
      [`.github/${decode('Y29waWxvdC1pbnN0cnVjdGlvbnMubWQ=')}`]: 'x\n',
      [decode('Q0xBVURFLm1k')]: 'x\n',
      [`magnusim-web/scripts/server/assistant/providers/${decode('Q0xBVURFLm1k')}`]: 'x\n',
      [decode('R0VNSU5JLm1k')]: 'x\n',
      [`magnusim-web/${decode('LndpbmRzdXJmcnVsZXM=')}`]: 'x\n',
      // Coding-tool files in any case: the tools read these names case-insensitively on Windows.
      [`docs/${decode('QUdFTlRTLm1k').toLowerCase()}`]: 'x\n',
      [`magnusim-web/docs/${mixedCase(decode('R0VNSU5JLm1k'))}`]: 'x\n',
      [`magnusim-web/src/${decode('bGxtcy50eHQ=').replace(/txt$/, 'TXT')}`]: 'x\n',
      [`bundled-plugins/x/.${mixedCase(decode('Y3Vyc29y'))}/rules/y.mdc`]: 'x\n',
      // Not a coding-tool file: the pointer word on its own.
      [`magnusim-web/src/${decode('Y3Vyc29y')}.ts`]: 'export {};\n',
    };
    const root = join(TMP, 'tree');
    for (const [rel, body] of Object.entries(files)) {
      mkdirSync(dirname(join(root, rel)), { recursive: true });
      writeFileSync(join(root, rel), body);
    }
    // A tracked path missing from the working tree is not an error.
    const hits = vendorHits(root, [...Object.keys(files), 'magnusim-web/src/deleted.ts']);
    const where = hits.map((h) => h.replace(/: .*$/, '')).sort();
    const expected = [
      'magnusim-web/src/app/a.ts:1',
      'magnusim-web/docs/b.md:2',
      'README.md:1',
      'magnusim-web/templates/c.md:1',
      'ROADMAP.md:1',
      'magnusim-web/scripts/d.js:1',
      'magnusim-web/src/app/late-nul.txt:1',
      'magnusim-web/e2e/sub/assistant-settings.spec.js:1',
      'magnusim-web/e2e/assistant-old/x.spec.js:1',
      'magnusim-web/THIRD_PARTY_NOTICES.md:1',
      `magnusim-web/src/${w.b}.ts`,
      `magnusim-web/scripts/server/assistant/${w.b}.ts`,
      `magnusim-web/scripts/server/assistant/providers/sub/${w.c}.ts`,
      `.${w.a}/settings.json`,
      `magnusim-web/.${decode('Y3Vyc29y')}/rules/x.mdc`,
      `.${decode('Y3Vyc29y')}rules`,
      `magnusim-web/${decode('QUdFTlRTLm1k')}`,
      `docs/${decode('bGxtcy50eHQ=')}`,
      `.github/${decode('Y29waWxvdC1pbnN0cnVjdGlvbnMubWQ=')}`,
      decode('Q0xBVURFLm1k'),
      `magnusim-web/scripts/server/assistant/providers/${decode('Q0xBVURFLm1k')}`,
      decode('R0VNSU5JLm1k'),
      `magnusim-web/${decode('LndpbmRzdXJmcnVsZXM=')}`,
      `docs/${decode('QUdFTlRTLm1k').toLowerCase()}`,
      `magnusim-web/docs/${mixedCase(decode('R0VNSU5JLm1k'))}`,
      `magnusim-web/src/${decode('bGxtcy50eHQ=').replace(/txt$/, 'TXT')}`,
      `bundled-plugins/x/.${mixedCase(decode('Y3Vyc29y'))}/rules/y.mdc`,
    ].sort();
    assert.deepEqual(where, expected, hits.join('\n'));
    // Two hits in one line are reported once, with the line's text.
    assert.ok(hits.includes(`README.md:1: Works with ${w.g.toUpperCase()}-6 and ${w.g}4o.`), hits.join('\n'));
  });
});
