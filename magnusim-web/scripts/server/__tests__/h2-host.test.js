/**
 * gate:h2-generic-jobs — a plugin JobKind starts through the registry and SSE.
 * gate:h2-tool-filter — a plugin ResultFilterType caches under the project id.
 */
import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

function rawStatus(port, path) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path, method: 'GET' }, (res) => {
      res.resume();
      res.on('end', () => resolve(res.statusCode));
    });
    req.on('error', reject);
    req.end();
  });
}
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JobManager } from '../jobs.ts';
import { Router, dispatch } from '../router.ts';
import { registerPhase3Routes } from '../routes.ts';
import { RpcError } from '../worker.ts';
import { PYTHON, PY_ROOT } from '../../python-env.js';

const root = mkdtempSync(join(tmpdir(), 'magnusim-h2-'));
const pluginDir = join(root, 'plugins', 'h2probe');
mkdirSync(pluginDir, { recursive: true });
writeFileSync(
  join(pluginDir, 'manifest.toml'),
  'key = "h2probe"\nname = "H2 probe"\nversion = "0.0.1"\napi_version = "1.0"\n',
  'utf8',
);
writeFileSync(
  join(pluginDir, 'echo_job.py'),
  'import json\nprint("MAGNUSIM_EVENT " + json.dumps({"event": "progress", "stage": "gmsh"}))\n',
  'utf8',
);
writeFileSync(
  join(pluginDir, 'echo_filter.py'),
  [
    'import argparse, json',
    'from pathlib import Path',
    'p = argparse.ArgumentParser()',
    'p.add_argument("--out", required=True)',
    'p.add_argument("--project-id", default="")',
    'args = p.parse_args()',
    'Path(args.out).write_text(json.dumps({"ok": True, "project_id": args.project_id}), encoding="utf-8")',
  ].join('\n'),
  'utf8',
);
writeFileSync(
  join(pluginDir, 'plugin.py'),
  [
    'from pathlib import Path',
    'from cfddesk.registry.jobs import JobKind',
    'from cfddesk.registry.result_filter import ResultFilterType',
    'from cfddesk.registry.schema import SchemaField',
    'ROOT = Path(__file__).resolve().parent',
    'def register(hub):',
    '    hub.register_job(JobKind(key="h2probe", tool="echo_job.py", scope="project", args_from_params=("project_id",)), plugin="h2probe", package_dir=ROOT)',
    '    hub.registry("filter").register(ResultFilterType(',
    '        key="h2probe", label="H2 probe",',
    '        params_schema=(SchemaField("project_id", "Project", "text", default=""),),',
    '        tool="echo_filter.py", cache_scope="case", output="json",',
    '        args_from_params=("project_id",),',
    '    ), plugin="h2probe")',
    '    def ping(params, scope):',
    '        return {"ok": True, "echo": (params or {}).get("msg"), "project_id": (scope or {}).get("project_id")}',
    '    hub.register_method("h2probe", "ping", ping)',
  ].join('\n'),
  'utf8',
);

const described = spawnSync(
  PYTHON,
  [
    '-c',
    [
      'import json, os, sys',
      'os.environ["MAGNUSIM_WEB_ROOT"] = sys.argv[1]',
      'from cfddesk.registry.discovery import reset_for_tests, load_all',
      'reset_for_tests()',
      'load_all(web_root=sys.argv[1])',
      'from cfddesk.worker.methods import jobs_describe, filter_validate, plugin_dispatch',
      'print(json.dumps({',
      '  "job": jobs_describe("h2probe"),',
      '  "filt": filter_validate("h2probe", {"project_id": "p1"}),',
      '  "ping": plugin_dispatch("h2probe", "ping", {"msg": "hi"}, {"project_id": "p1"}),',
      '}))',
    ].join('\n'),
    root,
  ],
  {
    cwd: PY_ROOT,
    encoding: 'utf8',
    env: { ...process.env, PYTHONPATH: PY_ROOT, MAGNUSIM_WEB_ROOT: root },
  },
);

const registry = JSON.parse(
  String(described.stdout || '')
    .trim()
    .split(/\r?\n/)
    .filter(Boolean)
    .pop() || '{}',
);

function listen(handler) {
  const server = http.createServer(handler);
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

describe('gate:h2-host', { concurrency: 1 }, () => {
  after(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('gate:h2-generic-jobs registers a novel job and delivers start and result on SSE', async () => {
    assert.equal(described.status, 0, described.stderr);
    assert.equal(registry.job.job.key, 'h2probe');
    assert.equal(registry.job.job.plugin, 'h2probe');
    assert.ok(String(registry.job.job.tool_path).endsWith('echo_job.py'));
    assert.equal(registry.ping.echo, 'hi');
    assert.equal(registry.ping.project_id, 'p1');

    const routesSrc = readFileSync(new URL('../routes.ts', import.meta.url), 'utf8');
    assert.equal(routesSrc.includes('h2probe'), false);
    assert.equal(/kind\s*!==\s*['"]mesh['"]/.test(routesSrc), false);

    const jobs = new JobManager({ cacheDir: join(root, 'cache-jobs') });
    const worker = {
      async call(method, params) {
        if (method === 'jobs.describe' && params.kind === 'h2probe') return registry.job;
        if (method === 'jobs.describe') throw new RpcError(-32602, 'unknown job kind: ' + params.kind);
        if (method === 'plugin.dispatch') return registry.ping;
        return {};
      },
    };
    const router = new Router();
    registerPhase3Routes(router, {
      worker,
      jobs,
      webRoot: root,
      cacheDir: join(root, 'cache'),
      serveLegacyFilter: async () => {},
      startMeshJob() {},
      startSolveJob() {},
      startCadImportJob() {},
      caseSnapshot: () => ({}),
      attachCaseDir: () => ({ ok: true, status: 200, body: {} }),
      resetCaseIdle() {},
    });
    const server = await listen((req, res) => dispatch(router, req, res));
    const port = server.address().port;
    try {
      const started = await fetch(`http://127.0.0.1:${port}/api/jobs`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ kind: 'h2probe', params: { project_id: 'p1' } }),
      });
      const startedBody = await started.json();
      assert.equal(started.status, 202);
      assert.equal(startedBody.job.kind, 'h2probe');
      const events = await fetch(
        `http://127.0.0.1:${port}/api/jobs/${startedBody.job.id}/events?project_id=p1`,
      );
      const foreignEvents = await fetch(
        `http://127.0.0.1:${port}/api/jobs/${startedBody.job.id}/events?project_id=other`,
      );
      assert.equal(foreignEvents.status, 403);
      const text = await events.text();
      assert.match(text, /"event":"start"/);
      assert.match(text, /"event":"result"/);

      const unknown = await fetch(`http://127.0.0.1:${port}/api/jobs`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ kind: 'no-such-job', params: { project_id: 'p1' } }),
      });
      assert.equal(unknown.status, 400);

      const ping = await fetch(`http://127.0.0.1:${port}/api/plugin/h2probe/ping`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ msg: 'hi' }),
      });
      assert.equal(ping.status, 200);
      const bad = await rawStatus(port, '/api/plugin/h2probe/foo/../../secret');
      assert.equal(bad, 400);
    } finally {
      server.close();
    }
  });

  it('gate:h2-tool-filter caches a plugin filter under the project id', async () => {
    assert.equal(described.status, 0, described.stderr);
    assert.equal(registry.filt.plugin, 'h2probe');
    assert.ok(String(registry.filt.tool_path).endsWith('echo_filter.py'));
    const fieldsSrc = readFileSync(new URL('../../vite-plugin-case-fields.js', import.meta.url), 'utf8');
    assert.equal(fieldsSrc.includes('h2probe'), false);
    assert.equal(fieldsSrc.includes('spawnSync('), false);

    const cacheDir = join(root, 'cache-filter');
    const jobs = new JobManager({ cacheDir: join(root, 'cache-jobs-2') });
    const worker = {
      async call(method) {
        if (method === 'filter.validate') return registry.filt;
        return {};
      },
    };
    const router = new Router();
    registerPhase3Routes(router, {
      worker,
      jobs,
      webRoot: root,
      cacheDir,
      serveLegacyFilter: async (_ctx, key) => {
        throw new Error('legacy filter path used for ' + key);
      },
      startMeshJob() {},
      startSolveJob() {},
      startCadImportJob() {},
      caseSnapshot: () => ({}),
      attachCaseDir: () => ({ ok: true, status: 200, body: {} }),
      resetCaseIdle() {},
    });
    const server = await listen((req, res) => dispatch(router, req, res));
    const port = server.address().port;
    try {
      const first = await fetch(`http://127.0.0.1:${port}/api/filter/h2probe?project_id=p1`);
      const body = await first.json();
      assert.equal(first.status, 200);
      assert.equal(body.ok, true);
      assert.equal(body.project_id, 'p1');
      assert.match(body.cache.replace(/\\/g, '/'), /filter\/p1\/h2probe\//);
      rmSync(registry.filt.tool_path);
      const second = await fetch(`http://127.0.0.1:${port}/api/filter/h2probe?project_id=p1`);
      const again = await second.json();
      assert.equal(second.status, 200);
      assert.equal(again.project_id, 'p1');
    } finally {
      server.close();
    }
  });
});
