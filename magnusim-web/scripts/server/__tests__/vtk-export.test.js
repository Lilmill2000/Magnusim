// Export to ParaView (VTK) and Open case folder routes (scripts/server/vtk-export.ts):
// a real export of the committed cavity case through the job manager and the
// Windows-side tool, the zip it serves, and what each route refuses.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inflateRawSync } from 'node:zlib';

const WEB = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const CAVITY = join(WEB, 'python', 'tests', 'fixtures', 'foam-results', 'cavity-2d');

/** name -> bytes of every entry of a zip (stored or deflated), from its central directory. */
function unzip(buf) {
  let eocd = buf.length - 22;
  while (eocd >= 0 && buf.readUInt32LE(eocd) !== 0x06054b50) eocd -= 1;
  assert.ok(eocd >= 0, 'zip end record');
  const count = buf.readUInt16LE(eocd + 10);
  let at = buf.readUInt32LE(eocd + 16);
  const out = new Map();
  for (let i = 0; i < count; i += 1) {
    assert.equal(buf.readUInt32LE(at), 0x02014b50);
    const method = buf.readUInt16LE(at + 10);
    const csize = buf.readUInt32LE(at + 20);
    const size = buf.readUInt32LE(at + 24);
    const nameLen = buf.readUInt16LE(at + 28);
    const extraLen = buf.readUInt16LE(at + 30);
    const commentLen = buf.readUInt16LE(at + 32);
    const local = buf.readUInt32LE(at + 42);
    const name = buf.toString('utf8', at + 46, at + 46 + nameLen);
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const raw = buf.subarray(start, start + csize);
    out.set(name, method === 8 ? inflateRawSync(raw) : Buffer.from(raw));
    assert.equal(out.get(name).length, size, name);
    at += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

// The projects root is read once, when project-isolation.js loads: one for the file,
// emptied before each test.
const ROOT = mkdtempSync(join(tmpdir(), 'magnusim-vtk-'));
process.env.MAGNUSIM_PROJECTS_ROOT = join(ROOT, 'projects');
after(() => rmSync(ROOT, { recursive: true, force: true }));
let serial = 0;

async function setup() {
  const root = ROOT;
  rmSync(join(root, 'projects'), { recursive: true, force: true });
  serial += 1;
  const caseDir = join(root, 'projects', 'proj-a', 'geometries', 'g', 'simulations', 's', 'runs', 'Run 1', 'case');
  mkdirSync(dirname(caseDir), { recursive: true });
  cpSync(CAVITY, caseDir, { recursive: true });
  const other = join(root, 'projects', 'proj-b', 'case');
  mkdirSync(other, { recursive: true });
  const { Router, dispatch } = await import('../router.ts');
  const { JobManager } = await import('../jobs.ts');
  const { registerVtkExportRoutes } = await import('../vtk-export.ts');
  const cacheDir = join(root, `cache-${serial}`);
  const jobs = new JobManager({ cacheDir });
  const opened = [];
  const router = new Router();
  registerVtkExportRoutes(router, { jobs, cacheDir, openFolder: (dir) => opened.push(dir) });
  const server = createServer(async (req, res) => {
    try {
      if (!(await dispatch(router, req, res))) {
        res.statusCode = 404;
        res.end('{}');
      }
    } catch (err) {
      res.statusCode = 500;
      res.end(String(err));
    }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (path, body) =>
    fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const close = async () => {
    await new Promise((r) => server.close(r));
  };
  return { root, caseDir, other, base, post, jobs, opened, cacheDir, close };
}

async function waitDone(base, jobId, project = 'proj-a') {
  const until = Date.now() + 90_000;
  const seen = [];
  for (;;) {
    const s = await (await fetch(`${base}/api/results/export-vtk/${jobId}?project_id=${project}`)).json();
    seen.push(s);
    if (['done', 'failed', 'stopped'].includes(s.status)) return { last: s, seen };
    if (Date.now() > until) throw new Error('export did not finish: ' + JSON.stringify(s));
    await new Promise((r) => setTimeout(r, 150));
  }
}

test('exports the frame on screen and all saved frames as a VTK zip with pressure in Pa', { timeout: 180_000 }, async () => {
  const t = await setup();
  try {
    const started = await t.post('/api/results/export-vtk', { project_id: 'proj-a', case: t.caseDir, frames: 'current', time: '0.5' });
    assert.equal(started.status, 202);
    const job = await started.json();
    assert.ok(job.job_id);
    const { last } = await waitDone(t.base, job.job_id);
    assert.equal(last.status, 'done', JSON.stringify(last));
    assert.equal(last.fraction, 1);
    assert.equal(last.error, null);
    assert.equal(last.file_name, 'Run_1-vtk-0.5.zip');
    assert.deepEqual(last.times, ['0.5']);
    assert.deepEqual(last.fields, ['U', 'p_Pa']);
    assert.match(last.units_note, /x density 1000 kg\/m\^3, in Pa/);

    const file = await fetch(`${t.base}/api/results/export-vtk/${job.job_id}/file?project_id=proj-a`);
    assert.equal(file.status, 200);
    assert.equal(file.headers.get('content-type'), 'application/zip');
    assert.match(file.headers.get('content-disposition'), /attachment; filename="Run_1-vtk-0.5.zip"/);
    const entries = unzip(Buffer.from(await file.arrayBuffer()));
    const vtm = entries.get('Run_1_0.5.vtm').toString('utf8');
    assert.match(vtm, /<VTKFile type="vtkMultiBlockDataSet"/);
    assert.match(vtm, /name="internalMesh" file="Run_1\/0.5\/internalMesh.vtu"/);
    assert.match(vtm, /name="movingWall" file="Run_1\/0.5\/boundary\/movingWall.vtp"/);
    const vtu = entries.get('Run_1/0.5/internalMesh.vtu').toString('latin1');
    assert.match(vtu, /^<VTKFile type="UnstructuredGrid"/);
    assert.match(vtu, /NumberOfCells="400"/);
    assert.match(vtu, /<CellData[^>]*>\s*<DataArray type="Float32" Name="U" NumberOfComponents="3"/);
    assert.match(vtu, /Name="p_Pa"/);
    assert.doesNotMatch(vtu, /Name="p" /);
    assert.match(entries.get('README.txt').toString('utf8'), /Open Run_1_0.5.vtm in ParaView/);
    // Another project cannot read it.
    const foreign = await fetch(`${t.base}/api/results/export-vtk/${job.job_id}/file?project_id=proj-b`);
    assert.equal(foreign.status, 403);

    const all = await (await t.post('/api/results/export-vtk', { project_id: 'proj-a', case: t.caseDir, frames: 'all' })).json();
    const allDone = await waitDone(t.base, all.job_id);
    assert.equal(allDone.last.status, 'done', JSON.stringify(allDone.last));
    assert.equal(allDone.last.file_name, 'Run_1-vtk-all-frames.zip');
    const allEntries = unzip(Buffer.from(await (await fetch(`${t.base}/api/results/export-vtk/${all.job_id}/file?project_id=proj-a`)).arrayBuffer()));
    const pvd = allEntries.get('Run_1.pvd').toString('utf8');
    // Every saved frame /api/times lists (time 0 included: it holds U and p).
    for (const time of allDone.last.times) assert.match(pvd, new RegExp(`timestep="${time.replace('.', '\\.')}"`));
    assert.ok(allDone.last.times.length >= 5);
    // Progress came in order while it ran.
    const fractions = allDone.seen.map((s) => s.fraction);
    assert.deepEqual(fractions, [...fractions].sort((a, b) => a - b));
  } finally {
    await t.close();
  }
});

test('refuses what is not this project, not saved or not asked right, in plain words', { timeout: 60_000 }, async () => {
  const t = await setup();
  try {
    const call = async (body) => {
      const r = await t.post('/api/results/export-vtk', body);
      return { status: r.status, body: await r.json() };
    };
    assert.equal((await call({ case: t.caseDir, frames: 'all' })).status, 400);
    const foreign = await call({ project_id: 'proj-a', case: t.other, frames: 'all' });
    assert.deepEqual([foreign.status, foreign.body.error], [403, 'That case folder is not in this project.']);
    const outside = await call({ project_id: 'proj-a', case: join(t.root, 'elsewhere'), frames: 'all' });
    assert.equal(outside.status, 403);
    const missing = await call({ project_id: 'proj-a', case: join(dirname(t.caseDir), 'gone'), frames: 'all' });
    assert.deepEqual([missing.status, missing.body.error], [404, "The run's case folder is missing."]);
    const notSaved = await call({ project_id: 'proj-a', case: t.caseDir, frames: 'current', time: '0.7' });
    assert.deepEqual([notSaved.status, notSaved.body.error], [404, 'The frame on screen is not saved in this run.']);
    assert.equal((await call({ project_id: 'proj-a', case: t.caseDir, frames: 'some' })).status, 400);
    const empty = join(dirname(t.caseDir), 'empty-case');
    mkdirSync(empty);
    const none = await call({ project_id: 'proj-a', case: empty, frames: 'all' });
    assert.deepEqual([none.status, none.body.error], [404, 'This run has no saved frames yet.']);
    assert.equal((await fetch(`${t.base}/api/results/export-vtk/job-nope?project_id=proj-a`)).status, 404);
    assert.equal(t.jobs.list({ project: 'proj-a' }).length, 0);

    // A tool failure is said as the tool said it.
    rmSync(join(t.caseDir, 'constant', 'polyMesh'), { recursive: true });
    const bad = await call({ project_id: 'proj-a', case: t.caseDir, frames: 'current', time: '0.5' });
    assert.equal(bad.status, 202);
    const { last } = await waitDone(t.base, bad.body.job_id);
    assert.equal(last.status, 'failed');
    assert.equal(last.error, "The run's case has no mesh (constant/polyMesh is missing).");
    assert.equal((await fetch(`${t.base}/api/results/export-vtk/${bad.body.job_id}/file?project_id=proj-a`)).status, 404);
  } finally {
    await t.close();
  }
});

test('open case folder shows only this project\'s case, from this PC', { timeout: 30_000 }, async () => {
  const t = await setup();
  try {
    const ok = await t.post('/api/results/open-folder', { project_id: 'proj-a', case: t.caseDir });
    assert.equal(ok.status, 200);
    assert.deepEqual(t.opened, [t.caseDir]);
    const foreign = await t.post('/api/results/open-folder', { project_id: 'proj-a', case: t.other });
    assert.equal(foreign.status, 403);
    const tunnel = await fetch(`${t.base}/api/results/open-folder`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': '203.0.113.9' },
      body: JSON.stringify({ project_id: 'proj-a', case: t.caseDir }),
    });
    assert.equal(tunnel.status, 403);
    assert.match((await tunnel.json()).error, /only works on the PC running Magnusim/);
    assert.equal(t.opened.length, 1);
  } finally {
    await t.close();
  }
});

test('old finished exports are swept; a running one is kept', async () => {
  const { sweepOldExports, exportBaseName, safeExportName } = await import('../vtk-export.ts');
  const root = mkdtempSync(join(tmpdir(), 'magnusim-vtk-sweep-'));
  try {
    for (const id of ['job-old', 'job-running', 'job-new']) mkdirSync(join(root, id));
    const past = new Date(Date.now() - 7 * 3600 * 1000);
    utimesSync(join(root, 'job-old'), past, past);
    utimesSync(join(root, 'job-running'), past, past);
    const jobs = { get: (id) => (id === 'job-running' ? { status: 'running' } : null) };
    sweepOldExports(root, jobs);
    assert.equal(existsSync(join(root, 'job-old')), false);
    assert.equal(existsSync(join(root, 'job-running')), true);
    assert.equal(existsSync(join(root, 'job-new')), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
  // The tool's last line may be read just after its exit: the job is "Finishing" until
  // then, and a job that ended long ago without it failed.
  const { exportStatus, LAST_LINE_GRACE_MS } = await import('../vtk-export.ts');
  const ended = '2026-10-05T10:00:00.000Z';
  const at = Date.parse(ended);
  const job = (status, events) => ({
    id: 'job-1',
    status,
    events,
    params: { download_name: 'R-vtk-0.5.zip' },
    finished_at: ended,
    error: status === 'failed' ? 'exit 1' : null,
  });
  const progress = { event: 'progress', fraction: 0.92, message: 'Packing the zip' };
  const early = exportStatus(job('done', [progress]), at + 10);
  assert.deepEqual([early.status, early.message, early.fraction, early.file_name], ['running', 'Finishing', 0.99, null]);
  const late = exportStatus(job('done', [progress]), at + LAST_LINE_GRACE_MS + 1);
  assert.deepEqual([late.status, late.error], ['failed', 'The export failed. See the log for details.']);
  const exported = { event: 'exported', file_name: 'R.zip', bytes: 12, times: ['0.5'], fields: ['p_Pa'], units_note: 'n' };
  const ok = exportStatus(job('done', [progress, exported]), at + 10);
  assert.deepEqual([ok.status, ok.fraction, ok.file_name, ok.bytes, ok.error], ['done', 1, 'R-vtk-0.5.zip', 12, null]);
  assert.equal(exportStatus(job('failed', []), at + 10).status, 'running');
  assert.equal(exportStatus(job('failed', [{ event: 'export_error', error: 'Plain words.' }]), at + 10).error, 'Plain words.');
  const stopped = exportStatus(job('stopped', [progress]), at + 10);
  assert.deepEqual([stopped.status, stopped.message, stopped.error], ['stopped', 'Cancelled', null]);

  assert.equal(exportBaseName(join('x', 'Run 1', 'case')), 'Run_1');
  // A run's shown name wins over its folder (Run_1_2 when another run took Run_1).
  const runDir = mkdtempSync(join(tmpdir(), 'vtk-name-'));
  try {
    const caseDir = join(runDir, 'Run_1_2', 'case');
    mkdirSync(caseDir, { recursive: true });
    assert.equal(exportBaseName(caseDir), 'Run_1_2');
    writeFileSync(join(runDir, 'Run_1_2', 'run.json'), '\uFEFF' + JSON.stringify({ id: 'r1', name: 'Run 1' }));
    assert.equal(exportBaseName(caseDir), 'Run_1');
    writeFileSync(join(runDir, 'Run_1_2', 'run.json'), JSON.stringify({ id: 'r1', name: '...' }));
    assert.equal(exportBaseName(caseDir), 'Run_1_2');
  } finally {
    rmSync(runDir, { recursive: true, force: true });
  }
  assert.equal(exportBaseName(join('x', 'cavity')), 'cavity');
  assert.equal(safeExportName('..'), 'results');
});
