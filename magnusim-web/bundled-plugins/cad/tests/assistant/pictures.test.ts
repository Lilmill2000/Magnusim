// A picture after every edit (src/assistant/pictures.ts): each edit call that answers ok (every
// tool whose risk is not read) carries one picture of the Part, iso, 640 x 480, PNG, drawn off
// screen by the viewport's snapshot, with data.picture saying what it shows; reads carry none; a
// model that reads no images, the person's Pictures off, an outside client's call (ext:, mcp:)
// unless its model reads images, no 3D view and a lost context get none; a failed edit gets none;
// a snapshot or encoding that fails keeps the edit ok with data.picture_note; the ledger counts
// the images. The person's choice is read from ws.prefs, written there, heard from another tab,
// and the test handle's override is never written.
// SPDX-License-Identifier: GPL-3.0-or-later
import type { AssistantCall } from '@magnusim/workspace';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createCallHandler } from '../../src/assistant/call';
import { ToolError } from '../../src/assistant/errors';
import { createPictures, EDIT_PICTURE_PX, editPicture, PICTURE_SETTLE_MS, PICTURES_PREF, wantsPicture, type Pictures } from '../../src/assistant/pictures';
import { runtimeOf } from '../../src/assistant/runtime';
import { CAD_TOOLS } from '../../src/assistant/schemas';
import { assistantTestHandle } from '../../src/assistant/install';
import { setViewRaster, type Ctx2D, type Raster } from '../../src/assistant/view';
import type { PrefsApi } from '../../src/lib/bridge';
import type { AppServices } from '../../src/types/app';
import type { ToolImpl, TurnFacts } from '../../src/types/assistant';
import type { SnapshotOptions, SnapshotResult, ViewportHandle } from '../../src/types/viewport';
import { FakeKernel } from '../doc/fake-kernel';
import { assistantHarness, type AssistantHarness } from './harness';

let h: AssistantHarness | null = null;
afterEach(() => {
  h?.dispose();
  h = null;
  setViewRaster(null);
});

// The workspace tool's answers are view and session state (undo_step false): no picture (the last test).
const EDITS = CAD_TOOLS.filter((t) => t.risk !== 'read' && t.name !== 'workspace').map((t) => t.name);
const READS = CAD_TOOLS.filter((t) => t.risk === 'read').map((t) => t.name);

/** Every tool answers ok at once with a line of its own (the edit tools' work is not what is tested here). */
const STUBS: Record<string, ToolImpl> = Object.fromEntries(CAD_TOOLS.map((t) => [t.name, { kind: t.risk === 'read' ? 'read' : 'edit', run: async () => ({ text: `${t.name} ok`, data: { did: t.name, ...(t.name === 'workspace' ? { undo_step: false } : {}) } }) } as ToolImpl]));

interface FakeView {
  shots: SnapshotOptions[];
  lost: boolean;
  fail: Error | null;
}

/** A viewport whose snapshot answers one grey picture of the size asked. */
function fakeViewport(x: AssistantHarness, o: { snapshot?: boolean } = {}): FakeView {
  const fv: FakeView = { shots: [], lost: false, fail: null };
  const snapshot = (opts: SnapshotOptions): SnapshotResult => {
    if (fv.lost) throw Object.assign(new Error('not_ready'), { code: 'not_ready' });
    if (fv.fail) throw fv.fail;
    fv.shots.push(JSON.parse(JSON.stringify(opts)));
    return { rgba: new Uint8ClampedArray(opts.width * opts.height * 4).fill(128), width: opts.width, height: opts.height, mmPerPx: 0.1, project: () => null, visibleFaceAt: () => null };
  };
  const handle = {
    camera: () => ({ position: [100, -100, 100], target: [0, 0, 0], up: [0, 0, 1], projection: 'perspective' }),
    userCameraMoves: () => 0,
    stats: () => ({ frames: 0, lastFrameMs: 0, lastSetBodiesMs: 0, lastUploadFrameMs: 0, lastPickMs: 0, bvh: {}, triangles: 0, drawCalls: 0, contextLost: fv.lost }),
    ...(o.snapshot === false ? {} : { snapshot }),
  } as unknown as ViewportHandle;
  x.services.viewport.set({ handle });
  return fv;
}

/** A canvas that encodes a PNG of 4 KB (null: a page with no 2D canvas). */
function fakeRaster(o: { context?: boolean } = {}): { sizes: [number, number][] } {
  const sizes: [number, number][] = [];
  const raster: Raster = (width, height) => {
    sizes.push([width, height]);
    const g = {
      createImageData: (w: number, ht: number) => ({ width: w, height: ht, data: new Uint8ClampedArray(w * ht * 4) }) as unknown as ImageData,
      putImageData: () => undefined,
      fillRect: () => undefined,
      strokeRect: () => undefined,
      fillText: () => undefined,
    } as unknown as Ctx2D;
    return { getContext: () => (o.context === false ? null : g), convertToBlob: async (b) => new Blob([new Uint8Array(4096)], { type: b.type }) };
  };
  setViewRaster(raster);
  return { sizes };
}

type Answer = { ok: true; result: { text: string; data: Record<string, unknown>; images?: { mediaType: string; data: Blob }[] } } | { ok: false; error: { code: string } };

/** One call through the page's handler with the stub tools, as the bridge sends it. */
async function call(x: AssistantHarness, tool: string, turn = 't-test', tools: Record<string, ToolImpl> = STUBS): Promise<Answer> {
  const handler = createCallHandler(runtimeOf(x.services)!, tools);
  const c: AssistantCall = { call: `c-${Math.random().toString(36).slice(2)}`, turn, tool, input: {}, signal: new AbortController().signal, progress: () => {} };
  try {
    return { ok: true, result: (await handler(c)) as Answer extends { result: infer R } ? R : never };
  } catch (e) {
    return { ok: false, error: { code: String((e as { code?: unknown }).code) } };
  }
}

const start = async (images: boolean | null = true) => {
  const x = await assistantHarness({ kernel: new FakeKernel() });
  x.fake.emitTurn({ id: 't-test', title: 'Build', images: images as boolean });
  return x;
};

describe('a picture after every edit', () => {
  it('an answer that changed no model (the workspace tool's undo_step false) carries none', async () => {
    h = await start(true);
    const fv = fakeViewport(h);
    fakeRaster();
    const r = await call(h, 'workspace');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.result.images).toBeUndefined();
    expect(fv.shots).toHaveLength(0);
  });

  it('each edit tool that answers ok carries one iso picture, 640 x 480 PNG, with its line in data; reads carry none', async () => {
    h = await start(true);
    const fv = fakeViewport(h);
    const { sizes } = fakeRaster();
    expect(EDITS.sort()).toEqual(['body', 'combine', 'construct', 'delete', 'direct', 'edit_feature', 'extrude', 'hole', 'modify', 'pattern', 'revolve', 'set_params', 'sketch', 'sweep_loft', 'undo']);
    for (const tool of EDITS) {
      const r = await call(h, tool);
      expect(r.ok, tool).toBe(true);
      if (!r.ok) continue;
      expect(r.result.images, tool).toHaveLength(1);
      expect(r.result.images![0].mediaType).toBe('image/png');
      expect(r.result.images![0].data.size).toBeLessThan(1.5 * 1024 * 1024);
      expect(r.result.data).toMatchObject({ did: tool, picture: expect.stringMatching(/^Picture: iso view of the Part framed on .+, 640x480, real colours; look at it and fix what looks wrong\.$/) });
      expect(r.result.data.picture_note).toBeUndefined();
    }
    expect(fv.shots).toHaveLength(EDITS.length);
    expect(fv.shots.every((s) => s.view === 'iso' && s.width === EDIT_PICTURE_PX.width && s.height === EDIT_PICTURE_PX.height && s.hide.length === 0 && s.section === null)).toBe(true);
    expect(sizes.every(([w, ht]) => w === 640 && ht === 480)).toBe(true);
    // The ledger counts each answer's images (the eval's record adds them up).
    const rt = runtimeOf(h.services)!;
    expect(rt.calls.slice(-EDITS.length).map((c) => c.images)).toEqual(EDITS.map(() => 1));
    for (const tool of READS.filter((t) => t !== 'view')) {
      const r = await call(h, tool);
      expect(r.ok && r.result.images, tool).toBeFalsy();
      expect(r.ok && r.result.data.picture, tool).toBeUndefined();
    }
    expect(fv.shots).toHaveLength(EDITS.length);
    expect(rt.calls.at(-1)!.images).toBeUndefined();
  });

  it('an edit that fails gets no picture', async () => {
    h = await start(true);
    const fv = fakeViewport(h);
    fakeRaster();
    const failing = { ...STUBS, extrude: { kind: 'edit', run: async () => Promise.reject(new ToolError('bad_input', 'No.')) } as ToolImpl };
    const r = await call(h, 'extrude', 't-test', failing);
    expect(r).toMatchObject({ ok: false, error: { code: 'invalid_input' } });
    expect(fv.shots).toEqual([]);
  });

  it('no picture for a model that reads no images, with Pictures off, for an outside client unless its model reads images, without a 3D view or with a lost context', async () => {
    h = await start(false);
    const fv = fakeViewport(h);
    fakeRaster();
    const pictureOf = async (turn = 't-test') => {
      const r = await call(h!, 'extrude', turn);
      expect(r.ok).toBe(true);
      return r.ok ? (r.result.images?.length ?? 0) : -1;
    };
    // images false: none, and nothing drawn.
    expect(await pictureOf()).toBe(0);
    // images not known (an older host): the picture goes.
    h.fake.emitTurn({ id: 't-unknown', title: 'Build', images: null as unknown as boolean });
    expect(await pictureOf('t-unknown')).toBe(1);
    // The person's Pictures off: none.
    h.fake.emitTurn({ id: 't-yes', title: 'Build', images: true });
    runtimeOf(h.services)!.pictures.force('off');
    expect(await pictureOf('t-yes')).toBe(0);
    runtimeOf(h.services)!.pictures.force(null);
    expect(await pictureOf('t-yes')).toBe(1);
    // An outside client's call (no turn: ext:1; another app over MCP: mcp:<session>): none.
    expect(await pictureOf('')).toBe(0);
    expect(await pictureOf('mcp:conn-1')).toBe(0);
    // A lost context: none, and no note (there is nothing to draw with).
    fv.lost = true;
    const lost = await call(h, 'extrude', 't-yes');
    expect(lost.ok && [lost.result.images, lost.result.data.picture_note]).toEqual([undefined, undefined]);
    fv.lost = false;
    expect(fv.shots).toHaveLength(2);
    // No snapshot (an older viewport) or no 3D view: none.
    fakeViewport(h, { snapshot: false });
    expect(await pictureOf('t-yes')).toBe(0);
    h.services.viewport.set({ handle: null });
    expect(await pictureOf('t-yes')).toBe(0);
  });

  it('an outside call gets the picture only when its model is known to read images', () => {
    const turn = (images: boolean | null) => ({ images }) as TurnFacts;
    expect(wantsPicture({ tool: 'extrude', key: 'ext:1', turn: null }, 'each')).toBe(false);
    expect(wantsPicture({ tool: 'extrude', key: 'mcp:a#2', turn: turn(null) }, 'each')).toBe(false);
    expect(wantsPicture({ tool: 'extrude', key: 'mcp:a', turn: turn(true) }, 'each')).toBe(true);
    expect(wantsPicture({ tool: 'extrude', key: 'turn:t', turn: null }, 'each')).toBe(true);
    expect(wantsPicture({ tool: 'extrude', key: 'turn:t', turn: turn(true) }, 'off')).toBe(false);
    expect(wantsPicture({ tool: 'find', key: 'turn:t', turn: turn(true) }, 'each')).toBe(false);
    expect(wantsPicture({ tool: 'nope', key: 'turn:t', turn: turn(true) }, 'each')).toBe(false);
  });

  it('a snapshot or encoding that fails keeps the edit ok, with a short note instead of the picture', async () => {
    h = await start(true);
    const fv = fakeViewport(h);
    fakeRaster();
    fv.fail = new Error('The GPU said no.');
    const r = await call(h, 'extrude');
    expect(r).toMatchObject({ ok: true, result: { text: 'extrude ok', data: { did: 'extrude', picture_note: 'No picture this time: The GPU said no.' } } });
    expect(r.ok && r.result.images).toBeFalsy();
    expect(r.ok && r.result.data.picture).toBeUndefined();
    fv.fail = null;
    fakeRaster({ context: false });
    const r2 = await call(h, 'set_params');
    expect(r2).toMatchObject({ ok: true, result: { data: { picture_note: expect.stringMatching(/^No picture this time: This page cannot draw pictures/) } } });
    expect(runtimeOf(h.services)!.calls.at(-1)).toMatchObject({ tool: 'set_params', ok: true });
    expect(runtimeOf(h.services)!.calls.at(-1)!.images).toBeUndefined();
  });

  it('a rebuild still running after PICTURE_SETTLE_MS: a note, nothing drawn', async () => {
    vi.useFakeTimers();
    try {
      const shots: unknown[] = [];
      const handle = { stats: () => ({ contextLost: false }), snapshot: (o: unknown) => void shots.push(o) };
      const services = { viewport: { get: () => ({ handle }) }, doc: { settled: () => new Promise(() => undefined), state: { get: () => ({ rebuild: { bodies: [] } }) } } } as unknown as AppServices;
      const pic = editPicture({ services, signal: new AbortController().signal });
      await vi.advanceTimersByTimeAsync(PICTURE_SETTLE_MS + 1);
      expect(await pic).toEqual({ note: 'No picture this time: the Part was still rebuilding.' });
      expect(shots).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('the real set_params answers with the picture through the fake host', async () => {
    h = await start(true);
    const fv = fakeViewport(h);
    fakeRaster();
    const r = await h.call('set_params', { set: [{ name: 'w', kind: 'length', expr: '40 mm', comment: '', rename_to: '' }], remove: [] });
    expect(r.ok).toBe(true);
    const res = (r as unknown as { result: { data: Record<string, unknown>; images?: unknown[] } }).result;
    expect(res.images).toHaveLength(1);
    expect(res.data.picture).toMatch(/^Picture: iso view of the Part framed on the shown sketches \(no body yet\)/);
    expect(fv.shots).toHaveLength(1);
  });
});

describe("the person's Pictures choice", () => {
  it('is read from ws.prefs, written there, heard from another tab; a test override is never written', async () => {
    const stored = new Map<string, unknown>([[PICTURES_PREF, 'off']]);
    let hear: ((key: string, value: unknown) => void) | null = null;
    const prefs: PrefsApi = {
      get: async <T,>(k: string) => (stored.get(k) ?? null) as T | null,
      set: async (k, v) => void stored.set(k, v),
      remove: async (k) => void stored.delete(k),
      onChange: (fn) => {
        hear = fn;
        return () => (hear = null);
      },
    };
    const p = createPictures({ prefs });
    const heard: Pictures[] = [];
    p.subscribe((v) => void heard.push(v));
    expect(createPictures({ prefs: null }).get()).toBe('each');
    await vi.waitFor(() => expect(p.get()).toBe('off'), { timeout: 10_000 });
    p.set('each');
    expect(stored.get(PICTURES_PREF)).toBe('each');
    hear!(PICTURES_PREF, 'off');
    expect(p.get()).toBe('off');
    // A value it does not know (a removed key) is the default.
    hear!(PICTURES_PREF, null);
    expect(p.get()).toBe('each');
    hear!('other', 'off');
    expect(heard).toEqual(['off', 'each', 'off', 'each']);
    p.force('off');
    expect(p.get()).toBe('off');
    expect(stored.get(PICTURES_PREF)).toBe('each');
    p.force(null);
    expect(p.get()).toBe('each');
    p.dispose();
    expect(hear).toBeNull();
  });

  it("the chip's action writes the choice and the chip's state follows; the test handle overrides it", async () => {
    h = await start(true);
    const rt = runtimeOf(h.services)!;
    expect(rt.store.get().pictures).toBe('each');
    h.services.apis.get().assistant!.actions!.setPictures('off');
    expect(rt.store.get().pictures).toBe('off');
    expect(rt.pictures.get()).toBe('off');
    h.services.apis.get().assistant!.actions!.setPictures('each');
    expect(rt.store.get().pictures).toBe('each');
    assistantTestHandle(h.services)!.setPictures('off');
    expect(rt.store.get().pictures).toBe('off');
    assistantTestHandle(h.services)!.setPictures(null);
    expect(rt.store.get().pictures).toBe('each');
  });
});
