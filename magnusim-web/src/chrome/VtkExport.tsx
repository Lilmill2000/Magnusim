import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * Export to ParaView (VTK) and Open case folder for the results on screen.
 *
 * Opened from the results toolbar (EXPORT > Export VTK) or the run's Results panel.
 * The export runs as a server job (scripts/server/vtk-export.ts): this dialog polls
 * its progress, so the app stays usable, and the zip downloads when it is ready
 * (also after the dialog was closed, with a toast). Errors are the server's sentences.
 */

export type OnScreen = {
  project_id: string;
  case_dir: string;
  time: string;
  times: string[];
  seconds: boolean;
};

export type ExportStatus = {
  job_id: string;
  status: 'queued' | 'running' | 'done' | 'failed' | 'stopped';
  fraction: number;
  message: string;
  error: string | null;
  file_name: string | null;
  bytes: number | null;
  units_note: string | null;
};

export const POLL_MS = 300;

/** The results on screen, or null when none are open. */
export function resultsOnScreen(): OnScreen | null {
  const read = window.__CFD_RESULTS_ON_SCREEN__;
  if (typeof read !== 'function') return null;
  try {
    const ctx = read();
    if (!ctx || !ctx.case_dir || !ctx.project_id || !Array.isArray(ctx.times) || !ctx.times.length) return null;
    return ctx;
  } catch {
    return null;
  }
}

/** How the frame on screen is named: a time for a transient run, else an iteration. */
export function frameLabel(time: string, seconds: boolean): string {
  return seconds ? `t = ${time} s` : `iteration ${time}`;
}

export function formatBytes(n: number | null): string {
  if (n == null || !Number.isFinite(n)) return '';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} kB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

export const FOLDER_OPENED =
  "The run's case folder is open in File Explorer. In ParaView, open case.foam there (File > Open).";

function toast(message: string, kind: 'info' | 'success' | 'error') {
  window.dispatchEvent(new CustomEvent('cfd:toast', { detail: { message, kind } }));
}

async function postJson(url: string, body: Record<string, unknown>) {
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  let json: Record<string, unknown> = {};
  try {
    json = (await r.json()) as Record<string, unknown>;
  } catch {
    json = {};
  }
  return { ok: r.ok, status: r.status, json };
}

function fileUrl(jobId: string, projectId: string) {
  return `/api/results/export-vtk/${encodeURIComponent(jobId)}/file?project_id=${encodeURIComponent(projectId)}`;
}

function download(url: string, name: string) {
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
}

/** Ask the server to show the case folder; returns the sentence to show. */
export async function openCaseFolder(ctx: OnScreen): Promise<{ ok: boolean; message: string }> {
  try {
    const r = await postJson('/api/results/open-folder', { project_id: ctx.project_id, case: ctx.case_dir });
    if (r.ok) return { ok: true, message: FOLDER_OPENED };
    return { ok: false, message: String(r.json.error || 'Could not open the case folder.') };
  } catch {
    return { ok: false, message: 'Could not reach the app to open the case folder.' };
  }
}

export function VtkExport() {
  const [open, setOpen] = useState(false);
  const [ctx, setCtx] = useState<OnScreen | null>(null);
  const [frames, setFrames] = useState<'current' | 'all'>('current');
  const [job, setJob] = useState<ExportStatus | null>(null);
  const [error, setError] = useState('');
  const [folderNote, setFolderNote] = useState('');
  const openRef = useRef(false);
  const jobRef = useRef<ExportStatus | null>(null);
  const timer = useRef<number>(0);
  const goRef = useRef<HTMLButtonElement | null>(null);
  openRef.current = open;
  jobRef.current = job;

  const running = !!job && (job.status === 'queued' || job.status === 'running');
  const hasCurrent = !!ctx && ctx.times.includes(ctx.time);

  const poll = useCallback((jobId: string, projectId: string) => {
    window.clearTimeout(timer.current);
    const tick = async () => {
      let s: ExportStatus | null = null;
      try {
        const r = await fetch(
          `/api/results/export-vtk/${encodeURIComponent(jobId)}?project_id=${encodeURIComponent(projectId)}`,
          { cache: 'no-store' },
        );
        const j = (await r.json()) as ExportStatus & { error?: string };
        if (!r.ok) {
          setJob(null);
          setError(String(j.error || 'The export was lost. Export again.'));
          return;
        }
        s = j;
      } catch {
        timer.current = window.setTimeout(tick, POLL_MS * 3);
        return;
      }
      setJob(s);
      if (s.status === 'done') {
        download(fileUrl(jobId, projectId), s.file_name || 'results.zip');
        if (!openRef.current) toast(`Saved ${s.file_name || 'the VTK export'}.`, 'success');
        return;
      }
      if (s.status === 'failed') {
        const msg = s.error || 'The export failed.';
        setError(msg);
        if (!openRef.current) toast(msg, 'error');
        return;
      }
      if (s.status === 'stopped') return;
      timer.current = window.setTimeout(tick, POLL_MS);
    };
    timer.current = window.setTimeout(tick, POLL_MS);
  }, []);

  useEffect(() => () => window.clearTimeout(timer.current), []);

  const show = useCallback(() => {
    const now = resultsOnScreen();
    setCtx(now);
    setFolderNote('');
    setOpen(true);
    const prev = jobRef.current;
    // An export still running stays on show; otherwise the dialog starts afresh.
    if (prev && (prev.status === 'queued' || prev.status === 'running')) return;
    setJob(null);
    setError('');
    setFrames(now && now.times.includes(now.time) ? 'current' : 'all');
  }, []);

  // The toolbar button, the Results panel's buttons.
  useEffect(() => {
    const onClick = (e: Event) => {
      const el = (e.target as HTMLElement | null)?.closest?.('#btn-export-vtk, #run-results-export-vtk, #run-results-open-folder');
      if (!el) return;
      if (el.id === 'run-results-open-folder') {
        const now = resultsOnScreen();
        if (!now) {
          toast("Open this run's results first.", 'info');
          return;
        }
        void openCaseFolder(now).then((r) => toast(r.message, r.ok ? 'info' : 'error'));
        return;
      }
      show();
    };
    document.addEventListener('click', onClick);
    return () => document.removeEventListener('click', onClick);
  }, [show]);

  // The Results panel offers the export only while its results are on screen.
  useEffect(() => {
    const panel = document.getElementById('panel-run-results');
    const row = document.getElementById('run-results-export');
    if (!panel || !row) return;
    let every = 0;
    const sync = () => {
      row.hidden = !resultsOnScreen();
    };
    const watch = () => {
      window.clearInterval(every);
      every = 0;
      sync();
      if (!panel.hidden) every = window.setInterval(sync, 700);
    };
    const mo = new MutationObserver(watch);
    mo.observe(panel, { attributes: true, attributeFilter: ['hidden'] });
    watch();
    return () => {
      mo.disconnect();
      window.clearInterval(every);
    };
  }, []);

  useEffect(() => {
    if (!open) return;
    goRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open]);

  const start = async () => {
    if (!ctx || running) return;
    setError('');
    setFolderNote('');
    setJob({
      job_id: '',
      status: 'queued',
      fraction: 0,
      message: 'Starting',
      error: null,
      file_name: null,
      bytes: null,
      units_note: null,
    });
    try {
      const r = await postJson('/api/results/export-vtk', {
        project_id: ctx.project_id,
        case: ctx.case_dir,
        frames,
        time: ctx.time,
      });
      if (!r.ok) {
        setJob(null);
        setError(String(r.json.error || `The export could not start (${r.status}).`));
        return;
      }
      const s = r.json as unknown as ExportStatus;
      setJob(s);
      poll(s.job_id, ctx.project_id);
    } catch {
      setJob(null);
      setError('Could not reach the app to start the export.');
    }
  };

  const cancel = async () => {
    if (!ctx || !job || !job.job_id) return;
    window.clearTimeout(timer.current);
    try {
      await fetch(
        `/api/jobs/${encodeURIComponent(job.job_id)}/stop?project_id=${encodeURIComponent(ctx.project_id)}`,
        { method: 'POST' },
      );
    } catch {
      /* the next poll says what happened */
    }
    setJob({ ...job, status: 'stopped', message: 'Cancelled' });
  };

  const folder = async () => {
    if (!ctx) return;
    const r = await openCaseFolder(ctx);
    setFolderNote(r.ok ? r.message : '');
    if (!r.ok) setError(r.message);
  };

  if (!open) return null;
  const pct = job ? Math.round(job.fraction * 100) : 0;
  const nFrames = ctx ? ctx.times.length : 0;
  return (
    <div id="modal-vtk-export" className="cfd-modal" role="dialog" aria-modal="true" aria-labelledby="vtk-heading">
      <div className="cfd-modal-backdrop" onClick={() => setOpen(false)} />
      <div className="cfd-modal-card vtk-export-card">
        <h2 id="vtk-heading">Export to ParaView (VTK)</h2>
        {!ctx ? (
          <p className="home-detail-desc" id="vtk-export-copy">
            Open a run&apos;s results first: the export saves the results on screen.
          </p>
        ) : (
          <>
            <fieldset className="vtk-export-frames" disabled={running}>
              <label>
                <input
                  type="radio"
                  id="vtk-frames-current"
                  name="vtk-frames"
                  checked={frames === 'current'}
                  disabled={!hasCurrent}
                  onChange={() => setFrames('current')}
                />{' '}
                The frame on screen{hasCurrent ? ` (${frameLabel(ctx.time, ctx.seconds)})` : ''}
              </label>
              <label>
                <input
                  type="radio"
                  id="vtk-frames-all"
                  name="vtk-frames"
                  checked={frames === 'all'}
                  onChange={() => setFrames('all')}
                />{' '}
                All saved frames ({nFrames})
              </label>
            </fieldset>
            <p className="home-detail-desc" id="vtk-export-copy">
              Saves a zip of VTK files: the mesh and each boundary, with every saved field as cell data.
              Pressure is in Pa, as Results shows it. Unzip it and open the .vtm (one frame) or the .pvd
              (all frames) in ParaView.
            </p>
          </>
        )}
        {job && running ? (
          <div className="vtk-export-status" id="vtk-export-status" aria-live="polite">
            <div
              className="vtk-export-bar"
              role="progressbar"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={pct}
            >
              <div className="vtk-export-bar-fill" style={{ width: `${pct}%` }} />
            </div>
            <span id="vtk-export-message">
              {job.message || 'Working'} ({pct} %)
            </span>
          </div>
        ) : null}
        {job && job.status === 'done' ? (
          <p className="home-detail-desc" id="vtk-export-done">
            Saved {job.file_name}
            {job.bytes != null ? ` (${formatBytes(job.bytes)})` : ''}.{job.units_note ? ` ${job.units_note}` : ''}
          </p>
        ) : null}
        {job && job.status === 'stopped' ? (
          <p className="home-detail-desc" id="vtk-export-stopped">
            Export cancelled.
          </p>
        ) : null}
        {error ? (
          <p className="vtk-export-error" id="vtk-export-error" role="alert">
            {error}
          </p>
        ) : null}
        {folderNote ? (
          <p className="home-detail-desc" id="vtk-folder-note">
            {folderNote}
          </p>
        ) : null}
        <div className="np-actions">
          <button type="button" className="home-btn vtk-export-folder" id="vtk-open-folder" disabled={!ctx} onClick={() => void folder()}>
            Open case folder
          </button>
          {running ? (
            <button type="button" className="home-btn" id="vtk-export-cancel" disabled={!job?.job_id} onClick={() => void cancel()}>
              Cancel export
            </button>
          ) : null}
          <button type="button" className="home-btn" id="vtk-export-close" onClick={() => setOpen(false)}>
            Close
          </button>
          <button
            type="button"
            className="home-btn home-btn-primary"
            id="vtk-export-go"
            ref={goRef}
            disabled={!ctx || running}
            onClick={() => void start()}
          >
            Export
          </button>
        </div>
      </div>
    </div>
  );
}
