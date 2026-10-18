// The Part's revision as the Assistant sees it (CAD tools spec §4): `rev` goes up by one for each
// new committed model (DocService.committed: the model from before an open panel, else the
// current one), so live drafts never move it. And what the person changed, in words: the
// committed model's difference since the key's last call ended, worked out as a call answers,
// so what the person did while it ran (an edit waits for them) is told in that answer; the
// call's own kept step (own(): from its mark to the model after it) never counts. Reported once,
// with the person's undo or redo of the Assistant's own steps (one that came while the call ran
// too).
// Owner: ASSISTANT.
// SPDX-License-Identifier: GPL-3.0-or-later
import type { BodyId, CadDoc, Feature } from '../types/doc';
import type { DocService } from '../types/doc-service';
import type { EventBus } from '../lib/bus';
import type { CadEvents } from '../types/events';

/** At most this many lines of the person's changes per reply (the rest is counted). */
export const USER_CHANGES_MAX = 20;
/** Keys whose baseline is kept (a page that ran many turns keeps the ones seen last). */
const KEYS_KEPT = 64;

export interface RevTracker {
  /** The revision now. */
  current(): number;
  /** A call under `key` starts: a key's first call takes the model now as its baseline. */
  begin(key: string): void;
  /** The call under `key` kept a step of its own, from `before` to `after` (never told as the person's). */
  own(key: string, before: CadDoc, after: CadDoc): void;
  /** The person's changes since the key's last call ended (or its first call began), the call's own step left out, in words. */
  changesFor(key: string): string[];
  /** A call under `key` ended: what it saw is now the key's baseline (each change is told once). */
  seen(key: string): void;
  dispose(): void;
}

const withoutName = (f: Feature) => {
  const { name: _n, suppressed: _s, ...rest } = f as Feature & Record<string, unknown>;
  return JSON.stringify(rest);
};

/** The difference between two committed models, as lines a model reads ("renamed Extrude 3 to Boss"). */
export function describeChanges(before: CadDoc, after: CadDoc): string[] {
  if (before === after) return [];
  const out: string[] = [];
  const old = new Map(before.features.map((f) => [f.id, f]));
  const now = new Map(after.features.map((f) => [f.id, f]));
  for (const f of after.features) {
    const o = old.get(f.id);
    if (!o) {
      out.push(`added ${f.name} (${f.type})`);
      continue;
    }
    if (o === f) continue;
    if (o.name !== f.name) out.push(`renamed ${o.name} to ${f.name}`);
    if (!!o.suppressed !== !!f.suppressed) out.push(`${f.suppressed ? 'suppressed' : 'unsuppressed'} ${f.name}`);
    if (withoutName(o) !== withoutName(f)) out.push(`changed ${f.name}`);
  }
  for (const f of before.features) if (!now.has(f.id)) out.push(`deleted ${f.name}`);
  const kept = (list: readonly Feature[], other: Map<string, Feature>) => list.filter((f) => other.has(f.id)).map((f) => f.id);
  const a = kept(before.features, now);
  const b = kept(after.features, old);
  if (a.join(' ') !== b.join(' ')) {
    const moved = b.filter((id, i) => a[i] !== id).map((id) => now.get(id)!.name);
    out.push(`reordered the history (${moved.slice(0, 4).join(', ')}${moved.length > 4 ? ', ...' : ''})`);
  }
  const pOld = new Map(before.params.map((p) => [p.id, p]));
  const pNow = new Map(after.params.map((p) => [p.id, p]));
  for (const p of after.params) {
    const o = pOld.get(p.id);
    if (!o) out.push(`added parameter ${p.name} = ${p.expr}`);
    else {
      if (o.name !== p.name) out.push(`renamed parameter ${o.name} to ${p.name}`);
      if (o.expr !== p.expr) out.push(`set parameter ${p.name} to ${p.expr} (was ${o.expr})`);
      if (o.quantity !== p.quantity) out.push(`made parameter ${p.name} a ${p.quantity === 'scalar' ? 'number' : p.quantity}`);
    }
  }
  for (const p of before.params) if (!pNow.has(p.id)) out.push(`deleted parameter ${p.name}`);
  const ids = new Set<BodyId>([...Object.keys(before.bodies), ...Object.keys(after.bodies)]);
  for (const id of ids) {
    const o = before.bodies[id];
    const b2 = after.bodies[id];
    if (!o || !b2) continue;
    if (o.name !== b2.name) out.push(`renamed body ${o.name} to ${b2.name}`);
    if (o.color !== b2.color) out.push(`set the colour of ${b2.name} to ${b2.color}`);
    if ((o.simulation === false) !== (b2.simulation === false)) out.push(b2.simulation === false ? `left ${b2.name} out of the simulation` : `put ${b2.name} back into the simulation`);
  }
  return out;
}

/** Cut to USER_CHANGES_MAX lines, the rest counted. */
function capped(lines: string[]): string[] {
  if (lines.length <= USER_CHANGES_MAX) return lines;
  return [...lines.slice(0, USER_CHANGES_MAX - 1), `and ${lines.length - USER_CHANGES_MAX + 1} more changes`];
}

export function createRevTracker(o: { doc: DocService; bus: EventBus<CadEvents> }): RevTracker {
  let rev = 0;
  let last = o.doc.committed();
  const offState = o.doc.state.subscribe(() => {
    const c = o.doc.committed();
    if (c !== last) {
      last = c;
      rev += 1;
    }
  });
  const baselines = new Map<string, CadDoc>();
  /** The steps the key's running call kept: the committed model before and after each. */
  const owns = new Map<string, { before: CadDoc; after: CadDoc }[]>();
  /** The person's undo or redo of a key's steps, told with that key's next reply. */
  const undone = new Map<string, string[]>();
  const offUndo = o.bus.on('assistant:person-undo', (e) => {
    if (!e.tag) return;
    const what = e.label ? ` (${e.label})` : '';
    const line = e.redo ? `the person redid your steps${what}` : `the person undid your steps${what}; do not redo them unless asked`;
    undone.set(e.tag, [...(undone.get(e.tag) ?? []), line]);
  });
  return {
    current: () => rev,
    begin(key) {
      if (!baselines.has(key)) baselines.set(key, o.doc.committed());
    },
    own(key, before, after) {
      if (before !== after) owns.set(key, [...(owns.get(key) ?? []), { before, after }]);
    },
    changesFor(key) {
      const notes = undone.get(key) ?? [];
      const base = baselines.get(key);
      const diff: string[] = [];
      if (base) {
        // The person's: before each own step, and after the last one.
        let from = base;
        for (const st of owns.get(key) ?? []) {
          diff.push(...describeChanges(from, st.before));
          from = st.after;
        }
        diff.push(...describeChanges(from, o.doc.committed()));
      }
      return capped([...notes, ...diff]);
    },
    seen(key) {
      undone.delete(key);
      owns.delete(key);
      // Moved to the end: the key least recently seen goes first when there are too many.
      baselines.delete(key);
      baselines.set(key, o.doc.committed());
      if (baselines.size > KEYS_KEPT) baselines.delete(baselines.keys().next().value as string);
      if (undone.size > KEYS_KEPT) undone.delete(undone.keys().next().value as string);
    },
    dispose() {
      offState();
      offUndo();
    },
  };
}
