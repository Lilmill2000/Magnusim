// H15: a core mesh holds the compute slot from its spawn to its generator's close
// (startMeshGenerate's wrapper in scripts/w21-mesh-generate.js).
import { after, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const W21 = join(HERE, '..', 'w21-mesh-generate.js');
const ROOT = mkdtempSync(join(tmpdir(), 'magnusim-mesh-slot-'));
const PROJECTS = join(ROOT, 'projects');
mkdirSync(join(PROJECTS, 'p1'), { recursive: true });
writeFileSync(join(PROJECTS, 'p1', 'project.json'), JSON.stringify({ id: 'p1', title: 'P1' }));
process.env.MAGNUSIM_PROJECTS_ROOT = PROJECTS;
process.env.MAGNUSIM_LOCAL_JSON = join(ROOT, 'local.json');
process.env.MAGNUSIM_WSL_CASE_ROOT = '/home/tester/cases';

const slot = await import('../compute-slot.js');
const { startMeshGenerate } = await import('../w21-mesh-generate.js');
const { claimComputeSlot, computeSlotHolder, releaseComputeSlot, resetComputeSlotForTests, setSlotReleaseHook, slotRefusal } = slot;

after(() => rmSync(ROOT, { recursive: true, force: true }));
beforeEach(() => resetComputeSlotForTests());

const text = readFileSync(W21, 'utf8').replace(/\r\n/g, '\n');
const wrapperSrc = text.slice(text.indexOf('export function startMeshGenerate(args) {'), text.indexOf('function startMeshGenerateBody('));

/** The real wrapper, with a stand-in body that may set liveJob. */
function wrapperWith(body, claim = claimComputeSlot) {
  const make = new Function(
    'computeSlotHolder',
    'claimComputeSlot',
    'releaseComputeSlot',
    'slotRefusal',
    'body',
    `let liveJob = null;
     function startMeshGenerateBody(args) {
       return body(args, { get: () => liveJob, set: (j) => { liveJob = j; } });
     }
     ${wrapperSrc.replace('export function', 'function')}
     return startMeshGenerate;`,
  );
  return make(computeSlotHolder, claim, releaseComputeSlot, slotRefusal, body);
}

function fakeJob(extra = {}) {
  const child = new EventEmitter();
  child.pid = 1234;
  return { child, project_id: 'p1', mesh_id: 'mesh_1', mesh_name: 'Mesh 1', generate_id: 'g1', path_kind: 'standard', started_at: 'now', ...extra };
}

describe('the mesh wrapper', () => {
  it('a refused generate (unknown mesher) takes no claim and calls no release hook', () => {
    let hooks = 0;
    setSlotReleaseHook(() => (hooks += 1));
    const out = startMeshGenerate({ settings: { mesh_backend: 'no-such-mesher' }, projectId: 'p1', meshId: null, onUpdate: () => {} });
    assert.equal(out.status, 400);
    assert.match(out.bodyExtra.error, /not installed or is turned off/);
    assert.equal(computeSlotHolder(), null);
    assert.equal(hooks, 0);
    setSlotReleaseHook(null);
  });

  it('a held slot answers 409 busy before the body runs', () => {
    claimComputeSlot('solve', { project_id: 'p2', run_id: 'r1', name: 'Run 1' }, { phase: 'running' });
    const out = startMeshGenerate({ settings: { mesh_backend: 'no-such-mesher' }, projectId: 'p1', meshId: 'm1', onUpdate: () => {} });
    assert.equal(out.status, 409);
    assert.equal(out.bodyExtra.code, 'busy');
    assert.deepEqual(out.bodyExtra.busy, { kind: 'solve', phase: 'running', project_id: 'p2', name: 'Run 1' });
  });

  it('claims only after the body, from liveJob, and releases at the child close (source scan)', () => {
    assert.ok(wrapperSrc.length > 100);
    const iHeld = wrapperSrc.indexOf('computeSlotHolder()');
    const iBody = wrapperSrc.indexOf('startMeshGenerateBody(args)');
    const iFinally = wrapperSrc.indexOf('finally');
    const iClaim = wrapperSrc.indexOf("claimComputeSlot('mesh'");
    assert.ok(iHeld > 0 && iHeld < iBody && iBody < iFinally && iFinally < iClaim);
    assert.match(wrapperSrc, /const job = .*liveJob/);
    assert.match(wrapperSrc, /job\.child\.once\('close', \(\) => releaseComputeSlot\(c\.token\)\)/);
    // The body is the old function, renamed only.
    assert.match(text, /\nfunction startMeshGenerateBody\(\{ settings, projectId, onUpdate, meshId \}\) \{\n {2}if \(isLiveMeshJobHeld\(\)\) \{/);
  });

  it('bindLiveMeshJob is unchanged against HEAD', (t) => {
    const head = spawnSync('git', ['show', 'HEAD:magnusim-web/scripts/w21-mesh-generate.js'], { cwd: join(HERE, '..', '..'), encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    if (head.status !== 0) {
      t.skip('no git history here');
      return;
    }
    const block = (src) => {
      const s = src.replace(/\r\n/g, '\n');
      const i = s.indexOf('function bindLiveMeshJob(');
      return s.slice(i, s.indexOf('\n}\n', i) + 2);
    };
    assert.ok(block(text).length > 200);
    assert.equal(block(text), block(head.stdout));
  });

  it('a spawned mesh holds the slot until its generator closes', () => {
    let hooks = 0;
    setSlotReleaseHook(() => (hooks += 1));
    const job = fakeJob();
    const start = wrapperWith((args, live) => {
      live.set(job);
      return { ok: true, status: 202, bodyExtra: {} };
    });
    assert.equal(start({}).ok, true);
    const h = computeSlotHolder();
    assert.deepEqual([h.kind, h.phase, h.project_id, h.mesh_id, h.name], ['mesh', 'running', 'p1', 'mesh_1', 'Mesh 1']);
    assert.equal(job.slot_token, h.token);
    job.child.emit('exit', 0);
    assert.ok(computeSlotHolder(), 'exit alone does not free it');
    job.child.emit('close', 0);
    assert.equal(computeSlotHolder(), null);
    assert.equal(hooks, 1);
    setSlotReleaseHook(null);
  });

  it('a body that throws after its spawn still claims, and its close releases', () => {
    const job = fakeJob();
    const start = wrapperWith((args, live) => {
      live.set(job);
      throw new Error('after the spawn');
    });
    assert.throws(() => start({}), /after the spawn/);
    assert.equal(computeSlotHolder().mesh_id, 'mesh_1');
    job.child.emit('close');
    assert.equal(computeSlotHolder(), null);
  });

  it('a body that claims through the runner and leaves liveJob alone gives one claim, not two', () => {
    let wrapperClaims = 0;
    const spy = (...a) => {
      wrapperClaims += 1;
      return claimComputeSlot(...a);
    };
    const start = wrapperWith(() => {
      // The plugin mesher path: runFoamSteps claims `mesh` itself.
      const c = claimComputeSlot('mesh', { project_id: 'p1', job_id: 'fc-aaaaaaaa-111111', name: 'Mesh 1' }, { phase: 'running' });
      return { ok: c.ok, status: 202, bodyExtra: {} };
    }, spy);
    assert.equal(start({}).ok, true);
    assert.equal(wrapperClaims, 0);
    assert.equal(computeSlotHolder().job_id, 'fc-aaaaaaaa-111111');
    releaseComputeSlot(computeSlotHolder().token);
  });

  it('a body that refuses takes no claim', () => {
    const start = wrapperWith(() => ({ ok: false, status: 400, bodyExtra: { error: 'no mesh' } }));
    assert.equal(start({}).status, 400);
    assert.equal(computeSlotHolder(), null);
  });
});
