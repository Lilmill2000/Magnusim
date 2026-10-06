// The shell feature type (proposal §2.5): hollow a body to a wall thickness, the
// picked faces removed (the openings). Inside: the outer size stays; outside: the
// body becomes the cavity and the wall grows out of it. Kernel `shell` on a work
// copy (BRepOffsetAPI_MakeThickSolid); the result's `valid` flag is honoured. The
// body keeps its id; an inner wall face is F:<id>:inner:<the face it was offset from>.
// Owner: P4a SOLIDS.
// SPDX-License-Identifier: GPL-3.0-or-later
import { newId, nextName } from '../../lib/ids';
import { timeoutForFaces } from '../../kernel/timeouts';
import type { ShellFeature } from '../../types/doc';
import type { FeatureBuildResult, FeatureTypeDef } from '../../types/doc-service';
import type { LengthUnit } from '../../types/units';
import { resolveRefs } from '../p2/refs';
import { kernelStep } from '../solids/build';
import { SOLIDS_ICONS } from '../solids/icons';
import { bodyFor } from '../solids/local';
import { localOpNames } from '../solids/naming';

const DEFAULT_THICKNESS: Record<LengthUnit, string> = { mm: '2 mm', cm: '0.2 cm', m: '0.002 m', in: '0.1 in', ft: '0.1 in' };

export const shellDef: FeatureTypeDef<ShellFeature, { t: number }> = {
  type: 'shell',
  label: 'Shell',
  icon: SOLIDS_ICONS.shell,
  create(doc, init = {}) {
    return {
      id: newId('f'),
      type: 'shell',
      name: nextName('Shell', doc.features.map((f) => f.name)),
      body: '',
      faces: [],
      thickness: DEFAULT_THICKNESS[doc.units.length],
      direction: 'inside',
      ...init,
    } as ShellFeature;
  },
  resolve(f, units) {
    const r = units.evaluate(typeof f.thickness === 'string' ? f.thickness : String(f.thickness ?? ''), 'length');
    if (!r.ok) return { ok: false, message: `Thickness: ${r.error}` };
    if (!(r.value > 0)) return { ok: false, message: 'Thickness must be more than 0' };
    return { ok: true, values: { t: r.value } };
  },
  incomplete(f, units) {
    if (!f.body || !f.faces?.length) return 'Pick the faces to remove (the openings)';
    const r = shellDef.resolve(f, units);
    return r.ok ? null : r.message;
  },
  parents: () => [],
  uses: (f) => (f.body ? [f.body] : []),
  exprs: (f) => [{ path: 'thickness', expr: f.thickness }],
  mapExprs: (f, fn) => ({ ...f, thickness: fn(f.thickness) }),
  async build(f, v, ctx): Promise<FeatureBuildResult> {
    const b = bodyFor(f.name, f.body, ctx);
    if (!b.ok) return b;
    const body = b.value;
    const res = await resolveRefs(ctx, body, f.faces);
    if (!res.ok) return { ok: false, message: `${f.name} failed: ${res.message}` };
    const timeoutMs = timeoutForFaces('shell', await ctx.faces(body.shape));
    const wall = ctx.units.format(v.t, 'length');
    const words = () => `${f.name} failed: the kernel could not make a ${wall} wall ${f.direction === 'outside' ? 'outside' : 'inside'} ${ctx.bodyName(f.body)}: try a thinner wall or other faces`;
    const r = await kernelStep(f.name, () => ctx.kernel.call('shell', { id: body.shape, faces: res.indices, t: v.t, outside: f.direction === 'outside' }, timeoutMs ? { timeoutMs } : {}));
    if (!r.ok) return /shell failed|returned no shape/i.test(r.message) ? { ok: false, message: words() } : r;
    const out = r.value.result;
    if (out.valid === false) {
      await ctx.release([out.id]);
      const why = out.reason ? ` (${out.reason.replace(/^invalid result\s*/i, '').trim()})` : '';
      return { ok: false, message: `${words()}${why}` };
    }
    const names = await localOpNames(f.id, 'inner', out, body, ctx.kernel);
    return { ok: true, bodies: [{ id: f.body, shape: out.id, valid: true, names }], removed: [], ...(res.warning ? { warning: res.warning } : {}) };
  },
};
