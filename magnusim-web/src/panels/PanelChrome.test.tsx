import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PanelChrome } from './PanelChrome';

describe('PanelChrome', () => {
  const listener = vi.fn();

  afterEach(() => {
    window.removeEventListener('cfd:panel-done', listener);
    listener.mockClear();
  });

  it('sends one cfd:panel-done per Done click', () => {
    window.addEventListener('cfd:panel-done', listener);
    render(
      <PanelChrome title="Mesh">
        <p>body</p>
      </PanelChrome>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Done' }));
    expect(listener).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: 'Done' }));
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it('Delete does not send cfd:panel-done', () => {
    window.addEventListener('cfd:panel-done', listener);
    const onDelete = vi.fn();
    render(
      <PanelChrome title="Mesh" onDelete={onDelete} deleteLabel="Remove">
        <p>body</p>
      </PanelChrome>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Remove' }));
    expect(onDelete).toHaveBeenCalledTimes(1);
    expect(listener).not.toHaveBeenCalled();
  });
});
