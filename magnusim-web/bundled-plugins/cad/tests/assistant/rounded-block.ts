// The fillet and hole selectors' test part (S4), made with kernel ops and written to STEP in the
// test (never a file of Daniel's): Body 1, an 80 x 50 x 20 block with R5 on its 4 vertical edges
// and R2 round its top (4 straight rounds and the 4 corner pieces between them), four 6 mm
// through holes, and a counterbored hole in its middle (6 mm through, 10 mm 5 deep): 12 fillet
// faces, 5 drilled holes. With `body2`, a plain 20 x 20 x 20 box beside it is Body 2 (no
// fillets or holes). Imported through the import panel's own runs, as the person's Import STEP.
// SPDX-License-Identifier: GPL-3.0-or-later
import { expect, vi } from 'vitest';
import { createFileTransfer } from '../../src/files/transfer';
import { importDef } from '../../src/features/import/feature';
import { createImportRuns } from '../../src/features/import/runs';
import type { FeatureTypeDef } from '../../src/types/doc-service';
import type { KernelAdapter } from '../../src/types/kernel';
import type { AssistantHarness } from './harness';

type Call = KernelAdapter['call'];
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type R = Record<string, any>;

/** What the part holds (the tests' truth). */
export const ROUNDED_BLOCK = {
  /** Faces of Body 1: 6 sides, 4 R5, 8 R2, 4 + 1 hole walls, the counterbore's wall and floor. */
  faces: 25,
  fillets: { r2: 8, r5: 4 },
  holes: { d6: 4, counterbore: { d_min: 6, d_max: 10 } },
  /** The four 6 mm holes' centres, and the counterbore's. */
  at: [
    [15, 12],
    [65, 12],
    [15, 38],
    [65, 38],
  ],
  centre: [40, 25],
} as const;

/** Body 1 made with kernel ops (`top` false: without the R2 round its top, the sharp reference). */
export async function roundedBlock(call: Call, o: { top?: boolean } = {}): Promise<number> {
  const r = async (op: string, p: R): Promise<R> => (await call(op as never, p as never)).result as R;
  const near = (a: number, b: number) => Math.abs(a - b) < 1e-6;
  const edges = async (id: number): Promise<R[]> => (await r('topo', { id, faces: 'none', vertices: 'none', edge_ends: true })).edges;
  const box = (await r('box', { dx: 80, dy: 50, dz: 20, origin: [0, 0, 0] })).id as number;
  const vertical = (await edges(box)).filter((e) => near(e.first[0], e.last[0]) && near(e.first[1], e.last[1])).map((e) => e.i);
  let id = (await r('fillet', { id: box, edges: vertical, r: 5 })).id as number;
  if (o.top !== false) {
    const top = (await edges(id)).filter((e) => near(e.first[2], 20) && near(e.last[2], 20)).map((e) => e.i);
    id = (await r('fillet', { id, edges: top, r: 2 })).id as number;
  }
  const cyl = async (rad: number, h: number, origin: number[]) => (await r('cylinder', { r: rad, h, origin, axis: [0, 0, 1] })).id as number;
  const tools: number[] = [];
  for (const [x, y] of ROUNDED_BLOCK.at) tools.push(await cyl(3, 22, [x, y, -1]));
  const [cx, cy] = ROUNDED_BLOCK.centre;
  tools.push(await cyl(3, 22, [cx, cy, -1]), await cyl(5, 6, [cx, cy, 15]));
  return (await r('boolean', { op: 'cut', targets: [id], tools })).id as number;
}

/** The part as STEP bytes (Body 1, and Body 2 with `body2`), and the sharp reference's volume (no R2). */
export async function roundedBlockStep(call: Call, o: { body2?: boolean } = {}): Promise<{ step: Uint8Array; sharp: number; volume: number }> {
  const r = async (op: string, p: R) => call(op as never, p as never) as Promise<{ result: R; buffers: Record<string, ArrayBuffer> }>;
  const id = await roundedBlock(call);
  const shapes: R[] = [{ id, name: 'Body 1' }];
  if (o.body2) shapes.push({ id: (await r('box', { dx: 20, dy: 20, dz: 20, origin: [100, 0, 0] })).result.id, name: 'Body 2' });
  const out = await r('export_step', { shapes, schema: 'AP214' });
  const sharpId = await roundedBlock(call, { top: false });
  const sharp = (await r('props', { id: sharpId, volume: true, bbox: 'none' })).result.volume as number;
  const volume = (await r('props', { id, volume: true, bbox: 'none' })).result.volume as number;
  await r('release', { ids: [id, sharpId] });
  return { step: new Uint8Array(out.buffers.step), sharp, volume };
}

/** Import the part into the harness's Part as the person's Import STEP does; its feature id and the sharp reference's volume. */
export async function importRoundedBlock(h: AssistantHarness, o: { body2?: boolean } = {}): Promise<{ feature: string; sharp: number; volume: number }> {
  if (!h.doc.features.get('import')) h.doc.features.register(importDef as unknown as FeatureTypeDef);
  const { step, sharp, volume } = await roundedBlockStep(h.services.kernel.call.bind(h.services.kernel), o);
  // The import panel's own runs (upload, read, heal, BREP), as tests/features/p2/real-doc.ts importFixture.
  const runs = createImportRuns(h.services, () => ({ kernel: h.services.kernel, files: createFileTransfer({ files: h.services.bridge.files }), studyId: h.services.bridge.studyId }));
  const s = h.doc.beginNew('import', { source: { rel: '', size: step.byteLength, sha256: '', fileName: 'rounded-block.step', unit: null } } as never);
  runs.start(s, new File([new Uint8Array(step).buffer as ArrayBuffer], 'rounded-block.step'));
  await vi.waitFor(
    () => {
      const run = runs.state.get().runs[s.feature];
      if (run?.error) throw new Error(`import stopped: ${run.error}`);
      expect(s.incomplete()).toBeNull();
    },
    { timeout: 60_000, interval: 20 },
  );
  s.commit();
  const rebuild = await h.settle();
  const feature = s.feature;
  const state = rebuild.features[feature]?.state;
  if (state !== 'ok') throw new Error(`the import is ${state}: ${rebuild.features[feature]?.message}`);
  return { feature, sharp, volume };
}
