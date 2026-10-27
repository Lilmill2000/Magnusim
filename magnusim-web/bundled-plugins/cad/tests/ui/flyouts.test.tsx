// Toolbar flyouts (v0.5.0, src/ui/flyouts.ts; Daniel: the sketch toolbar as SolidWorks lays it
// out): a group of drawing tools is one button that runs its last-used variant and an arrow that
// lists every variant (icon, name, shortcut, hint). The list's contents and order, the last-used
// variant (a pick from the list, a shortcut, a click on the button), the keyboard (Down / Up on the
// arrow open the list, Escape closes it), a flyout another lane fills with one line per command
// (Ellipse), and a flyout with nothing registered not shown.
// SPDX-License-Identifier: GPL-3.0-or-later
import { act, cleanup, fireEvent } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { barIdOf, collapseFlyouts, FLYOUTS } from '../../src/ui/flyouts';
import type { CommandDef } from '../../src/types/commands';
import { makeServices, type TestServices } from './fake-doc';
import { mountUi } from './mount';

let ui: ReturnType<typeof mountUi> | null = null;
afterEach(() => {
  cleanup();
  ui?.dispose();
  ui = null;
});

const ICON = 'M4 4h16';
const cmd = (id: string, label: string, order: number, flyout?: string, shortcut?: string): CommandDef => ({ id, label, group: 'draw', mode: 'sketch', icon: ICON, order, hint: `${label} hint`, ...(flyout ? { flyout } : {}), ...(shortcut ? { shortcut } : {}), run: () => {} });

const DRAW = [
  cmd('sketch.line', 'Line', 10, 'line', 'L'),
  cmd('sketch.rectangle', 'Rectangle', 11, 'rectangle', 'R'),
  cmd('sketch.rectangle-center', 'Center rectangle', 12, 'rectangle'),
  cmd('sketch.circle', 'Circle', 13, 'circle', 'C'),
  cmd('sketch.arc', '3-point arc', 14, 'arc', 'A'),
  cmd('sketch.arc-tangent', 'Tangent arc', 15, 'arc'),
  cmd('sketch.point', 'Point', 16),
  cmd('sketch.centerline', 'Centerline', 17, 'line'),
  cmd('sketch.arc-center', 'Centerpoint arc', 14.2, 'arc'),
  cmd('sketch.slot', 'Center-to-center slot', 15.1, 'slot'),
  cmd('sketch.slot-overall', 'Overall slot', 15.2, 'slot'),
  cmd('sketch.polygon', 'Polygon', 15.6),
];

describe('collapseFlyouts', () => {
  it('one command per flyout, in its first place; the variants in the list order', () => {
    const c = collapseFlyouts(DRAW);
    expect(c.commands.map((x) => x.id)).toEqual(['sketch.line', 'sketch.rectangle', 'sketch.circle', 'sketch.arc', 'sketch.point', 'sketch.slot', 'sketch.polygon']);
    expect(c.variants.get('sketch.arc')!.map((x) => x.id)).toEqual(['sketch.arc-center', 'sketch.arc-tangent', 'sketch.arc']);
    expect(c.variants.get('sketch.line')!.map((x) => x.id)).toEqual(['sketch.line', 'sketch.centerline']);
    // A flyout of one variant is that command alone.
    expect(c.variants.has('sketch.circle')).toBe(false);
    expect(barIdOf(DRAW, 'sketch.arc-tangent')).toBe('sketch.arc');
    expect(barIdOf(DRAW, 'sketch.point')).toBe('sketch.point');
  });

  it('the Ellipse flyout: Ellipse on the bar, then Partial ellipse, Parabola and Conic; a flyout without a main takes its first variant by order', () => {
    expect(FLYOUTS.find((f) => f.id === 'ellipse')).toMatchObject({ main: 'sketch.ellipse' });
    const ellipses = [cmd('sketch.conic', 'Conic', 23, 'ellipse'), cmd('sketch.ellipse-partial', 'Partial ellipse', 21, 'ellipse'), cmd('sketch.parabola', 'Parabola', 22, 'ellipse'), cmd('sketch.ellipse', 'Ellipse', 20, 'ellipse')];
    const c = collapseFlyouts([...DRAW, ...ellipses]);
    expect(c.commands.map((x) => x.id)).toContain('sketch.ellipse');
    for (const id of ['sketch.ellipse-partial', 'sketch.parabola', 'sketch.conic']) expect(c.commands.map((x) => x.id)).not.toContain(id);
    expect(c.variants.get('sketch.ellipse')!.map((x) => x.label)).toEqual(['Ellipse', 'Partial ellipse', 'Parabola', 'Conic']);
    expect(barIdOf([...DRAW, ...ellipses], 'sketch.conic')).toBe('sketch.ellipse');
    const other = collapseFlyouts([cmd('x.b', 'B', 2, 'nomain'), cmd('x.a', 'A', 1, 'nomain')]);
    expect(other.commands.map((x) => x.id)).toEqual(['x.a']);
  });
});

describe('the flyout button and its list', () => {
  async function setup(): Promise<{ t: TestServices; ran: string[] }> {
    const t = makeServices();
    const ran: string[] = [];
    for (const c of DRAW) t.services.commands.register({ ...c, run: () => void ran.push(c.id) });
    t.services.mode.set({ mode: 'sketch' });
    await act(async () => {
      ui = mountUi(t);
      await new Promise((r) => setTimeout(r, 0));
    });
    return { t, ran };
  }
  const arrow = (bar: string) => ui!.$<HTMLButtonElement>(`[data-tb-flyout="${bar}"]`)!;
  const button = (bar: string) => ui!.$<HTMLButtonElement>(`.tb-btn[data-command="${bar}"]`)!;

  it('the arrow lists every variant with its icon, name and shortcut; a pick runs it and the button runs it next', async () => {
    const { t, ran } = await setup();
    // One button per flyout; Point and Polygon on their own; the Ellipse flyout (nothing registered) not shown.
    expect(ui!.$$('[data-group="draw"] .tb-btn[data-command]').map((b) => b.getAttribute('data-command'))).toEqual([
      'sketch.line',
      'sketch.rectangle',
      'sketch.circle',
      'sketch.arc',
      'sketch.slot',
      'sketch.polygon',
      'sketch.point',
    ]);
    expect(ui!.$('[data-tb-flyout-group="ellipse"]')).toBeNull();
    // The button and its arrow are the group's items side by side (the toolbar's drag reads them so).
    expect(button('sketch.arc').parentElement!.classList.contains('tb-items')).toBe(true);
    expect(button('sketch.arc').nextElementSibling).toBe(arrow('sketch.arc'));
    expect(button('sketch.arc').getAttribute('data-variant')).toBe('sketch.arc');
    expect(arrow('sketch.arc').getAttribute('aria-label')).toBe('Arc tools');
    await act(async () => fireEvent.click(arrow('sketch.arc')));
    expect(ui!.$$('[data-cad-menu] [role="menuitem"]').map((b) => b.querySelector('.cad-menu-label')?.textContent)).toEqual(['Centerpoint arc', 'Tangent arc', '3-point arc']);
    expect(ui!.$$('[data-cad-menu] [role="menuitem"] svg').length).toBe(3);
    expect(ui!.$('[data-cad-menu]')!.textContent).toContain('A');
    await act(async () => fireEvent.click(ui!.$('[data-cad-menu] [data-command="sketch.arc-tangent"]')!));
    expect(ran).toEqual(['sketch.arc-tangent']);
    expect(ui!.$('[data-cad-menu]')).toBeNull();
    // The button now shows and runs Tangent arc (its id stays the flyout's).
    expect(button('sketch.arc').getAttribute('data-variant')).toBe('sketch.arc-tangent');
    expect(button('sketch.arc').getAttribute('aria-label')).toBe('Tangent arc');
    await act(async () => fireEvent.click(button('sketch.arc')));
    expect(ran).toEqual(['sketch.arc-tangent', 'sketch.arc-tangent']);
    // Another flyout keeps its own.
    expect(button('sketch.line').getAttribute('data-variant')).toBe('sketch.line');
    void t;
  });

  it('the keyboard: Down on the arrow opens the list on its first variant, Up on its last; Escape closes it', async () => {
    await setup();
    await act(async () => fireEvent.keyDown(arrow('sketch.slot'), { key: 'ArrowDown' }));
    expect(arrow('sketch.slot').getAttribute('aria-expanded')).toBe('true');
    expect(ui!.$$('[data-cad-menu] [role="menuitem"]').map((b) => b.getAttribute('data-command'))).toEqual(['sketch.slot', 'sketch.slot-overall']);
    await act(async () => fireEvent.keyDown(ui!.$('[data-cad-menu]')!, { key: 'Escape' }));
    expect(ui!.$('[data-cad-menu]')).toBeNull();
    // Down on the button itself opens it too.
    await act(async () => fireEvent.keyDown(button('sketch.line'), { key: 'ArrowDown' }));
    expect(arrow('sketch.line').getAttribute('aria-expanded')).toBe('true');
  });

  it('a flyout folded into More lists its variants one by one there', async () => {
    const { t } = await setup();
    // Move Arc to More (the right-click menu's Move to More).
    await act(async () => fireEvent.contextMenu(button('sketch.arc')));
    await act(async () => fireEvent.click(ui!.$('[data-cad-menu] [data-menu-item="tb-to-more"]')!));
    const more = ui!.$('[data-tb-more="draw"]')!;
    expect(more.getAttribute('data-more-commands')).toBe('sketch.arc-center sketch.arc-tangent sketch.arc');
    void t;
  });
});
