import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RunState } from '../legacyBridge';
import { ContinueRun, continueHint } from './RunControl';
import { askRunContinue } from '../../workbench/runContinueChoice';
import { confirmAction } from '../../workbench/dialogs';
import { continueAskWords } from '../../workbench/runHealthWords';
import { continueNumericsWords, numericsDiff } from '../../workbench/runReopen';

// The questions Continue asks (RH1's from_zero one, RH3's numerics one), answered by the test.
vi.mock('../../workbench/runContinueChoice', () => ({ askRunContinue: vi.fn() }));
vi.mock('../../workbench/dialogs', async (orig) => ({ ...(await orig<typeof import('../../workbench/dialogs')>()), confirmAction: vi.fn() }));

// F6: Continue on a finished or stopped run (RunControl's ContinueRun).
type Cont = NonNullable<RunState['cont']>;

function state(cont: Partial<Cont>): RunState {
  return {
    run_id: 'r1',
    cont: { visible: true, enabled: true, transient: false, from: 100, value: 100, write_interval: 50, reason: '', ...cont },
  } as unknown as RunState;
}

let go: ReturnType<typeof vi.fn>;
beforeEach(() => {
  go = vi.fn(async () => ({}));
  window.__CFD_SIM_CONTINUE__ = go;
});
afterEach(() => {
  cleanup();
  delete window.__CFD_SIM_CONTINUE__;
});

const amount = () => screen.getByRole('spinbutton') as HTMLInputElement;
const button = () => screen.getByRole('button', { name: 'Continue' }) as HTMLButtonElement;

describe('Continue a run', () => {
  it('a steady run: N more iterations (its last count by default) from its last saved result', () => {
    render(<ContinueRun state={state({})} scope="p:proj" onError={() => {}} />);
    expect(screen.getByText('Run')).toBeTruthy();
    expect(screen.getByText('more iterations')).toBeTruthy();
    expect(amount().value).toBe('100');
    expect(screen.getByText('Continues from the last saved result, iteration 100, to iteration 200.')).toBeTruthy();
    fireEvent.change(amount(), { target: { value: '30' } });
    fireEvent.click(button());
    expect(go).toHaveBeenCalledWith({ extra_iterations: 30 });
  });

  it('says which iteration is saved last when the count is not a whole number of write intervals', () => {
    render(<ContinueRun state={state({ value: 120 })} scope="p:proj" onError={() => {}} />);
    expect(
      screen.getByText(
        'Continues from the last saved result, iteration 100, to iteration 220. Results are saved every 50 iterations, so the last one saved is iteration 200.',
      ),
    ).toBeTruthy();
  });

  it('a transient run: on to a later end time (seconds)', () => {
    render(<ContinueRun state={state({ transient: true, from: 1, value: 2, write_interval: null })} scope="p:proj" onError={() => {}} />);
    expect(screen.getByText('Run on to t =')).toBeTruthy();
    expect(screen.getByText('s')).toBeTruthy();
    expect(screen.getByText('Continues from the last saved result, t = 1 s.')).toBeTruthy();
    fireEvent.change(amount(), { target: { value: '0.5' } });
    expect(button().disabled).toBe(true);
    expect(screen.getByRole('alert').textContent).toBe('Enter an end time after t = 1 s.');
    fireEvent.change(amount(), { target: { value: '3.5' } });
    fireEvent.click(button());
    expect(go).toHaveBeenCalledWith({ end_time: 3.5 });
  });

  it('not a whole number of iterations: Continue is off and says why', () => {
    render(<ContinueRun state={state({})} scope="p:proj" onError={() => {}} />);
    fireEvent.change(amount(), { target: { value: '2.5' } });
    expect(button().disabled).toBe(true);
    expect(screen.getByRole('alert').textContent).toBe('Enter a whole number of iterations, 1 or more.');
  });

  it('a case folder with no saved result: shown off, with the reason', () => {
    const why = "This run can't continue: its case folder has no saved result. Add a run to solve again.";
    render(<ContinueRun state={state({ enabled: false, from: null, reason: why })} scope="p:proj" onError={() => {}} />);
    expect(button().disabled).toBe(true);
    expect(screen.getByText(why)).toBeTruthy();
  });

  it('another job runs: Continue queues the run, as Start does', () => {
    render(<ContinueRun state={state({ queue: true })} scope="p:proj" onError={() => {}} />);
    const add = screen.getByRole('button', { name: 'Add to queue' }) as HTMLButtonElement;
    expect(add.disabled).toBe(false);
    expect(
      screen.getByText(
        'Continues from the last saved result, iteration 100, to iteration 200. A job is running: this run continues when that job finishes.',
      ),
    ).toBeTruthy();
    fireEvent.click(add);
    expect(go).toHaveBeenCalledWith({ extra_iterations: 100 });
  });

  it('nothing for a run that cannot continue (a draft, a running run)', () => {
    const { container } = render(<ContinueRun state={state({ visible: false })} scope="p:proj" onError={() => {}} />);
    expect(container.innerHTML).toBe('');
  });

  it('the hint texts', () => {
    const c = state({}).cont as Cont;
    expect(continueHint({ ...c, from: null }, 10, true)).toBe('');
    expect(continueHint(c, 0, false)).toBe('Continues from the last saved result, iteration 100.');
    expect(continueHint(c, 40, true)).toBe('Continues from the last saved result, iteration 100, to iteration 140.');
  });

  it('a converged run: N more iterations past convergence, its stops off for that part', () => {
    render(<ContinueRun state={state({ past_convergence: true })} scope="p:proj" onError={() => {}} />);
    const row = document.querySelector('[data-run-continue="1"] .sim-run-row') as HTMLElement;
    expect(row.textContent).toContain('Run');
    expect(row.textContent).toContain('more iterations past convergence');
    expect(screen.getByText(
      'Continues from the last saved result, iteration 100, to iteration 200. The residual targets and the settle stop are off for this part: it runs every iteration.',
    )).toBeTruthy();
    fireEvent.click(button());
    expect(go).toHaveBeenCalledWith({ extra_iterations: 100 });
  });

  it('a converged transient run: runs on past convergence, its settle stop off', () => {
    render(<ContinueRun state={state({ past_convergence: true, transient: true, from: 1, value: 2, write_interval: null })} scope="p:proj" onError={() => {}} />);
    expect(screen.getByText('Run on past convergence to t =')).toBeTruthy();
    expect(screen.getByText('Continues from the last saved result, t = 1 s. The settle stop is off for this part: it runs to the new end time.')).toBeTruthy();
  });
});

// RH3 (run health spec 5.3): once the study's numerics differ from what the run started with, the
// Continue box says what changed and Continue asks which numerics it goes on with; Cancel posts
// nothing. A run whose saved results come after it became unhealthy (from_zero) gets ONE question,
// its health first, never RH1's confirm and then this one.
describe('Continue after a study numerics change', () => {
  const SCHEMA = { type: 'object', properties: { relax_p: { type: 'number', title: 'Relaxation p' } } };
  const RUN = {
    name: 'Run_2',
    status: 'stopped',
    time_dependency: 'Steady-state',
    continue_from: 100,
    numerics_used: { analysis: 'incompressible_steady', mode: 'steady', at: 'x', values: { relax_p: 0.3 } },
  };
  const differences = numericsDiff(RUN, { relax_p: 0.2 }, SCHEMA);
  const words = continueNumericsWords(RUN, differences);
  const numerics = { differences, text: "The study's numerics changed after \"Run_2\" started: Relaxation p 0.3 → 0.2.", words };
  const ask = vi.mocked(askRunContinue);
  const confirm = vi.mocked(confirmAction);
  beforeEach(() => {
    ask.mockReset();
    confirm.mockReset();
  });
  const tick = () => new Promise((r) => setTimeout(r, 0));

  it('the box says what changed; Continue asks first, and goes on with the answer or not at all', async () => {
    render(<ContinueRun state={state({ numerics })} scope="p:proj" onError={() => {}} />);
    expect(screen.getByText(numerics.text).getAttribute('data-run-continue-numerics')).toBe('1');
    ask.mockResolvedValueOnce(null);
    fireEvent.click(button());
    await tick();
    expect(ask).toHaveBeenCalledWith({ ...words, health: '' });
    expect(go).not.toHaveBeenCalled();
    ask.mockResolvedValueOnce('new');
    fireEvent.click(button());
    await tick();
    expect(go).toHaveBeenCalledWith({ extra_iterations: 100, numerics: 'new' });
    ask.mockResolvedValueOnce('as_was');
    fireEvent.click(button());
    await tick();
    expect(go).toHaveBeenLastCalledWith({ extra_iterations: 100, numerics: 'as_was' });
    expect(confirm).not.toHaveBeenCalled();
  });

  it('nothing differs: no line, and Continue asks nothing', async () => {
    render(<ContinueRun state={state({ numerics: null })} scope="p:proj" onError={() => {}} />);
    expect(document.querySelector('[data-run-continue-numerics]')).toBeNull();
    fireEvent.click(button());
    await tick();
    expect([ask.mock.calls.length, confirm.mock.calls.length]).toEqual([0, 0]);
    expect(go).toHaveBeenCalledWith({ extra_iterations: 100 });
  });

  it("with from_zero too: one question, the health copy first; RH1's confirm is not asked", async () => {
    const health = {
      v: 1,
      verdict: 'unhealthy',
      unit: 'iteration',
      t: 60,
      first_unhealthy: { t: 40, step: 40 },
      restart: 'from_zero',
      findings: [],
    };
    const s = {
      ...state({ numerics }),
      name: 'Run_2',
      status: 'stopped',
      transient: false,
      health,
      health_run: { status: 'stopped', stopping: false, saved: 100, attempts: [], continue_changes: [] },
    } as unknown as RunState;
    render(<ContinueRun state={s} scope="p:proj" onError={() => {}} />);
    const copy = continueAskWords({ name: 'Run_2', status: 'stopped', stopping: false, saved: 100, transient: false, continues: false }, health as never).copy;
    expect(copy).toMatch(/after it became unhealthy/);
    ask.mockResolvedValueOnce(null);
    fireEvent.click(button());
    await tick();
    expect(ask).toHaveBeenCalledTimes(1);
    expect(ask).toHaveBeenCalledWith({ ...words, health: copy });
    expect(confirm).not.toHaveBeenCalled();
    expect(go).not.toHaveBeenCalled();
    // Without a numerics change, the from_zero question is RH1's confirm, as before.
    cleanup();
    render(<ContinueRun state={{ ...s, cont: { ...s.cont, numerics: null } } as RunState} scope="p:proj" onError={() => {}} />);
    confirm.mockResolvedValueOnce(true);
    fireEvent.click(button());
    await tick();
    expect([ask.mock.calls.length, confirm.mock.calls.length]).toEqual([1, 1]);
    expect(go).toHaveBeenCalledWith({ extra_iterations: 100 });
  });
});
