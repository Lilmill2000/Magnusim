// Shared pieces of the after-edit picture tests: a viewport whose snapshot answers a grey picture,
// a canvas that encodes a 4 KB PNG, stub tools that answer ok at once, one call through the page's
// handler as the bridge sends it (with what else the host may put on the call), and each call's
// place in a model step as the host counts it (placesOf).
// SPDX-License-Identifier: GPL-3.0-or-later
import type { AssistantCall } from '@magnusim/workspace';
import { createCallHandler } from '../../src/assistant/call';
import { runtimeOf } from '../../src/assistant/runtime';
import { CAD_TOOLS } from '../../src/assistant/schemas';
import { setViewRaster, type Ctx2D, type Raster } from '../../src/assistant/view';
import type { ToolImpl } from '../../src/types/assistant';
import type { SnapshotOptions, SnapshotResult, ViewportHandle } from '../../src/types/viewport';
import type { AssistantHarness } from './harness';

/** Every tool answers ok at once with a line of its own (the edit tools' work is not what is tested here). */
export const STUBS: Record<string, ToolImpl> = Object.fromEntries(CAD_TOOLS.map((t) => [t.name, { kind: t.risk === 'read' ? 'read' : 'edit', run: async () => ({ text: `${t.name} ok`, data: { did: t.name, ...(t.name === 'workspace' ? { undo_step: false } : {}) } }) } as ToolImpl]));

export interface FakeView {
  shots: SnapshotOptions[];
  lost: boolean;
  fail: Error | null;
}

/** A viewport whose snapshot answers one grey picture of the size asked. */
export function fakeViewport(x: AssistantHarness, o: { snapshot?: boolean } = {}): FakeView {
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
export function fakeRaster(o: { context?: boolean } = {}): { sizes: [number, number][] } {
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

export type Answer = { ok: true; result: { text: string; data: Record<string, unknown>; images?: { mediaType: string; data: Blob }[] } } | { ok: false; error: { code: string; detail?: Record<string, unknown> } };

/**
 * The host's place of each call of one model step (AssistantCall.step, callsLeftInStep,
 * editsLeftInStep): the calls after it, and how many of those are edits (a tool whose risk is not read).
 */
export function placesOf(tools: string[], step = 1): Record<string, number>[] {
  const isEdit = (name: string) => CAD_TOOLS.find((t) => t.name === name)?.risk !== 'read';
  return tools.map((_, i) => ({ step, callsLeftInStep: tools.length - 1 - i, editsLeftInStep: tools.slice(i + 1).filter(isEdit).length }));
}

/** One call through the page's handler with the stub tools, as the bridge sends it; `extra` goes on the call (a newer host's fields). */
export async function call(x: AssistantHarness, tool: string, turn = 't-test', tools: Record<string, ToolImpl> = STUBS, extra: Record<string, unknown> = {}): Promise<Answer> {
  const handler = createCallHandler(runtimeOf(x.services)!, tools);
  const c = { call: `c-${Math.random().toString(36).slice(2)}`, turn, tool, input: {}, signal: new AbortController().signal, progress: () => {}, ...extra } as AssistantCall;
  try {
    return { ok: true, result: (await handler(c)) as Answer extends { result: infer R } ? R : never };
  } catch (e) {
    const f = e as { code?: unknown; detail?: Record<string, unknown> };
    return { ok: false, error: { code: String(f.code), ...(f.detail ? { detail: f.detail } : {}) } };
  }
}
