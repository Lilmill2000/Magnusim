// Panels the Assistant fills (ui/controller.ts: openForAssistant, openEditForAssistant,
// openParamsForAssistant, doneForAssistant, dropForAssistant), in the mounted UI over the real
// DocService (tests/features/extrude/fake-app.tsx):
//   - read-only: data-panel-owner, the "Assistant" badge, the title not renamable, the fields
//     inert, no Delete, Done disabled with its reason;
//   - no viewport tool: the Extrude's profile clicks and arrow, the Fillet's edge picks, the
//     Combine's and the Revolve axis's tree picks and a CONSTRUCT field's tool are not taken, and
//     the selection filter is left as it is;
//   - the person's Escape, Ctrl+Z, a command, Parameters or a change of its draft take it over
//     (discarded, never committed; 'assistant:taken-over' with why);
//   - openForAssistant throws PersonEditing at once with the person's feature panel, tool panel,
//     menu, rename, dialog or a value typed in Parameters, and the person's work is left as it is;
//     an idle Parameters panel gives way and comes back after;
//   - doneForAssistant: an incomplete feature keeps nothing and says why; never a flush;
//   - the Assistant's own Parameters panel, and the rows an Assistant step changes flashing
//     (fake doc, fake timers).
// SPDX-License-Identifier: GPL-3.0-or-later
import { act, cleanup, fireEvent } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { isPersonEditing, type PersonEditing } from '../../src/doc';
import combineModule from '../../src/features/combine';
import filletModule from '../../src/features/fillet';
import measureModule from '../../src/features/measure';
import refgeomModule from '../../src/features/refgeom';
import { FIELD_TOOL_ID } from '../../src/features/refgeom/fields';
import revolveModule from '../../src/features/revolve';
import { selectItem } from '../../src/lib/selection';
import type { CombineFeature, ExtrudeFeature, Feature, FeatureId, RevolveFeature, SketchFeature } from '../../src/types/doc';
import type { AssistantStep, EditSession, TakeOverWhy } from '../../src/types/doc-service';
import { WELL_KNOWN_COMMANDS, type CadModule } from '../../src/types/modules';
import { uiFor, type UiController } from '../../src/ui/controller';
import { ASSISTANT_PANEL_DONE } from '../../src/ui/kit';
import { FLASH_MS } from '../../src/ui/panels/ParametersPanel';
import { startApp, type FakeApp } from '../features/extrude/fake-app';
import { rectRegion } from '../features/sketch/fake-profiles-kernel';
import { makeServices } from './fake-doc';
import { mountUi } from './mount';

let app: FakeApp | null = null;
afterEach(() => {
  cleanup();
  app?.dispose();
  app = null;
  for (const d of document.querySelectorAll('dialog')) d.remove();
});

/** Two side-by-side 20 x 10 rectangles' regions (A at x 0..20, B at x 20..40) in one sketch. */
const KEY_A = '+e_1[p:origin>p:pt_b] +e_2[p:pt_b>p:pt_c] +e_3[p:pt_c>p:pt_d] +e_4[p:pt_d>p:origin]';
const KEY_B = '+e_5[p:pt_b>p:pt_e] +e_6[p:pt_e>p:pt_f] +e_7[p:pt_f>p:pt_c] -e_2[p:pt_b>p:pt_c]';
const A_ENTITIES = ['e_1', 'e_2', 'e_3', 'e_4'];
const B_ENTITIES = ['e_2', 'e_5', 'e_6', 'e_7'];
const PROFILE_A = { sketch: 'f_sk', region: KEY_A, entities: A_ENTITIES, sample: [10, 5] as [number, number] };
const PROFILE_B = { sketch: 'f_sk', region: KEY_B, entities: B_ENTITIES, sample: [30, 5] as [number, number] };
const twoRects = (): Partial<SketchFeature> => ({
  id: 'f_sk',
  points: { pt_b: [20, 0], pt_c: [20, 10], pt_d: [0, 10], pt_e: [40, 0], pt_f: [40, 10] },
  entities: [
    { id: 'e_1', kind: 'line', p: ['origin', 'pt_b'] },
    { id: 'e_2', kind: 'line', p: ['pt_b', 'pt_c'] },
    { id: 'e_3', kind: 'line', p: ['pt_c', 'pt_d'] },
    { id: 'e_4', kind: 'line', p: ['pt_d', 'origin'] },
    { id: 'e_5', kind: 'line', p: ['pt_b', 'pt_e'] },
    { id: 'e_6', kind: 'line', p: ['pt_e', 'pt_f'] },
    { id: 'e_7', kind: 'line', p: ['pt_f', 'pt_c'] },
  ],
  constraints: [
    { id: 'c_1', kind: 'distance', refs: ['e_1'], expr: '20 mm', driving: true },
    { id: 'c_2', kind: 'distance', refs: ['e_2'], expr: '10 mm', driving: true },
  ],
  solved: { values: { c_1: 20, c_2: 10 }, dof: 3, state: 'under' },
});

interface Part {
  a: FakeApp;
  ui: UiController;
  /** 'assistant:taken-over' events, by why. */
  takeOvers: TakeOverWhy[];
  /** The extrudes made before the test (one per body asked for). */
  extrudes: FeatureId[];
}

/** A Part with the two-rectangle sketch, and `bodies` extrudes of its regions (A, then B), 5 mm. */
async function part(opts: { modules?: CadModule[]; bodies?: 0 | 1 | 2 } = {}): Promise<Part> {
  app = await startApp({ modules: opts.modules });
  const a = app;
  a.kernel.regionsFor = () => ({ regions: [rectRegion(KEY_A, A_ENTITIES, 0, 0, 20, 10), rectRegion(KEY_B, B_ENTITIES, 20, 0, 40, 10)] });
  act(() => a.doc.beginNew('sketch', twoRects() as Partial<Feature>).commit());
  const extrudes: FeatureId[] = [];
  for (const profile of [PROFILE_A, PROFILE_B].slice(0, opts.bodies ?? 0)) {
    act(() => {
      const s = a.doc.beginNew('extrude', { profiles: [profile], extent: { kind: 'blind', distance: '5 mm' } } as Partial<Feature>);
      s.commit();
      extrudes.push(s.feature);
    });
  }
  await a.settle();
  const takeOvers: TakeOverWhy[] = [];
  a.services.bus.on('assistant:taken-over', (e) => void takeOvers.push(e.why));
  return { a, ui: uiFor(a.services), takeOvers, extrudes };
}

const keyDown = (k: string, init: KeyboardEventInit = {}) => void fireEvent.keyDown(document.body, { key: k, ...init });
const key = (k: string, init: KeyboardEventInit = {}) => act(() => keyDown(k, init));
const panelEl = (a: FakeApp) => a.$('[data-cad-panel]');
const toolIds = (a: FakeApp) => a.vp.tools.map((t) => t.id);
const names = (a: FakeApp) => a.doc.state.get().doc.features.map((f) => f.name);
const draftOf = <F extends Feature>(s: EditSession) => s.draft as F;

/** The Assistant's New panel (it must open). */
function openNew(p: Part, step: AssistantStep, type: Feature['type'] = 'extrude', init: Record<string, unknown> = { profiles: [PROFILE_A] }): EditSession {
  let s: EditSession | string = '';
  act(() => void (s = p.ui.openForAssistant(step, type, init as Partial<Feature>)));
  if (typeof s === 'string') throw new Error(`openForAssistant: ${s}`);
  return s;
}

function openEdit(p: Part, step: AssistantStep, id: FeatureId): EditSession {
  let s: EditSession | string = '';
  act(() => void (s = p.ui.openEditForAssistant(step, id)));
  if (typeof s === 'string') throw new Error(`openEditForAssistant: ${s}`);
  return s;
}

/** The step goes back to its mark and ends (as its call's catch does). */
function revertAndEnd(step: AssistantStep) {
  act(() => {
    step.revert();
    step.end();
  });
}

/** What a call threw (null when it did not throw). */
function thrown(fn: () => unknown): unknown {
  try {
    fn();
  } catch (e) {
    return e;
  }
  return null;
}

describe('a panel the Assistant fills', () => {
  it('is read-only: badged, its title not renamable, its fields inert, no Delete, Done disabled with the reason', async () => {
    const p = await part({ bodies: 1 });
    const { a } = p;
    const step = a.doc.assistant.begin('assistant:c1');
    const s = openNew(p, step);
    await a.settle();
    expect(s.owner).toBe('assistant:c1');
    expect(p.ui.state.get().panel).toMatchObject({ kind: 'feature', feature: s.feature, isNew: true, owner: 'assistant' });
    const el = panelEl(a)!;
    expect(el.getAttribute('data-panel-owner')).toBe('assistant');
    expect(el.querySelector('[data-panel-badge]')!.textContent).toBe('Assistant');
    expect(el.querySelector('[data-rename-btn]')).toBeNull();
    expect(el.querySelector('.mgk-panel-body')!.hasAttribute('inert')).toBe(true);
    expect(el.querySelector('[data-panel-delete]')).toBeNull();
    const done = el.querySelector('[data-panel-done]')!;
    expect(done.getAttribute('aria-disabled')).toBe('true');
    expect(done.getAttribute('data-disabled-reason')).toBe('The Assistant is filling this in · Esc takes over (the Assistant pauses)');
    expect(ASSISTANT_PANEL_DONE).toBe(done.getAttribute('data-disabled-reason'));
    act(() => void fireEvent.click(done));
    expect(s.open).toBe(true);
    // Undo says what it does on the Assistant's panel (it takes over; nothing is undone).
    expect(a.services.commands.get('edit.undo')!.hint).toBe('Take over from the Assistant: its open panel is discarded');
    // Otherwise the person's own path: the feature's tree row edits, the feature is selected, the body is live.
    expect(a.$(`[data-tree-node="${s.feature}"]`)!.classList.contains('is-editing')).toBe(true);
    expect(a.services.selection.get().items).toEqual([{ kind: 'feature', feature: s.feature }]);
    expect(a.doc.state.get().rebuild.bodies).toHaveLength(2);
    act(() => void expect(p.ui.doneForAssistant(step)).toBeNull());
    act(() => {
      step.seal('turn:t1', 'Assistant: a second block');
      step.end();
    });
    // The person's own panel on the same feature has none of it.
    act(() => p.ui.openEdit(s.feature));
    const mine = panelEl(a)!;
    expect(p.ui.state.get().panel?.owner).toBe('person');
    expect(mine.hasAttribute('data-panel-owner')).toBe(false);
    expect(mine.querySelector('[data-panel-badge]')).toBeNull();
    expect(mine.querySelector('[data-rename-btn]')).not.toBeNull();
    expect(mine.querySelector('.mgk-panel-body')!.hasAttribute('inert')).toBe(false);
    expect(mine.querySelector('[data-panel-delete]')).not.toBeNull();
    expect(mine.querySelector('[data-panel-done]')!.getAttribute('aria-disabled')).toBeNull();
    expect(a.services.commands.get('edit.undo')!.hint).toBe('Undo the changes made in the open panel (Redo brings them back)');
    act(() => p.ui.closePanel());
    await a.settle();
  });

  it('a session an Assistant step opens elsewhere gets its panel read-only too (the session sync copies the owner)', async () => {
    const p = await part({ bodies: 1 });
    const { a } = p;
    const step = a.doc.assistant.begin('assistant:c1');
    act(() => void step.run(() => a.doc.beginEdit(p.extrudes[0])));
    expect(p.ui.state.get().panel).toMatchObject({ kind: 'feature', feature: p.extrudes[0], owner: 'assistant' });
    expect(panelEl(a)!.getAttribute('data-panel-owner')).toBe('assistant');
    // The step's end discards its session: the panel goes with it.
    act(() => step.end());
    expect(p.ui.state.get().panel).toBeNull();
    await a.settle();
  });
});

describe('no viewport tools on the Assistant\'s panels', () => {
  it('Extrude: no profile-click or arrow tool; a click on a region only selects it; the filter is left as it is', async () => {
    const p = await part();
    const { a } = p;
    const before = toolIds(a);
    const filter = a.services.selection.get().filter;
    // The person's Extrude pushes its tool, and a click on region B adds it to the profiles.
    act(() => p.ui.openNew('extrude', { profiles: [PROFILE_A] } as Partial<Feature>));
    await a.settle();
    expect(toolIds(a)).toHaveLength(before.length + 1);
    act(() => void a.vp.offer(a.vp.at('click', [30, 5, 0])));
    await a.settle();
    expect(draftOf<ExtrudeFeature>(a.doc.session()!).profiles.map((x) => x.region)).toEqual([KEY_A, KEY_B]);
    act(() => p.ui.deletePanelFeature());
    await a.settle();
    expect(toolIds(a)).toEqual(before);
    act(() => a.services.selection.set({ items: [] }));

    const step = a.doc.assistant.begin('assistant:c1');
    const s = openNew(p, step);
    await a.settle();
    expect(toolIds(a)).toEqual(before);
    expect(a.services.selection.get().filter).toEqual(filter);
    // The same click: the region tool selects region B; the Assistant's profiles stay as it set them.
    let took = false;
    act(() => void (took = a.vp.offer(a.vp.at('click', [30, 5, 0]))));
    await a.settle();
    expect(took).toBe(true);
    expect(a.services.selection.get().items).toEqual([{ kind: 'region', feature: 'f_sk', key: KEY_B }]);
    expect(draftOf<ExtrudeFeature>(s).profiles.map((x) => x.region)).toEqual([KEY_A]);
    // Looking is not taking over.
    expect(step.takenOver).toBeNull();
    expect(step.clean).toBe(true);
    expect(p.takeOvers).toEqual([]);
    act(() => p.ui.dropForAssistant(step));
    act(() => void expect(step.revert()).toEqual({ ok: true }));
    act(() => step.end());
    await a.settle();
    expect(names(a)).toEqual(['Sketch 1']);
  });

  it('Fillet: no edge-pick tool and no edge filter for the Assistant\'s, as the person\'s has', async () => {
    const p = await part({ modules: [filletModule], bodies: 1 });
    const { a } = p;
    const body = a.doc.state.get().rebuild.bodies[0].id;
    const before = toolIds(a);
    const filter = a.services.selection.get().filter;
    act(() => p.ui.openNew('fillet', { body } as Partial<Feature>));
    await a.settle();
    const mine = p.ui.state.get().panel;
    expect(mine?.kind).toBe('feature');
    expect(toolIds(a)).toContain(`solids-edges-${mine?.kind === 'feature' ? mine.feature : ''}`);
    expect(a.services.selection.get().filter).toEqual(['edge', 'face']);
    act(() => p.ui.deletePanelFeature());
    await a.settle();
    expect(toolIds(a)).toEqual(before);
    expect(a.services.selection.get().filter).toEqual(filter);

    const step = a.doc.assistant.begin('assistant:c1');
    const s = openNew(p, step, 'fillet', { body });
    await a.settle();
    expect(p.ui.state.get().panel).toMatchObject({ kind: 'feature', type: 'fillet', feature: s.feature, owner: 'assistant' });
    expect(a.$('[data-feature-panel="fillet"]')).not.toBeNull();
    expect(toolIds(a)).toEqual(before);
    expect(a.services.selection.get().filter).toEqual(filter);
    act(() => p.ui.dropForAssistant(step));
    revertAndEnd(step);
    await a.settle();
  });

  it('Combine: a body the person selects (its tree row) is not taken into the Assistant\'s, as the person\'s takes it', async () => {
    const p = await part({ modules: [combineModule], bodies: 2 });
    const { a } = p;
    const [b1, b2] = a.doc.state.get().rebuild.bodies.map((b) => b.id);
    const before = toolIds(a);
    const step = a.doc.assistant.begin('assistant:c1');
    const s = openNew(p, step, 'combine', { targets: [b1] });
    await a.settle();
    expect(toolIds(a)).toEqual(before);
    act(() => selectItem(a.services.selection, { kind: 'body', body: b2 }, false));
    await a.settle();
    expect(draftOf<CombineFeature>(s).tools).toEqual([]);
    expect(a.services.selection.get().items).toEqual([{ kind: 'body', body: b2 }]);
    act(() => p.ui.dropForAssistant(step));
    revertAndEnd(step);
    await a.settle();
    // The person's own Combine takes the same pick as its tool body.
    act(() => p.ui.openNew('combine', { targets: [b1] } as Partial<Feature>));
    await a.settle();
    expect(toolIds(a).length).toBeGreaterThan(before.length);
    act(() => selectItem(a.services.selection, { kind: 'body', body: b2 }, false));
    await a.settle();
    expect(draftOf<CombineFeature>(a.doc.session()!).tools).toEqual([b2]);
    act(() => p.ui.deletePanelFeature());
    await a.settle();
  });
});

describe('no viewport tools on the Assistant\'s panels (CONSTRUCT, Revolve)', () => {
  it('a CONSTRUCT plane\'s field pushes no pick tool, and a Revolve\'s axis field takes no tree row, as the person\'s do', async () => {
    const p = await part({ modules: [refgeomModule, revolveModule] });
    const { a } = p;
    // The CONSTRUCT overlay sizes its lines by the view's pixels (the fake view has none of its own).
    Object.assign(a.vp.handle, { lineResolution: (): [number, number] => [1000, 1000] });
    const before = toolIds(a);
    // The person's: an Offset plane waits for its plane (the field's tool), a Revolve for its axis (a tree row).
    act(() => p.ui.openNew('ref_plane'));
    await a.settle();
    expect(toolIds(a)).toContain(FIELD_TOOL_ID);
    act(() => p.ui.deletePanelFeature());
    await a.settle();
    expect(toolIds(a)).toEqual(before);
    act(() => p.ui.openNew('revolve', { profiles: [PROFILE_A] } as Partial<Feature>));
    await a.settle();
    act(() => selectItem(a.services.selection, { kind: 'origin', ref: 'origin:x' }, false));
    await a.settle();
    expect(draftOf<RevolveFeature>(a.doc.session()!).axis).toEqual({ kind: 'origin', axis: 'origin:x' });
    act(() => p.ui.deletePanelFeature());
    await a.settle();
    act(() => a.services.selection.set({ items: [] }));

    const step = a.doc.assistant.begin('assistant:c1');
    openNew(p, step, 'ref_plane', {});
    await a.settle();
    expect(toolIds(a)).toEqual(before);
    act(() => p.ui.dropForAssistant(step));
    const s = openNew(p, step, 'revolve', { profiles: [PROFILE_A] });
    await a.settle();
    act(() => selectItem(a.services.selection, { kind: 'origin', ref: 'origin:x' }, false));
    await a.settle();
    expect(draftOf<RevolveFeature>(s).axis).toBeNull();
    expect(toolIds(a)).toEqual(before);
    act(() => p.ui.dropForAssistant(step));
    revertAndEnd(step);
    await a.settle();
    expect(names(a)).toEqual(['Sketch 1']);
  });
});

describe('the person takes over the Assistant\'s panel', () => {
  it('Escape, Ctrl+Z, a command, Parameters or a change of its draft: the panel is discarded, never committed, with why', async () => {
    const p = await part({ bodies: 1 });
    const { a } = p;
    const base = p.extrudes[0];
    const cases: [string, 'new' | 'edit', () => void, TakeOverWhy][] = [
      ['Escape', 'new', () => key('Escape'), 'escape'],
      ['Ctrl+Z', 'new', () => key('z', { ctrlKey: true }), 'undo'],
      ['the toolbar Extrude', 'new', () => act(() => void fireEvent.click(a.$('[data-command="solid.extrude"]')!)), 'command'],
      ['Parameters', 'new', () => act(() => p.ui.openParams()), 'command'],
      ["the person's Edit of the same feature", 'edit', () => act(() => p.ui.openEdit(base)), 'command'],
      ['a rename of its feature in the tree', 'edit', () => act(() => void p.ui.renameFeature(base, 'Base')), 'draft'],
    ];
    for (const [what, kind, takeOver, why] of cases) {
      p.takeOvers.length = 0;
      const committed = a.doc.state.get().doc;
      const hist = a.doc.state.get().history;
      const step = a.doc.assistant.begin(`assistant:${kind}-${why}`);
      const s = kind === 'new' ? openNew(p, step) : openEdit(p, step, base);
      if (kind === 'edit') act(() => s.update({ extent: { kind: 'blind', distance: '9 mm' } } as Partial<Feature>));
      await a.settle();
      expect(a.doc.state.get().doc, what).not.toBe(committed);
      takeOver();
      await a.settle();
      expect(s.open, what).toBe(false);
      expect(p.takeOvers, what).toEqual([why]);
      expect(step.takenOver, what).toBe(why);
      expect(step.clean, what).toBe(false);
      const ex = a.doc.state.get().doc.features.find((f) => f.id === base) as ExtrudeFeature;
      // Nothing of the Assistant's draft was kept.
      expect(ex.extent, what).toEqual({ kind: 'blind', distance: '5 mm' });
      if (why === 'draft') {
        // The person's rename went ahead as a one-shot edit.
        expect(names(a), what).toEqual(['Sketch 1', 'Base']);
        expect(a.doc.state.get().history.undoLabel, what).toBe('Rename Extrude 1');
      } else {
        expect(a.doc.committed(), what).toBe(committed);
        expect(a.doc.state.get().history, what).toEqual(hist);
        expect(names(a), what).toEqual(['Sketch 1', 'Extrude 1']);
      }
      const panel = p.ui.state.get().panel;
      if (what === 'Parameters') expect(panel, what).toEqual({ kind: 'params', owner: 'person' });
      else if (why === 'command') expect(panel, what).toMatchObject({ kind: 'feature', owner: 'person' });
      else expect(panel, what).toBeNull();
      if (panel?.kind === 'feature') act(() => (panel.isNew ? p.ui.deletePanelFeature() : p.ui.closePanel()));
      if (panel?.kind === 'params') act(() => p.ui.closePanel());
      // Only the Assistant changed the Part: its call's revert completes the take-over.
      if (why !== 'draft') act(() => void expect(step.revert(), what).toEqual({ ok: true }));
      act(() => step.end());
      await a.settle();
    }
  });
});

describe('openForAssistant gives way to the person', () => {
  it('throws PersonEditing at once with the person\'s feature panel, tool panel, menu, rename, dialog or typed value, and leaves their work as it is', async () => {
    const p = await part({ modules: [measureModule], bodies: 1 });
    const { a } = p;
    const base = p.extrudes[0];
    let w = '';
    act(() => void (w = String(a.doc.addParam({ name: 'w', expr: '20 mm', quantity: 'length' }))));
    const step = a.doc.assistant.begin('assistant:c1');
    const dialog = () => {
      const d = document.createElement('dialog');
      d.setAttribute('open', '');
      d.setAttribute('aria-modal', 'true');
      document.body.appendChild(d);
    };
    const typed = () => {
      act(() => p.ui.openParams());
      const input = a.$<HTMLInputElement>(`[data-param-id="${w}"] [data-field="expr"] input`)!;
      act(() => void fireEvent.change(input, { target: { value: '30' } }));
    };
    const cases: [string, () => void, () => void, string, FeatureId | null][] = [
      ['a feature panel', () => act(() => p.ui.openEdit(base)), () => p.ui.closePanel(), 'The person is editing Extrude 1', base],
      ['a tool panel', () => act(() => p.ui.openTool(WELL_KNOWN_COMMANDS.measure)), () => p.ui.closePanel(), 'The person has the Measure panel open', null],
      ['a menu', () => act(() => p.ui.showMenu(10, 10, [{ id: 'x', label: 'X', run() {} }])), () => p.ui.closeMenu(), 'The person has a menu open', null],
      ['a rename', () => act(() => p.ui.startRename('feature', base)), () => p.ui.endRename(), 'The person is renaming Extrude 1', base],
      ['a dialog', dialog, () => document.querySelector('dialog')?.remove(), 'The person has a dialog open', null],
      ['a value typed in the Parameters panel', typed, () => p.ui.closePanel(), 'The person is typing a value in the Parameters panel', null],
    ];
    for (const [what, set, unset, words, feature] of cases) {
      set();
      const ui0 = p.ui.state.get();
      const session0 = a.doc.session();
      const live = a.doc.state.get().doc;
      const committed = a.doc.committed();
      const opens: [string, () => unknown][] = [
        ['new', () => p.ui.openForAssistant(step, 'extrude', { profiles: [PROFILE_B] } as Partial<Feature>)],
        ['edit', () => p.ui.openEditForAssistant(step, base)],
      ];
      if (ui0.panel?.kind !== 'params') opens.push(['parameters', () => p.ui.openParamsForAssistant(step)]);
      for (const [how, open] of opens) {
        const e = thrown(open);
        expect(isPersonEditing(e), `${what} (${how})`).toBe(true);
        expect((e as PersonEditing).message, `${what} (${how})`).toBe(words);
        expect((e as PersonEditing).feature, `${what} (${how})`).toBe(feature);
        expect(p.ui.state.get(), `${what} (${how})`).toBe(ui0);
        expect(a.doc.session(), `${what} (${how})`).toBe(session0);
        expect(a.doc.state.get().doc, `${what} (${how})`).toBe(live);
        expect(a.doc.committed(), `${what} (${how})`).toBe(committed);
      }
      act(unset);
    }
    expect(step.clean).toBe(true);
    expect(step.takenOver).toBeNull();
    expect(names(a)).toEqual(['Sketch 1', 'Extrude 1']);
    act(() => step.end());
    await a.settle();
  });

  it('refuses with a reason (no throw) while the Part cannot be edited, the step\'s own panel is still open, or the step ended', async () => {
    const p = await part();
    const { a } = p;
    const step = a.doc.assistant.begin('assistant:c1');
    const s = openNew(p, step);
    let r: EditSession | string = '';
    act(() => void (r = p.ui.openForAssistant(step, 'extrude', { profiles: [PROFILE_B] } as Partial<Feature>)));
    expect(r).toBe("The Assistant's Extrude 1 panel is still open");
    expect(p.ui.openForAssistant(step, 'nope' as Feature['type'])).toBe('This version of Magnusim CAD has no panel for nope features');
    expect(p.ui.openEditForAssistant(step, 'f_gone')).toBe('That feature is not in the part');
    expect(p.ui.openEditForAssistant(step, s.feature)).toBe(s);
    const off = p.ui.addEditBlock(() => 'The Part is being opened');
    act(() => p.ui.dropForAssistant(step));
    expect(p.ui.openForAssistant(step, 'extrude')).toBe('The Part is being opened');
    expect(p.ui.openParamsForAssistant(step)).toBe('The Part is being opened');
    off();
    revertAndEnd(step);
    await a.settle();
    expect(p.ui.openForAssistant(step, 'extrude')).toBe('This Assistant step has ended');
    expect(p.ui.openEditForAssistant(step, 'f_sk')).toBe('This Assistant step has ended');
    expect(p.ui.openParamsForAssistant(step)).toBe('This Assistant step has ended');
    expect(p.ui.doneForAssistant(step)).toBe('This Assistant step has ended');
    p.ui.dropForAssistant(step);
    expect(p.ui.state.get().panel).toBeNull();
    await a.settle();
  });

  it('an idle Parameters panel gives way and comes back after the Assistant\'s panel closes; a command of the person\'s forgets it', async () => {
    const p = await part();
    const { a } = p;
    const closes: [string, (step: AssistantStep) => void, boolean][] = [
      ['done', (step) => void expect(p.ui.doneForAssistant(step)).toBeNull(), true],
      ['dropped', (step) => p.ui.dropForAssistant(step), true],
      ['the step ended', (step) => step.end(), true],
      ['Escape', () => keyDown('Escape'), true],
      ['Ctrl+Z', () => keyDown('z', { ctrlKey: true }), true],
      ["the person's Extrude", () => void fireEvent.click(a.$('[data-command="solid.extrude"]')!), false],
    ];
    for (const [what, close, back] of closes) {
      act(() => p.ui.openParams());
      expect(a.$('[data-cad-panel="params"]'), what).not.toBeNull();
      const step = a.doc.assistant.begin(`assistant:${what}`);
      openNew(p, step);
      await a.settle();
      expect(p.ui.state.get().panel, what).toMatchObject({ kind: 'feature', owner: 'assistant' });
      expect(a.$('[data-cad-panel="params"]'), what).toBeNull();
      act(() => close(step));
      await a.settle();
      if (back) {
        expect(p.ui.state.get().panel, what).toEqual({ kind: 'params', owner: 'person' });
        expect(a.$('[data-cad-panel="params"]')!.hasAttribute('data-panel-owner'), what).toBe(false);
      } else expect(p.ui.state.get().panel, what).toMatchObject({ kind: 'feature', owner: 'person' });
      if (p.ui.state.get().panel?.kind === 'feature') act(() => p.ui.deletePanelFeature());
      act(() => p.ui.closePanel());
      if (!step.ended) revertAndEnd(step);
      await a.settle();
      expect(names(a), what).toEqual(['Sketch 1']);
    }
  });
});

describe('doneForAssistant and dropForAssistant', () => {
  it('Done keeps nothing of an incomplete feature and says why; a complete one is committed; neither flushes', async () => {
    const p = await part();
    const { a } = p;
    const flush = vi.spyOn(a.doc, 'flush');
    const hist = a.doc.state.get().history;
    const step = a.doc.assistant.begin('assistant:c1');
    openNew(p, step, 'extrude', {});
    act(() => void expect(p.ui.doneForAssistant(step)).toBe('Pick a profile'));
    expect(names(a)).toEqual(['Sketch 1']);
    expect(a.doc.state.get().history).toEqual(hist);
    expect(p.ui.state.get().panel).toBeNull();
    const s = openNew(p, step);
    await a.settle();
    act(() => void expect(p.ui.doneForAssistant(step)).toBeNull());
    expect(s.open).toBe(false);
    expect(names(a)).toEqual(['Sketch 1', 'Extrude 1']);
    expect(p.ui.state.get().panel).toBeNull();
    expect(a.doc.assistant.topGroup()).toMatchObject({ tag: 'assistant:c1', label: 'Extrude 1' });
    expect(p.ui.doneForAssistant(step)).toBe("The Assistant's panel is no longer open");
    expect(flush).not.toHaveBeenCalled();
    act(() => {
      step.seal('turn:t1', 'Assistant: a block');
      step.end();
    });
    await a.settle();
    // The person's Done writes at once (Back may follow), as before.
    act(() => p.ui.openEdit(s.feature));
    act(() => p.ui.closePanel());
    expect(flush).toHaveBeenCalledTimes(1);
    await a.settle();
  });

  it('drop discards the step\'s session, and is a no-op once the step ended', async () => {
    const p = await part({ bodies: 1 });
    const { a } = p;
    const step = a.doc.assistant.begin('assistant:c1');
    const s = openEdit(p, step, p.extrudes[0]);
    act(() => s.update({ extent: { kind: 'blind', distance: '9 mm' } } as Partial<Feature>));
    act(() => p.ui.dropForAssistant(step));
    expect(s.open).toBe(false);
    expect(p.ui.state.get().panel).toBeNull();
    expect((a.doc.state.get().doc.features[1] as ExtrudeFeature).extent).toEqual({ kind: 'blind', distance: '5 mm' });
    act(() => step.end());
    await a.settle();
    // After the end: a panel opened since (the person's) is left alone.
    act(() => p.ui.openEdit(p.extrudes[0]));
    p.ui.dropForAssistant(step);
    expect(p.ui.state.get().panel).toMatchObject({ kind: 'feature', owner: 'person' });
    expect(p.takeOvers).toEqual([]);
    act(() => p.ui.closePanel());
    await a.settle();
  });
});

describe('the Assistant\'s Parameters panel', () => {
  it('is read-only, Escape takes it over (the step is marked), drop closes it; a Parameters panel already open is used as it is', async () => {
    const p = await part({ bodies: 1 });
    const { a } = p;
    const step = a.doc.assistant.begin('assistant:c1');
    let r: string | null = 'x';
    act(() => void (r = p.ui.openParamsForAssistant(step)));
    expect(r).toBeNull();
    expect(p.ui.state.get().panel).toEqual({ kind: 'params', owner: 'assistant', by: 'assistant:c1' });
    const el = a.$('[data-cad-panel="params"]')!;
    expect(el.getAttribute('data-panel-owner')).toBe('assistant');
    expect(el.querySelector('[data-panel-badge]')!.textContent).toBe('Assistant');
    expect(el.querySelector('.mgk-panel-body')!.hasAttribute('inert')).toBe(true);
    expect(el.querySelector('[data-panel-done]')!.getAttribute('data-disabled-reason')).toBe(ASSISTANT_PANEL_DONE);
    act(() => p.ui.dropForAssistant(step));
    expect(p.ui.state.get().panel).toBeNull();
    expect(step.takenOver).toBeNull();
    act(() => void p.ui.openParamsForAssistant(step));
    key('Escape');
    expect(p.ui.state.get().panel).toBeNull();
    expect(p.takeOvers).toEqual(['escape']);
    expect(step.takenOver).toBe('escape');
    act(() => step.end());
    // Ctrl+Z on it: a take-over too, and nothing is undone.
    const hist = a.doc.state.get().history;
    const step1 = a.doc.assistant.begin('assistant:c1b');
    act(() => void p.ui.openParamsForAssistant(step1));
    expect(a.services.commands.get('edit.undo')!.hint).toBe('Take over from the Assistant: its open panel is discarded');
    key('z', { ctrlKey: true });
    expect(p.ui.state.get().panel).toBeNull();
    expect(p.takeOvers).toEqual(['escape', 'undo']);
    expect(step1.takenOver).toBe('undo');
    expect(a.doc.state.get().history).toEqual(hist);
    act(() => step1.end());
    // The person's own Parameters panel: used as it is, still theirs.
    act(() => p.ui.openParams());
    const step2 = a.doc.assistant.begin('assistant:c2');
    expect(p.ui.openParamsForAssistant(step2)).toBeNull();
    expect(p.ui.state.get().panel).toEqual({ kind: 'params', owner: 'person' });
    p.ui.dropForAssistant(step2);
    expect(p.ui.state.get().panel).toEqual({ kind: 'params', owner: 'person' });
    // The person's feature panel: PersonEditing, and the panel stays.
    act(() => p.ui.openEdit(p.extrudes[0]));
    expect(isPersonEditing(thrown(() => p.ui.openParamsForAssistant(step2)))).toBe(true);
    expect(p.ui.state.get().panel).toMatchObject({ kind: 'feature', owner: 'person' });
    act(() => step2.end());
    act(() => p.ui.closePanel());
    await a.settle();
  });

  it('flashes the rows an Assistant step changes for FLASH_MS, in the person\'s open panel; the person\'s own changes do not flash', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const t = makeServices({ panels: true });
      const shell = mountUi(t);
      const ui = uiFor(t.services);
      let w = '';
      let d = '';
      act(() => {
        w = String(t.doc.addParam({ name: 'w', expr: '20 mm', quantity: 'length' }));
        d = String(t.doc.addParam({ name: 'd', expr: '5 mm', quantity: 'length' }));
      });
      act(() => ui.openParams());
      const row = (name: string) => shell.$(`[data-param-row="${name}"]`)!;
      const flashed = () => shell.$$('[data-param-changed]').map((r) => r.getAttribute('data-param-row'));
      expect(shell.$$('[data-param-row]')).toHaveLength(2);
      act(() => void t.doc.updateParam(d, { expr: '6 mm' }));
      expect(flashed()).toEqual([]);
      const step = t.doc.assistant.begin('assistant:c1');
      act(() => void step.run(() => t.doc.editParams({ add: [{ name: 'h', expr: '8 mm', quantity: 'length' }], change: [{ id: w, patch: { expr: '30 mm' } }], remove: [] })));
      expect(flashed()).toEqual(['w', 'h']);
      expect(row('w').querySelector('[data-param-value]')!.textContent).toBe('30 mm');
      // The person's idle panel stays open and theirs.
      expect(ui.state.get().panel).toEqual({ kind: 'params', owner: 'person' });
      act(() => void vi.advanceTimersByTime(FLASH_MS - 1));
      expect(flashed()).toEqual(['w', 'h']);
      act(() => void vi.advanceTimersByTime(1));
      expect(flashed()).toEqual([]);
      act(() => step.end());
      cleanup();
      shell.dispose();
    } finally {
      vi.useRealTimers();
    }
  });
});
