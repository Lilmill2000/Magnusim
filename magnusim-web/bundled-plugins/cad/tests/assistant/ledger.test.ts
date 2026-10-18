// The undo groups and the ledger by key (CAD tools spec §1.2, §7.9, §12.1 session-key rows):
//   - the label: "Assistant: <request>" for a turn the host told of, "Assistant: <first part> +N"
//     without the turn events, "Assistant (other app): <first part> +N" for an outside client;
//   - an outside client's calls (turn "") share one group and one ledger while they keep coming
//     and the person changes nothing; the person's change between them starts a new key, and so a
//     new group, and the undo tool does not reach back past it;
//   - undoable(): how many of a key's newest calls the undo tool can take back.
// SPDX-License-Identifier: GPL-3.0-or-later
import { afterEach, describe, expect, it } from 'vitest';
import { createLedger, groupLabel } from '../../src/assistant/ledger';
import { runtimeOf } from '../../src/assistant/runtime';
import type { TurnFacts } from '../../src/types/assistant';
import type { CadDoc } from '../../src/types/doc';
import type { DocMark } from '../../src/types/doc-service';
import { BlockKernel } from '../doc/blocks';
import { assistantHarness, type AssistantHarness } from './harness';

let h: AssistantHarness | null = null;
afterEach(() => {
  h?.dispose();
  h = null;
});

const PARAM = (name: string) => ({ set: [{ name, kind: 'length', expr: '1 mm', comment: '', rename_to: '' }], remove: [] });
const turn = (title: string) => ({ id: 't', title }) as TurnFacts;

describe('the group label', () => {
  it('names the request, the first part with a count, or the other app', () => {
    expect(groupLabel('turn:t', turn('Plate with four holes'), ['Parameters', 'Edit Plate'])).toBe('Assistant: Plate with four holes');
    expect(groupLabel('turn:t', null, ['Parameters'])).toBe('Assistant: Parameters');
    expect(groupLabel('turn:t', turn(''), ['Parameters', 'Edit Plate', 'Body Plate'])).toBe('Assistant: Parameters +2');
    expect(groupLabel('ext:3', null, ['Parameters', 'Edit Plate'])).toBe('Assistant (other app): Parameters +1');
    expect(groupLabel('mcp:abc', turn('ignored'), ['Edit Plate'])).toBe('Assistant (other app): Edit Plate');
  });
});

describe('undoable', () => {
  it("counts the key's newest calls back to a change of someone else's", () => {
    const docs = Array.from({ length: 6 }, () => ({}) as CadDoc);
    const mark = (doc: CadDoc) => ({ doc }) as DocMark;
    const l = createLedger();
    let committed = docs[2];
    let top: string | null = 'k';
    const doc = { committed: () => committed, assistant: { topGroup: () => (top ? { tag: top, label: '', after: committed } : null) } } as never;
    expect(l.undoable('k', doc)).toBe(0);
    l.add('k', { call: 'c1', part: 'A', mark: mark(docs[0]), after: docs[1] });
    l.add('k', { call: 'c2', part: 'B', mark: mark(docs[1]), after: docs[2] });
    expect(l.undoable('k', doc)).toBe(2);
    // A change of the person's between the second and the third.
    l.add('k', { call: 'c3', part: 'C', mark: mark(docs[3]), after: docs[4] });
    committed = docs[4];
    expect(l.undoable('k', doc)).toBe(1);
    top = 'other';
    expect(l.undoable('k', doc)).toBe(0);
    top = 'k';
    expect(l.trim('k', 1).map((e) => e.part)).toEqual(['C']);
    committed = docs[2];
    expect(l.undoable('k', doc)).toBe(2);
    l.clear('k');
    expect(l.entries('k')).toEqual([]);
  });
});

describe("an outside client's calls", () => {
  it("share one group while they keep coming; the person's change starts a new one", async () => {
    h = await assistantHarness({ kernel: new BlockKernel(), solver: false });
    const rt = runtimeOf(h.services)!;
    await h.ok('set_params', PARAM('a'), { turn: '' });
    await h.ok('set_params', PARAM('b'), { turn: '' });
    expect(h.doc.state.get().history.undoLabel).toBe('Assistant (other app): Parameters +1');
    expect(rt.ledger.entries('ext:1').map((e) => e.call)).toHaveLength(2);
    h.doc.addParam({ name: 'mine', expr: '2 mm', quantity: 'length' });
    await h.ok('set_params', PARAM('c'), { turn: '' });
    // A new outside session: its own ledger and group.
    expect(rt.ledger.entries('ext:2')).toHaveLength(1);
    expect(h.doc.state.get().history.undoLabel).toBe('Assistant (other app): Parameters');
    expect(await h.call('undo', { steps: 2, previous_turn: false }, { turn: '' })).toMatchObject({ ok: false, error: { detail: { reason: 'bad_input', range: [1, 1] } } });
    expect(await h.call('undo', { steps: 1, previous_turn: false }, { turn: '' })).toMatchObject({ ok: true });
    expect(h.doc.state.get().doc.params.map((p) => p.name)).toEqual(['a', 'b', 'mine']);
  });
});
