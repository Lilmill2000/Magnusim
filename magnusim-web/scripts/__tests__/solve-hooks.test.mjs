// H15: Node passes solve hook names only when some plugin listens (scripts/solve-hooks.js).
import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = mkdtempSync(join(tmpdir(), 'magnusim-hooks-'));
process.env.MAGNUSIM_PROJECTS_ROOT = join(ROOT, 'projects');
process.env.MAGNUSIM_LOCAL_JSON = join(ROOT, 'local.json');

const { coreOwner, hookArgs, refreshSolveHooks, setSolveHookNamesForTests, solveHookNames, stopHookArgs } = await import('../solve-hooks.js');

after(() => rmSync(ROOT, { recursive: true, force: true }));

function worker(answer) {
  const calls = [];
  return {
    calls,
    async call(method, params) {
      calls.push([method, params]);
      if (answer instanceof Error) throw answer;
      return answer;
    },
  };
}

describe('solve hooks in Node', () => {
  it('nothing listening: no arguments at all (the command lines of today)', async () => {
    const w = worker({ names: [] });
    assert.deepEqual(await refreshSolveHooks(w), []);
    assert.deepEqual(w.calls, [['solve_hooks.listening', {}]]);
    assert.deepEqual(hookArgs('core:p1/s1'), []);
    assert.deepEqual(stopHookArgs({ owner: 'core:p1/s1', app: 'simpleFoam', caseDir: 'C:/x', nProcs: 2 }), []);
  });

  it('names a plugin listens to go to run_solve; solve.stop only to the stop tool', async () => {
    await refreshSolveHooks(worker({ names: ['solve.parse_line', 'solve.prepare', 'bogus', 'solve.parse_line'] }));
    assert.deepEqual(solveHookNames(), ['solve.parse_line', 'solve.prepare']);
    assert.deepEqual(hookArgs('core:p1/s1'), ['--owner', 'core:p1/s1', '--hooks', 'solve.parse_line,solve.prepare']);
    assert.deepEqual(stopHookArgs({ owner: 'core:p1/s1', app: 'simpleFoam' }), [], 'solve.stop is not listened to');
    setSolveHookNamesForTests(['solve.stop']);
    assert.deepEqual(stopHookArgs({ owner: 'core:p1/s1', app: 'simpleFoam', caseDir: 'C:/runs/case', nProcs: 4 }), [
      '--owner',
      'core:p1/s1',
      '--hooks',
      'solve.stop',
      '--app',
      'simpleFoam',
      '--case-dir',
      'C:/runs/case',
      '--n-procs',
      '4',
    ]);
    assert.deepEqual(hookArgs(''), [], 'no owner, no hooks');
  });

  it('a failure or no answer means no hooks', async () => {
    setSolveHookNamesForTests(['solve.prepare']);
    await refreshSolveHooks(worker(new Error('worker down')));
    assert.deepEqual(solveHookNames(), []);
    setSolveHookNamesForTests(['solve.prepare']);
    await refreshSolveHooks(worker(null));
    assert.deepEqual(solveHookNames(), []);
    await refreshSolveHooks(null);
    assert.deepEqual(hookArgs('core:p/s'), []);
  });

  it('a core owner needs plain ids', () => {
    assert.equal(coreOwner('proj-a', 'sim_1'), 'core:proj-a/sim_1');
    assert.equal(coreOwner('', 'sim_1'), '');
    assert.equal(coreOwner('a/b', 'sim_1'), '');
  });

  it('no RPC on a start or stop path: only refreshSolveHooks asks (source scan)', () => {
    const w27 = readFileSync(join(HERE, '..', 'w27-solve.js'), 'utf8');
    assert.ok(!w27.includes('solve_hooks.listening'));
    assert.match(w27, /\.\.\.hookArgs\(coreOwner\(id, simId\)\)/);
    const runner = readFileSync(join(HERE, '..', 'foam-runner.js'), 'utf8');
    assert.ok(!runner.includes('solve_hooks.listening'));
    const live = readFileSync(join(HERE, '..', 'server', 'live-routes.js'), 'utf8');
    assert.match(live, /worker\.on\('registry-changed'[\s\S]{0,80}refreshSolveHooks\(worker\)/);
    assert.match(live, /boot\(\) \{[\s\S]*refreshSolveHooks\(worker\)/);
  });
});
