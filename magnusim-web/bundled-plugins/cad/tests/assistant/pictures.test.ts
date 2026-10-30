// A picture after every edit (src/assistant/pictures.ts): each edit call that answers ok (every
// tool whose risk is not read) carries one picture of the Part, iso, 640 x 480, PNG, drawn off
// screen by the viewport's snapshot, with data.picture saying what it shows; reads carry none; a
// model that reads no images, the person's Pictures off, an outside client's call (ext:, mcp:)
// unless its model reads images, no 3D view and a lost context get none; a failed edit gets none;
// a snapshot or encoding that fails keeps the edit ok with data.picture_note; the ledger counts
// the images. When the host says each call's place in its step (step, callsLeftInStep,
// editsLeftInStep), one picture per step, on the edit after which no edit follows: a lone edit
// keeps it, reads between edits change nothing, a read after the step's last edit that failed
// carries it, else the failed edit says "comes with your next step" and that step brings it (the
// chat's next request when the turn names its conversation); the earlier edits say "see this
// step's last edit"; a place out of shape reads as none. The person's
// choice is read from ws.prefs, written there, heard from another tab, and the test
// handle's override is never written.
// SPDX-License-Identifier: GPL-3.0-or-later
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ToolError } from '../../src/assistant/errors';
import { createPictures, EDIT_PICTURE_PX, editPicture, PICTURE_LATER, PICTURE_NEXT, PICTURE_SETTLE_MS, PICTURES_PREF, placeOf, stepPicture, wantsPicture, type Pictures } from '../../src/assistant/pictures';
import { runtimeOf } from '../../src/assistant/runtime';
import { CAD_TOOLS } from '../../src/assistant/schemas';
import { assistantTestHandle } from '../../src/assistant/install';
import { setViewRaster } from '../../src/assistant/view';
import type { AssistantCall } from '@magnusim/workspace';
import type { PrefsApi } from '../../src/lib/bridge';
import type { AppServices } from '../../src/types/app';
import type { ToolImpl, TurnFacts } from '../../src/types/assistant';
import { FakeKernel } from '../doc/fake-kernel';
import { assistantHarness, type AssistantHarness } from './harness';
import { call, fakeRaster, fakeViewport, placesOf, STUBS, type Answer } from './picture-fakes';

let h: AssistantHarness | null = null;
afterEach(() => {
  h?.dispose();
  h = null;
  setViewRaster(null);
});

// The workspace tool's answers are view and session state (undo_step false): no picture (the last test).
const EDITS = CAD_TOOLS.filter((t) => t.risk !== 'read' && t.name !== 'workspace').map((t) => t.name);
const READS = CAD_TOOLS.filter((t) => t.risk === 'read').map((t) => t.name);

const start = async (images: boolean | null = true) => {
  const x = await assistantHarness({ kernel: new FakeKernel() });
  x.fake.emitTurn({ id: 't-test', title: 'Build', images: images as boolean });
  return x;
};

describe('a picture after every edit', () => {
  it("an answer that changed no model (the workspace tool's undo_step false) carries none", async () => {
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

describe("one picture per model step (the host's place of each call)", () => {
  /** One model step: its calls in order, each told its place (edits counted as the host counts them). */
  async function runStep(x: AssistantHarness, tools: string[], o: { turn?: string; table?: Record<string, ToolImpl>; step?: number } = {}): Promise<Answer[]> {
    const out: Answer[] = [];
    const places = placesOf(tools, o.step);
    for (const [i, tool] of tools.entries()) out.push(await call(x, tool, o.turn ?? 't-test', o.table ?? STUBS, places[i]));
    return out;
  }
  const imagesOf = (rs: Answer[]) => rs.map((r) => (r.ok ? (r.result.images?.length ?? 0) : -1));
  const linesOf = (rs: Answer[]) => rs.map((r) => (r.ok ? r.result.data.picture : undefined));
  const CAPTION = expect.stringMatching(/^Picture: iso view of the Part/);
  const failing = (tool: string) => ({ ...STUBS, [tool]: { kind: 'edit', run: async () => Promise.reject(new ToolError('bad_input', 'No.')) } as ToolImpl });

  it('a lone edit still gets its picture; reads after the last edit get none, and a step of reads only gets none', async () => {
    h = await start(true);
    const fv = fakeViewport(h);
    fakeRaster();
    const lone = await runStep(h, ['extrude']);
    expect([imagesOf(lone), linesOf(lone)]).toEqual([[1], [CAPTION]]);
    const rs = await runStep(h, ['extrude', 'pattern', 'get_model', 'measure'], { step: 2 });
    expect(imagesOf(rs)).toEqual([0, 1, 0, 0]);
    expect(linesOf(rs)).toEqual([PICTURE_LATER, CAPTION, undefined, undefined]);
    const reads = await runStep(h, ['find', 'measure'], { step: 3 });
    expect([imagesOf(reads), linesOf(reads)]).toEqual([[0, 0], [undefined, undefined]]);
    expect(fv.shots).toHaveLength(2);
  });

  it("a step whose last edit fails: a read after it brings the picture; when the failed edit is the step's last call it says so, and the turn's next step brings it once", async () => {
    h = await start(true);
    const fv = fakeViewport(h);
    fakeRaster();
    const rs = await runStep(h, ['sketch', 'extrude', 'get_model'], { table: failing('extrude') });
    expect(imagesOf(rs)).toEqual([0, -1, 1]);
    expect(linesOf(rs)).toEqual([PICTURE_LATER, undefined, CAPTION]);
    expect(fv.shots).toHaveLength(1);
    // The failed edit is the step's last call: its error says the next step brings the picture.
    h.fake.emitTurn({ id: 't-other', title: 'Other', images: true });
    const ends = await runStep(h, ['sketch', 'extrude'], { table: failing('extrude'), step: 2 });
    expect(imagesOf(ends)).toEqual([0, -1]);
    expect(ends[1].ok ? null : ends[1].error.detail).toMatchObject({ picture: PICTURE_NEXT });
    expect(PICTURE_NEXT).toBe('comes with your next step');
    // Another turn's step owes nothing; this turn's next step brings it at its last edit, once.
    expect(imagesOf(await runStep(h, ['get_model'], { turn: 't-other' }))).toEqual([0]);
    const next = await runStep(h, ['get_model', 'extrude', 'extrude'], { step: 3 });
    expect([imagesOf(next), linesOf(next)]).toEqual([[0, 0, 1], [undefined, PICTURE_LATER, CAPTION]]);
    expect(imagesOf(await runStep(h, ['get_model'], { step: 4 }))).toEqual([0]);
    // A step that ends on a failed edit, then a step of reads: its first read brings it.
    await runStep(h, ['sketch', 'extrude'], { table: failing('extrude'), step: 5 });
    expect(imagesOf(await runStep(h, ['get_model', 'find'], { step: 6 }))).toEqual([1, 0]);
    // A failed last call owing nothing says nothing of a picture.
    const plain = await runStep(h, ['extrude'], { table: failing('extrude'), step: 7 });
    expect(plain[0].ok ? null : plain[0].error.detail).not.toHaveProperty('picture');
    expect(fv.shots).toHaveLength(3);
  });

  it("a request that ends on a step whose failed edit owes the picture: the conversation's next request brings it at its first read, another conversation's never", async () => {
    h = await start(true);
    const fv = fakeViewport(h);
    fakeRaster();
    h.fake.emitTurn({ id: 't-r1', title: 'Build', images: true, conversation: 'conv-1' });
    const ends = await runStep(h, ['sketch', 'extrude'], { table: failing('extrude'), turn: 't-r1' });
    expect(imagesOf(ends)).toEqual([0, -1]);
    expect(ends[1].ok ? null : ends[1].error.detail).toMatchObject({ picture: PICTURE_NEXT });
    // The model ends its turn with text. Another chat's request owes nothing.
    h.fake.emitTurn({ id: 't-x', title: 'Other', images: true, conversation: 'conv-2' });
    expect(imagesOf(await runStep(h, ['get_model'], { turn: 't-x' }))).toEqual([0]);
    // The person's next message in the same chat: its first read brings the sketch's picture, once.
    h.fake.emitTurn({ id: 't-r2', title: 'Build', images: true, conversation: 'conv-1' });
    const next = await runStep(h, ['get_model'], { turn: 't-r2' });
    expect([imagesOf(next), linesOf(next)]).toEqual([[1], [CAPTION]]);
    expect(imagesOf(await runStep(h, ['get_model'], { turn: 't-r2', step: 2 }))).toEqual([0]);
    expect(fv.shots).toHaveLength(1);
  });

  it("undo_step false changes nothing in a step and its last call brings an earlier edit's picture; a last call with its own picture (view) takes none and nothing stays owed", async () => {
    h = await start(true);
    const fv = fakeViewport(h);
    fakeRaster();
    const ws = await runStep(h, ['workspace', 'workspace']);
    expect([imagesOf(ws), linesOf(ws)]).toEqual([[0, 0], [undefined, undefined]]);
    const shown = await runStep(h, ['extrude', 'workspace'], { step: 2 });
    expect([imagesOf(shown), linesOf(shown)]).toEqual([[0, 1], [PICTURE_LATER, CAPTION]]);
    const own = new Blob([new Uint8Array(8)], { type: 'image/png' });
    const table = { ...STUBS, view: { kind: 'read', run: async () => ({ text: 'view ok', data: {}, images: [{ mediaType: 'image/png', data: own }] }) } as ToolImpl };
    const rs = await runStep(h, ['extrude', 'view', 'workspace'], { table, step: 3 });
    expect(imagesOf(rs)).toEqual([0, 1, 1]);
    expect(rs[1].ok && rs[1].result.images![0].data).toBe(own);
    expect(imagesOf(await runStep(h, ['get_model'], { step: 4 }))).toEqual([0]);
    expect(fv.shots).toHaveLength(2);
  });

  it('no pointer and no picture with the place either for a model that reads no images, with Pictures off, or for an outside client', async () => {
    h = await start(false);
    const fv = fakeViewport(h);
    fakeRaster();
    for (const rs of [await runStep(h, ['extrude', 'extrude']), await runStep(h, ['extrude', 'extrude'], { turn: '' })]) expect([imagesOf(rs), linesOf(rs)]).toEqual([[0, 0], [undefined, undefined]]);
    h.fake.emitTurn({ id: 't-yes', title: 'Build', images: true });
    runtimeOf(h.services)!.pictures.force('off');
    const off = await runStep(h, ['extrude', 'extrude'], { turn: 't-yes' });
    expect([imagesOf(off), linesOf(off)]).toEqual([[0, 0], [undefined, undefined]]);
    expect(fv.shots).toHaveLength(0);
  });

  it('the place is read defensively: all three whole numbers (step from 1, edits no more than calls) or none, and with none each ok edit gets its picture as before', async () => {
    const place = (o: Record<string, unknown>) => placeOf(o as unknown as AssistantCall);
    expect(place({ step: 2, callsLeftInStep: 3, editsLeftInStep: 1 })).toEqual({ step: 2, callsLeft: 3, editsLeft: 1 });
    expect(place({})).toBeNull();
    const bad: Record<string, unknown>[] = [
      { callsLeftInStep: 4, editsLeftInStep: 3 },
      { step: 1, editsLeftInStep: 3 },
      { step: 1, callsLeftInStep: 4 },
      { step: 0, callsLeftInStep: 4, editsLeftInStep: 3 },
      { step: 1, callsLeftInStep: 1, editsLeftInStep: 3 },
      ...[-1, 1.5, '2', Number.NaN, Number.POSITIVE_INFINITY, null].map((v) => ({ step: 1, callsLeftInStep: v, editsLeftInStep: 0 })),
      ...[-1, 0.5, '0'].map((v) => ({ step: 1, callsLeftInStep: 4, editsLeftInStep: v })),
    ];
    for (const b of bad) expect(place(b), JSON.stringify(b)).toBeNull();
    expect(stepPicture({ editsLeft: null, edits: true, owed: false, on: true })).toBe('now');
    expect(stepPicture({ editsLeft: 2, edits: true, owed: false, on: true })).toBe('later');
    expect(stepPicture({ editsLeft: 2, edits: false, owed: true, on: true })).toBe('none');
    expect(stepPicture({ editsLeft: 0, edits: false, owed: true, on: false })).toBe('none');
    h = await start(true);
    const fv = fakeViewport(h);
    fakeRaster();
    // Each of the first five would say "an edit follows" (3) if it were read: read as none, each gets its picture.
    const rs: Answer[] = [];
    for (const b of bad.slice(0, 5)) rs.push(await call(h, 'extrude', 't-test', STUBS, b));
    expect(imagesOf(rs)).toEqual([1, 1, 1, 1, 1]);
    expect(linesOf(rs).every((l) => l !== PICTURE_LATER)).toBe(true);
    expect(fv.shots).toHaveLength(5);
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
