import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { RunState } from '../legacyBridge';
import { RunHealth } from './RunHealth';

// RH1: the Run panel's Health block (spec 3.10).
const IDS = { project_id: 'p1', simulation_id: 's1' };
const FIX = { label: 'New run: 3 outer correctors, Max Courant 5', target: 'new_run', values: [{ key: 'transient.max_co', value: 5 }], cost: { steps: 177_878, wall_s: 308_946 } };

function state(extra: Partial<RunState> = {}, health: Record<string, unknown> | null = null): RunState {
  return {
    run_id: 'r1',
    name: 'Run_2',
    status: 'running',
    transient: true,
    warnings: [],
    health,
    health_checked: true,
    health_run: { status: 'running', stopping: false, saved: null, attempts: [], continue_changes: [] },
    ...extra,
  } as unknown as RunState;
}

function record(extra: Record<string, unknown> = {}) {
  return {
    v: 1,
    verdict: 'unhealthy',
    unit: 'time step',
    window: 50,
    t: 0.0188,
    at: new Date().toISOString(),
    live: true,
    first_unhealthy: { t: 0.0069061069, step: 25, wall_s: 15 },
    restart: 'from_zero',
    findings: ['velocity_clipped', 'pv_coupling', 'turbulence_bounded', 'speed_growth', 'solver_at_limit', 'courant_mode'].map((code, i) => ({
      code,
      level: i < 5 ? 'error' : 'warn',
      text: `Finding ${code}`,
      evidence: { line: 700 + i, log_at: 1000 * i, key: 'abcdef012345' },
      ...(i === 0 ? { fix: [FIX] } : {}),
    })),
    ...extra,
  };
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const chip = () => document.querySelector('[data-run-health]') as HTMLElement;

describe('the Health block', () => {
  it('the verdict, its title, the subline with the onset, three findings then "Show all 6"', () => {
    render(<RunHealth state={state({}, record())} ids={IDS} />);
    expect(chip().textContent).toBe('Unhealthy');
    expect(chip().getAttribute('data-run-health')).toBe('unhealthy');
    expect(chip().title).toMatch(/^Stability problems found in the last 50 time steps/);
    expect(document.querySelector('[data-run-health-subline]')?.textContent).toMatch(/^Last 50 time steps, up to t = 0\.019 s · updated \d+ s ago · Unhealthy since t = 0\.0069 s \(15 s into the solve\)$/);
    expect(document.querySelectorAll('[data-run-health-finding]').length).toBe(3);
    fireEvent.click(screen.getByText('Show all 6'));
    expect(document.querySelectorAll('[data-run-health-finding]').length).toBe(6);
    expect(document.querySelector('[data-run-health-finding="velocity_clipped"] [data-run-health-text]')?.textContent).toBe('Finding velocity_clipped');
  });

  it('while it solves: a plain Stop and the new-run fix with its cost; no Continue sentence', () => {
    render(<RunHealth state={state({}, record())} ids={IDS} />);
    expect(screen.getByText('Stop this run')).toBeTruthy();
    expect(document.querySelector('[data-run-health-newrun="0"]')?.textContent).toBe('New run: 3 outer correctors, Max Courant 5 (~180,000 steps, about 4 days)');
    expect(document.querySelector('[data-run-health-next]')).toBeNull();
  });

  it('a stopped run says where Continue would go on from', () => {
    const s = state({ status: 'stopped', health_run: { status: 'stopped', stopping: false, saved: 0.1667, attempts: [], continue_changes: [] } }, record({ live: false }));
    render(<RunHealth state={s} ids={IDS} />);
    expect(document.querySelector('[data-run-health-next]')?.textContent).toMatch(/^Its saved results \(from t = 0\.167 s\) come after the problem began/);
    expect(screen.queryByText('Stop this run')).toBeNull();
  });

  it('steady words: iterations', () => {
    render(<RunHealth state={state({ transient: false }, record({ verdict: 'healthy', unit: 'iteration', window: 12, t: 17, findings: [] }))} ids={IDS} />);
    expect(chip().textContent).toBe('Healthy');
    expect(chip().title).toBe(
      'No stability problems found in the last 12 iterations. This does not check mesh independence or whether the residuals have reached their targets.',
    );
    expect(document.querySelector('[data-run-health-subline]')?.textContent).toMatch(/^Last 12 iterations, up to iteration 17/);
  });

  it('checking, not checked, ran before checks existed, stale', () => {
    const { unmount } = render(<RunHealth state={state({}, null)} ids={IDS} />);
    expect(chip().textContent).toBe('Checking (needs 6 time steps)');
    unmount();
    const b = render(<RunHealth state={state({ health_checked: false }, null)} ids={IDS} />);
    expect(screen.getByText('Health is not checked for this kind of run.')).toBeTruthy();
    b.unmount();
    const old = state({ status: 'done', health_checked: null, health_run: { status: 'done', stopping: false, saved: 0.1, attempts: [], continue_changes: [] } }, null);
    const c = render(<RunHealth state={old} ids={IDS} />);
    expect(screen.getByText('This run ran before health checks existed.')).toBeTruthy();
    expect(screen.getByText('Check its log')).toBeTruthy();
    c.unmount();
    render(<RunHealth state={state({}, record({ stale: true, t: 0.18 }))} ids={IDS} />);
    expect(document.querySelector('[data-run-health-subline]')?.textContent).toMatch(/ · details from t = 0\.18 s \(the latest check was too large to keep\)$/);
  });

  it('an ended run is never "Checking": not judged, failed before its solver, or not recorded', () => {
    const ended = (status: string, n_steps: number | null) => ({ status, health_run: { status, stopping: false, saved: null, n_steps, attempts: [], continue_changes: [] } });
    // A pending record on a stopped run: "Not judged", and why.
    const pending = record({ verdict: 'pending', window: 0, t: 0.0002, live: false, first_unhealthy: null, restart: null, findings: [] });
    const a = render(<RunHealth state={state(ended('stopped', 2), pending)} ids={IDS} />);
    expect(chip().textContent).toBe('Not judged');
    expect(document.querySelector('[data-run-health-subline]')?.textContent).toBe('It ended before its health could be judged (from the 6th time step on)');
    a.unmount();
    // No record: a Start that failed before its solver; a long run whose health was not recorded.
    const b = render(<RunHealth state={state(ended('failed', null), null)} ids={IDS} />);
    expect(document.querySelector('[data-run-health-none]')?.textContent).toBe('It failed before its solver started, so there is no solver output to check.');
    expect(chip()).toBeNull();
    b.unmount();
    render(<RunHealth state={state(ended('done', 5000), null)} ids={IDS} />);
    expect(document.querySelector('[data-run-health-none]')?.textContent).toBe('Its health was not recorded.');
    expect(screen.queryByText('This run ran before health checks existed.')).toBeNull();
  });

  it('"Check its log" asks the server and shows "Checking its log…" while it runs', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true, checking: true, health: null }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const old = state({ status: 'done', health_checked: null, health_run: { status: 'done', stopping: false, saved: 0.1, attempts: [], continue_changes: [] } }, null);
    render(<RunHealth state={old} ids={IDS} />);
    fireEvent.click(screen.getByText('Check its log'));
    expect(await screen.findByText('Checking its log…')).toBeTruthy();
    expect(String(fetchMock.mock.calls[0][0])).toMatch(/^\/api\/run\/health\?.*recompute=1/);
  });
});
