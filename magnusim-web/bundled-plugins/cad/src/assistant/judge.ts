// The honest outcome of one edit call (CAD tools spec §7.4, §7.5): the Part's feature states and
// bodies before and after the step, compared once the rebuild settled.
//   - the whole rebuild failed (also when it failed the same way before the call: nothing is
//     built), or the kernel stopped a feature: revert, kernel_failed;
//   - the call's own feature (the one its panel filled) now fails: revert, feature_failed with the
//     feature's own message and actions;
//   - a value edit (set_params, edit_feature set) turned a feature that worked red: revert,
//     broke_downstream with each feature and its message (step.ts adds the scoped cuts it left
//     cutting nothing, region-tools.ts);
//   - a structural edit (a rename, a move, a suppression, the undo tool, ...) did: kept, listed in
//     `broke` (get_model marks them broken_by_you while they fail);
//   - warnings: the own feature's warning, features newly warning (a repaired reference), a body
//     that now has more solids than before. A feature's note (a Join's pieces left apart, not a
//     warning in the tree) is the result's feature.note.
// report() gives every edit result's data (EditData): the feature, what was resolved, the bodies
// created, changed and removed (volumes, bounding boxes, solids), and the lists above.
// Owner: ASSISTANT.
// SPDX-License-Identifier: GPL-3.0-or-later
import type { EditData } from '../types/assistant';
import type { BodyId, CadDoc, FeatureAction, FeatureId } from '../types/doc';
import type { DocState } from '../types/doc-service';
import { ToolError } from './errors';
import { len, sig6 } from './numbers';
import { stateWord } from './model';

/** What a step changes and how the judge reads it (the edit tools' plans carry it). */
export interface JudgedPlan {
  /** A value edit: a working feature that fails afterwards reverts the call. */
  value: boolean;
  /** The feature the call's own panel filled (new or edited): its failure is the call's. */
  own?: FeatureId | null;
  /** The feature the result is about (EditData.feature), if any. */
  feature?: FeatureId | null;
  /** What the call's inputs resolved to, in words (EditData.resolved). */
  resolved?: Record<string, string>;
}

export interface FeatureSnap {
  name: string;
  type: string;
  /** stateWord: ok, warning, error, suppressed, rolled_back, pending. */
  state: string;
  message: string | null;
  /** FeatureStatus.note: said beside the state (a Join's pieces left apart), absent when none. */
  note?: string;
  actions: FeatureAction[];
}

export interface BodySnap {
  name: string;
  volume: number | null;
  bbox: number[];
  solids: number | null;
}

export interface StateSnap {
  doc: CadDoc;
  features: Map<FeatureId, FeatureSnap>;
  bodies: Map<BodyId, BodySnap>;
  /** A whole-rebuild failure (the kernel down), or null. */
  message: string | null;
}

/** The Part's feature states and bodies now (after a settled rebuild). */
export function snapshotStates(s: DocState): StateSnap {
  const features = new Map<FeatureId, FeatureSnap>();
  for (const f of s.doc.features) {
    const st = s.rebuild.features[f.id];
    features.set(f.id, { name: f.name, type: f.type, state: stateWord(st), message: st?.message ?? null, ...(st?.note ? { note: st.note } : {}), actions: [...(st?.actions ?? [])] });
  }
  const bodies = new Map<BodyId, BodySnap>();
  for (const b of s.rebuild.bodies) bodies.set(b.id, { name: b.name, volume: b.volume, bbox: [...b.bbox], solids: typeof b.solids === 'number' ? b.solids : null });
  return { doc: s.doc, features, bodies, message: s.rebuild.message };
}

export interface Verdict {
  /** The call reverts with this error, or null (kept). */
  error: ToolError | null;
  /** Features that worked before and fail now (kept structural edits only; a value edit reverts instead). */
  broke: { feature: string; message: string }[];
  /** Features that failed before and work now. */
  fixed: string[];
  warnings: string[];
}

const works = (state: string | undefined) => state === 'ok' || state === 'warning';
/** The kernel stopped the feature (watchdog, crash, out of memory): Retry is its way out. */
const stopped = (f: FeatureSnap) => f.actions.includes('retry');

/** The outcome of a step, from the states before it and after its rebuild settled (§7.4). */
export function verdict(before: StateSnap, after: StateSnap, plan: JudgedPlan): Verdict {
  const out: Verdict = { error: null, broke: [], fixed: [], warnings: [] };
  // A whole rebuild that failed built nothing (every feature pending), whatever it said before the call.
  if (after.message) {
    const again = after.message === before.message;
    out.error = new ToolError('kernel_failed', `${again ? 'The rebuild still fails after this change' : 'The rebuild failed'}: ${after.message}`, { detail: { message: after.message, ...(again ? { before: true } : {}) } });
    return out;
  }
  const own = plan.own ? after.features.get(plan.own) : undefined;
  if (own && own.state === 'error' && before.features.get(plan.own!)?.state !== 'error') {
    out.error = stopped(own)
      ? new ToolError('kernel_failed', `The geometry kernel stopped ${own.name}: ${own.message ?? 'no answer'}`, { detail: { feature: own.name, message: own.message, actions: own.actions } })
      : new ToolError('feature_failed', `${own.name} fails: ${own.message ?? 'it did not build'}`, { detail: { feature: own.name, message: own.message, actions: own.actions } });
    return out;
  }
  if (own?.state === 'warning' && own.message) out.warnings.push(`${own.name}: ${own.message}`);
  for (const [id, f] of after.features) {
    if (id === plan.own) continue;
    const was = before.features.get(id);
    if (f.state === 'error' && works(was?.state)) {
      if (stopped(f)) {
        out.error = new ToolError('kernel_failed', `The geometry kernel stopped ${f.name}: ${f.message ?? 'no answer'}`, { detail: { feature: f.name, message: f.message, actions: f.actions } });
        return out;
      }
      out.broke.push({ feature: f.name, message: f.message ?? 'it no longer builds' });
    } else if (works(f.state) && was?.state === 'error') out.fixed.push(f.name);
    else if (f.state === 'warning' && was?.state === 'ok' && f.message) out.warnings.push(`${f.name}: ${f.message}`);
  }
  if (plan.value && out.broke.length) {
    const names = out.broke.map((b) => b.feature);
    const list = names.length === 1 ? names[0] : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
    out.error = new ToolError('broke_downstream', `Nothing changed: after it ${list} would fail (${out.broke[0].message}).`, { detail: { broke: out.broke.slice(0, 20) } });
    return out;
  }
  for (const [id, b] of after.bodies) {
    const was = before.bodies.get(id);
    if (was && was.solids !== null && b.solids !== null && b.solids > was.solids) out.warnings.push(`${b.name} now has ${b.solids} solids (it had ${was.solids}): pieces that do not touch stay separate`);
  }
  return out;
}

const AXES = ['x', 'y', 'z'] as const;

/** A body's change, as the result shows it: volume and solids before and after, and each bounding-box side that moved. */
function bodyChange(name: string, a: BodySnap, b: BodySnap): Record<string, unknown> | null {
  const row: Record<string, unknown> = { body: name };
  let changed = a.name !== b.name;
  if (a.name !== b.name) row.renamed = [a.name, b.name];
  const vol = (v: number | null) => (v === null ? null : sig6(v));
  if (vol(a.volume) !== vol(b.volume)) changed = true;
  row.volume_mm3 = [vol(a.volume), vol(b.volume)];
  for (let i = 0; i < 6; i++) {
    if (len(a.bbox[i]) === len(b.bbox[i])) continue;
    changed = true;
    row[`bbox_${i < 3 ? 'min' : 'max'}_${AXES[i % 3]}`] = [len(a.bbox[i]), len(b.bbox[i])];
  }
  if (a.solids !== b.solids) changed = true;
  row.solids = [a.solids, b.solids];
  return changed ? row : null;
}

const bodyRow = (b: BodySnap) => ({
  body: b.name,
  volume_mm3: b.volume === null ? null : sig6(b.volume),
  bbox_mm: [b.bbox.slice(0, 3).map(len), b.bbox.slice(3, 6).map(len)],
  solids: b.solids,
});

/** Every edit result's data (§7.5). `step`: the call's number in its key (0 when it is in no ledger). */
export function report(o: { before: StateSnap; after: StateSnap; plan: JudgedPlan; verdict: Verdict; step: number; rev: number }): EditData {
  const { before, after, plan, verdict: v } = o;
  const f = plan.feature ? after.features.get(plan.feature) : undefined;
  const created: Record<string, unknown>[] = [];
  const changed: Record<string, unknown>[] = [];
  const removed: string[] = [];
  for (const [id, b] of after.bodies) {
    const was = before.bodies.get(id);
    if (!was) created.push(bodyRow(b));
    else {
      const c = bodyChange(b.name, was, b);
      if (c) changed.push(c);
    }
  }
  for (const [id, b] of before.bodies) if (!after.bodies.has(id)) removed.push(b.name);
  return {
    rev: o.rev,
    step: o.step,
    feature: f ? { name: f.name, type: f.type, state: f.state, message: f.message, ...(f.note ? { note: f.note } : {}) } : null,
    resolved: { ...(plan.resolved ?? {}) },
    bodies: { created: created.slice(0, 50), changed: changed.slice(0, 50), removed: removed.slice(0, 50) },
    created: [],
    warnings: v.warnings.slice(0, 20),
    broke: v.broke.slice(0, 20),
    fixed: v.fixed.slice(0, 20),
  };
}

/** One line of a body's change for a result's text: "Plate 14400 → 16813 mm³". */
export function bodyWords(data: EditData): string {
  const c = data.bodies.changed[0] as { body: string; volume_mm3?: [number | null, number | null] } | undefined;
  if (c?.volume_mm3 && c.volume_mm3[0] !== null && c.volume_mm3[1] !== null && c.volume_mm3[0] !== c.volume_mm3[1]) {
    return `${c.body} ${Math.round(c.volume_mm3[0])} → ${Math.round(c.volume_mm3[1])} mm³`;
  }
  const n = data.bodies.created[0] as { body: string; volume_mm3: number | null } | undefined;
  if (n) return `${n.body} made${n.volume_mm3 !== null ? ` (${Math.round(n.volume_mm3)} mm³)` : ''}`;
  if (data.bodies.removed.length) return `${data.bodies.removed[0]} removed`;
  return '';
}
