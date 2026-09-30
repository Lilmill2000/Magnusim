/**
 * readProject (w16..w26) is a bare JSON.parse(readFileSync(project.json)). The worker
 * rewrites project.json on project.tree / project.hydrate (migrate_root_siblings' marker)
 * while Node keeps reading it. A read must never land on a half-written file: it throws
 * and the request answers 500 (seen on /api/geometry/cad).
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';

const root = mkdtempSync(join(tmpdir(), 'magnusim-project-json-'));
process.env.MAGNUSIM_PROJECTS_ROOT = root;

const { PYTHON, PY_ROOT } = await import('../python-env.js');
const { writeJsonAtomic } = await import('../project-layout.js');
const { getProjectById } = await import('../w16-project-geometry.js');

const SECONDS = 1.5;

// The worker's marker write, flipped every round so each call rewrites project.json.
const WRITER = `
import json, sys, time
from pathlib import Path
from cfddesk.project.scope import _mark_migration
root = Path(sys.argv[1])
path = root / "project.json"
end = time.perf_counter() + float(sys.argv[2])
(root / "writer.started").write_text("1", encoding="utf-8")
rounds = written = 0
while time.perf_counter() < end:
    before = path.stat().st_mtime_ns
    _mark_migration(root, True if rounds % 2 else "skipped-multi")
    rounds += 1
    if path.stat().st_mtime_ns != before:
        written += 1
print(json.dumps({"rounds": rounds, "written": written}))
`;

after(() => rmSync(root, { recursive: true, force: true }));

describe('project.json rewrites', () => {
  it('readProject never parses a half-written project.json while the worker rewrites it', async () => {
    const id = 'atomic-read';
    const dir = join(root, id);
    mkdirSync(dir, { recursive: true });
    // Large enough that a truncate-then-write stays visible for a while.
    writeJsonAtomic(join(dir, 'project.json'), { id, title: 'Atomic read', notes: 'x'.repeat(512 * 1024) });

    const child = spawn(PYTHON, ['-c', WRITER, dir, String(SECONDS)], {
      cwd: PY_ROOT,
      windowsHide: true,
      env: { ...process.env, PYTHONPATH: PY_ROOT, PYTHONUNBUFFERED: '1', PYTHONUTF8: '1' },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    let exited = false;
    const exit = new Promise((resolve) => {
      child.on('close', (code) => {
        exited = true;
        resolve(code);
      });
    });

    const startBy = Date.now() + 60_000;
    while (!exited && !existsSync(join(dir, 'writer.started')) && Date.now() < startBy) {
      await new Promise((r) => setTimeout(r, 10));
    }

    const file = join(dir, 'project.json');
    const failures = [];
    let reads = 0;
    let changes = 0;
    let last = null;
    const seen = (marker) => {
      if (last !== null && marker !== last) changes += 1;
      last = marker;
    };
    while (!exited) {
      for (let i = 0; i < 20; i += 1) {
        try {
          // The route's own read, then readProject's expression on its own: getProjectById
          // spends most of its time on other files, and bare reads hit the rewrites far more often.
          reads += 1;
          const got = getProjectById(id);
          if (got.ok) seen(got.body.project.siblings_migrated ?? null);
          else failures.push(`status ${got.status}`);
          for (let j = 0; j < 3; j += 1) {
            reads += 1;
            seen(JSON.parse(readFileSync(file, 'utf8')).siblings_migrated ?? null);
          }
        } catch (err) {
          failures.push(String((err && err.message) || err).slice(0, 160));
        }
      }
      await new Promise((r) => setImmediate(r));
    }

    assert.equal(await exit, 0, stderr);
    const writer = JSON.parse(stdout.trim().split(/\r?\n/).pop() || '{}');
    // Windows refuses the replace while a read holds the file; atomic_write waits and retries.
    assert.ok(writer.written >= 5, `the worker rewrote project.json only ${writer.written} times`);
    assert.deepEqual(failures.slice(0, 5), [], `${failures.length} of ${reads} reads failed`);
    // The reads ran while the file was being rewritten, not before or after it.
    assert.ok(changes >= 5, `reads saw the marker change only ${changes} times in ${reads} reads`);
  });
});
