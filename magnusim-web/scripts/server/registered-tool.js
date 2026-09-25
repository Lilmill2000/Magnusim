import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pyTool } from '../python-env.js';

/**
 * @param {import('./jobs.ts').JobManager} jobs
 * @param {{ tool?: string, tool_path?: string, args_from_params?: string[] }} spec
 * @param {Record<string, unknown>} params
 * @param {{ id: string }} job
 */
export function startRegisteredJob(jobs, spec, params, job) {
  const script = spec.tool_path || pyTool(String(spec.tool || ''));
  const args = [];
  for (const name of spec.args_from_params || []) {
    const value = params[name];
    if (value !== undefined && value !== null && value !== '') {
      args.push('--' + String(name).replace(/_/g, '-'), String(value));
    }
  }
  jobs.spawnPython(job.id, script, args);
}

/**
 * @param {{ cacheDir: string, jobs: { runSync: Function } }} deps
 * @param {import('./router.ts').RequestContext} ctx
 * @param {{ key: string, tool?: string, tool_path?: string, args_from_params?: string[], output?: string }} spec
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
    const script = spec.tool_path || pyTool(String(spec.tool || ''));
    const args = ['--out', out];
    for (const name of spec.args_from_params || []) {
      if (params[name] != null && params[name] !== '') {
        args.push('--' + String(name).replace(/_/g, '-'), String(params[name]));
      }
    }
    const ran = deps.jobs.runSync(script, args);
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
