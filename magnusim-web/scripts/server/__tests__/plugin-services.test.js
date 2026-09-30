import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PYTHON } from '../../python-env.js';
import { PluginService, PluginServiceError, PluginServiceHost, startStudyMigrations } from '../plugin-services.ts';
import { JobManager } from '../jobs.ts';
import { RpcError } from '../worker.ts';

const tmp = mkdtempSync(join(tmpdir(), 'plugin-services-'));
after(() => rmSync(tmp, { recursive: true, force: true }));

// A service module (the core interpreter stands in for a plugin environment:
// both see magnusim_sdk; the host starts it isolated, -I).
writeFileSync(
  join(tmp, 'demo_service.py'),
  [
    'import os, sys, time',
    'from magnusim_sdk.service import method',
    '@method("hello")',
    'def hello(params, scope):',
    '    return {"pid": os.getpid(), "echo": params.get("echo"), "plugin": scope.get("plugin")}',
    '@method("slow", timeout_s=1)',
    'def slow(params, scope):',
    '    time.sleep(5)',
    '    return {}',
    '@method("crash")',
    'def crash(params, scope):',
    '    print("noise on stdout goes to the log", flush=True)',
    '    os._exit(1)',
    '@method("fail")',
    'def fail(params, scope):',
    '    raise ValueError("the airfoil has no trailing edge")',
    '',
  ].join('\n'),
);
writeFileSync(
  join(tmp, 'migrating_service.py'),
  [
    'from magnusim_sdk.service import method',
    '@method("migrate_study")',
    'def migrate_study(params, scope):',
    '    study = dict(params["study"])',
    '    study["title"] = study["title"] + " (upgraded)"',
    '    return study',
    '',
  ].join('\n'),
);

const spec = (key) => ({ key, name: key === 'a' ? 'Plugin A' : 'Plugin B', python: PYTHON, module: 'demo_service', cwd: tmp });
const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

describe('plugin services', () => {
  it('answers from its own process, and reports a method error as the call error', async () => {
    const svc = new PluginService(spec('a'));
    try {
      const r = await svc.call('hello', { echo: 'hi' }, { plugin: 'a' });
      assert.equal(r.echo, 'hi');
      assert.equal(r.plugin, 'a');
      assert.notEqual(r.pid, process.pid);
      assert.deepEqual(svc.methods().sort(), ['crash', 'fail', 'hello', 'slow']);
      await assert.rejects(svc.call('fail', {}, {}), (e) => e instanceof PluginServiceError && /no trailing edge/.test(e.message));
      await assert.rejects(svc.call('nope', {}, {}), (e) => e instanceof PluginServiceError && e.status === 404);
    } finally {
      svc.stop();
    }
  });

  // gate:h12-service-crash
  it('reports a crash and starts again on the next call', async () => {
    const svc = new PluginService(spec('a'));
    try {
      await svc.call('hello', {}, {});
      await assert.rejects(svc.call('crash', {}, {}), (e) => /stopped \(exit 1\)/.test(e.message));
      const again = await svc.call('hello', {}, {});
      assert.equal(typeof again.pid, 'number');
      assert.equal(svc.starts, 2);
    } finally {
      svc.stop();
    }
  });

  // gate:h12-service-timeout
  it('times out a call that runs too long, and another plugin keeps answering', async () => {
    const a = new PluginService(spec('a'));
    const b = new PluginService(spec('b'));
    try {
      await Promise.all([a.start(), b.start()]);
      const pidA = a.pid();
      const t0 = Date.now();
      const slow = a.call('slow', {}, {});
      const other = await b.call('hello', { echo: 'b' }, {});
      assert.equal(other.echo, 'b');
      assert.ok(Date.now() - t0 < 900, 'plugin B waited for plugin A');
      await assert.rejects(slow, (e) => e instanceof PluginServiceError && e.status === 504 && /took longer than 1 s/.test(e.message));
      assert.equal(a.running(), false);
      await new Promise((r) => setTimeout(r, 300));
      assert.equal(alive(pidA), false, 'the stuck service was left running');
      assert.equal((await a.call('hello', {}, {})).plugin, null);
    } finally {
      a.stop();
      b.stop();
    }
  });

  it('stops after being idle', async () => {
    const svc = new PluginService(spec('a'), 300);
    await svc.call('hello', {}, {});
    const pid = svc.pid();
    assert.equal(svc.running(), true);
    await new Promise((r) => setTimeout(r, 900));
    assert.equal(svc.running(), false);
    assert.equal(alive(pid), false);
  });

  it('finds a service through the worker, and says when it needs setup', async () => {
    const envs = {
      ready: { name: 'Ready', env: { state: 'ready', python: PYTHON, service: 'demo_service', plugin_dir: tmp } },
      setup: { name: 'Needs it', env: { state: 'needs_setup', service: 'demo_service' } },
      plain: { name: 'In-process', env: null },
    };
    const worker = {
      call: async (method, params) => {
        assert.equal(method, 'plugins.env');
        if (params.key === 'off') throw new RpcError(-32004, 'not loaded');
        return envs[params.key];
      },
    };
    const host = new PluginServiceHost(worker);
    try {
      const svc = await host.serviceFor('ready');
      assert.ok(svc);
      assert.equal((await svc.call('hello', {}, { plugin: 'ready' })).plugin, 'ready');
      await assert.rejects(host.serviceFor('setup'), (e) => e instanceof PluginServiceError && e.status === 409 && /needs setup/.test(e.message));
      assert.equal(await host.serviceFor('plain'), null);
      assert.equal(await host.serviceFor('off'), null);
      host.reset('ready');
      assert.equal(svc.running(), false);
    } finally {
      host.resetAll();
    }
  });
});

describe('study migrations', () => {
  it('run in the background: the tree never waits, the upgrade lands, a plugin that cannot is left alone', async () => {
    const stored = [];
    const worker = {
      call: async (method, params) => {
        if (method === 'plugins.env') {
          const module = params.key === 'mig' ? 'migrating_service' : 'demo_service';
          return { name: params.key, env: { state: 'ready', python: PYTHON, service: module, plugin_dir: tmp } };
        }
        if (method === 'plugin_studies.get') return { study: { id: params.study_id, title: 'Wing', rev: 3 } };
        if (method === 'plugin_studies.migrated') {
          stored.push(params);
          return { ok: true };
        }
        throw new Error(method);
      },
    };
    const host = new PluginServiceHost(worker);
    try {
      const rows = [
        { id: 'st-1', plugin: 'mig', needs_migration: true, schema_version: 1, kind_schema_version: 2 },
        { id: 'st-2', plugin: 'plain', needs_migration: true, schema_version: 1, kind_schema_version: 2 },
        { id: 'st-3', plugin: 'mig', needs_migration: false },
      ];
      const t0 = Date.now();
      assert.equal(startStudyMigrations(worker, host, 'p1', rows), true);
      assert.ok(Date.now() - t0 < 50, 'the caller waited for a plugin');
      await new Promise((resolve, reject) => {
        const until = Date.now() + 20_000;
        const tick = () =>
          stored.length ? resolve() : Date.now() > until ? reject(new Error('never migrated')) : setTimeout(tick, 100);
        tick();
      });
      assert.equal(stored.length, 1);
      assert.deepEqual([stored[0].study_id, stored[0].rev, stored[0].study.title], ['st-1', 3, 'Wing (upgraded)']);
      // The plugin with no migrate_study: skipped, and not tried again at once.
      await new Promise((r) => setTimeout(r, 1500));
      assert.equal(startStudyMigrations(worker, host, 'p1', [rows[1]]), false);
      host.reset('plain');
      assert.equal(startStudyMigrations(worker, host, 'p1', [rows[1]]), true, 'a reset plugin is tried again');
      // Let that attempt finish (it skips again) before the services are stopped.
      const until = Date.now() + 20_000;
      while (startStudyMigrations(worker, host, 'p1', [rows[1]]) && Date.now() < until) {
        await new Promise((r) => setTimeout(r, 100));
      }
    } finally {
      host.resetAll();
    }
  });
});

// gate:h12-kill-tree
describe('stopping a job', () => {
  it('stops the processes its tool started', async () => {
    const script = join(tmp, 'tree.py');
    writeFileSync(
      script,
      [
        'import json, subprocess, sys, time',
        'child = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(120)"])',
        'print("MAGNUSIM_EVENT " + json.dumps({"event": "log", "child_pid": child.pid}), flush=True)',
        'time.sleep(120)',
        '',
      ].join('\n'),
    );
    const jobs = new JobManager({ cacheDir: join(tmp, 'cache') });
    const job = jobs.create('tree_test', {}, 'p1');
    let childPid = 0;
    const got = new Promise((resolve) =>
      jobs.onEvents(job.id).on('event', (ev) => {
        if (ev && ev.child_pid) {
          childPid = ev.child_pid;
          resolve();
        }
      }),
    );
    const tool = jobs.spawnPython(job.id, script, []);
    await got;
    assert.equal(alive(childPid), true);
    jobs.stop(job.id, 'p1');
    await new Promise((r) => setTimeout(r, 500));
    assert.equal(alive(tool.pid), false, 'the job tool is still running');
    assert.equal(alive(childPid), false, 'the process the tool started is still running');
  });
});
