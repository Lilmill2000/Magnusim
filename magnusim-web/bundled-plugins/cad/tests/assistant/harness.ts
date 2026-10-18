// The Assistant tools' test Part (CAD tools spec §12.1): a real DocService on the REAL kernel
// (in this process, tests/features/p2/kernel-anywhere.ts), every module's feature types, the real
// sketch solver in this process (solver-anywhere.ts) as services.apis.solver, the UI
// controller, and the fake host's ws.assistant (tests/fakes/assistant-sdk.ts) with the Assistant
// installed on it. call() runs a tool as the host's bridge would (its result, or its error as the
// SDK sends it). Real-kernel test files give each test an explicit timeout (Linux CI is slow).
// SPDX-License-Identifier: GPL-3.0-or-later
import type { AssistantRegistration } from '@magnusim/workspace';
import { expect, vi } from 'vitest';
import { createCommandRegistry } from '../../src/app/commands';
import { createKeyboard } from '../../src/app/keyboard';
import { installAssistant } from '../../src/assistant/install';
import { runtimeOf } from '../../src/assistant/runtime';
import { createDocService } from '../../src/doc';
import chamferModule from '../../src/features/chamfer';
import combineModule from '../../src/features/combine';
import extrudeModule from '../../src/features/extrude';
import filletModule from '../../src/features/fillet';
import loftModule from '../../src/features/loft';
import patternModule from '../../src/features/pattern';
import refgeomModule from '../../src/features/refgeom';
import revolveModule from '../../src/features/revolve';
import shellModule from '../../src/features/shell';
import sketchModule from '../../src/features/sketch';
import sweepModule from '../../src/features/sweep';
import { createBridge } from '../../src/lib/bridge';
import { createBus } from '../../src/lib/bus';
import { createSelectionStore } from '../../src/lib/selection';
import { createStateStore } from '../../src/lib/store';
import { createModuleRegistry, registerModuleFeatures } from '../../src/modules';
import type { AppServices, AreaApis } from '../../src/types/app';
import type { Mode } from '../../src/types/commands';
import type { Feature } from '../../src/types/doc';
import type { DocService, RebuildState } from '../../src/types/doc-service';
import type { CadEvents } from '../../src/types/events';
import type { KernelAdapter } from '../../src/types/kernel';
import type { CadModule } from '../../src/types/modules';
import type { ViewportHandle } from '../../src/types/viewport';
import { uiFor } from '../../src/ui/controller';
import type { FakeAssistant, FakeAssistantOptions, FakeOutcome } from '../fakes/assistant-sdk';
import { createFakeWorkspace, type FakeWorkspace } from '../fakes/workspace-sdk';
import { realKernelAnywhere } from '../features/p2/kernel-anywhere';
import { solverAnywhere } from './solver-anywhere';

/** The feature types a tool may make (every module that makes one). */
export const FEATURE_MODULES: CadModule[] = [sketchModule, extrudeModule, revolveModule, sweepModule, loftModule, filletModule, chamferModule, shellModule, patternModule, combineModule, refgeomModule];

/** Real-kernel tests: each one's ceiling (Linux CI runs on 2 slow cores). */
export const REAL_KERNEL_MS = 120_000;

export interface AssistantHarness {
  services: AppServices;
  doc: DocService;
  ws: FakeWorkspace;
  fake: FakeAssistant;
  /** Run a tool as the bridge would (turn "" is an outside client's call). */
  call(tool: string, input: Record<string, unknown>, o?: { turn?: string; signal?: AbortSignal }): Promise<FakeOutcome>;
  /** A call that must answer ok: its result. */
  ok(tool: string, input: Record<string, unknown>, o?: { turn?: string }): Promise<{ text: string; data: Record<string, unknown>; summary: string }>;
  /** Add a feature as the person's panel would (one undo step) and wait for its rebuild. */
  add(type: Feature['type'], init: Record<string, unknown>): Promise<string>;
  /** Wait until the rebuild caught up with the model. */
  settle(): Promise<RebuildState>;
  dispose(): void;
}

export interface HarnessOptions {
  units?: 'metric' | 'imperial';
  /** The fake host's ws.assistant (turn events on by default). */
  assistant?: FakeAssistantOptions;
  /** The Part's title (the study record's). */
  title?: string;
  /** Start the sketch solver (true by default). */
  solver?: boolean;
  /** Another kernel (a fake, for the call plumbing); the real one by default. */
  kernel?: KernelAdapter;
  /** The Assistant's clock (session keys, the chip's timers read Date.now otherwise). */
  now?: () => number;
  /** The fake host's answers to the first registrations (else available, every tool accepted). */
  verdicts?: AssistantRegistration[];
}

export async function assistantHarness(o: HarnessOptions = {}): Promise<AssistantHarness> {
  const ws = createFakeWorkspace({ units: o.units ?? 'metric', hostVersion: '1.2', assistant: o.assistant ?? {}, study: { title: o.title ?? 'Part 1' } });
  const fake = ws.assistantFake!;
  fake.verdicts.push(...(o.verdicts ?? []));
  const kernel = o.kernel ?? realKernelAnywhere();
  await kernel.start();
  const bus = createBus<CadEvents>();
  const bridge = createBridge(ws);
  const apis = createStateStore<AreaApis>({ sketch: null, solver: null, files: null });
  const solver = o.solver === false ? null : await solverAnywhere();
  if (solver) apis.set({ solver });
  const doc = createDocService({ bridge, kernel, bus, solver: () => apis.get().solver, onSolverChange: (fn) => apis.subscribe(fn), saveIntervalMs: 20, saveViewIntervalMs: 20, log: () => {} });
  registerModuleFeatures(doc.features, FEATURE_MODULES);
  let services: AppServices | null = null;
  services = {
    bridge,
    bus,
    commands: createCommandRegistry(() => services!),
    keyboard: createKeyboard(document),
    kernel,
    doc,
    selection: createSelectionStore(),
    mode: createStateStore<{ mode: Mode }>({ mode: 'model' }),
    viewport: createStateStore<{ handle: ViewportHandle | null }>({ handle: null }),
    modules: createModuleRegistry(FEATURE_MODULES),
    apis,
  };
  // The UI controller follows the document's sessions from the start (installUi creates it in the app).
  uiFor(services);
  await doc.load();
  const off = installAssistant(services, { document, now: o.now });
  // The app's answer to the registration (the page's state says it).
  await vi.waitFor(() => expect(runtimeOf(services!)?.store.get().registration).not.toBe('pending'), { timeout: 5000, interval: 5 });
  const settle = () => doc.settled();
  const h: AssistantHarness = {
    services,
    doc,
    ws,
    fake,
    call: (tool, input, c = {}) => fake.invoke(tool, input, { turn: c.turn ?? 't-test', signal: c.signal }),
    async ok(tool, input, c = {}) {
      const r = await fake.invoke(tool, input, { turn: c.turn ?? 't-test' });
      if (!r.ok) throw new Error(`${tool} failed: ${JSON.stringify(r.error)}`);
      return r.result as { text: string; data: Record<string, unknown>; summary: string };
    },
    async add(type, init) {
      const s = doc.beginNew(type, init as Partial<Feature>);
      const id = s.feature;
      s.commit();
      const r = await settle();
      if (!r.features[id]) throw new Error(`${type} was not added`);
      return id;
    },
    settle,
    dispose() {
      off();
      uiFor(services!).dispose();
      doc.dispose();
      kernel.dispose();
      solver?.dispose();
    },
  };
  return h;
}

/** A rectangle w x h with a corner at (x0, y0): its points and four lines (stored ids). */
export function rectangle(w: number, h: number, x0 = 0, y0 = 0) {
  return {
    points: { pt_a: [x0, y0], pt_b: [x0 + w, y0], pt_c: [x0 + w, y0 + h], pt_d: [x0, y0 + h] } as Record<string, [number, number]>,
    entities: [
      { id: 'e_1', kind: 'line', p: ['pt_a', 'pt_b'] },
      { id: 'e_2', kind: 'line', p: ['pt_b', 'pt_c'] },
      { id: 'e_3', kind: 'line', p: ['pt_c', 'pt_d'] },
      { id: 'e_4', kind: 'line', p: ['pt_d', 'pt_a'] },
    ],
  };
}
