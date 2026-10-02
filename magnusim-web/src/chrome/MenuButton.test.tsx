import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { MenuButton, type MenuItem } from './MenuButton';

// gate:l1-menus: a menu button's keyboard (the header's start buttons and Workspaces menu).

function setup(items?: MenuItem[]) {
  const picked: string[] = [];
  const list: MenuItem[] = items || [
    { key: 'a', label: 'Part 1', onSelect: () => picked.push('a') },
    { key: 'b', label: 'Part 2', onSelect: () => picked.push('b') },
    { kind: 'separator', key: 'sep' },
    { key: 'new', label: 'New Part', onSelect: () => picked.push('new') },
  ];
  render(
    <>
      <MenuButton label="Parts" items={list} />
      <button type="button">after</button>
    </>,
  );
  const button = screen.getByRole('button', { name: 'Parts' });
  return { picked, button };
}

const focused = () => (document.activeElement as HTMLElement | null)?.textContent;

describe('MenuButton', () => {
  it('opens on Down, Enter or Space with the first item focused', () => {
    for (const key of ['ArrowDown', 'Enter', ' ']) {
      const { button } = setup();
      expect(button).toHaveAttribute('aria-haspopup', 'menu');
      expect(button).toHaveAttribute('aria-expanded', 'false');
      button.focus();
      fireEvent.keyDown(button, { key });
      expect(button).toHaveAttribute('aria-expanded', 'true');
      expect(screen.getByRole('menu')).toBeInTheDocument();
      expect(focused()).toBe('Part 1');
      document.body.replaceChildren();
    }
  });

  it('opens on Up with the last item focused', () => {
    const { button } = setup();
    button.focus();
    fireEvent.keyDown(button, { key: 'ArrowUp' });
    expect(button).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByRole('menu')).toBeInTheDocument();
    expect(focused()).toBe('New Part');
  });

  it('moves with Up, Down, Home and End (wrapping, skipping the separator)', () => {
    const { button } = setup();
    button.focus();
    fireEvent.keyDown(button, { key: 'ArrowDown' });
    const menu = screen.getByRole('menu');
    fireEvent.keyDown(menu, { key: 'ArrowDown' });
    expect(focused()).toBe('Part 2');
    fireEvent.keyDown(menu, { key: 'ArrowDown' });
    expect(focused()).toBe('New Part');
    fireEvent.keyDown(menu, { key: 'ArrowDown' });
    expect(focused()).toBe('Part 1');
    fireEvent.keyDown(menu, { key: 'ArrowUp' });
    expect(focused()).toBe('New Part');
    fireEvent.keyDown(menu, { key: 'Home' });
    expect(focused()).toBe('Part 1');
    fireEvent.keyDown(menu, { key: 'End' });
    expect(focused()).toBe('New Part');
    expect(screen.getAllByRole('menuitem')).toHaveLength(3);
    expect(screen.getByRole('separator')).toBeInTheDocument();
  });

  it('Escape closes it and gives the button the focus back; Tab closes it', () => {
    const { button } = setup();
    button.focus();
    fireEvent.keyDown(button, { key: 'ArrowDown' });
    fireEvent.keyDown(screen.getByRole('menu'), { key: 'Escape' });
    expect(screen.queryByRole('menu')).toBeNull();
    expect(document.activeElement).toBe(button);
    expect(button).toHaveAttribute('aria-expanded', 'false');
    fireEvent.keyDown(button, { key: 'Enter' });
    expect(screen.getByRole('menu')).toBeInTheDocument();
    fireEvent.keyDown(screen.getByRole('menu'), { key: 'Tab' });
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('Enter on an item picks it and closes the menu; a click outside closes it', () => {
    const { picked, button } = setup();
    fireEvent.click(button);
    expect(screen.getByRole('menu')).toBeInTheDocument();
    fireEvent.mouseDown(document.body);
    expect(screen.queryByRole('menu')).toBeNull();
    button.focus();
    fireEvent.keyDown(button, { key: 'ArrowDown' });
    fireEvent.keyDown(screen.getByRole('menu'), { key: 'ArrowDown' });
    fireEvent.click(document.activeElement as HTMLElement);
    expect(picked).toEqual(['b']);
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('a note is shown but never focused, and a disabled item is skipped', () => {
    const onSelect = vi.fn();
    const { button } = setup([
      { kind: 'note', key: 'none', label: 'No Part yet' },
      { kind: 'separator', key: 'sep' },
      { key: 'off', label: 'Busy', onSelect, disabled: true },
      { key: 'new', label: 'New Part', onSelect },
    ]);
    button.focus();
    fireEvent.keyDown(button, { key: 'ArrowDown' });
    expect(screen.getByText('No Part yet')).toBeInTheDocument();
    expect(focused()).toBe('New Part');
    fireEvent.keyDown(screen.getByRole('menu'), { key: 'ArrowDown' });
    expect(focused()).toBe('New Part');
  });
});
