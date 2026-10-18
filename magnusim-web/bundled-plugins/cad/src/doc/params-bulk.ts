// Parameters in bulk (DocService.editParams): every add, change and removal of
// one edit is applied to a copy of the model and the final set is checked once,
// so the rows can come in any order: a parameter may use one added after it,
// and two may swap which uses which (w = 2*d and d = 10 mm, where d was w/2),
// which row-by-row edits refuse half-way. A rename rewrites every use in the
// other parameters and in every feature (as updateParam does); a removed name
// still used in the final model refuses the whole edit. A refusal names the
// row at fault ("add[0]", "change[1]", "remove[0]").
// Owner: DOC-CORE.
// SPDX-License-Identifier: GPL-3.0-or-later
import { newId } from '../lib/ids';
import type { CadDoc, Feature, Param, ParamId } from '../types/doc';
import type { FeatureRegistry, ParamRows } from '../types/doc-service';
import type { Quantity } from '../types/units';
import { renameInExpr } from './expr';
import { renameParamInFeature } from './features/hooks';
import { createParamScope, featureExprs, paramNameProblem, usersOfParam } from './params';

const QUANTITIES: Quantity[] = ['length', 'angle', 'scalar'];

export type ParamsPlan =
  /** `doc` is the input itself when nothing changes. `count`: the rows. */
  | { ok: true; doc: CadDoc; ids: Record<string, ParamId>; count: number }
  | { ok: false; reason: string; row?: string };

/** "a", "a and b", "a, b and c", "a, b, c and 2 more". */
export function listOfNames(names: string[]): string {
  if (names.length <= 1) return names.join('');
  if (names.length <= 3) return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
  return `${names.slice(0, 3).join(', ')} and ${names.length - 3} more`;
}

/** The words removeParam uses for a parameter still read by others. */
export function stillUsed(name: string, users: string[]): string {
  return `${name} can't be deleted: ${listOfNames(users)} ${users.length === 1 ? 'uses' : 'use'} it`;
}

/** A patch without its undefined keys (an explicit undefined keeps the field as it was). */
function defined<T extends object>(patch: T): Partial<T> {
  return Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined)) as Partial<T>;
}

function tidy(p: Param): Param {
  const next = { ...p, name: String(p.name ?? '').trim(), expr: String(p.expr ?? '').trim() };
  if (!next.comment) delete next.comment;
  if (!next.favorite) delete next.favorite;
  return next;
}

/** The model after `rows`, every parameter checked, or why not (pure: nothing is applied). */
export function planParams(doc: CadDoc, rows: ParamRows, registry: FeatureRegistry | null): ParamsPlan {
  const add = rows.add ?? [];
  const change = rows.change ?? [];
  const remove = rows.remove ?? [];
  const fail = (row: string | undefined, reason: string): ParamsPlan => (row ? { ok: false, reason, row } : { ok: false, reason });
  const byId = new Map(doc.params.map((p) => [p.id, p] as const));

  // Each row names a parameter of the part, once.
  const changed = new Map<ParamId, number>();
  for (let i = 0; i < change.length; i++) {
    const old = change[i] ? byId.get(change[i].id) : undefined;
    if (!old) return fail(`change[${i}]`, 'That parameter is not in the part');
    if (changed.has(old.id)) return fail(`change[${i}]`, `${old.name} is changed twice in this edit`);
    changed.set(old.id, i);
  }
  const removed = new Map<ParamId, number>();
  for (let i = 0; i < remove.length; i++) {
    const old = byId.get(remove[i]);
    if (!old) return fail(`remove[${i}]`, 'That parameter is not in the part');
    if (removed.has(old.id)) return fail(`remove[${i}]`, `${old.name} is removed twice in this edit`);
    if (changed.has(old.id)) return fail(`remove[${i}]`, `${old.name} is both changed and removed in this edit`);
    removed.set(old.id, i);
  }

  // Renames. A new name that another parameter renamed or removed here had before: its uses
  // could not be told apart from the renamed one's.
  const renames: { id: ParamId; from: string; to: string; row: string }[] = [];
  for (let i = 0; i < change.length; i++) {
    if (change[i].patch?.name === undefined) continue;
    const old = byId.get(change[i].id)!;
    const to = String(change[i].patch.name ?? '').trim();
    if (to !== old.name) renames.push({ id: old.id, from: old.name, to, row: `change[${i}]` });
  }
  const moving = new Set<ParamId>([...renames.map((r) => r.id), ...removed.keys()]);
  for (const r of renames) {
    if (doc.params.some((p) => p.id !== r.id && p.name === r.to && moving.has(p.id))) {
      return fail(r.row, `${r.to} is the name of a parameter this edit renames or removes: rename them in two edits`);
    }
  }

  // The copy: removals, every rename's uses rewritten, the changes, then the new rows.
  let params: Param[] = doc.params.filter((p) => !removed.has(p.id));
  let features: Feature[] = doc.features;
  for (const r of renames) {
    params = params.map((p) => {
      const expr = renameInExpr(p.expr, r.from, r.to);
      return expr === p.expr ? p : { ...p, expr };
    });
    features = features.map((f) => (featureExprs(f, registry).some((e) => renameInExpr(e.expr, r.from, r.to) !== e.expr) ? renameParamInFeature(registry, f, r.from, r.to) : f));
  }
  params = params.map((p) => {
    const i = changed.get(p.id);
    // A changed row's expression is written with the final names: it is not rewritten.
    return i === undefined ? p : tidy({ ...p, ...defined(change[i].patch ?? {}), id: p.id } as Param);
  });
  const ids: Record<string, ParamId> = {};
  const added: Param[] = add.map((a) => {
    const p: Param = tidy({ id: newId('p'), name: String(a?.name ?? ''), expr: String(a?.expr ?? ''), quantity: a?.quantity ?? 'length' });
    if (a?.comment) p.comment = String(a.comment);
    if (a?.favorite) p.favorite = true;
    return p;
  });
  params = [...params, ...added];

  // The rows' own names and quantities, against the final set.
  const rowsOf: { p: Param; row: string }[] = [
    ...added.map((p, i) => ({ p, row: `add[${i}]` })),
    ...change.map((c, i) => ({ p: params.find((x) => x.id === c.id)!, row: `change[${i}]` })),
  ];
  for (const { p, row } of rowsOf) {
    const problem = paramNameProblem(p.name, params, p.id);
    if (problem) return fail(row, problem);
    if (!QUANTITIES.includes(p.quantity)) return fail(row, 'Pick length, angle or number');
  }

  // A removed name still read in the final model (unless a parameter of the final set has it).
  const final: CadDoc = { ...doc, params, features };
  for (let i = 0; i < remove.length; i++) {
    const name = byId.get(remove[i])!.name;
    if (params.some((p) => p.name === name)) continue;
    const users = usersOfParam(final, name, registry);
    const names = [...users.params.map((u) => u.name), ...users.features.map((u) => u.name)];
    if (names.length) return fail(`remove[${i}]`, stillUsed(name, names));
  }

  // Every row evaluates in the final set; a parameter no row names that evaluated before still does.
  const scope = createParamScope(params, doc.units);
  for (const { p, row } of rowsOf) {
    const r = scope.valueOf(p.name);
    if (!r || !r.ok) return fail(row, r ? r.error : 'Not evaluated');
  }
  const before = createParamScope(doc.params, doc.units);
  const rowIds = new Set(rowsOf.map((x) => x.p.id));
  for (const p of params) {
    if (rowIds.has(p.id) || !before.valueOf(p.name)?.ok) continue;
    const r = scope.valueOf(p.name);
    if (!r || !r.ok) return fail(undefined, `${p.name}: ${r ? r.error : 'Not evaluated'}`);
  }

  for (const p of added) ids[p.name] = p.id;
  const count = add.length + change.length + remove.length;
  if (features === doc.features && JSON.stringify(params) === JSON.stringify(doc.params)) return { ok: true, doc, ids, count };
  return { ok: true, doc: final, ids, count };
}
