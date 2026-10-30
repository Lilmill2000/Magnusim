// See-through bodies (Daniel 2026-10-29: a per-body view state, INSPECT > See-through for the
// selected bodies, the body's menu toggles it back):
//   - the rule: the bodies the selection touches; all see-through: opaque again; else (none, or a
//     mix) all see-through; an Enclosure's air (always see-through) is left alone, and alone it
//     cannot be made opaque (the reason says so);
//   - the person's INSPECT > See-through over the UI shell: refused with nothing selected, pressed
//     while every selected body is see-through, the tree row marks it (apart from hidden), the body's
//     menu has Make <body> opaque / see-through; a body always see-through shows its mark and the
//     menu item greyed with the reason.
// SPDX-License-Identifier: GPL-3.0-or-later
import { act, cleanup, fireEvent } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import seeThroughModule from '../../../src/features/see_through';
import { NOTHING_SELECTED, seeThroughTarget, SEE_THROUGH_COMMAND, type SeeEntry } from '../../../src/features/see_through/rule';
import type { Feature } from '../../../src/types/doc';
import type { FeatureTypeDef } from '../../../src/types/doc-service';
import type { SelectionItem } from '../../../src/types/selection';
import { uiFor } from '../../../src/ui/controller';
import { makeServices, type TestServices } from '../../ui/fake-doc';
import { mountUi } from '../../ui/mount';

const e = (id: string, why: SeeEntry['why'], by: string | null = null): SeeEntry => ({ id, name: id.replace('b', 'Body '), why, by });

describe("INSPECT > See-through's rule", () => {
  it('nothing selected: the reason; all opaque or a mix: the opaque ones go see-through; all see-through: the ones the person made so go opaque', () => {
    expect(seeThroughTarget([])).toBe(NOTHING_SELECTED);
    expect(seeThroughTarget([e('b1', null), e('b2', null)])).toEqual({ ids: ['b1', 'b2'], on: true });
    expect(seeThroughTarget([e('b1', 'view'), e('b2', null)])).toEqual({ ids: ['b2'], on: true });
    expect(seeThroughTarget([e('b1', 'view'), e('b2', 'view')])).toEqual({ ids: ['b1', 'b2'], on: false });
    // An Enclosure's air among them: left as it is.
    expect(seeThroughTarget([e('b1', 'view'), e('b3', 'feature', 'Enclosure 1')])).toEqual({ ids: ['b1'], on: false });
    expect(seeThroughTarget([e('b2', null), e('b3', 'feature', 'Enclosure 1')])).toEqual({ ids: ['b2'], on: true });
    // Only such bodies: nothing to change, and why.
    expect(seeThroughTarget([e('b3', 'feature', 'Enclosure 1')])).toBe('Body 3 is always see-through: Enclosure 1 draws it so');
    expect(seeThroughTarget([e('b3', 'feature', 'Enclosure 1'), e('b4', 'feature', 'Enclosure 2')])).toBe('These bodies are always see-through: their features draw them so');
  });
});

describe('INSPECT > See-through and the body menu, as the person meets them', () => {
  let t: TestServices;
  let ui: ReturnType<typeof mountUi>;
  let f: Feature[];
  let uninstall: () => void;

  beforeEach(() => {
    t = makeServices({ viewport: true, panels: true });
    f = [t.doc.seed('extrude'), t.doc.seed('extrude'), t.doc.seed('extrude')];
    ui = mountUi(t);
    act(() => {
      uninstall = seeThroughModule.install!(t.services);
    });
    // The Bodies folder open.
    fireEvent.click(ui.$('[data-bodies-folder] > .tree-row')!);
  });

  afterEach(() => {
    act(() => uninstall());
    cleanup();
    ui.dispose();
  });

  const bodies = () => t.doc.state.get().rebuild.bodies;
  const button = () => ui.$(`.tb-btn[data-command="${SEE_THROUGH_COMMAND}"]`)!;
  const select = (items: SelectionItem[]) => act(() => t.services.selection.set((s) => ({ ...s, items })));
  const row = (id: string) => ui.$(`[data-body-row="${id}"]`)!;
  const menuOf = (id: string) => {
    fireEvent.contextMenu(ui.$(`[data-body-row="${id}"] > .tree-row`)!);
    return ui.menu();
  };

  it('is in INSPECT after Section view, refused with nothing selected; on a body: see-through, pressed, marked in the tree; again: opaque', () => {
    const [b1] = bodies();
    const cmd = t.services.commands.get(SEE_THROUGH_COMMAND)!;
    expect(cmd).toMatchObject({ label: 'See-through', group: 'inspect', order: 17 });
    expect(cmd.hint).toMatch(/A mix of the two all turn see-through/);
    expect(button().getAttribute('data-disabled-reason')).toBe(NOTHING_SELECTED);
    expect(button().getAttribute('aria-pressed')).toBeNull();

    select([{ kind: 'body', body: b1.id }]);
    expect(button().getAttribute('data-disabled-reason')).toBeNull();
    fireEvent.click(button());
    expect(t.doc.calls).toContain(`setBodiesSeeThrough ${b1.id} true`);
    expect(t.doc.state.get().view.seeThroughBodies).toEqual([b1.id]);
    expect(button().getAttribute('aria-pressed')).toBe('true');
    // The tree row: its own mark, not a hidden body's dimmed name.
    expect(row(b1.id).getAttribute('data-see-through')).toBe('view');
    expect(row(b1.id).className).toContain('is-see-through-body');
    expect(row(b1.id).className).not.toContain('is-hidden-body');
    expect(row(b1.id).querySelector('[data-see-through-badge]')!.getAttribute('aria-label')).toMatch(/^See-through: Drawn see-through/);
    expect(row(bodies()[1].id).getAttribute('data-see-through')).toBeNull();

    fireEvent.click(button());
    expect(t.doc.calls).toContain(`setBodiesSeeThrough ${b1.id} false`);
    expect(t.doc.state.get().view).not.toHaveProperty('seeThroughBodies');
    expect(row(b1.id).getAttribute('data-see-through')).toBeNull();
    expect(row(b1.id).querySelector('[data-see-through-badge]')).toBeNull();
    expect(button().getAttribute('aria-pressed')).toBeNull();
  });

  it('a mix (one see-through, one opaque, a face counting for its body) all turn see-through', () => {
    const [b1, b2] = bodies();
    act(() => void uiFor(t.services).setBodiesSeeThrough([b1.id], true));
    select([{ kind: 'face', body: b1.id, index: 0 }, { kind: 'body', body: b2.id }]);
    expect(button().getAttribute('aria-pressed')).toBeNull();
    fireEvent.click(button());
    expect(t.doc.calls.at(-1)).toBe(`setBodiesSeeThrough ${b2.id} true`);
    expect(t.doc.state.get().view.seeThroughBodies).toEqual([b1.id, b2.id]);
    expect(button().getAttribute('aria-pressed')).toBe('true');
  });

  it("the body's menu in the tree: Make <body> see-through, then Make <body> opaque, beside Hide", () => {
    const [b1] = bodies();
    expect(menuOf(b1.id).slice(0, 2)).toEqual(['Hide Body 1', 'Make Body 1 see-through']);
    fireEvent.click(ui.menuItem('body-see-through'));
    expect(t.doc.state.get().view.seeThroughBodies).toEqual([b1.id]);
    expect(row(b1.id).getAttribute('data-see-through')).toBe('view');
    expect(menuOf(b1.id).slice(0, 2)).toEqual(['Hide Body 1', 'Make Body 1 opaque']);
    fireEvent.click(ui.menuItem('body-see-through'));
    expect(t.doc.state.get().view).not.toHaveProperty('seeThroughBodies');
    expect(row(b1.id).getAttribute('data-see-through')).toBeNull();
    // Hidden and see-through: both marks (the dimmed name and the see-through one).
    act(() => {
      uiFor(t.services).setBodiesSeeThrough([b1.id], true);
      uiFor(t.services).setBodyVisible(b1.id, false);
    });
    expect(row(b1.id).className).toContain('is-hidden-body');
    expect(row(b1.id).getAttribute('data-see-through')).toBe('view');
  });

  it("a body its feature always draws see-through (an Enclosure's air): marked, Make opaque greyed with the reason, the command refused on it alone", () => {
    const def = t.doc.features.get('extrude')!;
    t.doc.features.register({ ...def, ownsBody: (g: Feature, id: string) => (g as { creates?: string }).creates === id, seeThrough: (g: Feature) => g.id === f[2].id } as unknown as FeatureTypeDef);
    act(() => t.doc.setRollback(null));
    const b3 = bodies()[2];
    act(() => t.services.selection.set((s) => ({ ...s })));
    expect(row(b3.id).getAttribute('data-see-through')).toBe('feature');
    expect(menuOf(b3.id)).toContain('(Make Body 3 opaque)');
    expect(ui.menuItem('body-see-through').getAttribute('data-disabled-reason')).toBe('Body 3 is always see-through: Extrude 3 draws it so');
    key('Escape');
    select([{ kind: 'body', body: b3.id }]);
    expect(button().getAttribute('data-disabled-reason')).toBe('Body 3 is always see-through: Extrude 3 draws it so');
    expect(button().getAttribute('aria-pressed')).toBe('true');
    expect(uiFor(t.services).setBodiesSeeThrough([b3.id], false)).toBe('Body 3 is always see-through: Extrude 3 draws it so');
    expect(t.doc.calls.some((c) => c.startsWith('setBodiesSeeThrough'))).toBe(false);
  });
});

const key = (k: string) => act(() => void fireEvent.keyDown(document.body, { key: k }));
