// delete: delete features by name (CAD tools spec §3.2.17, §7.8). The tool is destructive, so the
// app asks the person first ("Allow the Assistant to delete features?", its confirm note saying
// Ctrl+Z brings them back); a call reaches the page only once the person allowed it.
//   - Plan: each name resolves (any case, or its id); a name given twice or not in the Part is
//     refused, every problem at once. Then every feature NOT in the list that uses one of them
//     (its parents, or the makers of the bodies it names: the Part's own rule, whose refusal names
//     only the first user) is found, and the call is refused with nothing changed (in_use), naming
//     every user of every one.
//   - Apply, in one step: the same check on the Part as it is now (the person may have changed it
//     since the plan), then the Part's own remove of each, newest first, so the list's own users
//     go before what they use. One undo step, sealed into the request's group.
//   - A delete is structural: features that fail afterwards are kept and listed in `broke`.
// The deleted features leave the person's selection, as the person's own Delete does.
// Owner: ASSISTANT.
// SPDX-License-Identifier: GPL-3.0-or-later
import { storedBodyName } from '../../doc/features/body-ids';
import { dependencies, featureUses, ownsBody } from '../../doc/features/hooks';
import type { EditData, ToolImpl, ToolReply } from '../../types/assistant';
import type { CadDoc, Feature, FeatureId } from '../../types/doc';
import type { FeatureRegistry } from '../../types/doc-service';
import type { SelectionItem } from '../../types/selection';
import { ToolError } from '../errors';
import { bodyWords } from '../judge';
import { featureByName } from '../model';
import { runEdit, type EditCtx, type EditPlan, type EditTool } from '../step';
import { closestName } from '../closest';

interface Plan extends EditPlan {
  /** The features to delete, in history order. */
  ids: FeatureId[];
  names: string[];
}

/** One feature outside the list that uses one in it (detail.users). */
export interface UserRow {
  /** The feature that uses it. */
  feature: string;
  /** The listed feature it uses. */
  uses: string;
  /** The body of that feature it names, or null (it uses the feature itself: a sketch, a face, an axis). */
  via: string | null;
}

/** Users listed in the message (detail.users holds up to USERS_KEPT). */
const USERS_SAID = 12;
const USERS_KEPT = 40;
/** Feature names listed in a not_found message. */
const NAMES_SAID = 30;

const str = (v: unknown) => (typeof v === 'string' ? v.trim() : '');

/** "A", "A and B", "A, B and C". */
function andList(names: readonly string[]): string {
  return names.length <= 1 ? (names[0] ?? '') : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

/** The call's name in the undo label and the undo tool's answer: "Delete Boss", "Delete Boss and Hole 1", "Delete Boss and 2 more". */
function partOf(names: readonly string[]): string {
  if (names.length <= 2) return `Delete ${andList(names)}`;
  return `Delete ${names[0]} and ${names.length - 1} more`;
}

/**
 * Every feature of `doc` not in `ids` that uses one in it, one row per (user, used) pair, in
 * history order of the used feature, then of its users.
 */
export function usersOutside(registry: FeatureRegistry, doc: CadDoc, ids: ReadonlySet<FeatureId>): UserRow[] {
  const rows: UserRow[] = [];
  const outside = doc.features.filter((g) => !ids.has(g.id));
  const deps = new Map(outside.map((g) => [g.id, dependencies(registry, doc, g)] as const));
  for (const f of doc.features) {
    if (!ids.has(f.id)) continue;
    for (const g of outside) {
      if (!deps.get(g.id)!.includes(f.id)) continue;
      const uses = featureUses(registry, g);
      const body = uses === 'all' ? undefined : uses.find((b) => ownsBody(registry, f, b));
      const name = body ? storedBodyName(doc, body) : null;
      // A body named as its feature (Enclosure 1's "Enclosure 1") is said once.
      rows.push({ feature: g.name, uses: f.name, via: name && name !== f.name ? name : null });
    }
  }
  return rows;
}

/** The refusal while features outside the list use those in it: every user named. */
function inUse(rows: readonly UserRow[]): ToolError {
  const byUsed = new Map<string, string[]>();
  for (const r of rows.slice(0, USERS_SAID)) {
    const list = byUsed.get(r.uses) ?? [];
    list.push(r.via ? `${r.feature} (through ${r.via})` : r.feature);
    byUsed.set(r.uses, list);
  }
  const said = [...byUsed].map(([used, users]) => `${used} is used by ${andList(users)}`).join('; ');
  const more = rows.length > USERS_SAID ? ` (and ${rows.length - USERS_SAID} more uses: detail.users)` : '';
  return new ToolError('in_use', `Nothing was deleted: ${said}${more}. Add those features to the list to delete them too, or change what they use first.`, {
    detail: { users: rows.slice(0, USERS_KEPT), users_more: Math.max(0, rows.length - USERS_KEPT) },
  });
}

const deleteTool: EditTool<Plan> = {
  async plan(ctx) {
    const s = ctx.services.doc.state.get();
    const given = (Array.isArray(ctx.input.features) ? ctx.input.features : []).map(str);
    if (!given.length) throw new ToolError('bad_input', 'features: name at least one feature to delete.', { detail: { field: 'features' } });
    const ids = new Set<FeatureId>();
    const missing: string[] = [];
    const problems: string[] = [];
    const all = s.doc.features.map((g) => g.name);
    given.forEach((name, i) => {
      const f = name ? featureByName(s, name) : null;
      if (!f) {
        missing.push(`features[${i}]`);
        const near = name ? closestName(name, all) : null;
        problems.push(name ? `features[${i}]: no feature is called "${name}"${near ? ` (closest: "${near}")` : ''}` : `features[${i}]: enter a feature name`);
      } else if (ids.has(f.id)) problems.push(`features[${i}]: ${f.name} is named twice`);
      else ids.add(f.id);
    });
    if (missing.length) {
      const names = s.doc.features.map((g) => g.name);
      throw new ToolError('not_found', `${problems.slice(0, 12).join('; ')}. Features: ${names.length ? names.slice(0, NAMES_SAID).join(', ') : 'none yet'}.`, {
        detail: { field: missing[0], problems: problems.slice(0, 12), names: names.slice(0, NAMES_SAID) },
      });
    }
    if (problems.length) throw new ToolError('bad_input', `${problems.slice(0, 12).join('; ')}.`, { detail: { field: 'features', problems: problems.slice(0, 12) } });
    const users = usersOutside(ctx.services.doc.features, s.doc, ids);
    if (users.length) throw inUse(users);
    const list: Feature[] = s.doc.features.filter((g) => ids.has(g.id));
    const names = list.map((g) => g.name);
    return {
      part: partOf(names),
      value: false,
      own: null,
      feature: null,
      resolved: { features: list.map((g) => `${g.name} (${g.type})`).join(', ') },
      ids: list.map((g) => g.id),
      names,
    };
  },

  async apply(plan, ctx: EditCtx) {
    const { doc } = ctx.services;
    await ctx.checkpoint({ pace: 'commit', label: plan.part });
    // The Part as it is now: a feature the person deleted meanwhile, or one of theirs that uses a listed one.
    const now = doc.state.get().doc;
    const gone = plan.ids.filter((id) => !now.features.some((g) => g.id === id));
    if (gone.length) {
      const names = plan.names.filter((_, i) => gone.includes(plan.ids[i]));
      throw new ToolError('changed', `The Part changed while the call ran: ${andList(names)} ${names.length === 1 ? 'is' : 'are'} not in it any more. Nothing was deleted.`);
    }
    const users = usersOutside(doc.features, now, new Set(plan.ids));
    if (users.length) throw inUse(users);
    // Newest first: a listed feature's listed users go before it.
    for (const id of [...plan.ids].reverse()) {
      const block = doc.removeBlock(id);
      if (block) throw new ToolError('in_use', `Nothing was deleted: ${block}.`);
      const r = ctx.step.run(() => doc.remove(id));
      if (!r.ok) throw new ToolError('not_editable', `Nothing was deleted: ${r.reason}.`);
    }
    await ctx.checkpoint({ hold: 'before-commit', label: plan.part });
  },

  sealed(plan, ctx) {
    // The deleted features leave the selection (their rows, sketch items and regions), as the person's Delete does.
    const sel = ctx.services.selection;
    const gone = new Set(plan.ids);
    const keep = (it: SelectionItem) => !('feature' in it && gone.has(it.feature));
    if (!sel.get().items.every(keep)) sel.set((s) => ({ ...s, items: s.items.filter(keep) }));
  },

  reply(plan, data: EditData): ToolReply {
    const n = plan.names.length;
    const shown = n <= 3 ? andList(plan.names) : `${plan.names.slice(0, 2).join(', ')} and ${n - 2} more`;
    const body = bodyWords(data);
    const broke = data.broke.length ? ` · ${data.broke.length} feature${data.broke.length === 1 ? '' : 's'} broke: ${andList(data.broke.map((b) => b.feature).slice(0, 3))}` : '';
    const text = `Deleted ${shown}${body ? ` · ${body}` : ''}${broke}`;
    return { text, data: { ...data, deleted: plan.names }, summary: text };
  },
};

export const tool: ToolImpl = {
  kind: 'edit',
  run: (ctx) => runEdit(ctx, deleteTool),
};
