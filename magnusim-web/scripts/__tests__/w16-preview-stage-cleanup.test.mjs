/**
 * A CAD preview is made in a magnusim-preview-* folder in the temp folder, then moved into
 * the project (w16-preview-removed-geometry.test.mjs); a thumbnail is rendered to a
 * magnusim-thumb-*.png there. Removing them used rmSync, which on Windows gives up at the
 * first EPERM/EBUSY (Node 24 ignores its maxRetries): a file the indexer, antivirus or a
 * writer finishing held for a moment left the folder behind (~1,250 empty ones in %TEMP%
 * on 2026-10-17), and the throw from the finally failed a preview that was made. The
 * removal is now retried, and one that still fails is logged, never thrown.
 */
import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { rm } from 'node:fs/promises';
import { after, describe, it } from 'node:test';

const root = mkdtempSync(join(tmpdir(), 'magnusim-stage-cleanup-'));
process.env.MAGNUSIM_PROJECTS_ROOT = root;
// The previews these tests make run the app's Python, which must be a file path (the
// server checks it exists). CI has no python/.venv (setup-python's interpreter is on PATH):
// name that one, before the server's modules read MAGNUSIM_PYTHON.
const WEB = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const VENV = ['Scripts/python.exe', 'bin/python'].some((p) => existsSync(join(WEB, 'python', '.venv', p)));
if (!VENV && !process.env.MAGNUSIM_PYTHON && !process.env.CFDDESK_PYTHON) {
  const r = spawnSync(process.platform === 'win32' ? 'python' : 'python3', ['-c', 'import sys; print(sys.executable)'], { encoding: 'utf8' });
  if (r.status === 0 && r.stdout.trim()) process.env.MAGNUSIM_PYTHON = r.stdout.trim();
}
const { createGeometryFolder, writeJsonAtomic } = await import('../project-layout.js');
const { geometryThumbWithin, handleW16Api, setStageRemoverForTests, setThumbRendererForTests } = await import('../w16-project-geometry.js');

const FIXTURES = join(WEB, 'python', 'tests', 'fixtures', 'geometry');

// No thumbnail renders through Python here: a stand-in picture.
setThumbRendererForTests(async (args) => {
  const out = args[args.indexOf('--out') + 1];
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, Buffer.alloc(256, 7));
});

after(() => {
  setStageRemoverForTests(null);
  setThumbRendererForTests(null);
  rmSync(root, { recursive: true, force: true });
});

/** The round hole plate, with no preview yet. Returns its geometry folder. */
function seedProject(pid) {
  const dir = join(root, pid);
  mkdirSync(dir, { recursive: true });
  const folder = createGeometryFolder(dir, { id: 'g-round', name: 'transient-test', original_filename: 'transient-test.step' });
  const stepPath = join(folder.dir, 'source.step');
  cpSync(join(FIXTURES, 'transient-test.step'), stepPath);
  writeJsonAtomic(join(dir, 'project.json'), {
    id: pid,
    title: pid,
    units: 'Metric',
    folder: 'My Projects',
    geometries: [{ id: 'g-round', name: 'transient-test', original_filename: 'transient-test.step', step_path: stepPath, source_kind: 'step', n_solids: 1 }],
    active_geometry_id: 'g-round',
  });
  return folder.dir;
}

async function call(method, path, body) {
  const url = new URL(path, 'http://localhost');
  const res = {
    statusCode: 200,
    body: null,
    headers: {},
    setHeader(k, v) {
      this.headers[String(k).toLowerCase()] = v;
    },
    end(bytes) {
      this.body = bytes;
    },
  };
  const helpers = {
    sendJson(_res, status, doc) {
      res.statusCode = status;
      res.body = doc;
      return true;
    },
    readJsonBody: async () => body,
  };
  await handleW16Api({ method, headers: { 'content-type': 'application/json' } }, res, url, url.pathname.split('/').filter(Boolean), helpers);
  return res;
}

/**
 * Removal attempts of temp paths whose name starts with `prefix` fail with EPERM, as
 * Windows answers while someone holds a file: the first `failures` of them (Infinity: all).
 * The others are removed. `tried` lists each attempt's path.
 */
function failRemovals(prefix, failures) {
  const tried = [];
  let failed = 0;
  setStageRemoverForTests(async (path) => {
    tried.push(path);
    if (basename(path).startsWith(prefix) && failed < failures) {
      failed += 1;
      throw Object.assign(new Error(`EPERM: operation not permitted, rmdir '${path}'`), { code: 'EPERM' });
    }
    await rm(path, { recursive: true, force: true });
  });
  return { tried, of: () => tried.filter((p) => basename(p).startsWith(prefix)) };
}

/** console.warn lines, kept while `fn` runs. */
async function withWarnings(fn) {
  const lines = [];
  const was = console.warn;
  console.warn = (...args) => lines.push(args.map(String).join(' '));
  try {
    await fn(lines);
  } finally {
    console.warn = was;
  }
}

const PREVIEW_FILES = ['cad_edges.vtp', 'cad_faces.vtp', 'cad_preview.json'];

describe("a CAD preview's stage folder that Windows holds for a moment", () => {
  it('is removed on a retry, and the preview is made', { timeout: 300_000 }, async () => {
    const geomDir = seedProject('stage-held-once');
    const removals = failRemovals('magnusim-preview-', 1);
    try {
      const shown = await call('POST', '/api/geometry/activate', { project_id: 'stage-held-once', geometry_id: 'g-round' });
      assert.equal(shown.statusCode, 200, JSON.stringify(shown.body));
      for (const f of PREVIEW_FILES) assert.ok(existsSync(join(geomDir, f)), `${f} missing`);

      const stages = removals.of();
      assert.ok(stages.length >= 2, `the stage removal was not tried again: ${stages.join(', ')}`);
      assert.equal(new Set(stages).size, 1, stages.join(', '));
      assert.equal(dirname(stages[0]), tmpdir());
      assert.equal(existsSync(stages[0]), false, `${stages[0]} was left behind`);
    } finally {
      setStageRemoverForTests(null);
    }
  });

  it('that stays held is left and logged, and the preview is still made', { timeout: 300_000 }, async () => {
    const geomDir = seedProject('stage-held-always');
    const removals = failRemovals('magnusim-preview-', Infinity);
    let stage = '';
    try {
      await withWarnings(async (warnings) => {
        const shown = await call('POST', '/api/geometry/activate', { project_id: 'stage-held-always', geometry_id: 'g-round' });
        assert.equal(shown.statusCode, 200, JSON.stringify(shown.body));
        for (const f of PREVIEW_FILES) assert.ok(existsSync(join(geomDir, f)), `${f} missing`);
        stage = removals.of()[0];
        assert.ok(stage, 'the stage removal was never tried');
        // The first try and its 8 retries.
        assert.equal(removals.of().length, 9);
        assert.ok(
          warnings.some((w) => w.includes('temp not removed') && w.includes(stage) && w.includes('EPERM')),
          `no warning for ${stage}: ${warnings.join(' | ')}`,
        );
      });
    } finally {
      setStageRemoverForTests(null);
      if (stage) rmSync(stage, { recursive: true, force: true });
    }
  });
});

describe("a thumbnail's temp render that Windows holds for a moment", () => {
  it('is removed on a retry, and the thumbnail is made', { timeout: 300_000 }, async () => {
    const pid = 'thumb-held-once';
    const geomDir = seedProject(pid);
    const removals = failRemovals('magnusim-thumb-', 1);
    try {
      const got = await geometryThumbWithin(pid, 240_000);
      assert.equal(got.ok, true, JSON.stringify(got.body));
      assert.ok(existsSync(join(geomDir, 'thumb.png')) || existsSync(got.path), `no thumbnail at ${got.path}`);
      const renders = removals.of();
      assert.ok(renders.length >= 2, `the render removal was not tried again: ${renders.join(', ')}`);
      assert.equal(existsSync(renders[0]), false, `${renders[0]} was left behind`);
    } finally {
      setStageRemoverForTests(null);
    }
  });
});
