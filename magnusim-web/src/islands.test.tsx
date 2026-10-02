import { act, fireEvent, render, screen } from '@testing-library/react';
import { useEffect } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearIslands, mountIsland, PanelBoundary, registerIsland } from './islands';

function Boom(): never {
  throw new Error('panel failed');
}

describe('PanelBoundary', () => {
  let logged: ReturnType<typeof vi.spyOn>;
  const done = vi.fn();
  beforeEach(() => {
    // React reports each caught error too; this checks only the boundary's own line.
    logged = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    window.addEventListener('cfd:panel-done', done);
  });
  afterEach(() => {
    window.removeEventListener('cfd:panel-done', done);
    done.mockClear();
    logged.mockRestore();
  });

  const panelLines = () => logged.mock.calls.filter((c: unknown[]) => c[0] === '[panel]');

  it('shows the card in place of a panel that throws: what failed, Try again and Done', () => {
    render(
      <PanelBoundary panelId="panel-sim-control" chrome>
        <Boom />
      </PanelBoundary>,
    );
    const card = screen.getByRole('alert');
    expect(card).toHaveAttribute('data-panel-boundary', '1');
    expect(card).toHaveClass('mgk-error');
    expect(card).toHaveTextContent('This panel stopped working.');
    expect(card.querySelector('.mgk-error-msg')).toHaveTextContent('panel failed');
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Done' })).toBeInTheDocument();
  });

  it("logs '[panel]', the panel id, the error and the component stack", () => {
    render(
      <PanelBoundary panelId="panel-sim-control">
        <Boom />
      </PanelBoundary>,
    );
    expect(panelLines()).toHaveLength(1);
    const [, id, error, stack] = panelLines()[0];
    expect(id).toBe('panel-sim-control');
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe('panel failed');
    expect(typeof stack).toBe('string');
    expect(stack).toContain('Boom');
  });

  it('without a panel id it logs an empty one', () => {
    render(
      <PanelBoundary>
        <Boom />
      </PanelBoundary>,
    );
    expect(panelLines()[0][1]).toBe('');
  });

  it('Try again mounts the panel afresh', () => {
    let fail = true;
    let mounts = 0;
    function Flaky() {
      if (fail) throw new Error('not yet');
      useEffect(() => {
        mounts += 1;
      }, []);
      return <div data-testid="panel">Run panel</div>;
    }
    render(
      <PanelBoundary panelId="p" chrome>
        <Flaky />
      </PanelBoundary>,
    );
    expect(screen.getByRole('alert')).toHaveTextContent('not yet');
    fail = false;
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.getByTestId('panel')).toHaveTextContent('Run panel');
    expect(mounts).toBe(1);
  });

  it('Try again on a panel that still throws shows the card again', () => {
    render(
      <PanelBoundary panelId="p" chrome>
        <Boom />
      </PanelBoundary>,
    );
    expect(panelLines()).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(screen.getByRole('alert')).toHaveTextContent('panel failed');
    expect(panelLines()).toHaveLength(2);
  });

  it('has Done only as a whole panel (chrome); Done sends one cfd:panel-done', () => {
    const { unmount } = render(
      <PanelBoundary panelId="p">
        <Boom />
      </PanelBoundary>,
    );
    expect(screen.queryByRole('button', { name: 'Done' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument();
    unmount();
    render(
      <PanelBoundary panelId="p" chrome>
        <Boom />
      </PanelBoundary>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Done' }));
    expect(done).toHaveBeenCalledTimes(1);
  });

  it('a panel host gets the card with Done, and the log names it', async () => {
    document.body.innerHTML = '<div id="panel-probe" class="mat-panel"></div>';
    registerIsland('panel-probe', Boom);
    try {
      await act(async () => {
        mountIsland('panel-probe', {});
      });
      const card = document.querySelector('#panel-probe .cfd-island [data-panel-boundary="1"]') as HTMLElement;
      expect(card).not.toBeNull();
      expect(card.querySelector('.mgk-panel-done')).toHaveTextContent('Done');
      expect(panelLines()[0][1]).toBe('panel-probe');
    } finally {
      act(() => clearIslands());
      document.body.innerHTML = '';
    }
  });
});
