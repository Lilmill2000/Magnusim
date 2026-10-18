// The Part's health at the end of a turn (CAD tools spec §8.3): what the chip adds to "Assistant:
// <request> · done" so the person sees at once what is left to fix: "· Fillet 2 fails" (or "· 3
// features fail"), "· 2 sketches under-defined", "· 1 feature with a warning"; `error` when a
// feature fails (or the whole rebuild did), `warn` for under-defined sketches and warnings, `ok`
// otherwise. A click on the words selects the first such feature's tree row.
// Owner: ASSISTANT.
// SPDX-License-Identifier: GPL-3.0-or-later
import type { FeatureId } from '../types/doc';
import type { DocState } from '../types/doc-service';

export interface PartHealth {
  health: 'ok' | 'warn' | 'error';
  /** Each part of what is wrong ("Fillet 2 fails", "2 sketches under-defined"), worst first. */
  words: string[];
  /** The tree row a click selects: the first failing feature, else the first under-defined sketch, else the first warning. */
  first: FeatureId | null;
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** The Part's health now (as built: a rebuild still running reads as it was last built). */
export function healthOf(s: Pick<DocState, 'doc' | 'rebuild'>): PartHealth {
  const words: string[] = [];
  const failing: FeatureId[] = [];
  const under: FeatureId[] = [];
  const warning: FeatureId[] = [];
  let failingName = '';
  for (const f of s.doc.features) {
    if (f.suppressed) continue;
    const st = s.rebuild.features[f.id]?.state;
    if (st === 'error') {
      if (!failing.length) failingName = f.name;
      failing.push(f.id);
    } else if (st === 'warning') warning.push(f.id);
    if (f.type === 'sketch' && st !== 'error' && st !== 'rolled-back' && st !== 'suppressed' && f.solved?.state === 'under') under.push(f.id);
  }
  if (failing.length === 1) words.push(`${failingName} fails`);
  else if (failing.length > 1) words.push(`${failing.length} features fail`);
  else if (s.rebuild.status === 'failed') words.push('the rebuild failed');
  if (under.length) words.push(`${plural(under.length, 'sketch', 'sketches')} under-defined`);
  if (warning.length) words.push(`${plural(warning.length, 'feature')} with a warning`);
  const health = failing.length || s.rebuild.status === 'failed' ? 'error' : under.length || warning.length ? 'warn' : 'ok';
  return { health, words, first: failing[0] ?? under[0] ?? warning[0] ?? null };
}
