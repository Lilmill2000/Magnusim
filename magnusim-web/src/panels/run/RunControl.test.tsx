import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RunState } from '../legacyBridge';
import { ContinueRun, continueHint } from './RunControl';

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
});
