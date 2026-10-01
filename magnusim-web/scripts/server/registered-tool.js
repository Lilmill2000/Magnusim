import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pyTool } from '../python-env.js';
import { projectDir } from '../w17-sim-catalog.js';

/**
 * What a plugin job is told of its call: its plugin, project (and folder), study,
 * geometry and job id (PluginData.from_env reads the first two for its own files).
 * @param {{ plugin?: string }} spec
 * @param {Record<string, unknown>} params
 * @param {{ id: string }} job
 */
function pluginJobEnv(spec, params, job) {
  const pid = String(params.project_id || params.projectId || '');
  let dir;
  try {
    dir = pid ? String(projectDir(pid)) : '';
  } catch {
    dir = '';
  }
  /** @type {Record<string, string>} */
  const env = { MAGNUSIM_PLUGIN_KEY: String(spec.plugin || ''), MAGNUSIM_JOB_ID: String(job.id) };
  const optional = {
    MAGNUSIM_PROJECT_ID: pid,
    MAGNUSIM_PROJECT_DIR: dir,
    MAGNUSIM_SIMULATION_ID: String(params.simulation_id || params.simulationId || ''),
    MAGNUSIM_GEOMETRY_ID: String(params.geometry_id || params.geometryId || ''),
  };
  // Only what is known (an empty variable reads differently across platforms).
  for (const [name, value] of Object.entries(optional)) if (value) env[name] = value;
  return env;
}

/**
 * @param {import('./jobs.ts').JobManager} jobs
 * @param {{ tool?: string, tool_path?: string, args_from_params?: string[], plugin?: string, python?: string | null, cwd?: string | null, python_error?: string }} spec
 * @param {Record<string, unknown>} params
 * @param {{ id: string }} job
 */
export function startRegisteredJob(jobs, spec, params, job) {
  if (spec.python_error) {
    jobs.finish(job.id, 'failed', undefined, spec.python_error);
    return;
  }
  // Plugin jobs run their own tool (tool_path, resolved inside the plugin folder
  // by jobs.describe); never a core script of the same name.
  const builtin = String(spec.plugin || 'builtin') === 'builtin';
  const script = spec.tool_path || (builtin ? pyTool(String(spec.tool || '')) : '');
  if (!script) {
    jobs.finish(job.id, 'failed', undefined, `plugin job tool ${String(spec.tool || '')} is not in the plugin folder`);
    return;
  }
  const args = [];
  for (const name of spec.args_from_params || []) {
    const value = params[name];
    if (value !== undefined && value !== null && value !== '') {
      args.push('--' + String(name).replace(/_/g, '-'), String(value));
    }
  }
  // A plugin job on its plugin's environment runs there, in the plugin's folder.
  jobs.spawnPython(job.id, script, args, {
    python: spec.python || null,
    cwd: spec.python ? spec.cwd || null : null,
    ...(builtin ? {} : { env: pluginJobEnv(spec, params, job) }),
  });
}

/**
 * @param {{ cacheDir: string, jobs: { runSync: Function } }} deps
 * @param {import('./router.ts').RequestContext} ctx
 * @param {{ key: string, tool?: string, tool_path?: string, args_from_params?: string[], output?: string, python?: string | null, cwd?: string | null, python_error?: string }} spec
 */
export function serveRegisteredFilter(deps, ctx, spec) {
  const params = {};
  ctx.url.searchParams.forEach((value, key) => {
    params[key] = value;
  });
  const projectId = String((ctx.scope && ctx.scope.projectId) || params.project_id || 'none');
  const hash = createHash('sha256')
    .update(JSON.stringify({ key: spec.key, params }))
    .digest('hex')
    .slice(0, 16);
  const dir = join(deps.cacheDir, 'filter', projectId, spec.key, hash);
  mkdirSync(dir, { recursive: true });
  const fileName = spec.output === 'vtp' ? 'result.vtp' : 'result.json';
  const out = join(dir, fileName);
  if (!existsSync(out)) {
    // Plugin filters only reach here (filter.validate refuses a missing tool); no core fallback.
    const script = spec.tool_path || '';
    if (!script) {
      ctx.sendJson(400, { error: `plugin filter tool ${String(spec.tool || '')} is not in the plugin folder` });
      return;
    }
    const args = ['--out', out];
    for (const name of spec.args_from_params || []) {
      if (params[name] != null && params[name] !== '') {
        args.push('--' + String(name).replace(/_/g, '-'), String(params[name]));
      }
    }
    if (spec.python_error) {
      ctx.sendJson(409, { error: spec.python_error });
      return;
    }
    // The owning plugin's interpreter when it has its own environment.
    const ran = deps.jobs.runSync(script, args, spec.python ? { python: spec.python, cwd: spec.cwd || null } : undefined);
    if (!existsSync(out) && spec.output !== 'vtp' && ran.stdout) {
      writeFileSync(out, ran.stdout, 'utf8');
    }
    if (!existsSync(out) || (ran.status && ran.status !== 0 && !existsSync(out))) {
      ctx.sendJson(500, {
        error: 'filter failed',
        detail: String(ran.stderr || ran.stdout || '').slice(0, 500),
      });
      return;
    }
  }
  let body = {};
  try {
    body = JSON.parse(readFileSync(out, 'utf8'));
  } catch {
    body = { ok: true };
  }
  ctx.sendJson(200, { ...body, cache: dir, project_id: projectId, key: spec.key });
}
