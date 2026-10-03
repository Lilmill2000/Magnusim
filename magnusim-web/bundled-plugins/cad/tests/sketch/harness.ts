// A sketch-mode harness for unit tests (test-only): a minimal document with
// one sketch session, the real solver (solver-api.mjs over the shipped wasm,
// in this process instead of a worker), and SketchMode with the real tools.
// Tools are driven with pointer events on the sketch plane.
// SPDX-License-Identifier: GPL-3.0-or-later
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createBus } from '../../src/lib/bus';
import { newId } from '../../src/lib/ids';
import { createSelectionStore } from '../../src/lib/selection';
import { createStateStore } from '../../src/lib/store';
import { createCommandRegistry } from '../../src/app/commands';
import { normaliseCombo } from '../../src/app/keyboard';
import { createModuleRegistry } from '../../src/modules';
import { SketchMode, type SketchPointer } from '../../src/sketch/mode';
import type { SolverClient } from '../../src/sketch/solver-client';
import { toSolverSketch } from '../../src/sketch/model';
import { makeTool } from '../../src/sketch/tools';
import { registerSketchCommands } from '../../src/sketch/commands';
import type { AppServices, AreaApis } from '../../src/types/app';
import type { Mode } from '../../src/types/commands';
import type { CadDoc, Feature, SketchFeature, Vec2 } from '../../src/types/doc';
import type { DocService, DocState, EditSession } from '../../src/types/doc-service';
import type { CadEvents } from '../../src/types/events';
import type { SketchToolId } from '../../src/types/sketch';
import type { ViewportHandle } from '../../src/types/viewport';
import { createFakeUnits } from '../ui/fake-doc';
import { sketchOf } from './fixtures';

const API = pathToFileURL(fileURLToPath(new URL('../../src/solver-worker/solver-api.mjs', import.meta.url))).href;
const MODULE = pathToFileURL(fileURLToPath(new URL('../../workspace/solver/planegcs.mjs', import.meta.url))).href;

type Api = Record<string, (...a: unknown[]) => unknown>;

/** The solver client contract over solver-api in this process (calls are async like the worker's). */
async function inProcessSolver(): Promise<SolverClient> {
  const { createSolver } = (await import(/* @vite-ignore */ API)) as { createSolver(o: { moduleUrl: string }): Promise<Api> };
  const s = await createSolver({ moduleUrl: MODULE });
  const scratch = await createSolver({ moduleUrl: MODULE });
  const call = <T>(op: string, ...args: unknown[]) => Promise.resolve().then(() => s[op](...args) as T);
  return {
    starts: 1,
    ready: () => Promise.resolve(),
    solveFeature: (f, values) =>
      Promise.resolve().then(() => {
        scratch.load(toSolverSketch(f, values));
        return scratch.solve() as never;
      }),
    load: (sk) => call('load', sk),
    solve: () => call('solve'),
    analyze: () => call('analyze'),
    setValue: (c, v) => call('setValue', c, v),
    dragStart: (p, o) => call('dragStart', p, o ?? {}),
    dragStartEntity: (e, g, o) => call('dragStartEntity', e, g, o ?? {}),
    dragMove: (u, v) => call('dragMove', u, v),
    dragEnd: () => call('dragEnd'),
    dispose: () => s.dispose(),
  };
}

export interface Harness {
  services: AppServices;
  mode: SketchMode;
  session: EditSession;
  sketch(): SketchFeature;
  tool(id: SketchToolId): void;
  /** Click at a sketch point (mm) with 0.1 mm per pixel. */
  click(at: Vec2, opts?: { ctrl?: boolean }): void;
  move(at: Vec2, opts?: { ctrl?: boolean; pressed?: boolean }): void;
  /** A press-drag-release from a to b (select tool drags, power trim). */
  drag(a: Vec2, b: Vec2): Promise<void>;
  idle(): Promise<void>;
  dispose(): void;
}

/**
 * `handle`: a viewport handle (fake) in place before the sketch is entered; `later`: features
 * after the sketch in the history, with their rebuild states (a reopened sketch).
 */
export interface HarnessOptions {
  handle?: Partial<ViewportHandle>;
  later?: { feature: Feature; state: 'ok' | 'rolled-back' }[];
}

export async function sketchHarness(start: Partial<SketchFeature> = {}, opts: HarnessOptions = {}): Promise<Harness> {
  const later = (opts.later ?? []).map((l) => l.feature);
  const laterStates = Object.fromEntries((opts.later ?? []).map((l) => [l.feature.id, { state: l.state }]));
  const solver = await inProcessSolver();
  const empty: CadDoc = { schema: 2, units: { length: 'mm', angle: 'deg' }, params: [], bodies: {}, features: [], meta: { created_at: '2026-10-01T00:00:00Z', written_by: 'test' } };
  const state = createStateStore<DocState>({
    status: 'ready',
    error: null,
    doc: empty,
    view: { rollback: null, hiddenBodies: [], expanded: [] },
    rebuild: { status: 'idle', seq: 0, features: laterStates, bodies: [], outputs: {}, ms: null, message: null },
    save: { state: 'saved', at: null },
    history: { canUndo: false, canRedo: false, undoLabel: null, redoLabel: null },
    session: null,
  });
  const units = createFakeUnits(() => state.get().doc);
  let draft: SketchFeature = sketchOf({}, start);
  const session: EditSession = {
    id: newId('s'),
    feature: draft.id,
    isNew: true,
    get draft() {
      return draft as Feature;
    },
    open: true,
    update(patch) {
      draft = { ...draft, ...(patch as Partial<SketchFeature>) };
      state.set((s) => ({ ...s, doc: { ...s.doc, features: [draft, ...later] } }));
    },
    incomplete: () => null,
    commit() {
      (this as { open: boolean }).open = false;
      state.set((s) => ({ ...s, session: null }));
    },
    discard() {
      (this as { open: boolean }).open = false;
      state.set((s) => ({ ...s, session: null }));
    },
  };
  const doc = {
    state,
    units,
    features: { get: (t: string) => (t === 'sketch' ? ({ type: 'sketch' } as never) : undefined), all: () => [], register() {} },
    editable: () => true as const,
    session: () => (session.open ? session : null),
  } as unknown as DocService;
  const services: AppServices = {
    bridge: { toast() {}, spawnWorker: () => null } as never,
    bus: createBus<CadEvents>(),
    commands: createCommandRegistry(() => services),
    keyboard: { bind: () => () => {}, normalise: normaliseCombo, dispose() {} },
    kernel: {} as never,
    doc,
    selection: createSelectionStore(),
    mode: createStateStore<{ mode: Mode }>({ mode: 'model' }),
    viewport: createStateStore<{ handle: ViewportHandle | null }>({ handle: (opts.handle as ViewportHandle | undefined) ?? null }),
    modules: createModuleRegistry([]),
    apis: createStateStore<AreaApis>({ sketch: null, solver: null, files: null }),
  };
  const mode = new SketchMode(services, solver, makeTool);
  const offCommands = registerSketchCommands(services, mode);
  state.set((s) => ({ ...s, doc: { ...s.doc, features: [draft, ...later] }, session: { id: session.id, feature: session.feature, isNew: true } }));
  await mode.idle();
  const px = 0.1;
  const ev = (type: SketchPointer['type'], at: Vec2, o: { ctrl?: boolean; pressed?: boolean } = {}): SketchPointer => ({
    type,
    uv: at,
    px,
    ctrl: !!o.ctrl,
    shift: false,
    pressed: !!o.pressed,
    clientX: at[0] / px,
    clientY: -at[1] / px,
  });
  return {
    services,
    mode,
    session,
    sketch: () => draft,
    tool: (id) => mode.setTool(id),
    click(at, o = {}) {
      mode.tool!.pointer(ev('move', at, o));
      mode.tool!.pointer(ev('down', at, { ...o, pressed: true }));
      mode.tool!.pointer(ev('up', at, o));
      mode.tool!.pointer(ev('click', at, o));
    },
    move(at, o = {}) {
      mode.tool!.pointer(ev('move', at, o));
    },
    async drag(a, b) {
      mode.tool!.pointer(ev('move', a));
      mode.tool!.pointer(ev('down', a, { pressed: true }));
      for (let i = 1; i <= 5; i++) {
        mode.tool!.pointer(ev('move', [a[0] + ((b[0] - a[0]) * i) / 5, a[1] + ((b[1] - a[1]) * i) / 5], { pressed: true }));
        await new Promise((r) => setTimeout(r, 0));
        await mode.idle();
      }
      mode.tool!.pointer(ev('up', b));
      await new Promise((r) => setTimeout(r, 0));
      await mode.idle();
    },
    idle: async () => {
      await new Promise((r) => setTimeout(r, 0));
      await mode.idle();
      await new Promise((r) => setTimeout(r, 0));
      await mode.idle();
    },
    dispose() {
      offCommands();
      mode.dispose();
      solver.dispose();
      services.keyboard.dispose();
    },
  };
}
