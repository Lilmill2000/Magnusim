/**
 * Export to ParaView (VTK) and Open case folder, for the results on screen.
 *
 *   POST /api/results/export-vtk            {project_id, case, frames: 'current'|'all', time}
 *        -> 202 {ok, job_id, status}: python/tools/export_vtk.py runs as a job
 *           (Windows, no WSL), writing one zip under .cache/vtk-export/<job>.
 *   GET  /api/results/export-vtk/:id        -> {status, fraction, message, error, file_name, bytes}
 *   GET  /api/results/export-vtk/:id/file   -> the zip (attachment)
 *   POST /api/jobs/:id/stop                 -> stops it (the job manager's own route)
 *   POST /api/results/open-folder           {project_id, case} -> File Explorer on the case folder
 *
 * Every call names its project; the case must lie inside it. Opening a folder is
 * refused through the public tunnel (only a browser on this PC sees the window).
 */
import { spawn } from 'node:child_process';
import { createReadStream, existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { pyTool } from '../python-env.js';
import { caseDirBelongsToProject } from '../project-isolation.js';
import { listFoamTimeDirs, readJsonFile } from '../project-layout.js';
import { pathIsWithin } from '../safe-path.js';
import { isLocalOperator } from './http.ts';
import type { JobManager, JobRecord } from './jobs.ts';
import type { RequestContext, Router } from './router.ts';

export const VTK_EXPORT_KIND = 'vtk_export';
/** Finished exports older than this are deleted when a new one starts. */
export const EXPORT_KEEP_MS = 6 * 60 * 60 * 1000;

export interface VtkExportDeps {
  jobs: JobManager;
  cacheDir: string;
  /** Shows a folder to the user (tests pass a stub). */
  openFolder?: (dir: string) => void;
  /** The tool the job runs (tests may point elsewhere). */
  script?: string;
}

/** File Explorer (Finder, the desktop's file manager) on ``dir``, detached. */
export function openFolderOnThisPc(dir: string): void {
  const cmd = process.platform === 'win32' ? 'explorer.exe' : process.platform === 'darwin' ? 'open' : 'xdg-open';
  const child = spawn(cmd, [dir], { detached: true, stdio: 'ignore', windowsHide: false });
  child.on('error', () => undefined);
  child.unref();
}

/** A download / folder name: letters, digits, '.', '_' and '-' only. */
export function safeExportName(text: string, fallback = 'results'): string {
  const out = String(text || '')
    .replace(/[^A-Za-z0-9._-]+/g, '_')
    .replace(/^[._]+|[._]+$/g, '');
  return out.slice(0, 80) || fallback;
}

/**
 * The run's name for the files: for ``<run>/case``, the name the run shows in the tree
 * (run.json's ``name``, e.g. "Run 1" -> Run_1), else the run's folder; any other case
 * folder, its own name. A run folder may carry a suffix the user never sees (Run_1_2).
 */
export function exportBaseName(caseDir: string): string {
  const abs = resolve(caseDir);
  const leaf = basename(abs);
  if (leaf.toLowerCase() !== 'case') return safeExportName(leaf);
  const runDir = dirname(abs);
  const rec = readJsonFile(join(runDir, 'run.json')) as { name?: unknown } | null;
  const shown = rec && typeof rec.name === 'string' ? safeExportName(rec.name, '') : '';
  return shown || safeExportName(basename(runDir));
}

type Checked = { ok: true; caseDir: string } | { ok: false; status: number; error: string };

/** The request's case folder, when it lies in the request's project and exists. */
export function checkedCase(projectId: string, raw: unknown): Checked {
  const text = String(raw ?? '').trim();
  if (!projectId) return { ok: false, status: 400, error: 'project_id required' };
  if (!text) return { ok: false, status: 400, error: 'No results are open.' };
  const caseDir = resolve(text);
  if (!caseDirBelongsToProject(caseDir, projectId)) {
    return { ok: false, status: 403, error: 'That case folder is not in this project.' };
  }
  if (!existsSync(caseDir) || !statSync(caseDir).isDirectory()) {
    return { ok: false, status: 404, error: "The run's case folder is missing." };
  }
  return { ok: true, caseDir };
}

export interface ExportStatus {
  ok: true;
  job_id: string;
  status: JobRecord['status'];
  fraction: number;
  message: string;
  error: string | null;
  file_name: string | null;
  bytes: number | null;
  times: string[];
  fields: string[];
  units_note: string | null;
}

type ExportEvent = { event?: string; [key: string]: unknown };

/** How long after the tool's exit its last output line may still be on its way. */
export const LAST_LINE_GRACE_MS = 3000;

/** What the dialog shows of a job: its last progress line, its result or its error. */
export function exportStatus(job: JobRecord, now = Date.now()): ExportStatus {
  let fraction = 0;
  let message = job.status === 'queued' ? 'Starting' : '';
  let error: string | null = null;
  let done: ExportEvent | null = null;
  for (const raw of job.events as ExportEvent[]) {
    if (raw.event === 'progress') {
      const f = Number(raw.fraction);
      if (Number.isFinite(f)) fraction = Math.max(0, Math.min(1, f));
      if (raw.message) message = String(raw.message);
    } else if (raw.event === 'exported') {
      done = raw;
    } else if (raw.event === 'export_error') {
      error = String(raw.error || '');
    }
  }
  let status = job.status;
  if ((status === 'done' && !done) || (status === 'failed' && !error)) {
    // The tool's last line can be read after its exit: for a moment the job is not over.
    const ended = job.finished_at ? Date.parse(job.finished_at) : NaN;
    if (Number.isFinite(ended) && now - ended < LAST_LINE_GRACE_MS) {
      status = 'running';
      fraction = Math.max(fraction, 0.99);
      message = 'Finishing';
    } else {
      status = 'failed';
      error = /server restart/i.test(String(job.error || ''))
        ? 'The app restarted during the export. Export again.'
        : 'The export failed. See the log for details.';
    }
  }
  const finished = status === 'done';
  const params = job.params as { download_name?: string };
  return {
    ok: true,
    job_id: job.id,
    status,
    fraction: finished ? 1 : fraction,
    message: status === 'stopped' ? 'Cancelled' : message,
    error: status === 'failed' ? error : null,
    file_name: finished && done ? String(params.download_name || done.file_name || 'results.zip') : null,
    bytes: finished && done && Number.isFinite(Number(done.bytes)) ? Number(done.bytes) : null,
    times: finished && done && Array.isArray(done.times) ? done.times.map(String) : [],
    fields: finished && done && Array.isArray(done.fields) ? done.fields.map(String) : [],
    units_note: finished && done && done.units_note ? String(done.units_note) : null,
  };
}

/** Delete export folders older than ``keepMs`` whose job is not running. */
export function sweepOldExports(root: string, jobs: JobManager, keepMs = EXPORT_KEEP_MS, now = Date.now()): void {
  let names: string[] = [];
  try {
    names = readdirSync(root);
  } catch {
    return;
  }
  for (const name of names) {
    const job = jobs.get(name);
    if (job && (job.status === 'running' || job.status === 'queued')) continue;
    const dir = join(root, name);
    try {
      if (now - statSync(dir).mtimeMs > keepMs) rmSync(dir, { recursive: true, force: true });
    } catch {
      /* gone already */
    }
  }
}

function ownJob(ctx: RequestContext, jobs: JobManager): JobRecord | null {
  const project = ctx.scope.projectId;
  if (!project) {
    ctx.sendJson(400, { error: 'project_id required' });
    return null;
  }
  const job = jobs.get(ctx.params.id || '');
  if (!job || job.kind !== VTK_EXPORT_KIND) {
    ctx.sendJson(404, { error: 'No such export.' });
    return null;
  }
  if (job.project !== project) {
    ctx.sendJson(403, { error: 'That export belongs to another project.' });
    return null;
  }
  return job;
}

export function registerVtkExportRoutes(router: Router, deps: VtkExportDeps): void {
  const root = join(deps.cacheDir, 'vtk-export');
  const openFolder = deps.openFolder || openFolderOnThisPc;
  const script = deps.script || pyTool('export_vtk.py');

  router.post('/api/results/export-vtk', async (ctx) => {
    const body = await ctx.readJsonBody();
    const checked = checkedCase(ctx.scope.projectId, body.case);
    if (!checked.ok) return ctx.sendJson(checked.status, { ok: false, error: checked.error });
    const frames = String(body.frames || 'current');
    if (frames !== 'current' && frames !== 'all') {
      return ctx.sendJson(400, { ok: false, error: "frames must be 'current' or 'all'" });
    }
    const saved = listFoamTimeDirs(checked.caseDir, { complete: true }) as string[];
    if (!saved.length) return ctx.sendJson(404, { ok: false, error: 'This run has no saved frames yet.' });
    let times = saved;
    if (frames === 'current') {
      const time = String(body.time ?? '').trim();
      if (!saved.includes(time)) {
        return ctx.sendJson(404, { ok: false, error: 'The frame on screen is not saved in this run.' });
      }
      times = [time];
    }
    const base = exportBaseName(checked.caseDir);
    const downloadName =
      frames === 'all' ? `${base}-vtk-all-frames.zip` : `${base}-vtk-${safeExportName(times[0], 'frame')}.zip`;
    mkdirSync(root, { recursive: true });
    sweepOldExports(root, deps.jobs);
    const job = deps.jobs.create(
      VTK_EXPORT_KIND,
      {
        project_id: ctx.scope.projectId,
        case: checked.caseDir,
        frames,
        times,
        download_name: downloadName,
      },
      ctx.scope.projectId,
    );
    const outDir = join(root, job.id);
    mkdirSync(outDir, { recursive: true });
    job.params.out_dir = outDir;
    deps.jobs.spawnPython(job.id, script, [
      '--case',
      checked.caseDir,
      '--times',
      times.join(','),
      '--out-dir',
      outDir,
      '--name',
      base,
    ]);
    ctx.sendJson(202, exportStatus(job));
  });

  router.get('/api/results/export-vtk/:id', (ctx) => {
    const job = ownJob(ctx, deps.jobs);
    if (job) ctx.sendJson(200, exportStatus(job));
  });

  router.get('/api/results/export-vtk/:id/file', (ctx) => {
    const job = ownJob(ctx, deps.jobs);
    if (!job) return;
    const status = exportStatus(job);
    const done = (job.events as ExportEvent[]).filter((e) => e.event === 'exported').pop();
    const zip = done ? resolve(String(done.zip || '')) : '';
    const outDir = String(job.params.out_dir || '');
    if (job.status !== 'done' || !zip || !outDir || !pathIsWithin(zip, resolve(outDir)) || !existsSync(zip)) {
      return ctx.sendJson(404, { ok: false, error: status.error || 'The export is not ready, or it was cleaned up. Export again.' });
    }
    const name = status.file_name || 'results.zip';
    const size = statSync(zip).size;
    ctx.res.statusCode = 200;
    ctx.res.setHeader('Content-Type', 'application/zip');
    ctx.res.setHeader('Content-Length', String(size));
    ctx.res.setHeader('Cache-Control', 'no-store');
    ctx.res.setHeader(
      'Content-Disposition',
      `attachment; filename="${safeExportName(name)}"; filename*=UTF-8''${encodeURIComponent(name)}`,
    );
    if (ctx.method === 'HEAD') {
      ctx.res.end();
      return;
    }
    return new Promise<void>((done2) => {
      const stream = createReadStream(zip);
      stream.on('error', () => {
        ctx.res.destroy();
        done2();
      });
      stream.on('end', () => done2());
      stream.pipe(ctx.res);
    });
  });

  router.post('/api/results/open-folder', async (ctx) => {
    const body = await ctx.readJsonBody();
    const checked = checkedCase(ctx.scope.projectId, body.case);
    if (!checked.ok) return ctx.sendJson(checked.status, { ok: false, error: checked.error });
    if (!isLocalOperator(ctx.req)) {
      return ctx.sendJson(403, { ok: false, error: 'Opening a folder only works on the PC running Magnusim.' });
    }
    try {
      openFolder(checked.caseDir);
    } catch (err) {
      return ctx.sendJson(500, { ok: false, error: `Could not open the folder: ${String((err as Error)?.message || err)}` });
    }
    ctx.sendJson(200, { ok: true, case: checked.caseDir, foam: existsSync(join(checked.caseDir, 'case.foam')) });
  });
}
