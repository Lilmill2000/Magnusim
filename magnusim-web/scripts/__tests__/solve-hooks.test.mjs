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

const hooks = await import('../solve-hooks.js');
const { coreOwner, refreshSolveHooks, setSolveHookNamesForTests, solveHookNames } = hooks;

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
  it('nothing listening: no names at all', async () => {
    const w = worker({ names: [] });
    assert.deepEqual(await refreshSolveHooks(w), []);
    assert.deepEqual(w.calls, [['solve_hooks.listening', {}]]);
    assert.deepEqual(solveHookNames(), []);
  });

  it('the names a plugin listens to, cleaned and sorted (a solve\'s relay gets them in its spec)', async () => {
    await refreshSolveHooks(worker({ names: ['solve.parse_line', 'solve.prepare', 'bogus', 'solve.parse_line'] }));
    assert.deepEqual(solveHookNames(), ['solve.parse_line', 'solve.prepare']);
    setSolveHookNamesForTests(['solve.stop']);
    assert.deepEqual(solveHookNames(), ['solve.stop']);
    // The old run path's command-line arguments are gone with run_solve.py's solve and stop_solve.py.
    assert.equal('hookArgs' in hooks, false);
    assert.equal('stopHookArgs' in hooks, false);
  });

  it('a failure or no answer means no hooks', async () => {
    setSolveHookNamesForTests(['solve.prepare']);
    await refreshSolveHooks(worker(new Error('worker down')));
    assert.deepEqual(solveHookNames(), []);
    setSolveHookNamesForTests(['solve.prepare']);
    await refreshSolveHooks(worker(null));
    assert.deepEqual(solveHookNames(), []);
    await refreshSolveHooks(null);
    assert.deepEqual(solveHookNames(), []);
  });

  it('a core owner needs plain ids', () => {
    assert.equal(coreOwner('proj-a', 'sim_1'), 'core:proj-a/sim_1');
    assert.equal(coreOwner('', 'sim_1'), '');
    assert.equal(coreOwner('a/b', 'sim_1'), '');
  });

  it('no RPC on a start or stop path: only refreshSolveHooks asks (source scan)', () => {
    const w27 = readFileSync(join(HERE, '..', 'w27-solve.js'), 'utf8');
    assert.ok(!w27.includes('solve_hooks.listening'));
    // A core solve's Start reads the cached names and gives its runner run the owner.
    assert.match(w27, /const hookNames = solveHookNames\(\);/);
    assert.match(w27, /const owner = hookNames\.length \? coreOwner\(id, simId\) \|\| null : null;/);
    // Its Stop goes to the runner record (or ends a legacy run's processes): no hook tool.
    assert.ok(!/stop_solve|run_solve/.test(w27));
    const runner = readFileSync(join(HERE, '..', 'foam-runner.js'), 'utf8');
    assert.ok(!runner.includes('solve_hooks.listening'));
    const live = readFileSync(join(HERE, '..', 'server', 'live-routes.js'), 'utf8');
    assert.match(live, /worker\.on\('registry-changed'[\s\S]{0,80}refreshSolveHooks\(worker\)/);
    assert.match(live, /boot\(\) \{[\s\S]*refreshSolveHooks\(worker\)/);
  });
});
