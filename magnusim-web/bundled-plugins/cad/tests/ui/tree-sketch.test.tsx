// Sketch rows in the design tree (P3-PROFILES): the definition prefix
// ("(-)" under, none fully with a lock, "(+)" over, "(?)" not solved), the
// dimension count, and the eye (shown until a later feature uses the sketch;
// a choice equal to the default is forgotten).
// SPDX-License-Identifier: GPL-3.0-or-later
import { act, cleanup, fireEvent } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { extrudeDef } from '../../src/features/extrude/def';
import { sketchDef } from '../../src/features/sketch/def';
import type { Feature, FeatureTypeDef, SketchFeature } from '../../src/types';
import { dimensionsText, historyRows, sketchPrefix } from '../../src/ui/tree/model';
import { makeServices, type TestServices } from './fake-doc';
import { mountUi } from './mount';

let t: TestServices;
let ui: ReturnType<typeof mountUi>;
afterEach(() => {
  cleanup();
  ui?.dispose();
});

const dims = (n: number): SketchFeature['constraints'] => Array.from({ length: n }, (_, i) => ({ id: `c_${i}`, kind: 'distance' as const, refs: ['e_1'], expr: `${i + 1} mm`, driving: i % 2 === 0 }));

function start() {
  t = makeServices({ viewport: true });
  t.doc.features.register(sketchDef as unknown as FeatureTypeDef);
  t.doc.features.register(extrudeDef as unknown as FeatureTypeDef);
}

describe('sketch rows', () => {
  it('model: prefix per state, dimension count words, sketch info only on sketches', () => {
    expect(['under', 'fully', 'over', 'unsolved'].map((s) => sketchPrefix(s as SketchFeature['solved']['state']))).toEqual(['(-)', '', '(+)', '(?)']);
    expect([0, 1, 2].map(dimensionsText)).toEqual([null, '1 dimension', '2 dimensions']);
    const rows = historyRows(
      {
        features: [
          { id: 'f_s', type: 'sketch', name: 'Sketch 1', constraints: [...dims(3), { id: 'c_h', kind: 'horizontal', refs: ['e_1'] }], solved: { values: {}, dof: 2, state: 'under' } } as unknown as Feature,
          { id: 'f_b', type: 'box', name: 'Box 1' } as unknown as Feature,
        ],
      },
      { rollback: null },
      { features: {} },
    );
    expect(rows.map((r) => r.sketch ?? null)).toEqual([{ state: 'under', dims: 3, empty: true }, null]);
  });

  it('draws the prefix, the lock, the count and the eye, and the eye stores only a choice that differs from the default', () => {
    start();
    const under = t.doc.seed('sketch', { name: 'Sketch 1', constraints: dims(1), solved: { values: {}, dof: 2, state: 'under' } } as Partial<Feature>);
    const fully = t.doc.seed('sketch', { name: 'Sketch 2', points: { p_1: [0, 0], p_2: [10, 0] }, entities: [{ id: 'e_1', kind: 'line', p: ['p_1', 'p_2'] }], constraints: dims(2), solved: { values: {}, dof: 0, state: 'fully' } } as Partial<Feature>);
    const over = t.doc.seed('sketch', { name: 'Sketch 3', solved: { values: {}, dof: 0, state: 'over' } } as Partial<Feature>);
    const unsolved = t.doc.seed('sketch', { name: 'Sketch 4', solved: { values: {}, dof: 0, state: 'unsolved' } } as Partial<Feature>);
    // Nothing drawn: no lock, although the solver calls an empty sketch fully defined (review P2/P3 round 2).
    const empty = t.doc.seed('sketch', { name: 'Sketch 5', entities: [], solved: { values: {}, dof: 0, state: 'fully' } } as Partial<Feature>);
    ui = mountUi(t);
    expect(ui.history()).toEqual(['(-) Sketch 1', 'Sketch 2', '(+) Sketch 3', '(?) Sketch 4', 'Sketch 5', '|']);
    expect(ui.row(fully.id).querySelector('[data-sketch-lock]')!.getAttribute('aria-label')).toBe('Fully defined');
    expect(ui.row(empty.id).querySelector('[data-sketch-lock]')).toBeNull();
    expect(ui.row(under.id).querySelector('[data-sketch-lock]')).toBeNull();
    expect(ui.row(under.id).querySelector('.tree-sub')!.textContent).toBe('1 dimension');
    expect(ui.row(fully.id).querySelector('.tree-sub')!.textContent).toBe('2 dimensions');
    expect(ui.row(over.id).querySelector('.tree-sub')).toBeNull();
    expect(ui.node(unsolved.id).getAttribute('data-sketch-state')).toBe('unsolved');
    // Nothing uses Sketch 1: shown; the eye hides it (stored), and shows it again (the choice forgotten).
    const eye = () => ui.row(under.id).querySelector<HTMLElement>('[data-sketch-act="visibility"]')!;
    expect(eye().getAttribute('aria-label')).toBe('Hide Sketch 1');
    act(() => void fireEvent.click(eye()));
    expect(t.doc.calls).toContain(`setSketchVisibility ${under.id} hidden`);
    expect(ui.node(under.id).getAttribute('data-sketch-shown')).toBe('0');
    expect(eye().getAttribute('aria-label')).toBe('Show Sketch 1');
    act(() => void fireEvent.click(eye()));
    expect(t.doc.calls).toContain(`setSketchVisibility ${under.id} null`);
    // F2 renames the plain name (the prefix is not part of it).
    act(() => t.services.selection.set({ items: [{ kind: 'feature', feature: under.id }] }));
    act(() => void fireEvent.keyDown(document.body, { key: 'F2' }));
    expect(ui.row(under.id).querySelector<HTMLInputElement>('input')!.value).toBe('Sketch 1');
  });

  it('hides a sketch an extrude uses by default; the eye then stores "shown"', () => {
    start();
    const s = t.doc.seed('sketch', { name: 'Sketch 1' } as Partial<Feature>);
    t.doc.seed('extrude', { profiles: [{ sketch: s.id, region: 'k', entities: [], sample: [0, 0] }] } as Partial<Feature>);
    ui = mountUi(t);
    expect(ui.node(s.id).getAttribute('data-sketch-shown')).toBe('0');
    act(() => void fireEvent.click(ui.row(s.id).querySelector('[data-sketch-act="visibility"]')!));
    expect(t.doc.calls).toContain(`setSketchVisibility ${s.id} shown`);
  });
});

describe('a feature type no panel edits (INTEGRATE, P3-PROFILES request 6)', () => {
  it('double-clicking a sketch with no sketch module installed says why instead of opening the Box panel on it (it crashed reading origin[0])', () => {
    start();
    const s = t.doc.seed('sketch', { name: 'Sketch 1' } as Partial<Feature>);
    ui = mountUi(t);
    act(() => void fireEvent.doubleClick(ui.row(s.id)));
    expect(t.ws.log.toasts.at(-1)).toEqual({ message: 'This version of Magnusim CAD cannot edit Sketch 1: no panel edits sketch features', kind: 'info' });
    expect(t.doc.calls).not.toContain(`beginEdit ${s.id}`);
    expect(ui.$('[data-cad-panel]')).toBeNull();
  });
});
