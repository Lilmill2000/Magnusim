// scripts/check-build-no-dev-sheet.mjs (H14): a production build that still
// holds the UI kit dev sheet fails CI; a clean one passes; no build fails too.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEV_SHEET_MARKERS, findDevSheet } from '../check-build-no-dev-sheet.mjs';

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), '..', 'check-build-no-dev-sheet.mjs');

function withDist(files, fn) {
  const dir = mkdtempSync(join(tmpdir(), 'magnusim-dist-'));
  try {
    for (const [rel, text] of Object.entries(files)) {
      mkdirSync(dirname(join(dir, rel)), { recursive: true });
      writeFileSync(join(dir, rel), text);
    }
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const CLEAN = {
  'index.html': '<!doctype html><div id="react-root"></div>',
  'assets/index-abc.js': 'const s="#/dev/";console.log(s)',
  'assets/index-abc.css': '.mgk-btn{padding:0}',
};

describe('findDevSheet', () => {
  it('names both markers', () => {
    assert.deepEqual(DEV_SHEET_MARKERS, ['data-kit-sheet', 'ui-kit-sheet']);
  });

  it('passes a clean build', () => {
    withDist(CLEAN, (dir) => assert.deepEqual(findDevSheet(dir), []));
  });

  it('finds each marker in any file, however deep', () => {
    withDist(
      {
        ...CLEAN,
        'assets/page-1.js': 'e.setAttribute("data-kit-sheet-ready","page")',
        'assets/deep/frame.js': 'fetch("/plugin-sdk/ui-kit-sheet.html")',
      },
      (dir) => {
        const found = findDevSheet(dir).sort((a, b) => a.file.localeCompare(b.file));
        assert.deepEqual(found, [
          { file: 'assets/deep/frame.js', marker: 'ui-kit-sheet' },
          { file: 'assets/page-1.js', marker: 'data-kit-sheet' },
        ]);
      },
    );
  });

  it('throws when there is no build', () => {
    assert.throws(() => findDevSheet(join(tmpdir(), 'magnusim-no-such-dist-' + process.pid)), /run npm run build first/);
  });
});

describe('the script', () => {
  const run = (dir) => spawnSync(process.execPath, [SCRIPT, dir], { encoding: 'utf8' });

  it('exits 0 on a clean build and 1 when the sheet is there', () => {
    withDist(CLEAN, (dir) => {
      const ok = run(dir);
      assert.equal(ok.status, 0, ok.stderr);
    });
    withDist({ ...CLEAN, 'assets/x.js': 'src="/plugin-sdk/ui-kit-sheet.js"' }, (dir) => {
      const bad = run(dir);
      assert.equal(bad.status, 1);
      assert.match(bad.stderr, /assets\/x\.js: ui-kit-sheet/);
    });
  });

  it('exits 1 when there is no build', () => {
    const r = run(join(tmpdir(), 'magnusim-no-such-dist-' + process.pid));
    assert.equal(r.status, 1);
    assert.match(r.stderr, /run npm run build first/);
  });
});
