// edit_feature: change one feature without resending everything (CAD tools spec §3.2.15, §7.7):
// its expression fields (by its tool's field names once that tool reads its features, else by
// their paths as get_model lists them, "extent.distance"), its name, its suppression, or its
// place in the history ("end", "before X", "after X"), in one step.
//   - Values go through the person's own Edit panel (openEditForAssistant, read-only for the
//     person): one update with every changed top-level field whole, the live rebuild, then an
//     honest Done. A value that makes the feature fail, or a working feature after it, or moves a
//     scoped cut after it off its body (it builds but cuts nothing), changes nothing
//     (feature_failed, broke_downstream).
//   - rename, setSuppressed and move are the Part's own edits, with their refusal words; they are
//     structural, so a feature they turn red is kept and listed in `broke`. With values in the same
//     call, the values are judged first, as a value edit, before the rename, suppression or move.
//   - Choice and on/off fields (choices.ts: flip, op, method, shape, padding, axis, keepTool,
//     orientation, ruled, along, fromEnd, a pattern's symmetric and mode...) go the same way, a
//     row's value one of the field's words; the feature with every row applied must be complete
//     by its type's own check (a method that needs a pick it has not got is refused).
//   - Magnusim CAD keeps an Enclosure made in Magnusim as it is (features/enclosure/kept.ts): its
//     values are refused with the read-only panel's words; rename, suppress and move work.
//   - A sketch's dimension values (set rows naming its dimension ids) are checked headless first and
//     go through sketch mode, which solves the stored geometry with them (sketch/dims.ts); the answer
//     says when a change turned a sketch over (`flipped`).
// Owner: ASSISTANT.
// SPDX-License-Identifier: GPL-3.0-or-later
import type { EditData, ToolImpl, ToolReply } from '../../types/assistant';
import { isDimension } from '../../sketch/model';
import type { Feature, FeatureId, SketchFeature } from '../../types/doc';
import type { EditResult } from '../../types/doc-service';
import { uiFor } from '../../ui/controller';
import { heartbeat } from '../busy';
import { ToolError } from '../errors';
import { choiceField, choicesOf, storedChoice } from '../choices';
import { pathOfField, valuesOf } from '../features-io';
import { featureByName, stateWord } from '../model';
import { macrotask } from '../pace';
import { bodyWords } from '../judge';
import { runEdit, type EditCtx, type EditPlan, type EditTool } from '../step';
import { applyDimensions, planDimensions, type DimensionEdit } from '../sketch/dims';
import { flippedSketches } from '../sketch/flip';
import { closestName, closestWords } from '../closest';
import { enclosureKept, KEPT_WORDS } from '../../features/enclosure/kept';
import { nameForCopy } from '../../features/move_body/feature';

interface SetRow {
  field: string;
  value: string;
}

interface Plan extends EditPlan {
  id: FeatureId;
  name: string;
  /** The top-level fields the values change, each whole (session.update merges only the top level). */
  patch: Partial<Feature> | null;
  set: { field: string; path: string; value: string; stored?: unknown }[];
  renameTo: string | null;
  suppress: boolean | null;
  /** The feature's index after the move, or null. */
  moveTo: number | null;
  moveWords: string | null;
  /** A sketch's dimension values (sketch/dims.ts), or null. */
  dims: DimensionEdit | null;
}

const MAX_NAME = 80;
const str = (v: unknown) => (typeof v === 'string' ? v.trim() : '');

/** A path ("extent.distance", "dir1.count", "ties[0].exprs.d1") as keys and indices. */
function pathKeys(path: string): (string | number)[] {
  const out: (string | number)[] = [];
  for (const part of path.split('.')) {
    const m = /^([^[\]]+)((?:\[\d+\])*)$/.exec(part);
    if (!m) throw new ToolError('bad_input', `"${path}" is not a field path.`);
    out.push(m[1]);
    for (const i of m[2].matchAll(/\[(\d+)\]/g)) out.push(Number(i[1]));
  }
  return out;
}

/** `f` with `value` at `path` (copies along the path; the rest shared). */
function withValue<T>(f: T, path: string, value: unknown): T {
  const keys = pathKeys(path);
  const put = (node: unknown, i: number): unknown => {
    const k = keys[i];
    if (i === keys.length - 1) {
      if (Array.isArray(node)) return node.map((x, j) => (j === k ? value : x));
      return { ...(node as Record<string, unknown>), [k]: value };
    }
    const child = Array.isArray(node) ? node[k as number] : (node as Record<string, unknown> | null)?.[k as string];
    if (child === null || typeof child !== 'object') throw new ToolError('bad_input', `"${path}" is not a field of this feature now.`);
    const next = put(child, i + 1);
    if (Array.isArray(node)) return node.map((x, j) => (j === k ? next : x));
    return { ...(node as Record<string, unknown>), [k]: next };
  };
  return put(f, 0) as T;
}

/** Where `move` puts the feature: its final index, or a refusal. */
function moveIndex(features: readonly Feature[], f: Feature, move: string, findName: (n: string) => Feature | null): { to: number; words: string } | null {
  const m = move.trim();
  if (!m) return null;
  const from = features.indexOf(f);
  if (/^end$/i.test(m)) return from === features.length - 1 ? null : { to: features.length - 1, words: 'to the end' };
  const r = /^(before|after)\s+(.+)$/i.exec(m);
  if (!r) throw new ToolError('bad_input', `move: "", "end", "before <feature>" or "after <feature>", not "${m}".`, { detail: { field: 'move' } });
  const other = findName(r[2]);
  if (!other) {
    const near = closestName(r[2], features.map((g) => g.name));
    throw new ToolError('not_found', `move: no feature is called "${r[2].trim()}".${closestWords(near)} Features: ${features.map((g) => g.name).slice(0, 30).join(', ')}.`, { detail: { field: 'move', ...(near ? { closest: near } : {}) } });
  }
  if (other.id === f.id) throw new ToolError('bad_input', `move: ${f.name} cannot move ${r[1].toLowerCase()} itself.`, { detail: { field: 'move' } });
  const at = features.indexOf(other);
  const before = r[1].toLowerCase() === 'before';
  // The final index: the list without the feature, then the feature put in.
  const to = before ? (from < at ? at - 1 : at) : from < at ? at : at + 1;
  return to === from ? null : { to, words: `${before ? 'before' : 'after'} ${other.name}` };
}

/** The sketch `f` is made from (its profiles' sketch) when `field` is one of that sketch's dimensions (a hole's d, h1x...), or null. */
function sketchWithDimension(s: { doc: { features: readonly Feature[] } }, f: Feature, field: string): SketchFeature | null {
  const profiles = (f as Feature & { profiles?: unknown }).profiles;
  if (!Array.isArray(profiles) || !profiles.length) return null;
  const id = (profiles[0] as { sketch?: unknown }).sketch;
  const sketch = s.doc.features.find((g) => g.id === id);
  if (!sketch || sketch.type !== 'sketch') return null;
  return sketch.constraints.some((c) => c.id === field && isDimension(c)) ? sketch : null;
}

/** A refusal of the Part's own edit as the tool's error. */
function refused(field: string, r: EditResult): ToolError {
  const reason = r.ok ? '' : r.reason;
  if (/already called/.test(reason)) return new ToolError('name_taken', `${field}: ${reason}.`, { detail: { field } });
  return new ToolError('bad_input', `${field}: ${reason}.`, { detail: { field } });
}

const editFeature: EditTool<Plan> = {
  async plan(ctx) {
    const { services } = ctx;
    const s = services.doc.state.get();
    const f = featureByName(s, str(ctx.input.feature));
    if (!f) {
      const names = s.doc.features.map((g) => g.name);
      const near = closestName(str(ctx.input.feature), names);
      throw new ToolError('not_found', `No feature is called "${str(ctx.input.feature)}".${closestWords(near)} Features: ${names.length ? names.slice(0, 30).join(', ') : 'none yet'}.`, {
        detail: { field: 'feature', names: names.slice(0, 30), ...(near ? { closest: near } : {}) },
      });
    }
    const rows = (Array.isArray(ctx.input.set) ? ctx.input.set : []) as SetRow[];
    // Magnusim CAD keeps an Enclosure made in Magnusim as it is: its panel is read-only, and so are its values here.
    if (rows.length && enclosureKept(services, f)) throw new ToolError('bad_input', `set: ${f.name}: ${KEPT_WORDS} rename_to, suppress and move work.`, { detail: { field: 'set' } });
    const set: Plan['set'] = [];
    // A sketch's dimensions: checked headless now, written through sketch mode (sketch/dims.ts).
    const dims = rows.length && f.type === 'sketch' ? await planDimensions(ctx, f, rows.map((r) => ({ field: str(r?.field), value: str(r?.value) }))) : null;
    if (dims) for (const x of dims.set) set.push({ field: x.field, path: x.field, value: x.value });
    const problems: string[] = [];
    let redirect: string | null = null;
    for (const [i, row] of (dims ? [] : rows).entries()) {
      const field = str(row?.field);
      const value = str(row?.value);
      const path = pathOfField(f, field, services);
      const choice = path ? null : choiceField(f, field);
      if (choice) {
        const st = storedChoice(choice, value);
        if (!st.ok) problems.push(`set[${i}].value: ${st.why}`);
        else if (set.some((x) => x.path === choice.path)) problems.push(`set[${i}]: ${field} is set twice`);
        else set.push({ field: choice.field, path: choice.path, value, stored: st.value });
        continue;
      }
      if (!path) {
        const fields = [...valuesOf(f, services).map((v) => v.field), ...choicesOf(f).map((c) => c.field)];
        const sketch = sketchWithDimension(s, f, field);
        if (sketch) {
          redirect ??= sketch.name;
          problems.push(`set[${i}].field: ${field} is a dimension of ${sketch.name}, the sketch ${f.name} is made from: edit_feature ${sketch.name} with it (${f.name}'s own fields: ${fields.length ? fields.join(', ') : 'none'})`);
        } else problems.push(`set[${i}].field: ${f.name} has no field "${field}" (its fields: ${fields.length ? fields.join(', ') : 'none'})`);
        continue;
      }
      if (!value) problems.push(`set[${i}].value: enter an expression ("12 mm", "w/2")`);
      if (set.some((x) => x.path === path)) problems.push(`set[${i}]: ${field} is set twice`);
      set.push({ field, path, value });
    }
    if (problems.length) {
      throw new ToolError('bad_input', `${problems.slice(0, 12).join('; ')}.`, {
        detail: { problems: problems.slice(0, 12), ...(redirect ? { sketch: redirect } : {}) },
        ...(redirect ? { hint: `Call edit_feature with feature "${redirect}" and the same set rows.` } : {}),
      });
    }
    // The dry run: the feature with each new value, as its type checks it.
    let patched: Feature = f;
    const def = services.doc.features.get(f.type);
    const choiceRows = set.filter((x) => 'stored' in x);
    for (let i = 0; i < (dims ? 0 : set.length); i++) {
      const row = set[i];
      if ('stored' in row) continue;
      const next = withValue(patched, row.path, row.value);
      const why = def?.incomplete(next, services.doc.units) ?? null;
      if (why && !def?.incomplete(patched, services.doc.units)) {
        throw new ToolError('expr_error', `set[${i}].value (${row.field}): ${why}.`, { detail: { field: `set[${i}].value` } });
      }
      patched = next;
    }
    // The choices together (a method and its picks may only make sense as a whole), as the type checks them.
    if (choiceRows.length) {
      const was = def?.incomplete(patched, services.doc.units) ?? null;
      for (const row of choiceRows) patched = withValue(patched, row.path, row.stored);
      // The person's panel clears a Point's face when its method is no longer a centre.
      if (patched.type === 'ref_point' && patched.method !== 'center' && choiceRows.some((r) => r.path === 'method')) patched = { ...patched, face: null };
      const why = def?.incomplete(patched, services.doc.units) ?? null;
      if (why && !was) {
        const fields = choiceRows.map((r) => r.field).join(', ');
        throw new ToolError('bad_input', `set (${fields}): ${f.name} would be incomplete: ${why}. Send its picks with its own tool${f.type.startsWith('ref_') ? ' (construct, edit)' : ''} instead.`, { detail: { field: 'set', why } });
      }
    }
    const keys = new Set(set.map((x) => String(pathKeys(x.path)[0])));
    // Keep a copy names a Move/copy body as the person's panel does (Body-Move 1 becomes Body-Copy 1;
    // a name given to it stays), unless this call renames it.
    if (patched.type === 'move_body' && f.type === 'move_body' && patched.copy !== f.copy && !str(ctx.input.rename_to)) {
      const named = nameForCopy(f.name, patched.copy, s.doc.features.filter((g) => g.id !== f.id).map((g) => g.name));
      if (named !== f.name) {
        patched = { ...patched, name: named };
        keys.add('name');
      }
    }
    if (patched !== f && patched.type === 'ref_point' && (f as Feature & { face?: unknown }).face !== (patched as Feature & { face?: unknown }).face) keys.add('face');
    const patch: Partial<Feature> | null = set.length && !dims ? (Object.fromEntries([...keys].map((k) => [k, (patched as unknown as Record<string, unknown>)[k]])) as Partial<Feature>) : null;
    const renameTo = str(ctx.input.rename_to);
    let rename: string | null = null;
    if (renameTo && renameTo !== f.name) {
      if (renameTo.length > MAX_NAME) throw new ToolError('bad_input', `rename_to: at most ${MAX_NAME} characters.`, { detail: { field: 'rename_to' } });
      const clash = s.doc.features.find((g) => g.id !== f.id && g.name.toLowerCase() === renameTo.toLowerCase());
      if (clash) throw new ToolError('name_taken', `rename_to: another feature is already called ${clash.name}.`, { detail: { field: 'rename_to' } });
      rename = renameTo;
    }
    const sup = ctx.input.suppress === 'suppress' ? true : ctx.input.suppress === 'unsuppress' ? false : null;
    const suppress = sup !== null && sup !== !!f.suppressed ? sup : null;
    const move = moveIndex(s.doc.features, f, str(ctx.input.move), (n) => featureByName(s, n));
    if (!patch && !dims && rename === null && suppress === null && !move) throw new ToolError('bad_input', `Nothing to change in ${f.name}: give set rows, rename_to, suppress or move.`);
    const value = (!!patch || !!dims) && rename === null && suppress === null && !move;
    const at = s.doc.features.indexOf(f);
    const resolved: Record<string, string> = { feature: `${f.name} (${f.type})` };
    for (const x of set) resolved[x.field] = x.path === x.field ? x.value : `${x.value} (${x.path})`;
    if (move) resolved.move = move.words;
    return {
      part: `Edit ${rename ?? f.name}`,
      value,
      // A rename alone moves nothing: no cut to check.
      ...(patch || dims || suppress !== null || move ? { scopedFrom: move ? Math.min(at, move.to) : at } : {}),
      own: patch || dims ? f.id : null,
      feature: f.id,
      resolved,
      id: f.id,
      name: f.name,
      patch,
      set,
      renameTo: rename,
      suppress,
      moveTo: move?.to ?? null,
      moveWords: move?.words ?? null,
      dims,
    };
  },

  async apply(plan, ctx: EditCtx) {
    const { services } = ctx;
    const { doc } = services;
    const ui = uiFor(services);
    const structural = plan.renameTo !== null || plan.suppress !== null || plan.moveTo !== null;
    if (plan.dims) {
      await applyDimensions(ctx, plan.dims);
      // The values first, as a value edit: what they break reverts the call, whatever follows them.
      if (structural) await ctx.judgeValues();
      if (structural) await ctx.checkpoint({ hold: 'between-opens' });
    } else if (plan.patch) {
      const before = stateWord(doc.state.get().rebuild.features[plan.id]);
      const s = ui.openEditForAssistant(ctx.step, plan.id);
      if (typeof s === 'string') throw new ToolError('bad_input', `${plan.name} cannot be edited here: ${s}.`);
      await macrotask();
      await ctx.checkpoint({ hold: 'after-open', pace: 'open', label: `Edit ${plan.name}` });
      s.update(plan.patch);
      ctx.wrote(s);
      await heartbeat(ctx, doc.settled(ctx.signal), `Edit ${plan.name}`);
      await ctx.checkpoint({ pace: 'commit', hold: 'before-commit', label: `Edit ${plan.name}` });
      // The feature's own state before its Done: a value that makes it fail is the call's failure.
      const st = doc.state.get().rebuild.features[plan.id];
      if (st?.state === 'error' && before !== 'error') {
        throw new ToolError('feature_failed', `${plan.name} fails: ${st.message ?? 'it did not build'}`, { detail: { feature: plan.name, message: st.message ?? null, actions: [...(st.actions ?? [])] } });
      }
      const why = ui.doneForAssistant(ctx.step);
      if (why) throw new ToolError('incomplete', `${plan.name}: ${why}.`);
      // The values first, as a value edit: what they break reverts the call, whatever follows them.
      if (structural) await ctx.judgeValues();
      // Between the panel and the one-shot edits: a change of the person's here makes the step unclean.
      if (structural) await ctx.checkpoint({ hold: 'between-opens' });
    }
    if (plan.renameTo !== null) {
      const r = ctx.step.run(() => doc.rename(plan.id, plan.renameTo!));
      if (!r.ok) throw refused('rename_to', r);
    }
    if (plan.suppress !== null) {
      const r = ctx.step.run(() => doc.setSuppressed(plan.id, plan.suppress!));
      if (!r.ok) throw refused('suppress', r);
    }
    if (plan.moveTo !== null) {
      const r = ctx.step.run(() => doc.move(plan.id, plan.moveTo!));
      if (!r.ok) throw refused('move', r);
    }
    await ctx.checkpoint({ pace: plan.patch ? undefined : 'commit' });
  },

  reply(plan, data: EditData, ctx): ToolReply {
    const f = ctx.services.doc.state.get().doc.features.find((g) => g.id === plan.id);
    const name = f?.name ?? plan.renameTo ?? plan.name;
    const bits: string[] = [];
    if (plan.set.length) bits.push(plan.set.map((x) => `${x.field} ${x.value}`).join(', '));
    if (plan.renameTo !== null) bits.push(`renamed from ${plan.name}`);
    if (plan.suppress !== null) bits.push(plan.suppress ? 'suppressed' : 'unsuppressed');
    if (plan.moveWords) bits.push(`moved ${plan.moveWords}`);
    const state = data.feature?.state ?? 'ok';
    const body = bodyWords(data);
    const text = `Edit ${name} ${state}: ${bits.join('; ')}${body ? ` · ${body}` : ''}${data.broke.length ? ` · ${data.broke.length} feature${data.broke.length === 1 ? '' : 's'} broke` : ''}`;
    const extra: Record<string, unknown> = {};
    if (plan.dims) {
      const flipped = flippedSketches(plan.dims.before, ctx.services.doc.state.get());
      extra.flipped = flipped;
      extra.moved = plan.dims.solved.moved;
      extra.solver = { state: plan.dims.solved.state, dof: plan.dims.solved.dof, free: plan.dims.solved.free };
      if (flipped.length) data.warnings.push(`${flipped.join(', ')} turned over: a dimension went through zero; check it with get_model or view`);
    }
    const choices = f ? choicesOf(f) : [];
    return { text, data: { ...data, values: f ? valuesOf(f, ctx.services).slice(0, 40) : [], ...(choices.length ? { choices: Object.fromEntries(choices.map((c) => [c.field, c.value])) } : {}), ...extra }, summary: text };
  },
};

export const tool: ToolImpl = {
  kind: 'edit',
  run: (ctx) => runEdit(ctx, editFeature),
};
