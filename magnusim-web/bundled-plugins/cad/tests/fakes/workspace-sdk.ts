// A fake '@magnusim/workspace' for unit tests (vitest aliases the module here).
// createFakeWorkspace() gives an in-memory bridge: study record with revs, the
// plugin's folder (ws.data JSON and ws.files bytes over the same files, as on
// the host), toasts, dialogs and setDirty recorded, workers from a factory you
// pass. hostVersion "1.1" by default (ws.data only); pass "1.2" for ws.files.
// nav.onLeave (host 1.6) keeps the handler in `leaveHook`; a host before 1.6
// refuses it with not_allowed, as the real one does.
// Edit in CAD (host 1.7): pass `edit` for ws.context.geometry / launch and
// ws.project.geometrySource / geometryFaces (with hostVersion "1.7").
// The app's Assistant (unreleased 1.9): pass `assistant` for a scriptable ws.assistant
// (tests/fakes/assistant-sdk.ts; `assistantFake` is it). Without it there is no ws.assistant.
// The Assistant panel's keys (unreleased 1.9): pass `assistantKeys` (a list, or null for the
// default) for ws.context.assistantKeys; push('assistantKeys', keys) is the host's change, as the
// SDK takes it (the context first, then the listeners). Without it the welcome has none.
// The host's appearance (unreleased, SDK 1.5): pass `appearance` for ws.context.appearance, and
// push('appearance', a) for its event (the context follows, as the SDK's does). Without it the
// context has none, as an older host's.
// SPDX-License-Identifier: GPL-3.0-or-later
import type { ConfirmOptions, LeaveHandler, PromptOptions, StudyRecord, UnitSystem, Workspace, WorkspaceContext } from '@magnusim/workspace';
import { FakeFiles, FakeFolder } from '../doc/fake-files';
import { createFakeAssistant, type FakeAssistant, type FakeAssistantOptions } from './assistant-sdk';

export const SDK_VERSION = '1.1.0';

export interface FakeWorkspace extends Workspace {
  /** What the fake recorded. */
  readonly log: {
    toasts: { message: string; kind: string }[];
    confirms: ConfirmOptions[];
    prompts: PromptOptions[];
    dataWrites: { rel: string; doc: unknown }[];
    backs: number;
    /** Every nav.setDirty call, in order. */
    dirty: { dirty: boolean; message: string }[];
  };
  /** The plugin's folder of the project (what ws.data and ws.files both see). */
  readonly folder: FakeFolder;
  /** ws.files over that folder (set `refuse`, `failNext`, `hold` to script the host). */
  readonly files: FakeFiles;
  /** ws.assistant when the fake was made with `assistant` (it is the same object), else null. */
  readonly assistantFake: FakeAssistant | null;
  /** The JSON in a file of the folder (null when there is none). */
  json(rel: string): unknown;
  /** Answers for the next dialogs. */
  answers: { confirm: boolean; prompt: string | null };
  /** The exit hook the page registered (host 1.6 nav.onLeave), or null. */
  leaveHook: LeaveHandler | null;
  /** Push a host event (units change, study renamed in the header, the appearance changed). */
  push(event: 'units', v: UnitSystem): void;
  push(event: 'study', v: StudyRecord): void;
  push(event: 'assistantKeys', v: string[] | null): void;
  push(event: 'appearance', v: Record<string, unknown>): void;
}

export function fakeStudy(over: Partial<StudyRecord> = {}): StudyRecord {
  return {
    id: 'st-test',
    kind: 'part',
    title: 'Part 1',
    schema_version: 1,
    rev: 1,
    plugin: 'cad',
    plugin_name: 'Magnusim CAD',
    plugin_version: '0.1.0',
    created_at: '2026-09-30T00:00:00Z',
    updated_at: '2026-09-30T00:00:00Z',
    ...over,
  };
}

export function createFakeWorkspace(
  opts: {
    units?: UnitSystem;
    study?: Partial<StudyRecord>;
    spawnWorker?: (url: string) => Worker;
    hostVersion?: string;
    folder?: FakeFolder;
    /** Host API 1.5: what ws.project.linkedGeometry() answers (the calls exist only with it). */
    linked?: () => unknown;
    /** Host API 1.7 (Edit in CAD): the context's geometry and launch, and the two calls' answers. */
    edit?: {
      geometry: unknown;
      launch?: unknown;
      source?: (o?: { signal?: AbortSignal; onProgress?(done: number, total: number): void }) => Promise<unknown>;
      faces?: () => Promise<unknown>;
    };
    /** Unreleased 1.9: a scriptable ws.assistant (true for the defaults: turn events on). */
    assistant?: FakeAssistantOptions | true;
    /** Unreleased 1.9: ws.context.assistantKeys (null: the default); left out, the welcome has none. */
    assistantKeys?: string[] | null;
    /** Unreleased (SDK 1.5): ws.context.appearance ({theme, preference, textScale, iconScale}). */
    appearance?: Record<string, unknown>;
  } = {},
): FakeWorkspace {
  let study = fakeStudy(opts.study);
  const assistantFake = opts.assistant ? createFakeAssistant(opts.assistant === true ? {} : opts.assistant) : null;
  const listeners = { units: new Set<(v: UnitSystem) => void>(), study: new Set<(v: StudyRecord) => void>(), theme: new Set<(v: unknown) => void>(), assistantKeys: new Set<(v: unknown) => void>(), appearance: new Set<(v: unknown) => void>() };
  const log: FakeWorkspace['log'] = { toasts: [], confirms: [], prompts: [], dataWrites: [], backs: 0, dirty: [] };
  const folder = opts.folder ?? new FakeFolder();
  const files = new FakeFiles(folder);
  const context: WorkspaceContext = {
    plugin: 'cad',
    workspace: 'part',
    project: { id: 'proj-test', title: 'Test project' },
    study,
    units: opts.units ?? 'metric',
    theme: { name: 'light', stylesheet: '/plugin-sdk/theme.css' },
    hostVersion: opts.hostVersion ?? '1.1',
    ...(opts.edit ? { geometry: opts.edit.geometry, launch: opts.edit.launch ?? null } : {}),
    ...('assistantKeys' in opts ? { assistantKeys: opts.assistantKeys ?? null } : {}),
    ...(opts.appearance ? { appearance: { ...opts.appearance } } : {}),
  } as WorkspaceContext;
  const clone = <T>(v: T): T => (v === undefined ? v : (JSON.parse(JSON.stringify(v)) as T));
  const ws = {
    context,
    log,
    folder,
    files,
    assistantFake,
    ...(assistantFake ? { assistant: assistantFake } : {}),
    json: (rel: string) => folder.json(rel),
    answers: { confirm: true, prompt: null },
    async call() {
      throw new Error('fake workspace: call() is not supported');
    },
    async service() {
      throw new Error('fake workspace: the CAD plugin has no backend methods');
    },
    study: {
      async get() {
        return clone(study);
      },
      async update(patch: Record<string, unknown>, rev: number) {
        if (rev !== study.rev) throw new Error('This study was changed elsewhere (stale rev)');
        study = { ...study, ...clone(patch), rev: study.rev + 1, updated_at: new Date().toISOString() };
        context.study = clone(study);
        for (const fn of listeners.study) fn(clone(study));
        return clone(study);
      },
    },
    data: {
      async read<T>(rel: string) {
        return folder.has(rel) ? (folder.json(rel) as T) : null;
      },
      async write(rel: string, doc: unknown) {
        log.dataWrites.push({ rel, doc: clone(doc) });
        folder.putJson(rel, doc);
      },
    },
    jobs: {
      async start() {
        throw new Error('fake workspace: no jobs');
      },
      events() {
        return () => {};
      },
      async stop() {},
    },
    project: {
      async info() {
        return { id: context.project.id, title: context.project.title, units: context.units };
      },
      ...(opts.linked
        ? {
            async linkGeometry() {
              throw Object.assign(new Error('fake workspace: linkGeometry is not scripted'), { code: 'failed' });
            },
            async linkedGeometry() {
              return opts.linked!();
            },
          }
        : {}),
      ...(opts.edit
        ? {
            async geometrySource(o?: { signal?: AbortSignal; onProgress?(done: number, total: number): void }) {
              if (!opts.edit!.source) throw Object.assign(new Error('fake workspace: geometrySource is not scripted'), { code: 'failed' });
              return opts.edit!.source(o);
            },
            async geometryFaces() {
              if (!opts.edit!.faces) throw Object.assign(new Error('fake workspace: geometryFaces is not scripted'), { code: 'failed' });
              return opts.edit!.faces();
            },
          }
        : {}),
    },
    ui: {
      async toast(message: string, o?: { kind?: string }) {
        log.toasts.push({ message, kind: o?.kind ?? 'info' });
      },
      async confirm(o: ConfirmOptions) {
        log.confirms.push(o);
        return ws.answers.confirm;
      },
      async prompt(o: PromptOptions) {
        log.prompts.push(o);
        return ws.answers.prompt;
      },
    },
    nav: {
      async back() {
        log.backs += 1;
        return true;
      },
      async setDirty(dirty: boolean, message?: string) {
        log.dirty.push({ dirty: dirty === true, message: String(message ?? '') });
      },
      async onLeave(handler: LeaveHandler | null) {
        const [maj, min] = String(context.hostVersion).split('.').map(Number);
        if (maj < 1 || (maj === 1 && min < 6)) throw Object.assign(new Error('This version of Magnusim has no exit hook'), { code: 'not_allowed' });
        ws.leaveHook = handler;
      },
    },
    leaveHook: null,
    on(event: 'units' | 'theme' | 'study' | 'assistantKeys' | 'appearance', fn: (v: never) => void) {
      const set = listeners[event] as Set<(v: never) => void>;
      set.add(fn);
      return () => set.delete(fn);
    },
    spawnWorker(url: string | URL) {
      if (!opts.spawnWorker) throw new Error('fake workspace: pass spawnWorker to createFakeWorkspace');
      return opts.spawnWorker(String(url));
    },
    push(event: 'units' | 'study' | 'assistantKeys' | 'appearance', v: UnitSystem | StudyRecord | string[] | null | Record<string, unknown>) {
      if (event === 'study') {
        study = clone(v as StudyRecord);
        context.study = clone(study);
      }
      if (event === 'assistantKeys') context.assistantKeys = clone(v as string[] | null);
      if (event === 'appearance') context.appearance = clone(v as unknown as WorkspaceContext['appearance']);
      for (const fn of listeners[event] as Set<(x: unknown) => void>) fn(clone(v));
    },
  } as unknown as FakeWorkspace;
  return ws;
}

let connectWith: FakeWorkspace | null = null;
/** Make the next connect() resolve with this fake. */
export function setFakeConnection(ws: FakeWorkspace | null): void {
  connectWith = ws;
}

export async function connect(): Promise<Workspace> {
  if (!connectWith) throw new Error('Not inside a Magnusim workspace');
  return connectWith;
}
