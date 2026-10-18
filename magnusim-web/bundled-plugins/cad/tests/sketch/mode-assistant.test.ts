// @vitest-environment node
// A sketch the Assistant draws (src/sketch/mode.ts), on the real DocService (the toy kernel of
// tests/doc/blocks.ts), the UI controller, the real solver in this process and sketch mode's own
// commands and keys (the keyboard on a stand-in document):
//   - startSketch(support, {step}) opens it on the person's path for the step, read-only; it
//     rejects with PersonEditing while the person has a menu open, and leaves it open;
//   - only the step edits it (apply's `by`): the person's apply, tools (Line, construction
//     drawing) and drags are refused with the reason in the panel's foot, the draft untouched;
//     the step edits nothing in the person's own sketch;
//   - Escape through sketch mode's binding closes an open value box first, then takes it over
//     ('escape'); Ctrl+Z and Ctrl+Y take it over ('undo'), also with nothing to undo in it, and
//     move nothing in the history; Enter and Finish sketch take it over ('enter'); nothing of it
//     is kept in any of these;
//   - finish({step}) is the step's honest Done: kept, or the reason with nothing kept;
//   - a refused over-definition names the constraints (ApplyResult conflicting / redundant).
// The camera at the sketch's entry is another lane's (autoCamera).
// SPDX-License-Identifier: GPL-3.0-or-later
import { afterEach, describe, expect, it } from 'vitest';
import { createCommandRegistry } from '../../src/app/commands';
import { bindCommandShortcuts, createKeyboard } from '../../src/app/keyboard';
import { createDocService, isPersonEditing } from '../../src/doc';
import { createBridge } from '../../src/lib/bridge';
import { createBus } from '../../src/lib/bus';
import { createSelectionStore } from '../../src/lib/selection';
import { createStateStore } from '../../src/lib/store';
import { createModuleRegistry } from '../../src/modules';
import { registerSketchCommands } from '../../src/sketch/commands';
import { ASSISTANT_SKETCH, SketchMode, type ApplyResult } from '../../src/sketch/mode';
import { makeTool } from '../../src/sketch/tools';
import { registerSketchToolCommands } from '../../src/sketch/tools/commands';
import type { AppServices, AreaApis } from '../../src/types/app';
import type { Mode } from '../../src/types/commands';
import type { Feature, SketchConstraint, SketchFeature } from '../../src/types/doc';
import type { AssistantStep, DocService, TakeOverWhy } from '../../src/types/doc-service';
import type { CadEvents } from '../../src/types/events';
import { WELL_KNOWN_COMMANDS, type CadModule } from '../../src/types/modules';
import type { ViewportHandle } from '../../src/types/viewport';
import { installUi } from '../../src/ui/commands';
import { uiFor } from '../../src/ui/controller';
import { BlockKernel, blockSketch, registerSolidFeatures } from '../doc/blocks';
import { createFakeWorkspace } from '../fakes/workspace-sdk';
import { inProcessSolver } from './harness';

/** The keyboard's document: keys are pressed on it (no dialog is ever open). */
function keyDocument() {
  const keydown: ((e: KeyboardEvent) => void)[] = [];
  const doc = {
    addEventListener: (type: string, fn: (e: KeyboardEvent) => void) => void (type === 'keydown' && keydown.push(fn)),
    removeEventListener: () => {},
    querySelectorAll: () => [],
  } as unknown as Document;
  const press = (key: string, mods: { ctrl?: boolean; shift?: boolean } = {}) => {
    const e = { key, ctrlKey: !!mods.ctrl, metaKey: false, altKey: false, shiftKey: !!mods.shift, target: null, preventDefault() {} } as unknown as KeyboardEvent;
    for (const fn of keydown) fn(e);
  };
  return { doc, press };
}

interface Part {
  services: AppServices;
  doc: DocService;
  mode: SketchMode;
  press(key: string, mods?: { ctrl?: boolean; shift?: boolean }): void;
  /** Hold the next solve of sketch mode's solver: `reached` when it is asked, `release` lets it answer. */
  holdNextSolve(): { reached: Promise<void>; release(): void };
  takeOvers: TakeOverWhy[];
  personUndos: number;
  dispose(): void;
}

let part: Part | null = null;
afterEach(() => {
  part?.dispose();
  part = null;
});

/** The sketch's panel (only that it exists: sketch mode's own panel is another test's). */
const panelStub: CadModule = { id: 'sketch-panel', panels: { sketch: (() => null) as never } };

async function openPart(): Promise<Part> {
  const solver = await inProcessSolver();
  let hold: { reached(): void; gate: Promise<void> } | null = null;
  const solve = solver.solve.bind(solver);
  solver.solve = async () => {
    const h = hold;
    hold = null;
    if (h) {
      h.reached();
      await h.gate;
    }
    return solve();
  };
  const ws = createFakeWorkspace({ units: 'metric' });
  const bus = createBus<CadEvents>();
  const kernel = new BlockKernel();
  const doc = createDocService({ bridge: createBridge(ws), kernel, bus, solver: () => solver, saveIntervalMs: 20, saveViewIntervalMs: 20, log: () => {} });
  registerSolidFeatures(doc);
  const keys = keyDocument();
  const keyboard = createKeyboard(keys.doc);
  let services: AppServices | null = null;
  const commands = createCommandRegistry(() => services!);
  services = {
    bridge: createBridge(ws),
    bus,
    commands,
    keyboard,
    kernel,
    doc,
    selection: createSelectionStore(),
    mode: createStateStore<{ mode: Mode }>({ mode: 'model' }),
    viewport: createStateStore<{ handle: ViewportHandle | null }>({ handle: null }),
    modules: createModuleRegistry([panelStub]),
    apis: createStateStore<AreaApis>({ sketch: null, solver: null, files: null }),
  };
  await doc.load();
  // As the app: the shell first (its Escape closes a panel), then sketch mode's newer bindings.
  const offUi = installUi(services);
  const mode = new SketchMode(services, solver, makeTool);
  services.apis.set({ sketch: mode, solver });
  const offSketch = registerSketchCommands(services, mode);
  const offTools = registerSketchToolCommands(services, mode);
  const unbind = bindCommandShortcuts(commands, keyboard, undefined, () => services!.mode.get().mode);
  const p: Part = {
    services,
    doc,
    mode,
    press: keys.press,
    holdNextSolve() {
      let reached!: () => void;
      let release!: () => void;
      const at = new Promise<void>((r) => (reached = r));
      hold = { reached, gate: new Promise<void>((r) => (release = r)) };
      return { reached: at, release };
    },
    takeOvers: [],
    personUndos: 0,
    dispose() {
      unbind();
      offTools();
      offSketch();
      offUi();
      mode.dispose();
      uiFor(services!).dispose();
      keyboard.dispose();
      doc.dispose();
      solver.dispose();
    },
  };
  bus.on('assistant:taken-over', (e) => void p.takeOvers.push(e.why));
  bus.on('assistant:person-undo', () => void (p.personUndos += 1));
  return p;
}

const TOP = { kind: 'plane', plane: 'origin:top' } as const;
const names = (doc: DocService) => doc.state.get().doc.features.map((f) => f.name);

/** A 20 x 10 rectangle at the origin with its horizontals and verticals (2 DOF), and `more` constraints. */
function rectangle(more: SketchConstraint[] = []) {
  const g = blockSketch(0, 0, 20, 10);
  const constraints: SketchConstraint[] = [
    { id: 'h1', kind: 'horizontal', refs: ['e_1'] },
    { id: 'v2', kind: 'vertical', refs: ['e_2'] },
    { id: 'h3', kind: 'horizontal', refs: ['e_3'] },
    { id: 'v4', kind: 'vertical', refs: ['e_4'] },
    { id: 'c0', kind: 'coincident', refs: ['pt_1', 'origin'] },
    ...more,
  ];
  return () => ({ points: g.points!, entities: g.entities!, constraints });
}

/** An Assistant step with its sketch open on Top and a rectangle drawn in it (by the step). */
async function assistantSketch(p: Part, owner: string, more: SketchConstraint[] = []): Promise<AssistantStep> {
  const step = p.doc.assistant.begin(owner);
  expect(await p.mode.startSketch(TOP, { step })).toBe(true);
  const r = await p.mode.apply('Draw rectangle', rectangle(more), { by: step });
  expect(r.ok).toBe(true);
  return step;
}

/** The call's catch, as the Assistant's own will be: back to the mark, then the end. */
function revertAndEnd(step: AssistantStep) {
  expect(step.revert().ok).toBe(true);
  step.end();
}

/** The open sketch is gone with nothing of it kept, sketch mode is left, the step is marked `why`. */
function takenOver(p: Part, step: AssistantStep, why: TakeOverWhy, before: string[]) {
  expect(step.takenOver).toBe(why);
  expect(p.takeOvers).toEqual([why]);
  expect(p.doc.session()).toBeNull();
  expect(p.mode.active).toBe(false);
  expect(p.services.mode.get().mode).toBe('model');
  expect(uiFor(p.services).state.get().panel).toBeNull();
  expect(names(p.doc)).toEqual(before);
}

describe('a sketch the Assistant draws', () => {
  it("opens on the person's path for its step, read-only: only the step's edits apply; the person's tools, edits and drags are refused with the reason", async () => {
    part = await openPart();
    const { doc, mode, services } = part;
    const step = doc.assistant.begin('assistant:c1');
    expect(await mode.startSketch(TOP, { step })).toBe(true);
    expect(mode.active).toBe(true);
    expect(mode.byAssistant).toBe(true);
    expect(doc.session()?.owner).toBe('assistant:c1');
    const panel = uiFor(services).state.get().panel;
    expect(panel?.kind === 'feature' && panel.owner).toBe('assistant');
    expect(services.mode.get().mode).toBe('sketch');

    // The step's own edit applies (solved and stored, analysed: 2 DOF).
    const drawn = await mode.apply('Draw rectangle', rectangle(), { by: step });
    expect(drawn.ok).toBe(true);
    expect(mode.stored()!.entities.map((e) => e.id)).toEqual(['e_1', 'e_2', 'e_3', 'e_4']);
    expect(mode.state.get().status).toMatchObject({ state: 'under', dof: 2 });
    const draft = mode.stored();

    // The person's edit (Delete) is refused, with the reason in the panel's foot; the draft is untouched.
    const del = await mode.apply('Delete', (d) => ({ points: d.points, entities: [], constraints: [] }));
    expect(del).toEqual({ ok: false, reason: ASSISTANT_SKETCH });
    expect(mode.view.get().note).toBe(ASSISTANT_SKETCH);
    expect(mode.stored()).toBe(draft);
    // Another step's hands too.
    const other = await mode.apply('Draw', rectangle(), { by: { ...step, owner: 'assistant:other' } as AssistantStep });
    expect(other).toEqual({ ok: false, reason: ASSISTANT_SKETCH });

    // The person's tools: Line (its command and L) and construction drawing (X) keep Select, with the reason.
    mode.note(null);
    expect(await services.commands.run('sketch.line')).toBe(true);
    expect(mode.state.get().tool).toBe('select');
    expect(mode.tool?.id).toBe('select');
    expect(mode.view.get().note).toBe(ASSISTANT_SKETCH);
    mode.note(null);
    part.press('l');
    await mode.idle();
    expect(mode.state.get().tool).toBe('select');
    expect(mode.view.get().note).toBe(ASSISTANT_SKETCH);
    mode.note(null);
    part.press('x');
    expect(mode.drawConstruction).toBe(false);
    expect(mode.view.get().note).toBe(ASSISTANT_SKETCH);
    // A drag of its geometry (the Select tool's press on a corner) is refused before the solver moves anything.
    mode.note(null);
    expect(await mode.beginDrag({ point: 'pt_3' })).toBe(false);
    expect(mode.dragging).toBe(false);
    expect(mode.view.get().note).toBe(ASSISTANT_SKETCH);
    expect(mode.stored()).toBe(draft);

    // Nothing of that took it over; the step's own Done keeps it.
    expect(step.takenOver).toBeNull();
    expect(part.takeOvers).toEqual([]);
    expect(await mode.finish({ step })).toBeNull();
    expect(mode.active).toBe(false);
    expect(names(doc)).toEqual(['Sketch 1']);
    const kept = doc.state.get().doc.features[0] as SketchFeature;
    expect(kept.entities).toHaveLength(4);
    expect(kept.solved).toMatchObject({ state: 'under', dof: 2 });
    step.end();
  });

  it('rejects with PersonEditing while the person has a menu open, and leaves it open; then opens', async () => {
    part = await openPart();
    const { doc, mode, services } = part;
    const ui = uiFor(services);
    const step = doc.assistant.begin('assistant:c2');
    ui.showMenu(10, 10, [{ id: 'x', label: 'Something', run() {} }]);
    const err = await mode.startSketch(TOP, { step }).then(
      () => null,
      (e: unknown) => e,
    );
    expect(isPersonEditing(err)).toBe(true);
    expect((err as Error).message).toBe('The person has a menu open');
    expect(ui.state.get().menu).not.toBeNull();
    expect(doc.session()).toBeNull();
    ui.closeMenu();
    expect(await mode.startSketch(TOP, { step })).toBe(true);
    expect(mode.byAssistant).toBe(true);
    revertAndEnd(step);
    expect(mode.active).toBe(false);
  });

  it('Escape through sketch mode\'s own key closes an open value box first, then takes it over keeping nothing', async () => {
    part = await openPart();
    const { doc, mode } = part;
    const step = await assistantSketch(part, 'assistant:c3', [{ id: 'dw', kind: 'distance', refs: ['e_1'], expr: '20 mm', driving: true }]);
    // The person opened the width's value box (a double-click on its label): Escape closes it, nothing more.
    mode.view.set({ editing: 'dw' });
    part.press('Escape');
    expect(mode.view.get().editing).toBeNull();
    expect(mode.active).toBe(true);
    expect(step.takenOver).toBeNull();
    // Escape again: the person takes it over.
    part.press('Escape');
    takenOver(part, step, 'escape', []);
    revertAndEnd(step);
    expect(doc.state.get().doc).toBe(step.mark.doc);
  });

  it('Ctrl+Z and Ctrl+Y take it over, also with nothing to undo in it, and move nothing in the history', async () => {
    part = await openPart();
    const { doc, mode, services } = part;
    // The person's own sketch first: the history has one step.
    doc.beginNew('sketch', blockSketch(40, 0) as Partial<Feature>).commit();
    const label = doc.state.get().history.undoLabel;
    expect(label).not.toBeNull();

    // Ctrl+Z with the Assistant's edits in the sketch's own undo.
    let step = await assistantSketch(part, 'assistant:c4');
    expect(mode.undoDepth).toBe(1);
    expect(services.commands.get(WELL_KNOWN_COMMANDS.sketchUndo)?.hint).toBe('Take over from the Assistant: its sketch is discarded');
    part.press('z', { ctrl: true });
    takenOver(part, step, 'undo', ['Sketch 1']);
    expect(doc.state.get().history.undoLabel).toBe(label);
    expect(part.personUndos).toBe(0);
    revertAndEnd(step);

    // Ctrl+Z with nothing to undo in it yet (just opened): still the person's take-over.
    part.takeOvers.length = 0;
    step = doc.assistant.begin('assistant:c5');
    expect(await mode.startSketch(TOP, { step })).toBe(true);
    expect(mode.undoDepth).toBe(0);
    expect(services.commands.canRun(WELL_KNOWN_COMMANDS.sketchUndo)).toBe(true);
    part.press('z', { ctrl: true });
    await mode.idle();
    takenOver(part, step, 'undo', ['Sketch 1']);
    revertAndEnd(step);

    // Ctrl+Y and Ctrl+Shift+Z.
    for (const mods of [{ ctrl: true }, { ctrl: true, shift: true }]) {
      part.takeOvers.length = 0;
      step = await assistantSketch(part, `assistant:c6${mods.shift ? 's' : ''}`);
      part.press(mods.shift ? 'Z' : 'y', mods);
      takenOver(part, step, 'undo', ['Sketch 1']);
      expect(doc.state.get().history.undoLabel).toBe(label);
      revertAndEnd(step);
    }
    expect(part.personUndos).toBe(0);
    // The person's own Ctrl+Z after all that still undoes their sketch.
    doc.undo();
    expect(names(doc)).toEqual([]);
  });

  it('Enter and Finish sketch take it over; the step\'s own Finish keeps it, or says why and keeps nothing', async () => {
    part = await openPart();
    const { doc, mode, services } = part;
    let step = await assistantSketch(part, 'assistant:c7');
    part.press('Enter');
    takenOver(part, step, 'enter', []);
    revertAndEnd(step);

    part.takeOvers.length = 0;
    step = await assistantSketch(part, 'assistant:c8');
    expect(services.commands.get(WELL_KNOWN_COMMANDS.sketchFinish)?.hint).toBe('Take over from the Assistant: its sketch is discarded');
    expect(await services.commands.run(WELL_KNOWN_COMMANDS.sketchFinish)).toBe(true);
    takenOver(part, step, 'enter', []);
    revertAndEnd(step);

    // The step's Done of a sketch whose dimension cannot be evaluated: why, and nothing kept.
    part.takeOvers.length = 0;
    step = await assistantSketch(part, 'assistant:c9', [{ id: 'dw', kind: 'distance', refs: ['e_1'], expr: 'nowhere * 2', driving: true }]);
    const why = await mode.finish({ step });
    expect(why).toMatch(/nowhere/);
    expect(mode.active).toBe(false);
    expect(names(doc)).toEqual([]);
    expect(step.takenOver).toBeNull();
    revertAndEnd(step);

    // The step's own Done of a good one keeps it, and the person's Finish hint is the usual one again.
    step = await assistantSketch(part, 'assistant:c10');
    expect(await mode.finish({ step })).toBeNull();
    expect(names(doc)).toEqual(['Sketch 1']);
    expect(part.takeOvers).toEqual([]);
    step.end();
    expect(services.commands.get(WELL_KNOWN_COMMANDS.sketchFinish)?.hint).toBe('Leave the sketch (the whole sketch session is one undo step)');
  });

  it("a take-over while the step's edit is being solved: the edit and the step's Finish say the sketch is closed, and nothing is kept", async () => {
    part = await openPart();
    const { doc, mode } = part;
    const step = await assistantSketch(part, 'assistant:c13');
    const held = part.holdNextSolve();
    const edit = mode.apply('Distance', rectangle([{ id: 'dw', kind: 'distance', refs: ['e_1'], expr: '30 mm', driving: true }]), { by: step });
    const done = mode.finish({ step });
    await held.reached;
    part.press('Escape');
    takenOver(part, step, 'escape', []);
    held.release();
    expect(await edit).toEqual({ ok: false, reason: 'The sketch is closed' });
    expect(await done).toBe('The sketch is closed');
    expect(names(doc)).toEqual([]);
    revertAndEnd(step);
    expect(doc.state.get().doc).toBe(step.mark.doc);
  });

  it("the step edits nothing in the person's own sketch, and the person's keys work there as always", async () => {
    part = await openPart();
    const { doc, mode } = part;
    const step = doc.assistant.begin('assistant:c11');
    // The person starts a sketch while the step is open (between its calls).
    expect(await mode.startSketch(TOP)).toBe(true);
    expect(mode.byAssistant).toBe(false);
    expect(await mode.apply('Draw', rectangle(), { by: step })).toEqual({ ok: false, reason: 'The person is drawing Sketch 1' });
    expect(await mode.finish({ step })).toBe('The person is drawing Sketch 1');
    expect(mode.active).toBe(true);
    const mine = await mode.apply('Draw', rectangle());
    expect(mine.ok).toBe(true);
    part.press('l');
    expect(mode.state.get().tool).toBe('line');
    part.press('Escape');
    expect(mode.state.get().tool).toBe('select');
    part.press('z', { ctrl: true });
    await mode.idle();
    expect(mode.stored()!.entities).toEqual([]);
    expect(mode.active).toBe(true);
    expect(part.takeOvers).toEqual([]);
    await mode.finish();
    expect(names(doc)).toEqual(['Sketch 1']);
    step.end();
  });

  it('an edit that over-defines the sketch is refused naming the constraints', async () => {
    part = await openPart();
    const { mode } = part;
    const step = await assistantSketch(part, 'assistant:c12');
    const before = mode.stored();
    // A second horizontal on the bottom line: redundant with h1.
    const r = (await mode.apply('Horizontal', rectangle([{ id: 'hx', kind: 'horizontal', refs: ['e_1'] }]), { by: step })) as Extract<ApplyResult, { ok: false }>;
    expect(r.ok).toBe(false);
    expect(r.over).toBe(true);
    const named = [...(r.conflicting ?? []), ...(r.redundant ?? [])];
    expect(named.length).toBeGreaterThan(0);
    expect(named.every((id) => id === 'hx' || id === 'h1')).toBe(true);
    expect(mode.stored()).toBe(before);
    // Over-defined the other way round too: a width fixed twice with two values.
    const two = (await mode.apply(
      'Distance',
      rectangle([
        { id: 'd1', kind: 'distance', refs: ['e_1'], expr: '20 mm', driving: true },
        { id: 'd2', kind: 'distance', refs: ['pt_1', 'pt_2'], expr: '30 mm', driving: true },
      ]),
      { by: step },
    )) as Extract<ApplyResult, { ok: false }>;
    expect(two.ok).toBe(false);
    expect([...(two.conflicting ?? []), ...(two.redundant ?? [])].some((id) => id === 'd1' || id === 'd2')).toBe(true);
    revertAndEnd(step);
  });
});
