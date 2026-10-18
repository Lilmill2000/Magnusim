// The Assistant's edit calls per key (CAD tools spec §7.9): each kept call with its name in the
// undo label ("Parameters", "Edit Boss"), the point before it (a DocMark) and the committed model
// after it, so the undo tool can take back the newest calls of a request exactly, and get_model
// can say how many it may (undo.your_steps). And the undo group's label: "Assistant: <the
// request's first line>" for a turn the host told of, "Assistant (other app): <first part> +N"
// for an outside client, "Assistant: <first part> +N" otherwise.
// Owner: ASSISTANT.
// SPDX-License-Identifier: GPL-3.0-or-later
import type { TurnFacts } from '../types/assistant';
import type { CadDoc } from '../types/doc';
import type { DocMark, DocService } from '../types/doc-service';
import { keyKind } from './session-key';

export interface LedgerEntry {
  /** The call's id. */
  call: string;
  /** Its name in the undo label and in the undo tool's answer ("Parameters", "Edit Boss"). */
  part: string;
  /** The Part just before the call. */
  mark: DocMark;
  /** The committed model just after it. */
  after: CadDoc;
}

export interface Ledger {
  /** The key's calls, oldest first. */
  entries(key: string): readonly LedgerEntry[];
  /** A call kept under `key`: its number in the key (1 for the first). */
  add(key: string, e: LedgerEntry): number;
  /** Take the newest `n` calls of `key` out (the undo tool took them back): newest first. */
  trim(key: string, n: number): LedgerEntry[];
  /** Forget a key's calls (its request was undone as a whole). */
  clear(key: string): void;
  /**
   * How many of the key's newest calls the undo tool can take back now: the Part is as the newest
   * left it and the newest undo step is the key's group, counting back while each call began where
   * the one before it ended (a change of the person's in between stops the count).
   */
  undoable(key: string, doc: Pick<DocService, 'committed' | 'assistant'>): number;
}

/** Keys kept (a page that ran many requests keeps the newest). */
const KEYS_KEPT = 32;
/** Calls kept per key (a request is capped well below this). */
const CALLS_KEPT = 400;

export function createLedger(): Ledger {
  const byKey = new Map<string, LedgerEntry[]>();
  const list = (key: string) => byKey.get(key) ?? [];
  return {
    entries: (key) => list(key),
    add(key, e) {
      const l = [...list(key), e].slice(-CALLS_KEPT);
      byKey.delete(key);
      byKey.set(key, l);
      if (byKey.size > KEYS_KEPT) byKey.delete(byKey.keys().next().value as string);
      return l.length;
    },
    trim(key, n) {
      const l = list(key);
      const k = Math.max(0, Math.min(n, l.length));
      const gone = l.slice(l.length - k).reverse();
      byKey.set(key, l.slice(0, l.length - k));
      return gone;
    },
    clear(key) {
      byKey.delete(key);
    },
    undoable(key, doc) {
      const l = list(key);
      if (!l.length) return 0;
      if (doc.committed() !== l[l.length - 1].after || doc.assistant.topGroup()?.tag !== key) return 0;
      let n = 1;
      for (let k = l.length - 1; k > 0 && l[k].mark.doc === l[k - 1].after; k--) n++;
      return n;
    },
  };
}

/** The undo group's label for a call under `key` (`parts`: the key's parts so far, this call's last). */
export function groupLabel(key: string, turn: TurnFacts | null, parts: readonly string[]): string {
  const first = parts[0] || 'changes';
  const more = parts.length > 1 ? ` +${parts.length - 1}` : '';
  if (keyKind(key) === 'external') return `Assistant (other app): ${first}${more}`;
  if (turn?.title) return `Assistant: ${turn.title}`;
  return `Assistant: ${first}${more}`;
}
