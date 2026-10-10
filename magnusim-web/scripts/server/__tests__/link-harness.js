// A whole app server for the link tests (host API 1.5), in this test process: the real
// Python worker (with the link-demo fixture plugin), the real routes and router, a
// projects root of its own. Not a test file itself (*.test.js only are run).
//
//   const h = await linkHarness({ name: 'link-job' });
//   const pid = h.project('p1'); const sid = await h.study(pid);
//   const r = await h.link(pid, sid, { version: 'v1', sourceVersion: 1 });
//
// Set any MAGNUSIM_TEST_* variable before calling it: the modules read them when they load.
import http from 'node:http';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
export const WEB = resolve(HERE, '..', '..', '..');
export const EXPORTS = join(WEB, 'python', 'tests', 'fixtures', 'link-plugins', 'link-demo', 'workspace', 'exports');
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

/**
 * `bundled`: fixture plugins (python/tests/fixtures/link-plugins) shipped as bundled ones,
 * in a fixture bundled folder (MAGNUSIM_BUNDLED_DIR) beside a copy of the required
 * incompressible_flow, with the generated registry that goes with that folder.
 * @param {{ name?: string, env?: Record<string, string>, plugins?: string[], bundled?: string[] }} [opts]
 */
export async function linkHarness(opts = {}) {
  const root = mkdtempSync(join(tmpdir(), `magnusim-${opts.name || 'link'}-`));
  const projects = join(root, 'projects');
  const plugins = join(root, 'plugins');
  mkdirSync(projects, { recursive: true });
  mkdirSync(plugins, { recursive: true });
  cpSync(join(WEB, 'python', 'tests', 'fixtures', 'link-plugins', 'link-demo'), join(plugins, 'link-demo'), { recursive: true });
  // A plugin that owns a BC kind with a face field (plugin_needed while it is off or gone).
  if ((opts.plugins || []).includes('bc-demo')) {
    cpSync(join(WEB, 'python', 'tests', 'fixtures', 'link-plugins', 'bc-demo'), join(plugins, 'bc-demo'), { recursive: true });
  }
  // A plugin that edits a project geometry (host API 1.7, [[geometry_actions]]).
  if ((opts.plugins || []).includes('edit-demo')) {
    cpSync(join(WEB, 'python', 'tests', 'fixtures', 'edit-plugins', 'edit-demo'), join(plugins, 'edit-demo'), { recursive: true });
  }
  // A second plugin with the same kind title (its own key): two plugins' studies never meet.
  if ((opts.plugins || []).includes('link-demo-2')) {
    cpSync(join(plugins, 'link-demo'), join(plugins, 'link-demo-2'), { recursive: true });
    const m = join(plugins, 'link-demo-2', 'manifest.toml');
    writeFileSync(m, readFileSync(m, 'utf8').replace('key = "link-demo"', 'key = "link-demo-2"').replace('name = "Link demo"', 'name = "Link demo 2"'));
  }
  /** @type {Record<string, string>} */
  const bundledEnv = {};
  if ((opts.bundled || []).length) {
    const dir = join(root, 'bundled');
    mkdirSync(dir, { recursive: true });
    const skip = /[\\/](__pycache__|tests|e2e)([\\/]|$)/;
    cpSync(join(WEB, 'bundled-plugins', 'incompressible_flow'), join(dir, 'incompressible_flow'), { recursive: true, filter: (src) => !skip.test(src) });
    const dump = JSON.parse(readFileSync(join(WEB, 'scripts', 'generated', 'registry.json'), 'utf8'));
    for (const key of opts.bundled || []) {
      cpSync(join(WEB, 'python', 'tests', 'fixtures', 'link-plugins', key), join(dir, key), { recursive: true });
      const m = join(dir, key, 'manifest.toml');
      // A top-level key, right after the plugin's own key line.
      writeFileSync(m, readFileSync(m, 'utf8').replace(/^(key = .*)$/m, '$1\ntier = "bundled"'));
      const extra = JSON.parse(readFileSync(join(WEB, 'python', 'tests', 'fixtures', 'link-plugins', key, 'registry-rows.json'), 'utf8'));
      for (const [reg, rows] of Object.entries(extra)) dump[reg] = [...(dump[reg] || []), ...rows];
    }
    writeFileSync(join(dir, 'registry.json'), JSON.stringify(dump));
    bundledEnv.MAGNUSIM_BUNDLED_DIR = dir;
  }
  const local = join(root, 'local.json');
  writeFileSync(local, '{}');
  const env = {
    ...bundledEnv,
    MAGNUSIM_PROJECTS_ROOT: projects,
    MAGNUSIM_PLUGINS_DIR: plugins,
    MAGNUSIM_LOCAL_JSON: local,
    CFDDESK_LOCAL_JSON: local,
    MAGNUSIM_QUEUE_QUIET: '1',
    // A request still running after 20 s dumps the worker's stacks here (a stuck start shows why).
    MAGNUSIM_WORKER_STACKS: join(root, 'worker-stacks.txt'),
    ...(opts.env || {}),
  };
  Object.assign(process.env, env);

  const { Router, dispatch } = await import('../router.ts');
  const { registerPhase3Routes } = await import('../routes.ts');
  const { registerLiveRoutes } = await import('../live-routes.js');
  const { JobManager } = await import('../jobs.ts');
  const { WorkerClient } = await import('../worker.ts');
  const { attachWorkerBridge } = await import('../../py-json.js');
  const { setLiveRegistry } = await import('../../registry-defaults.js');
  const queue = await import('../compute-queue.ts');
  const slot = await import('../../compute-slot.js');
  const store = await import('../../link-store.js');
  const job = await import('../link-job.js');
  const gate = await import('../link-gate.js');

  const real = new WorkerClient({ name: 'link-test-worker', env, timeoutMs: 180_000 });
  real.start();
  /** Calls a test answers itself: method → (params, real) => answer. */
  const overrides = new Map();
  const calls = [];
  const worker = {
    on: (...a) => real.on(...a),
    call: (method, params, timeoutMs) => {
      calls.push([method, params]);
      const o = overrides.get(method);
      if (o) return Promise.resolve().then(() => o(params, real, timeoutMs));
      return real.call(method, params, timeoutMs);
    },
    stop: () => real.stop(),
  };
  attachWorkerBridge((m, p, t) => worker.call(m, p, t));
  // In the full server suite (many workers starting at once) a first registry.describe
  // has been seen to get no answer at all; a new request is answered, so ask again.
  const refreshRegistry = async () => {
    let last = null;
    for (let i = 0; i < 4; i += 1) {
      try {
        const doc = await real.call('registry.describe', {}, 90_000);
        if (!setLiveRegistry(doc)) throw new Error('registry.describe gave no usable registry');
        return;
      } catch (e) {
        last = e;
        console.warn(`[link harness] registry.describe try ${i + 1} failed: ${e instanceof Error ? e.message : e}`);
      }
    }
    throw last;
  };
  try {
    await refreshRegistry();
  } catch (e) {
    // The worker must not keep this test process alive.
    real.stop();
    let stacks = '';
    try {
      stacks = readFileSync(join(root, 'worker-stacks.txt'), 'utf8').slice(-6000);
    } catch {
      stacks = '(no stacks)';
    }
    throw new Error(`${e instanceof Error ? e.message : String(e)}\n${stacks}`);
  }

  const router = new Router();
  const jobs = new JobManager({ cacheDir: join(root, 'jobs') });
  const live = registerLiveRoutes(router, { worker, jobs, services: null });
  registerPhase3Routes(router, {
    worker,
    jobs,
    webRoot: root,
    cacheDir: join(root, 'cache'),
    serveLegacyFilter: async (ctx) => ctx.sendJson(200, { ok: true }),
    startMeshJob() {},
    startSolveJob() {},
    startCadImportJob() {},
    caseSnapshot: () => ({}),
    attachCaseDir: () => ({ ok: true, status: 200, body: {} }),
    resetCaseIdle() {},
    envInstaller: () => ({ get: () => null, start: () => ({ state: 'installing', log: [] }) }),
  });
  // The thumbnail renderer needs a display stack; the tests stand it in (a PNG header).
  job.setLinkJobDepsForTests({
    renderThumb: async (args) => {
      const out = args[args.indexOf('--out') + 1];
      writeFileSync(out, Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47]), Buffer.alloc(200)]));
      return { code: 0, stdout: '', stderr: '', timedOut: false };
    },
    timing: { waitSteps: [50, 50, 50, 50], waitEvery: 100 },
  });
  const server = await new Promise((done) => {
    const s = http.createServer(async (req, res) => {
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
    // An idle keep-alive socket the server closes just as fetch reuses it resets the
    // request (ECONNRESET); keep idle sockets far longer than the client does.
    s.keepAliveTimeout = 120_000;
    s.listen(0, '127.0.0.1', () => done(s));
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  /** A reset socket (the request never reached a handler): ask once more. */
  const socketReset = (e) => {
    const c = e && /** @type {any} */ (e).cause;
    const code = String((c && (c.code || c.name)) || '');
    return /ECONNRESET|UND_ERR_SOCKET|EPIPE/.test(code) || /ECONNRESET|other side closed/.test(String((c && c.message) || ''));
  };
  const request = async (method, path, body) => {
    const send = () =>
      fetch(base + path, {
        method,
        headers: body ? { 'content-type': 'application/json' } : {},
        body: body ? JSON.stringify(body) : undefined,
      });
    let r;
    try {
      r = await send();
    } catch (e) {
      if (!socketReset(e)) throw e;
      r = await send();
    }
    const text = await r.text();
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      data = text;
    }
    return { status: r.status, body: data, headers: r.headers };
  };

  const h = {
    root,
    projects,
    plugins,
    base,
    worker,
    real,
    overrides,
    calls,
    router,
    live,
    queue,
    slot,
    store,
    job,
    gate,
    refreshRegistry,
    get: (path) => request('GET', path),
    post: (path, body = {}) => request('POST', path, body),
    /** A web-format project with no geometry. */
    project(pid, doc) {
      const dir = join(projects, pid);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'project.json'), JSON.stringify(doc || { id: pid, title: pid, geometries: [], created_at: '2026-10-01T00:00:00Z' }, null, 2));
      return pid;
    },
    /** A plugin study of link-demo (kind demo by default); its id. */
    async study(pid, { kind = 'demo', title = 'Demo 1', plugin = 'link-demo' } = {}) {
      const r = await request('POST', '/api/plugin-studies/create', { project_id: pid, plugin, kind, title });
      if (r.status !== 200) throw new Error(`study create: ${r.status} ${JSON.stringify(r.body)}`);
      return r.body.study.id;
    },
    /** Put an export into the study's folder as the plugin would; {rel, sha256}. */
    put(pid, sid, file, as, plugin = 'link-demo') {
      const rel = `studies/${sid}/exports/${as || file}`;
      const dest = join(projects, pid, 'plugins', plugin, rel);
      mkdirSync(dirname(dest), { recursive: true });
      const buf = Buffer.isBuffer(file) ? file : readFileSync(join(EXPORTS, file));
      writeFileSync(dest, buf);
      return { rel, sha256: sha256(buf) };
    },
    /**
     * POST /api/plugin-geometry/link with a fixture version's files. When the host asks
     * (a shape change on a geometry in use, proposal 5.0) the answer is `choose`
     * ('overwrite' by default, revision 6's update, as the older tests expect), sent
     * through POST /api/plugin-geometry/choose; its answer comes back with `asked` (the
     * question). `choose: null` returns the question itself.
     */
    async link(pid, sid, { version = 'v1', names, sourceVersion = 1, basedOnRev = null, plugin = 'link-demo', name, shapeFile, extra = {}, choose = 'overwrite', copy = [] } = {}) {
      const shape = h.put(pid, sid, shapeFile || `${version}.bbrep`, 'shape.bin', plugin);
      const namesFile = names === null ? null : names || `${version}.face_names.json`;
      const faceNames = namesFile ? h.put(pid, sid, namesFile, 'names.json', plugin) : null;
      const r = await request('POST', '/api/plugin-geometry/link', {
        project_id: pid,
        plugin,
        study_id: sid,
        shape: { ...shape, format: 'brep' },
        face_names: faceNames,
        source_version: sourceVersion,
        based_on_rev: basedOnRev,
        ...(name ? { name } : {}),
        ...extra,
      });
      if (!choose || r.status !== 202 || !r.body || !r.body.choosing) return r;
      const c = await h.choose(pid, sid, r.body.job_id, choose, copy, plugin);
      return { ...c, body: { ...c.body, asked: r.body.choosing } };
    },
    /** POST /api/plugin-geometry/choose: the user's answer to the host's question. */
    choose(pid, sid, jobId, choice, copy = [], plugin = 'link-demo') {
      return request('POST', '/api/plugin-geometry/choose', { project_id: pid, plugin, study_id: sid, job_id: jobId, choice, copy });
    },
    record: (id) => store.readLinkRecord(id),
    /** Wait until the job's record has one of these statuses. */
    async until(id, statuses = ['done', 'failed', 'cancelled', 'superseded', 'gone', 'busy', 'stale'], ms = 120_000) {
      const end = Date.now() + ms;
      for (;;) {
        const rec = store.readLinkRecord(id);
        if (rec && statuses.includes(rec.status)) return rec;
        if (Date.now() > end) throw new Error(`job ${id} still ${rec && rec.status} (${rec && rec.stage}) after ${ms} ms`);
        await sleep(40);
      }
    },
    async waitFor(fn, ms = 60_000, what = 'condition') {
      const end = Date.now() + ms;
      for (;;) {
        const v = await fn();
        if (v) return v;
        if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
        await sleep(40);
      }
    },
    /** The geometry folder of an id (null when none). */
    geomDir(pid, gid) {
      const root2 = join(projects, pid, 'geometries');
      if (!existsSync(root2)) return null;
      for (const name of readdirSafe(root2)) {
        try {
          const id = JSON.parse(readFileSync(join(root2, name, 'id.json'), 'utf8'));
          if (id.id === gid) return join(root2, name);
        } catch {
          /* not a geometry */
        }
      }
      return null;
    },
    state(pid, gid) {
      const dir = h.geomDir(pid, gid);
      return dir ? JSON.parse(readFileSync(join(dir, 'link', 'state.json'), 'utf8')) : null;
    },
    async close() {
      try {
        server.closeAllConnections();
      } catch {
        /* closed */
      }
      await new Promise((r) => server.close(() => r()));
      try {
        real.stop();
      } catch {
        /* stopped */
      }
      for (let i = 0; i < 50; i += 1) {
        try {
          rmSync(root, { recursive: true, force: true });
          return;
        } catch {
          await sleep(200);
        }
      }
    },
  };
  return h;
}

function readdirSafe(dir) {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}
