/**
 * gate:h2-worker-only-writes — Node does not write project.json or spawn project_cli.
 * Also runs the land14 sibling guard, which npm test otherwise skips.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { commitRpcSync } from '../py-json.js';

const scriptsRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const webRoot = join(scriptsRoot, '..');

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === '__tests__') continue;
    const path = join(dir, name);
    const st = statSync(path);
    if (st.isDirectory()) walk(path, out);
    else if (/\.(js|mjs|cjs|ts)$/.test(name)) out.push(path);
    continue;
  }
  return out;
}

describe('gate:h2-worker-only-writes', () => {
  it('keeps the land14 sibling guard green', () => {
    const ran = spawnSync(process.execPath, [join(scriptsRoot, '__tests__', 'test_no_node_sibling_writes.js')], {
      cwd: webRoot,
      encoding: 'utf8',
    });
    assert.equal(ran.status, 0, (ran.stdout || '') + (ran.stderr || ''));
  });

  it('does not write project.json from Node or spawn project_cli', () => {
    const hits = [];
    for (const file of walk(scriptsRoot)) {
      const rel = relative(scriptsRoot, file).replace(/\\/g, '/');
      if (rel === 'w28-media.js' || rel === 'py-json.js') continue;
      const text = readFileSync(file, 'utf8');
      if (text.includes('project_cli.py')) hits.push(rel + ' spawns project_cli.py');
      if (/writeFileSync\([\s\S]{0,80}project\.json/.test(text)) hits.push(rel + ' writeFileSync project.json');
      if (/writeJsonAtomic\(\s*projectJsonPath/.test(text)) hits.push(rel + ' writeJsonAtomic project.json');
    }
    assert.deepEqual(hits, []);
  });

  it('commits project.json through project.write_project', () => {
    const dir = mkdtempSync(join(tmpdir(), 'magnusim-h2-write-'));
    try {
      const written = commitRpcSync('project.write_project', {
        project_dir: dir,
        doc: { id: 'h2write', title: 'Renamed' },
      });
      assert.equal(written.title, 'Renamed');
      const onDisk = JSON.parse(readFileSync(join(dir, 'project.json'), 'utf8'));
      assert.equal(onDisk.title, 'Renamed');
      assert.equal(onDisk.id, 'h2write');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
