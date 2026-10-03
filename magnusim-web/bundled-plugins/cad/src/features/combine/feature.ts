// Combine (decision 2026-09-30, MVP; docs/p2p3-plan.md §1.6, §2.6): Join, Cut
// or Intersect with several targets and several tools, imported and native
// bodies alike, in one kernel call (combine: work copies of every input,
// copied together). Join fuses everything into the first target and the other
// targets go; Cut removes every tool from each target; Intersect keeps what
// each target shares with all the tools (SOLIDWORKS' Common, Fusion's
// Intersect: what the tools share is made first, one more kernel call per
// extra tool); a target left empty goes (said in amber), one left in more
// pieces than it had says so. Tools go unless kept.
// Faces keep their names through the history. An invalid result is red with
// "Try repair": fuzzy 0.001 mm, then 0.01 mm, then ShapeFix.
// Owner: P2-FEATURES.
// SPDX-License-Identifier: GPL-3.0-or-later
import { newId, nextName } from '../../lib/ids';
import { namesFromResult } from '../../naming/result';
import { timeoutForFaces } from '../../kernel/timeouts';
import type { BodyId, CombineFeature } from '../../types/doc';
import type { BuildContext, FeatureBuildResult, FeatureTypeDef } from '../../types/doc-service';
import type { KernelCallError } from '../../types/kernel';
import type { ShapeId } from '../../types/kernel-protocol';
import type { FaceNames } from '../../types/naming';
import { P2_ICONS } from '../p2/icons';
import { invalidWords, kernelWords, occtWords, repairActions, repairFuzzy, shapeFix } from '../p2/repair';

/** Parts up to this many faces (targets and tools together) are measured to say when a Cut or Join changed nothing. */
export const COMBINE_CHECK_MAX_FACES = 2000;

/** A body's volume (mm³), or null when the kernel cannot say. */
async function volumeOf(ctx: BuildContext, id: ShapeId): Promise<number | null> {
  try {
    const r = await ctx.kernel.call('props', { id, volume: true, bbox: 'none', bbox_mode: 'fast' });
    return typeof r.result.volume === 'number' ? r.result.volume : null;
  } catch (err) {
    const k = (err as KernelCallError).kind;
    if (k === 'occt' || k === 'input' || k === 'internal') return null;
    throw err;
  }
}

export const COMBINE_OPS: { value: CombineFeature['op']; label: string; hint: string }[] = [
  { value: 'join', label: 'Join', hint: 'Fuse the tools into the first target (the other targets join it too)' },
  { value: 'cut', label: 'Cut', hint: 'Remove the tools from each target' },
  // What every tool and the target share (SOLIDWORKS' Common, Fusion's Intersect); review P2/P3
  // round 4: with two tools it kept what the target shared with either of them.
  { value: 'intersect', label: 'Intersect', hint: 'Keep only what each target shares with all the tools' },
];

/** "Body 2", "Body 2 and Body 3", "Body 2, Body 3 and Body 4". */
function andList(names: string[]): string {
  return names.length < 2 ? (names[0] ?? '') : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

/** How many solids a shape holds (the kernel's cheap counts), or null when it cannot say. */
async function solidsOf(ctx: BuildContext, id: ShapeId): Promise<number | null> {
  try {
    const r = await ctx.kernel.call('props', { id, bbox: 'none' });
    return typeof r.result.solids === 'number' ? r.result.solids : null;
  } catch (err) {
    const k = (err as KernelCallError).kind;
    if (k === 'occt' || k === 'input' || k === 'internal') return null;
    throw err;
  }
}

export const combineDef: FeatureTypeDef<CombineFeature, Record<string, never>> = {
  type: 'combine',
  label: 'Combine',
  icon: P2_ICONS.combine,
  create(doc, init = {}) {
    return {
      id: newId('f'),
      type: 'combine',
      name: nextName('Combine', doc.features.map((f) => f.name)),
      op: 'join',
      targets: [],
      tools: [],
      keepTools: false,
      ...init,
    } as CombineFeature;
  },
  resolve: () => ({ ok: true, values: {} }),
  incomplete(f) {
    if (!f.targets?.length) return 'Pick at least one target';
    if (!f.tools?.length) return 'Pick at least one tool';
    if (f.targets.some((t) => f.tools.includes(t))) return 'A body cannot be a target and a tool';
    return null;
  },
  parents: () => [],
  uses: (f) => [...(f.targets ?? []), ...(f.tools ?? []).filter((t) => !(f.targets ?? []).includes(t))],
  exprs: () => [],
  mapExprs: (f) => f,
  async build(f, _v, ctx): Promise<FeatureBuildResult> {
    const missing = [...f.targets, ...f.tools].filter((id) => !ctx.bodies.has(id));
    if (missing.length) return { ok: false, message: `${f.name} failed: ${missing.map((id) => ctx.bodyName(id)).join(', ')} ${missing.length === 1 ? 'is' : 'are'} not there at this point` };
    const targets = f.targets.map((id) => ctx.bodies.get(id)!);
    const tools = f.tools.map((id) => ctx.bodies.get(id)!);
    const fuzzy = repairFuzzy(f);
    let faces = 0;
    for (const b of [...targets, ...tools]) faces += await ctx.faces(b.shape);
    const timeoutMs = timeoutForFaces('combine', faces);
    const inputs = new Map<ShapeId, FaceNames | null>([...targets, ...tools].map((b) => [b.shape, b.names] as [ShapeId, FaceNames | null]));
    /** Shapes made on the way (what the tools share), released at the end. */
    const steps: ShapeId[] = [];
    let toolShapes = tools.map((b) => b.shape);
    let res;
    try {
      // Intersect with several tools keeps what the target shares with every one of them: what the
      // tools share comes first, then each target is intersected with that.
      if (f.op === 'intersect' && tools.length > 1) {
        let acc = tools[0].shape;
        let accNames = tools[0].names;
        for (const t of tools.slice(1)) {
          const r = (await ctx.kernel.call('combine', { op: 'intersect', targets: [acc], tools: [t.shape], ...(fuzzy ? { fuzzy } : {}) }, timeoutMs ? { timeoutMs } : {})).result.results[0];
          if (!r) return { ok: false, message: `${f.name} failed: the kernel gave no result` };
          steps.push(r.id);
          if (r.empty) return { ok: false, message: `${f.name} failed: Nothing in common: the tools ${andList(f.tools.map((id) => ctx.bodyName(id)))} have no volume that all of them share (touching is not enough)` };
          if (r.valid === false) return { ok: false, message: `${f.name} failed: ${invalidWords(r.reason, fuzzy)}`, actions: repairActions(fuzzy) };
          accNames = namesFromResult(f.id, { faces: r.faces, history: r.history }, new Map([[acc, accNames], [t.shape, t.names]] as [ShapeId, FaceNames | null][]));
          acc = r.id;
        }
        inputs.set(acc, accNames);
        toolShapes = [acc];
      }
      res = (await ctx.kernel.call('combine', { op: f.op, targets: targets.map((b) => b.shape), tools: toolShapes, ...(fuzzy ? { fuzzy } : {}) }, timeoutMs ? { timeoutMs } : {})).result;
    } catch (err) {
      const k = (err as KernelCallError).kind;
      if (k === 'occt' || k === 'input' || k === 'internal') return { ok: false, message: `${f.name} failed: ${kernelWords(err)}` };
      throw err;
    } finally {
      if (!res && steps.length) await ctx.release(steps).catch(() => {});
    }
    const byShape = new Map<ShapeId, BodyId>(targets.map((b) => [b.shape, b.id] as [ShapeId, BodyId]));
    const made: ShapeId[] = [...res.results.map((r) => r.id), ...steps];
    const bodies: Extract<FeatureBuildResult, { ok: true }>['bodies'] = [];
    const removed = new Set<BodyId>();
    const gone: string[] = [];
    const repaired: string[] = [];
    const notes: string[] = [];
    try {
      for (const r of res.results) {
        const id = byShape.get(r.target);
        if (!id) continue;
        if (r.empty) {
          removed.add(id);
          gone.push(ctx.bodyName(id));
          continue;
        }
        let shape = r.id;
        let names = namesFromResult(f.id, { faces: (r as { faces?: number }).faces, history: r.history }, inputs);
        if (r.valid === false) {
          const fixed = fuzzy ? await shapeFix(ctx, r.id) : null;
          if (fixed == null) return { ok: false, message: `${f.name} failed: ${invalidWords(r.reason, fuzzy)}`, actions: repairActions(fuzzy) };
          made.push(fixed);
          shape = fixed;
          names = null;
          repaired.push(ctx.bodyName(id));
        }
        if (r.warning_text) notes.push(occtWords(r.warning_text));
        // Join: tools that do not touch the target stay apart inside the one body (no silent pass).
        if (f.op === 'join' && r.solids > 1) notes.push(`${ctx.bodyName(id)} is now ${r.solids} separate solids: ${tools.length === 1 ? 'the tool does' : 'the tools do'} not touch it`);
        // A Cut or Intersect that leaves a target in pieces says so (review P2/P3 round 4: two cubes
        // meeting at a corner read as one body, "Body 1 · 2,000 mm³", with no word of the 2 pieces).
        if (f.op !== 'join' && r.solids > 1) {
          const before = await solidsOf(ctx, targets.find((x) => x.id === id)!.shape);
          if (before != null && r.solids > before) notes.push(`${ctx.bodyName(id)} is now in ${r.solids} separate pieces`);
        }
        bodies.push({ id, shape, valid: true, names });
      }
      // A Cut or a Join that leaves a target as it was says so (review P2/P3 round 1: a tool only
      // touching the target, or lying inside it, passed with nothing changed and no word, while an
      // Extrude says "Nothing to cut ... (touching is not enough)"). Measured on parts small enough.
      if (f.op !== 'intersect' && faces <= COMBINE_CHECK_MAX_FACES) {
        const same: string[] = [];
        for (const b of bodies) {
          const t = targets.find((x) => x.id === b.id);
          if (!t) continue;
          const [v0, v1] = [await volumeOf(ctx, t.shape), await volumeOf(ctx, b.shape)];
          if (v0 != null && v1 != null && v0 > 0 && Math.abs(v1 - v0) <= 1e-9 * v0) same.push(ctx.bodyName(b.id));
        }
        const toolNames = f.tools.map((t) => ctx.bodyName(t)).join(', ');
        const one = tools.length === 1;
        if (f.op === 'cut' && same.length && same.length === bodies.length && !gone.length) {
          return { ok: false, message: `${f.name} failed: Nothing to cut: ${toolNames} ${one ? 'does' : 'do'} not overlap ${same.join(', ')} (touching is not enough)` };
        }
        if (f.op === 'cut' && same.length) notes.push(`nothing was cut from ${same.join(', ')}: ${toolNames} ${one ? 'does' : 'do'} not overlap it (touching is not enough)`);
        if (f.op === 'join' && same.length && f.targets.length === 1) notes.push(`${toolNames} ${one ? 'lies' : 'lie'} inside ${same.join(', ')}: joining adds nothing`);
      }
      // An Intersect target with nothing in common with the tools: in the same words as a Cut that
      // cuts nothing, and a failure when no target is left (review P2/P3 round 2: two bodies that
      // only touch gave an amber "flange was removed completely" and the target was gone, while
      // the same Cut said "Nothing to cut ... (touching is not enough)" in red).
      if (f.op === 'intersect' && gone.length) {
        const one = tools.length === 1;
        // With several tools it is what they all share that the target must overlap.
        const toolNames = one ? ctx.bodyName(f.tools[0]) : `what ${andList(f.tools.map((t) => ctx.bodyName(t)))} share`;
        if (!bodies.length) return { ok: false, message: `${f.name} failed: Nothing in common: ${toolNames} does not overlap ${gone.join(', ')} (touching is not enough)` };
        notes.unshift(`${gone.join(', ')} had nothing in common with ${toolNames} (touching is not enough) and ${gone.length === 1 ? 'was' : 'were'} removed`);
        gone.length = 0;
      }
      if (f.op === 'join') for (const t of f.targets.slice(1)) removed.add(t);
      if (!f.keepTools) for (const t of f.tools) removed.add(t);
      if (!bodies.length && !gone.length) return { ok: false, message: `${f.name} failed: the kernel gave no result` };
      if (gone.length) notes.unshift(`${gone.join(', ')} ${gone.length === 1 ? 'was' : 'were'} removed completely`);
      if (repaired.length) notes.push(`${repaired.join(', ')} ${repaired.length === 1 ? 'was' : 'were'} repaired: check the result`);
      const kept = new Set(bodies.map((b) => b.shape));
      const extra = made.filter((s) => !kept.has(s));
      made.length = 0;
      await ctx.release(extra);
      return { ok: true, bodies, removed: [...removed], ...(notes.length ? { warning: notes.join('; ') } : {}) };
    } finally {
      if (made.length) await ctx.release(made).catch(() => {});
    }
  },
};
