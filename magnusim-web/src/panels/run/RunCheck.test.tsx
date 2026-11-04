import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RunCheckRow, RunState } from '../legacyBridge';
import { RunCheck } from './RunCheck';

afterEach(cleanup);

const PISO: RunCheckRow = {
  code: 'piso_high_co',
  level: 'warn',
  text: 'Max Courant 100 with 1 outer corrector.',
  fix: { label: '3 outer correctors, Max Courant 5', target: 'run', values: [{ key: 'transient.n_outer_correctors', value: 3 }, { key: 'transient.max_co', value: 5 }], cost: { steps: 180000, wall_s: 315000 } },
  alt: { label: 'Max Courant 1', target: 'run', values: [{ key: 'transient.max_co', value: 1 }], cost: { steps: 900000, wall_s: 525000 } },
};
const AVG: RunCheckRow = { code: 'average_startup', level: 'warn', text: 'Mean velocity and Mean pressure average from 0 s.', fix: { label: 'Average from 0.6667 s', target: 'run', values: [{ key: 'transient.average_from', value: 0.6667 }] } };
const MESH: RunCheckRow = { code: 'quality_unknown', level: 'info', text: 'This mesh has no quality numbers.', fix: null };

function state(extra: Partial<RunState> = {}): RunState {
  return {
    has_run: true,
    run_id: 'r1',
    name: 'Run_2',
    status: 'draft',
    transient: true,
    locked: false,
    precheck: { ok: true, checked: true, checks: [PISO, AVG, MESH], estimate: { line: 'Δt ≈ 1.1e-5 s at Max Courant 1 · ~900,000 steps' } },
    checks_kept: [],
    ...extra,
  } as unknown as RunState;
}

describe('Before you start (RH2)', () => {
  beforeEach(() => {
    window.__CFD_RUN_CHECK_APPLY__ = vi.fn(async () => ({ ok: true }));
    window.__CFD_RUN_CHECK_KEEP__ = vi.fn(async () => ({ ok: true }));
    window.__CFD_RUN_CHECK_UNKEEP__ = vi.fn(async () => ({ ok: true }));
    window.__CFD_RUN_CHECK_AGAIN__ = vi.fn();
  });

  it('shows the estimate line and each row with its Apply, its alternative and Keep as set; a row without a fix has no button', () => {
    render(<RunCheck state={state()} onError={() => {}} />);
    expect(screen.getByText('Before you start')).toBeInTheDocument();
    expect(screen.getByText('Δt ≈ 1.1e-5 s at Max Courant 1 · ~900,000 steps')).toBeInTheDocument();
    const row = document.querySelector('[data-run-check-row="piso_high_co"]') as HTMLElement;
    expect(row.getAttribute('data-level')).toBe('warn');
    expect(row.querySelector('[data-run-check-apply="piso_high_co"]')).toHaveTextContent('Use 3 outer correctors, Max Courant 5');
    expect(row.querySelector('[data-run-check-alt="piso_high_co"]')).toHaveTextContent('Max Courant 1 (about 6 days)');
    expect(row.querySelector('[data-run-check-keep="piso_high_co"]')).toHaveTextContent('Keep as set');
    // No dead button: a row the app has no setting for has none.
    expect(document.querySelector('[data-run-check-apply="quality_unknown"]')).toBeNull();
    // Two fixable rows: Apply all.
    expect(document.querySelector('[data-run-check-apply-all="1"]')).toHaveTextContent('Apply all');
  });

  it('Apply, the alternative, Apply all, Keep as set and Check again call the runtime', async () => {
    render(<RunCheck state={state()} onError={() => {}} />);
    fireEvent.click(document.querySelector('[data-run-check-apply="piso_high_co"]')!);
    await waitFor(() => expect(window.__CFD_RUN_CHECK_APPLY__).toHaveBeenCalledWith(PISO.fix));
    fireEvent.click(document.querySelector('[data-run-check-alt="piso_high_co"]')!);
    await waitFor(() => expect(window.__CFD_RUN_CHECK_APPLY__).toHaveBeenCalledWith(PISO.alt));
    fireEvent.click(document.querySelector('[data-run-check-apply-all="1"]')!);
    await waitFor(() => expect(window.__CFD_RUN_CHECK_APPLY__).toHaveBeenCalledWith([PISO.fix, AVG.fix]));
    fireEvent.click(document.querySelector('[data-run-check-keep="piso_high_co"]')!);
    await waitFor(() => expect(window.__CFD_RUN_CHECK_KEEP__).toHaveBeenCalledWith('piso_high_co'));
    fireEvent.click(screen.getByText('Check again'));
    expect(window.__CFD_RUN_CHECK_AGAIN__).toHaveBeenCalled();
  });

  it('a kept row moves under "Kept (n)" with Undo keep; one fixable row left: no Apply all', async () => {
    render(<RunCheck state={state({ checks_kept: ['piso_high_co'] })} onError={() => {}} />);
    expect(document.querySelector('[data-run-check-row="piso_high_co"]')).toBeNull();
    expect(screen.getByText('Kept (1)')).toBeInTheDocument();
    expect(document.querySelector('[data-run-check-kept-row="piso_high_co"]')).toHaveTextContent('Max Courant 100 with 1 outer corrector.');
    expect(document.querySelector('[data-run-check-apply-all="1"]')).toBeNull();
    const undo = document.querySelector('[data-run-check-unkeep="piso_high_co"]') as HTMLElement;
    expect(undo).toHaveTextContent('Undo keep');
    fireEvent.click(undo);
    await waitFor(() => expect(window.__CFD_RUN_CHECK_UNKEEP__).toHaveBeenCalledWith('piso_high_co'));
  });

  it("what is kept is the run's list as the panel shows it, not the last answer's", () => {
    // The answer was checked while piso_high_co was kept; the person has since undone it.
    const answered = { ok: true, checked: true, checks: [{ ...PISO, kept: true }, AVG], estimate: { line: 'x' } };
    render(<RunCheck state={state({ precheck: answered, checks_kept: [] } as Partial<RunState>)} onError={() => {}} />);
    expect(document.querySelector('[data-run-check-row="piso_high_co"]')).not.toBeNull();
    expect(document.querySelector('[data-run-check-kept="1"]')).toBeNull();
  });

  it('Apply all applies only the problems and warnings shown, and says what it changes', async () => {
    const STILL: RunCheckRow = { code: 'still_start', level: 'info', text: 'The run starts from rest.', fix: { label: 'Start from potential flow', target: 'study', values: [{ key: 'potential_flow', value: true }] } };
    const warns = [0, 1, 2, 3, 4, 5].map((i) => ({ ...AVG, code: 'w' + i, fix: { ...AVG.fix!, label: 'Fix ' + i, values: [{ key: 'transient.k' + i, value: i }] } }));
    // Seven warnings and a note: six shown, the seventh and the note left out.
    const many = { ok: true, checked: true, checks: [...warns, { ...AVG, code: 'w6' }, STILL], estimate: { line: 'x' } };
    render(<RunCheck state={state({ precheck: many } as Partial<RunState>)} onError={() => {}} />);
    const all = document.querySelector('[data-run-check-apply-all="1"]') as HTMLElement;
    expect(all.getAttribute('title')).toBe('Applies Fix 0; Fix 1; Fix 2; Fix 3; Fix 4; Fix 5');
    fireEvent.click(all);
    await waitFor(() => expect(window.__CFD_RUN_CHECK_APPLY__).toHaveBeenCalledWith(warns.map((w) => w.fix)));
  });

  it('a check of the run settings only says so, and never "nothing found in its mesh or physics"', () => {
    const partial = {
      ok: true,
      checked: true,
      checks: [],
      estimate: { line: 'No time-step estimate until the mesh is generated', complete: false, unchecked: 'its mesh and physics are checked once the mesh is generated' },
    };
    render(<RunCheck state={state({ precheck: partial } as Partial<RunState>)} onError={() => {}} />);
    expect(document.querySelector('[data-run-check-partial="1"]')).toHaveTextContent(
      'Only its run settings were checked: its mesh and physics are checked once the mesh is generated.',
    );
    expect(document.querySelector('[data-run-check-none="1"]')).toHaveTextContent('Nothing found in its run settings.');
    expect(screen.queryByText(/mesh or physics/)).toBeNull();
  });

  it('only for a draft; while it checks it says so', () => {
    const { rerender } = render(<RunCheck state={state({ status: 'running', locked: true })} onError={() => {}} />);
    expect(document.querySelector('[data-run-check="1"]')).toBeNull();
    rerender(<RunCheck state={state({ precheck: null, precheck_busy: true })} onError={() => {}} />);
    expect(screen.getByText('Checking…')).toBeInTheDocument();
    rerender(<RunCheck state={state({ precheck: { ok: true, checked: false, checks: [] } })} onError={() => {}} />);
    expect(document.querySelector('[data-run-check="1"]')).toBeNull();
  });
});
