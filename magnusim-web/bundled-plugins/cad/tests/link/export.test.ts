// @vitest-environment node
// The export's body rows for a body of several solids (link review polish):
// "Bar", "Bar · piece 2", with ids "<id>", "<id>#2"; two bodies of one name stay
// "Block", "Block (2)".
// Owner: LINK.
// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { exportForLink } from '../../src/link/export';
import type { CadDoc } from '../../src/types/doc';
import type { EndBody } from '../../src/types/doc-service';
import type { KernelAdapter } from '../../src/types/kernel';

const doc = (bodies: CadDoc['bodies']): CadDoc => ({ schema: 2, units: { length: 'mm', angle: 'deg' }, params: [], bodies, features: [], meta: { created_at: 'x', written_by: 't' } });
const body = (id: string, shape: number, name: string): EndBody => ({ id, shape, valid: true, feature: 'f1', names: null, name, color: '#bdc9db' });

function kernel(solids: { src: number; piece: number; faces: number }[]): KernelAdapter {
  const visits = solids.map((_, i) => i + 1);
  return { call: async () => ({ result: { solids, empty: [], visit_body: visits, visit_face: visits.map(() => 0) }, buffers: { brep: new Uint8Array([1, 2]).buffer } }) } as unknown as KernelAdapter;
}

describe('export: body rows', () => {
  it('the pieces of one body: "Bar", "Bar · piece 2"; two bodies of one name: "Block (2)"', async () => {
    const ex = await exportForLink(
      kernel([
        { src: 0, piece: 1, faces: 1 },
        { src: 0, piece: 2, faces: 1 },
        { src: 1, piece: 1, faces: 1 },
        { src: 2, piece: 1, faces: 1 },
      ]),
      doc({ b1: { name: 'Bar', color: '#bdc9db' }, b2: { name: 'Block', color: '#bdc9db' }, b3: { name: 'Block', color: '#bdc9db' } }),
      { bodies: [body('b1', 1, 'Bar'), body('b2', 2, 'Block'), body('b3', 3, 'Block')], failed: [] },
    );
    if ('nothing' in ex) throw new Error('nothing exported');
    const side = JSON.parse(ex.faceNames) as { bodies: { index: number; id: string; name: string }[] };
    expect(side.bodies.map((b) => [b.index, b.id, b.name])).toEqual([
      [1, 'b1', 'Bar'],
      [2, 'b1#2', 'Bar · piece 2'],
      [3, 'b2', 'Block'],
      [4, 'b3', 'Block (2)'],
    ]);
  });
});
