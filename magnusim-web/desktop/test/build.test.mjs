// The installer build's word on where its source is (desktop/scripts/build.mjs sourceOf): this
// checkout's commit in Magnusim, and in the Magnusim CAD repository (a copy with the export's
// EXPORT.json at its root) that repository and the Magnusim commit its code was copied from.
// SPDX-License-Identifier: GPL-3.0-or-later
import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CAD_REPO_URL, sourceOf } from '../scripts/build.mjs';

const BUILD = join(dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'build.mjs');
const ROOT = mkdtempSync(join(tmpdir(), 'magnusim-cad-build-'));
after(() => rmSync(ROOT, { recursive: true, force: true }));

const SHA = '0123456789abcdef0123456789abcdef01234567';

function folder(name, exportJson) {
  const dir = join(ROOT, name);
  mkdirSync(dir, { recursive: true });
  if (exportJson !== undefined) writeFileSync(join(dir, 'EXPORT.json'), typeof exportJson === 'string' ? exportJson : JSON.stringify(exportJson));
  return dir;
}

describe('sourceOf', () => {
  it("names the Magnusim CAD repository and EXPORT.json's Magnusim commit in the export's copy", () => {
    const dir = folder('copy', { kind: 'magnusim-cad-export', magnusim: { repository: 'https://github.com/Lilmill2000/Magnusim', commit: SHA, date: '2026-10-29T00:00:00Z' } });
    assert.deepEqual(sourceOf(dir), { repo: CAD_REPO_URL, commit: '', copiedFrom: { repo: 'https://github.com/Lilmill2000/Magnusim', commit: SHA, changed: 0 } });
    assert.equal(CAD_REPO_URL, 'https://github.com/Lilmill2000/Magnusim-CAD');
  });

  it('counts the files a copy made with --allow-dirty took from the working tree', () => {
    const dir = folder('dirty-copy', { kind: 'magnusim-cad-export', magnusim: { commit: SHA, uncommitted: ['a.ts', 'b.ts'] } });
    assert.equal(sourceOf(dir).copiedFrom.changed, 2);
    assert.equal(sourceOf(dir).copiedFrom.repo, 'https://github.com/Lilmill2000/Magnusim', "Magnusim's repository when the record names none");
  });

  it("fails on the export's record without a Magnusim commit, rather than naming a wrong source", () => {
    const dir = folder('no-commit', { kind: 'magnusim-cad-export', magnusim: { commit: 'HEAD' } });
    assert.throws(() => sourceOf(dir), /names no Magnusim commit/);
  });

  it('fails in a copy whose export did not finish or failed its self-check, and builds in one that passed it', () => {
    const magnusim = { commit: SHA };
    assert.throws(() => sourceOf(folder('incomplete', { kind: 'magnusim-cad-export', incomplete: 'the export did not finish', magnusim })), /did not finish, or failed its self-check/);
    assert.throws(() => sourceOf(folder('failed', { kind: 'magnusim-cad-export', magnusim, selfCheck: { passed: false, checks: {} } })), /failed its self-check/);
    assert.throws(() => sourceOf(folder('not-run', { kind: 'magnusim-cad-export', magnusim, selfCheck: 'not run yet' })), /failed its self-check/);
    assert.equal(sourceOf(folder('passed', { kind: 'magnusim-cad-export', magnusim, selfCheck: { passed: true, checks: {} } })).copiedFrom.commit, SHA);
  });

  it("takes no other EXPORT.json, nor one that is not JSON, for the export's: Magnusim and this checkout's commit", () => {
    const repo = folder('checkout', { kind: 'something-else', magnusim: { commit: SHA } });
    const env = { ...process.env, GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@example.org', GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@example.org' };
    execFileSync('git', ['init', '-q'], { cwd: repo });
    execFileSync('git', ['commit', '-q', '--allow-empty', '-m', 'one'], { cwd: repo, env });
    const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim();
    assert.deepEqual(sourceOf(repo), { repo: 'https://github.com/Lilmill2000/Magnusim', commit: head, copiedFrom: null });
    writeFileSync(join(repo, 'EXPORT.json'), '{ not json');
    assert.equal(sourceOf(repo).commit, head);
  });

  it('names no commit outside a git checkout, and git says nothing on the terminal', () => {
    const dir = folder('not-a-checkout');
    // In its own process, so what git prints to stderr is heard; no git folder above the temporary one
    // counts. The paths are in the code, not its arguments: build.mjs builds when argv[1] is itself.
    const code = `const { pathToFileURL } = await import('node:url'); const m = await import(pathToFileURL(${JSON.stringify(BUILD)}).href); console.log(JSON.stringify(m.sourceOf(${JSON.stringify(dir)})));`;
    const r = spawnSync(process.execPath, ['--input-type=module', '-e', code], { encoding: 'utf8', env: { ...process.env, GIT_CEILING_DIRECTORIES: dirname(dir) }, timeout: 30_000 });
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(JSON.parse(r.stdout), { repo: 'https://github.com/Lilmill2000/Magnusim', commit: '', copiedFrom: null });
    assert.equal(r.stderr, '', 'no "fatal: not a git repository"');
  });
});
