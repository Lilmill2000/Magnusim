import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { Button } from '../Button';
import { PanelChrome } from './PanelChrome';

describe('PanelChrome', () => {
  it('calls onDone once per Done click', () => {
    const onDone = vi.fn();
    render(
      <PanelChrome title="Mesh" onDone={onDone}>
        body
      </PanelChrome>,
    );
    const done = screen.getByRole('button', { name: 'Done' });
    expect(done.className).toBe('mgk-btn mgk-btn--neutral mgk-panel-done');
    fireEvent.click(done);
    expect(onDone).toHaveBeenCalledTimes(1);
    expect(onDone).toHaveBeenCalledWith();
    fireEvent.click(done);
    expect(onDone).toHaveBeenCalledTimes(2);
  });

  it('Delete calls onDelete, not onDone; it shows only with onDelete, under its label', () => {
    const onDone = vi.fn();
    const onDelete = vi.fn();
    const { rerender } = render(
      <PanelChrome title="Mesh" onDone={onDone}>
        body
      </PanelChrome>,
    );
    expect(screen.getAllByRole('button').map((b) => b.textContent)).toEqual(['Done']);
    rerender(
      <PanelChrome title="Mesh" onDone={onDone} onDelete={onDelete} deleteLabel="Remove">
        body
      </PanelChrome>,
    );
    const remove = screen.getByRole('button', { name: 'Remove' });
    expect(remove.className).toBe('mgk-btn mgk-btn--link');
    fireEvent.click(remove);
    expect(onDelete).toHaveBeenCalledTimes(1);
    expect(onDone).not.toHaveBeenCalled();
    rerender(
      <PanelChrome title="Mesh" onDone={onDone} onDelete={onDelete}>
        body
      </PanelChrome>,
    );
    expect(screen.getByRole('button', { name: 'Delete' })).toBeInTheDocument();
  });

  it('draws the title, body and foot, with no button in the head', () => {
    const { container } = render(
      <PanelChrome title="Boundary layer" onDone={() => undefined} onDelete={() => undefined}>
        <span data-testid="body">First layer 0.1 mm</span>
      </PanelChrome>,
    );
    const root = container.firstElementChild as HTMLElement;
    expect(root.className).toBe('mgk-type mgk-panel');
    expect([...root.children].map((c) => c.className)).toEqual(['mgk-panel-head', 'mgk-panel-body', 'mgk-panel-foot']);
    const head = root.querySelector('.mgk-panel-head') as HTMLElement;
    expect(head.querySelector('.mgk-panel-title')).toHaveTextContent('Boundary layer');
    expect(head.querySelector('button')).toBeNull();
    expect(root.querySelector('.mgk-panel-body')).toContainElement(screen.getByTestId('body'));
    const foot = root.querySelector('.mgk-panel-foot') as HTMLElement;
    expect([...foot.children].map((c) => c.className)).toEqual(['mgk-panel-foot-left', 'mgk-btn mgk-btn--neutral mgk-panel-done']);
  });

  it('card adds the card class', () => {
    const { container } = render(
      <PanelChrome title="Mesh" onDone={() => undefined} card>
        body
      </PanelChrome>,
    );
    expect((container.firstElementChild as HTMLElement).className).toBe('mgk-type mgk-panel mgk-panel--card');
  });

  it('footExtra renders in the foot-left, after Delete', () => {
    const { container } = render(
      <PanelChrome
        title="Mesh"
        onDone={() => undefined}
        onDelete={() => undefined}
        footExtra={<Button variant="link">Duplicate</Button>}
      >
        body
      </PanelChrome>,
    );
    const left = container.querySelector('.mgk-panel-foot-left') as HTMLElement;
    expect([...left.querySelectorAll('button')].map((b) => b.textContent)).toEqual(['Delete', 'Duplicate']);
  });
});
