import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FOLDER_OPENED, VtkExport, formatBytes, frameLabel } from './VtkExport';

type Call = { url: string; method: string; body: Record<string, unknown> | null };

const CTX = {
  project_id: 'proj-a',
  case_dir: 'C:\\p\\proj-a\\runs\\Run 1\\case',
  time: '0.5',
  times: ['0', '0.1', '0.5'],
  seconds: true,
};

function reply(status: number, body: unknown) {
  return Promise.resolve(new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } }));
}

/** fetch answers: POST start, then each status poll in turn (the last repeats). */
function serve(start: [number, unknown], polls: unknown[], extra: Record<string, [number, unknown]> = {}) {
  const calls: Call[] = [];
  let poll = 0;
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string, init?: RequestInit) => {
      const method = String(init?.method || 'GET');
      calls.push({ url, method, body: init?.body ? JSON.parse(String(init.body)) : null });
      for (const [prefix, answer] of Object.entries(extra)) if (url.startsWith(prefix)) return reply(...answer);
      if (method === 'POST' && url === '/api/results/export-vtk') return reply(...start);
      const body = polls[Math.min(poll, polls.length - 1)];
      poll += 1;
      return reply(200, body);
    }),
  );
  return calls;
}

const status = (over: Record<string, unknown>) => ({
  ok: true,
  job_id: 'job-1',
  status: 'running',
  fraction: 0,
  message: '',
  error: null,
  file_name: null,
  bytes: null,
  times: [],
  fields: [],
  units_note: null,
  ...over,
});

function toolbarButton() {
  const btn = document.createElement('button');
  btn.id = 'btn-export-vtk';
  document.body.appendChild(btn);
  return btn;
}

describe('Export to ParaView (VTK)', () => {
  let clicks: string[];
  beforeEach(() => {
    clicks = [];
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
      clicks.push(`${this.getAttribute('href')} as ${this.download}`);
    });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    delete window.__CFD_RESULTS_ON_SCREEN__;
    document.body.innerHTML = '';
  });

  it('names the frame by time or iteration and sizes in plain units', () => {
    expect(frameLabel('0.5', true)).toBe('t = 0.5 s');
    expect(frameLabel('500', false)).toBe('iteration 500');
    expect(formatBytes(78042)).toBe('76 kB');
    expect(formatBytes(5 * 1024 * 1024)).toBe('5.0 MB');
    expect(formatBytes(null)).toBe('');
  });

  it('says to open results first when none are on screen', () => {
    render(<VtkExport />);
    fireEvent.click(toolbarButton());
    expect(screen.getByRole('dialog')).toHaveTextContent("Open a run's results first");
    expect(screen.getByRole('button', { name: 'Export' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Open case folder' })).toBeDisabled();
  });

  it('exports the frame on screen with progress, then downloads the zip', async () => {
    window.__CFD_RESULTS_ON_SCREEN__ = () => CTX;
    const calls = serve(
      [202, status({ status: 'queued', message: 'Starting' })],
      [
        status({ fraction: 0.45, message: 'Writing the frame' }),
        status({
          status: 'done',
          fraction: 1,
          message: 'Done',
          file_name: 'Run_1-vtk-0.5.zip',
          bytes: 78042,
          units_note: "p_Pa: OpenFOAM's p (m^2/s^2) x density 1000 kg/m^3, in Pa.",
        }),
      ],
    );
    render(<VtkExport />);
    fireEvent.click(toolbarButton());
    const current = screen.getByLabelText(/The frame on screen/);
    expect(current).toBeChecked();
    expect(current.parentElement).toHaveTextContent('The frame on screen (t = 0.5 s)');
    expect(screen.getByLabelText(/All saved frames/).parentElement).toHaveTextContent('All saved frames (3)');
    fireEvent.click(screen.getByRole('button', { name: 'Export' }));
    expect(calls[0]).toEqual({
      url: '/api/results/export-vtk',
      method: 'POST',
      body: { project_id: 'proj-a', case: CTX.case_dir, frames: 'current', time: '0.5' },
    });
    await waitFor(() => expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '45'));
    expect(screen.getByText('Writing the frame (45 %)')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Export' })).toBeDisabled();
    await waitFor(() => expect(document.getElementById('vtk-export-done')).not.toBeNull());
    expect(document.getElementById('vtk-export-done')).toHaveTextContent(
      "Saved Run_1-vtk-0.5.zip (76 kB). p_Pa: OpenFOAM's p (m^2/s^2) x density 1000 kg/m^3, in Pa.",
    );
    expect(clicks).toEqual(['/api/results/export-vtk/job-1/file?project_id=proj-a as Run_1-vtk-0.5.zip']);
    expect(calls[1].url).toBe('/api/results/export-vtk/job-1?project_id=proj-a');
  });

  it('says why an export could not start or failed, in the server words', async () => {
    window.__CFD_RESULTS_ON_SCREEN__ = () => CTX;
    serve([404, { ok: false, error: 'The frame on screen is not saved in this run.' }], []);
    render(<VtkExport />);
    fireEvent.click(toolbarButton());
    fireEvent.click(screen.getByLabelText(/All saved frames/));
    fireEvent.click(screen.getByRole('button', { name: 'Export' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('The frame on screen is not saved in this run.');
    expect(screen.getByRole('button', { name: 'Export' })).toBeEnabled();

    serve([202, status({})], [status({ status: 'failed', error: "The run's case has no mesh (constant/polyMesh is missing)." })]);
    fireEvent.click(screen.getByRole('button', { name: 'Export' }));
    await waitFor(() =>
      expect(screen.getByRole('alert')).toHaveTextContent("The run's case has no mesh (constant/polyMesh is missing)."),
    );
    expect(clicks).toEqual([]);
  });

  it('keeps exporting after Close and says when the zip is saved', async () => {
    window.__CFD_RESULTS_ON_SCREEN__ = () => CTX;
    const toasts: unknown[] = [];
    const onToast = (e: Event) => toasts.push((e as CustomEvent).detail);
    window.addEventListener('cfd:toast', onToast);
    serve(
      [202, status({})],
      [status({ fraction: 0.2, message: 'Reading frame 1 of 3' }), status({ status: 'done', fraction: 1, file_name: 'Run_1-vtk-all-frames.zip', bytes: 10 })],
    );
    render(<VtkExport />);
    fireEvent.click(toolbarButton());
    fireEvent.click(screen.getByRole('button', { name: 'Export' }));
    await screen.findByRole('progressbar');
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    await waitFor(() => expect(clicks).toHaveLength(1));
    expect(toasts).toEqual([{ message: 'Saved Run_1-vtk-all-frames.zip.', kind: 'success' }]);
    window.removeEventListener('cfd:toast', onToast);
  });

  it('cancels a running export', async () => {
    window.__CFD_RESULTS_ON_SCREEN__ = () => CTX;
    const calls = serve([202, status({})], [status({ fraction: 0.1, message: 'Reading the frame' })], {
      '/api/jobs/': [200, { ok: true }],
    });
    render(<VtkExport />);
    fireEvent.click(toolbarButton());
    fireEvent.click(screen.getByRole('button', { name: 'Export' }));
    await screen.findByRole('progressbar');
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Cancel export' }));
    });
    expect(calls.some((c) => c.method === 'POST' && c.url === '/api/jobs/job-1/stop?project_id=proj-a')).toBe(true);
    expect(await screen.findByText('Export cancelled.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Export' })).toBeEnabled();
  });

  it('opens the case folder from the dialog and from the Results panel', async () => {
    window.__CFD_RESULTS_ON_SCREEN__ = () => CTX;
    const calls = serve([500, {}], [], { '/api/results/open-folder': [200, { ok: true }] });
    const toasts: unknown[] = [];
    const onToast = (e: Event) => toasts.push((e as CustomEvent).detail);
    window.addEventListener('cfd:toast', onToast);
    render(<VtkExport />);
    fireEvent.click(toolbarButton());
    fireEvent.click(screen.getByRole('button', { name: 'Open case folder' }));
    expect(await screen.findByText(FOLDER_OPENED)).toBeInTheDocument();
    expect(calls[0]).toEqual({
      url: '/api/results/open-folder',
      method: 'POST',
      body: { project_id: 'proj-a', case: CTX.case_dir },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    const panelBtn = document.createElement('button');
    panelBtn.id = 'run-results-open-folder';
    document.body.appendChild(panelBtn);
    fireEvent.click(panelBtn);
    await waitFor(() => expect(toasts).toEqual([{ message: FOLDER_OPENED, kind: 'info' }]));
    window.removeEventListener('cfd:toast', onToast);
  });

  it('shows the Results panel row only while results are on screen', async () => {
    document.body.innerHTML =
      '<div id="panel-run-results"><div id="run-results-export"></div></div>';
    render(<VtkExport />);
    const row = document.getElementById('run-results-export')!;
    expect(row.hidden).toBe(true);
    window.__CFD_RESULTS_ON_SCREEN__ = () => CTX;
    await waitFor(() => expect(row.hidden).toBe(false), { timeout: 2000 });
  });
});
