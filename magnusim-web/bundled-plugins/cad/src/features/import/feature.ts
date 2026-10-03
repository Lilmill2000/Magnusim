// The Imported feature (docs/p2p3-plan.md §1.2): one feature at the top of the
// history that makes one body per solid (or open shell, a surface body) of a
// STEP file. Its build reads the stored healed BREP and nothing else: never
// the STEP, never healing again, so a reopen gives the same shapes with the
// same face indices, hence the same face names (F:<feature>:import:<item>:<i>).
// Only when the kernel is another OCCT version than the one that wrote the
// BREP does it heal the stored source again, with a warning.
// Owner: P2-FEATURES.
// SPDX-License-Identifier: GPL-3.0-or-later
import { newId } from '../../lib/ids';
import { indexedNames } from '../../naming/names';
import { DEFAULT_BODY_COLOR } from '../../doc/schema';
import type { BodyDef, BodyId, CadDoc, ImportFeature } from '../../types/doc';
import type { BuildContext, FeatureBuildResult, FeatureTypeDef, ImportOutput } from '../../types/doc-service';
import type { KernelCallError } from '../../types/kernel';
import type { ShapeId } from '../../types/kernel-protocol';
import { P2_ICONS } from '../p2/icons';
import { kernelWords } from '../p2/repair';
import { DEFAULT_HEAL_TOLERANCE, LARGE_STEP_BYTES, readAndHeal } from './pipeline';

/** BREP bytes this session just wrote, by sha256: the first build after an import reads them here instead of downloading them again. */
const recent = new Map<string, ArrayBuffer>();
const RECENT_MAX_BYTES = 320 * 1024 * 1024;

export function rememberBrep(sha256: string, bytes: ArrayBuffer): void {
  recent.delete(sha256);
  recent.set(sha256, bytes);
  let total = 0;
  for (const b of recent.values()) total += b.byteLength;
  for (const [k, b] of recent) {
    if (total <= RECENT_MAX_BYTES || recent.size <= 1) break;
    recent.delete(k);
    total -= b.byteLength;
  }
}

/** For tests. */
export function forgetBreps(): void {
  recent.clear();
}

/** "Imported 2 (flange.step)": numbered among the Part's imports, with the file name. */
export function importName(doc: Pick<CadDoc, 'features'>, fileName: string): string {
  let max = 0;
  for (const f of doc.features) {
    const m = /^Imported (\d+)(?: \(.*\))?$/.exec(f.name);
    if (m) max = Math.max(max, Number(m[1]));
  }
  const base = `Imported ${max + 1}`;
  return fileName ? `${base} (${fileName})` : base;
}

/** Body names a STEP brings, kept apart from names already in the Part ("Body1", "Body1 (2)"). */
function uniqueName(name: string, taken: Set<string>): string {
  const base = name.trim() || 'Body';
  if (!taken.has(base.toLowerCase())) return base;
  for (let k = 2; ; k++) {
    const n = `${base} (${k})`;
    if (!taken.has(n.toLowerCase())) return n;
  }
}

function emptyRef() {
  return { rel: '', size: 0, sha256: '' };
}

export const importDef: FeatureTypeDef<ImportFeature, Record<string, never>> = {
  type: 'import',
  label: 'Imported',
  icon: P2_ICONS.imported,
  create(doc, init = {}) {
    const fileName = init.source?.fileName ?? '';
    return {
      id: newId('f'),
      type: 'import',
      name: importName(doc, fileName),
      source: { ...emptyRef(), fileName, unit: null },
      brep: { ...emptyRef(), occt: '' },
      heal: { tolerance: DEFAULT_HEAL_TOLERANCE, sew: false },
      items: [],
      ...init,
    } as ImportFeature;
  },
  resolve: () => ({ ok: true, values: {} }),
  incomplete(f) {
    if (!f.brep?.rel || !f.items?.length) return `${f.source?.fileName || 'The STEP file'} is still being imported`;
    return null;
  },
  parents: () => [],
  uses: () => [],
  ownsBody: (f, id) => (f.items ?? []).some((it) => it.body === id),
  newBodies(f, doc) {
    const taken = new Set(Object.values(doc.bodies).map((b) => b.name.toLowerCase()));
    const out: Record<BodyId, BodyDef> = {};
    for (const it of f.items ?? []) {
      if (doc.bodies[it.body]) continue;
      const name = uniqueName(it.stepName, taken);
      taken.add(name.toLowerCase());
      out[it.body] = { name, color: it.stepColor ?? DEFAULT_BODY_COLOR };
    }
    return out;
  },
  // No expressions: the tolerance is a plain number the panel sets; file paths and names must never be rewritten.
  exprs: () => [],
  mapExprs: (f) => f,
  async build(f, _v, ctx) {
    return buildImport(f, ctx);
  },
};

async function buildImport(f: ImportFeature, ctx: BuildContext): Promise<FeatureBuildResult> {
  if (!ctx.files) return { ok: false, message: `${f.name} failed: importing needs Magnusim's file storage (host API 1.2)` };
  const t0 = performance.now();
  const kernelOcct = ctx.kernel.status.get().info?.occt ?? null;
  if (kernelOcct && f.brep.occt && kernelOcct !== f.brep.occt) return rehealFromSource(f, ctx, kernelOcct);
  let bytes: ArrayBuffer | null;
  const hit = recent.get(f.brep.sha256);
  try {
    bytes = hit ? hit.slice(0) : await ctx.files.read(f.brep);
  } catch (err) {
    return { ok: false, message: `${f.name} failed: ${kernelWords(err)}` };
  }
  if (!bytes) return { ok: false, message: `${f.name} failed: its stored shapes (${f.brep.rel}) are not in the project any more` };
  let shapes: { id: ShapeId; type: string; faces: number }[] = [];
  try {
    const r = await ctx.kernel.call('brep_read', { check: false }, { bytes });
    shapes = r.result.shapes;
  } catch (err) {
    const k = (err as KernelCallError).kind;
    if (k === 'occt' || k === 'input' || k === 'internal') return { ok: false, message: `${f.name} failed: the stored shapes could not be read (${kernelWords(err)})` };
    throw err;
  }
  return bodiesOf(f, ctx, shapes, { type: 'import', from: 'brep', bytes: f.brep.size, ms: performance.now() - t0 }, null);
}

async function bodiesOf(f: ImportFeature, ctx: BuildContext, shapes: { id: ShapeId; faces: number; valid?: boolean; reason?: string }[], output: ImportOutput, warning: string | null): Promise<FeatureBuildResult> {
  const used = new Set<number>();
  const bodies: Extract<FeatureBuildResult, { ok: true }>['bodies'] = [];
  for (const it of f.items) {
    const s = shapes[it.index];
    if (!s) {
      await ctx.release(shapes.map((x) => x.id));
      return { ok: false, message: `${f.name} failed: the stored shapes hold ${shapes.length} ${shapes.length === 1 ? 'body' : 'bodies'}, the import lists ${f.items.length}` };
    }
    used.add(it.index);
    bodies.push({ id: it.body, shape: s.id, valid: s.valid ?? it.valid, names: indexedNames(f.id, 'import', s.faces, it.index) });
  }
  const extra = shapes.filter((_, i) => !used.has(i)).map((s) => s.id);
  if (extra.length) await ctx.release(extra);
  const bad = f.items.filter((it) => !(shapes[it.index]?.valid ?? it.valid));
  const notes: string[] = [];
  if (warning) notes.push(warning);
  if (bad.length) {
    const names = bad.map((it) => ctx.bodyName(it.body)).join(', ');
    const reason = shapes[bad[0].index]?.reason ?? bad[0].reason;
    // "invalid result (BRepCheck): NotClosed x2" reads "(BRepCheck: NotClosed x2)".
    const why = reason ? ` (${reason.replace(/^invalid result\s*\(BRepCheck\):\s*/i, 'BRepCheck: ').replace(/^invalid result\s*/i, '').trim()})` : '';
    notes.push(`${names} ${bad.length === 1 ? 'is' : 'are'} not a valid solid${why}: Heal all with a larger tolerance may fix ${bad.length === 1 ? 'it' : 'them'}`);
  }
  return { ok: true, bodies, removed: [], output, ...(notes.length ? { warning: notes.join('; ') } : {}) };
}

/** Another OCCT version than the BREP's: heal the stored source again (§4.5 point 6). */
async function rehealFromSource(f: ImportFeature, ctx: BuildContext, occt: string): Promise<FeatureBuildResult> {
  const t0 = performance.now();
  const bytes = await ctx.files!.read(f.source);
  if (!bytes) return { ok: false, message: `${f.name} failed: it was stored by OCCT ${f.brep.occt} and its source STEP (${f.source.rel}) is not in the project any more` };
  const h = await readAndHeal({ kernel: ctx.kernel }, { bytes, fileName: f.source.fileName, tolerance: f.heal.tolerance, sew: f.heal.sew, large: f.source.size > LARGE_STEP_BYTES }, undefined, () => {});
  if (h.raw?.length) await ctx.release(h.raw);
  const shapes = h.healed.map((s) => ({ id: s.id, faces: s.faces ?? 0, valid: s.valid, reason: s.reason }));
  for (const s of shapes) if (!s.faces) s.faces = await ctx.faces(s.id);
  const output: ImportOutput = { type: 'import', from: 'source', bytes: f.source.size, ms: performance.now() - t0 };
  return bodiesOf(f, ctx, shapes, output, `${f.name} was healed again with OCCT ${occt}: check later references`);
}
