import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../api/client', () => ({
  apiGet: vi.fn(async () => ({ ok: true, rank_cap: 4 })),
}));

import type { RegistryDescribe } from '../../api/registry.gen';
import { RunCores, runCanUseCores, useRankCap } from './RunCores';

afterEach(cleanup);

function options(): string[] {
  const select = screen.getByLabelText('Cores') as HTMLSelectElement;
  return Array.from(select.options).map((o) => o.textContent || '');
}

describe('RunCores', () => {
  it('offers Auto and 1 up to the cap, and says what Auto does', () => {
    render(<RunCores cores={null} locked={false} cap={4} onSave={() => {}} />);
    expect(options()).toEqual(['Auto', '1', '2', '3', '4']);
    expect((screen.getByLabelText('Cores') as HTMLSelectElement).value).toBe('auto');
    expect(screen.getByText('Auto: a small mesh runs on 1 core, a larger one on 4 cores.')).toBeInTheDocument();
  });

  it('saves a number, and Auto as null', () => {
    const onSave = vi.fn();
    const { rerender } = render(<RunCores cores={null} locked={false} cap={4} onSave={onSave} />);
    fireEvent.change(screen.getByLabelText('Cores'), { target: { value: '3' } });
    expect(onSave).toHaveBeenLastCalledWith(3);
    rerender(<RunCores cores={3} locked={false} cap={4} onSave={onSave} />);
    expect((screen.getByLabelText('Cores') as HTMLSelectElement).value).toBe('3');
    expect(screen.getByText('Runs on 3 cores, whatever the mesh size.')).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Cores'), { target: { value: 'auto' } });
    expect(onSave).toHaveBeenLastCalledWith(null);
  });

  it('a saved count above this PC cap says what the run gets', () => {
    render(<RunCores cores={12} locked={false} cap={4} onSave={() => {}} />);
    expect(options()).toEqual(['Auto', '1', '2', '3', '4', '12 (this PC gives 4)']);
    expect(screen.getByText('Runs on 4 cores: the most this PC gives a run.')).toBeInTheDocument();
  });

  it('a started run shows its setting read-only', () => {
    const { rerender } = render(<RunCores cores={2} locked cap={4} onSave={() => {}} />);
    expect(screen.queryByLabelText('Cores')).toBeNull();
    expect(screen.getByText('2')).toBeInTheDocument();
    rerender(<RunCores cores={null} locked cap={4} onSave={() => {}} />);
    expect(screen.getByText('Auto')).toBeInTheDocument();
  });

  it('reads the cap from the server', async () => {
    function Probe() {
      const cap = useRankCap();
      return <span data-testid="cap">{cap == null ? 'none' : String(cap)}</span>;
    }
    render(<Probe />);
    await waitFor(() => expect(screen.getByTestId('cap')).toHaveTextContent('4'));
  });
});

describe('runCanUseCores', () => {
  const registry: RegistryDescribe = {
    solver: [
      { key: 'simpleFoam', label: 'simpleFoam', parallel: 'mpirun' } as never,
      { key: 'serialFoam', label: 'serialFoam', parallel: 'none' } as never,
    ],
  };
  it('follows the started run launch, else the analysis solver', () => {
    expect(runCanUseCores({ launch_parallel: false }, registry, { key: 'a', label: 'A', default_solver: 'simpleFoam' })).toBe(false);
    expect(runCanUseCores({ launch_parallel: null }, registry, { key: 'a', label: 'A', default_solver: 'simpleFoam' })).toBe(true);
    expect(runCanUseCores({ launch_parallel: null }, registry, { key: 'a', label: 'A', default_solver: 'serialFoam' })).toBe(false);
    expect(runCanUseCores({ launch_parallel: null }, registry, undefined)).toBe(true);
  });
});
