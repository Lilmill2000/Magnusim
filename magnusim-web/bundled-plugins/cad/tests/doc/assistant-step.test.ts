// doc.assistant: one Assistant edit call as one step, all or nothing, with the
// person always first. Over a fake host and the toy kernel:
//   - run() makes the sessions and undo steps inside it the step's own;
//   - inside run, the person's open session is never committed (PersonEditing),
//     and outside it the person's edit takes over the Assistant's session;
//   - seal merges a call into its turn's group, never over the person's steps;
//   - a person's Ctrl+Z between a push and the seal (forced in a microtask) is a
//     take-over, and no seal happens over it;
//   - revert is exact, refused once someone else changed the Part, idempotent;
//   - the save hold: the stored model is the mark during a clean step, on every
//     write path, and one write follows end();
//   - restore (the undo tool), undoGroup and the person-undo events.
// SPDX-License-Identifier: GPL-3.0-or-later
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDocService, isPersonEditing, PersonEditing } from '../../src/doc';
import { linearPatternDef } from '../../src/features/pattern/defs';
import { createBridge } from '../../src/lib/bridge';
import { createBus } from '../../src/lib/bus';
import type { Feature, ParamId } from '../../src/types/doc';
import type { AssistantStep, DocService, FeatureTypeDef } from '../../src/types/doc-service';
import type { CadEvents } from '../../src/types/events';
import { createFakeWorkspace } from '../fakes/workspace-sdk';
import { block, BlockKernel, blockSketch, extentFor, profileOf, registerSolidFeatures } from './blocks';

const MODEL = 'studies/st-test/model.json';

const services: DocService[] = [];
afterEach(() => {
  for (const s of services.splice(0)) s.dispose();
});

function make(opts: { interval?: number; burst?: number; hostVersion?: string } = {}) {
  const ws = createFakeWorkspace({ hostVersion: opts.hostVersion });
  const bus = createBus<CadEvents>();
  const doc = createDocService({
    bridge: createBridge(ws),
    kernel: new BlockKernel(),
    bus,
    saveIntervalMs: opts.interval ?? 20,
    saveBurst: opts.burst,
    saveViewIntervalMs: 20,
    log: () => {},
  });
  registerSolidFeatures(doc);
  services.push(doc);
  const takeOvers: CadEvents['assistant:taken-over'][] = [];
  const undos: CadEvents['assistant:person-undo'][] = [];
  /** The model when each person-undo event was heard. */
  const undoDocs: unknown[] = [];
  bus.on('assistant:taken-over', (e) => takeOvers.push(e));
  bus.on('assistant:person-undo', (e) => {
    undos.push(e);
    undoDocs.push(doc.state.get().doc);
  });
  return { ws, doc, bus, takeOvers, undos, undoDocs };
}

const names = (doc: DocService) => doc.state.get().doc.features.map((f) => f.name);
const history = (doc: DocService) => doc.state.get().history;
const newSketch = (doc: DocService, x = 50) => doc.beginNew('sketch', blockSketch(x, 0) as Partial<Feature>);

/** One Assistant call of turn `tag`: `fn` inside one step, sealed into the turn's group. */
function call(doc: DocService, owner: string, fn: () => void, tag = 'turn:t1', label = 'Assistant: plate'): AssistantStep {
  const st = doc.assistant.begin(owner);
  st.run(fn);
  st.seal(tag, label);
  st.end();
  return st;
}

/** Undo until the history is empty, collecting the labels on the way. */
function undoLabels(doc: DocService): string[] {
  const out: string[] = [];
  while (history(doc).canUndo) {
    out.push(history(doc).undoLabel!);
    doc.undo();
  }
  return out;
}

describe('doc.assistant: ownership', () => {
  it('run makes the sessions it opens and the undo steps it pushes the step\'s own; the person\'s carry none', async () => {
    const { doc } = make();
    await doc.load();
    const a = block(doc);
    expect(doc.assistant.topGroup()).toBeNull();
    const st = doc.assistant.begin('assistant:c1');
    expect(doc.assistant.current()).toBe(st);
    expect(st.owner).toBe('assistant:c1');
    const s = st.run(() => newSketch(doc));
    expect(s.owner).toBe('assistant:c1');
    // The session's own changes are the step's, also when called outside run (a paced fill).
    s.update({ points: { ...blockSketch(50, 0).points, pt_2: [75, 0] } } as Partial<Feature>);
    st.run(() => s.commit());
    expect(doc.assistant.topGroup()).toEqual({ tag: 'assistant:c1', label: 'Sketch 2', after: doc.state.get().doc });
    expect(st.run(() => doc.rename(a.extrude, 'Base'))).toEqual({ ok: true });
    expect(doc.assistant.topGroup()).toMatchObject({ tag: 'assistant:c1', label: 'Rename Extrude 1' });
    expect(st.clean).toBe(true);
    expect(st.takenOver).toBeNull();
    st.end();
    expect(st.ended).toBe(true);
    expect(doc.assistant.current()).toBeNull();
    expect(() => st.run(() => 1)).toThrow('This Assistant step has ended');
    // The person's own session and undo steps carry no owner and no tag.
    const p = newSketch(doc, 100);
    expect(p.owner).toBeUndefined();
    p.commit();
    expect(doc.assistant.topGroup()).toBeNull();
    expect(history(doc).undoLabel).toBe('Sketch 3');
  });

  it('a session\'s own changes are its owner\'s whoever calls: the person\'s draft is never the step\'s', async () => {
    const { doc } = make();
    await doc.load();
    const a = block(doc);
    const st = doc.assistant.begin('assistant:c1');
    const person = doc.beginEdit(a.extrude);
    // Even reached from inside the step's run, the person's draft is the person's change: the
    // step's own record does not take it in (an open panel is no change of the Part until its Done).
    st.run(() => person.update({ extent: { kind: 'blind', distance: '30 mm' } } as Partial<Feature>));
    const live = doc.state.get().doc;
    expect(live).not.toBe(st.mark.doc);
    expect(doc.committed()).toBe(st.mark.doc);
    expect(st.clean).toBe(true);
    // The step changed nothing: its revert leaves the person's draft as it is.
    expect(st.revert()).toEqual({ ok: true });
    expect(doc.state.get().doc).toBe(live);
    expect(person.open).toBe(true);
    st.end();
    // The person's Done is the person's own step, never tagged as the step's.
    person.commit();
    expect(history(doc).undoLabel).toBe('Edit Extrude 1');
    expect(doc.assistant.topGroup()).toBeNull();
  });

  it('begin refuses a second step, a Part that is not editable, and an open panel session', async () => {
    const { doc } = make();
    expect(() => doc.assistant.begin('assistant:c0')).toThrow('The part is still loading');
    await doc.load();
    const st = doc.assistant.begin('assistant:c1');
    expect(() => doc.assistant.begin('assistant:c2')).toThrow('An Assistant step is already open');
    st.end();
    const person = newSketch(doc);
    let caught: unknown = null;
    try {
      doc.assistant.begin('assistant:c3');
    } catch (e) {
      caught = e;
    }
    expect(isPersonEditing(caught)).toBe(true);
    expect((caught as PersonEditing).feature).toBe(person.feature);
    expect((caught as PersonEditing).message).toBe('The person is editing Sketch 1');
    expect(doc.session()).toBe(person);
    expect(person.open).toBe(true);
  });
});

describe('doc.assistant: the person always first', () => {
  it('inside run, a person\'s open session is never committed: every edit throws PersonEditing and it stays open, uncommitted', async () => {
    const { doc } = make();
    await doc.load();
    const a = block(doc);
    const st = doc.assistant.begin('assistant:c1');
    const committed = doc.state.get().doc;
    // The person opens a panel between two of the step's opens, and types in it.
    const person = doc.beginEdit(a.extrude);
    person.update({ extent: { kind: 'blind', distance: '30 mm' } } as Partial<Feature>);
    const live = doc.state.get().doc;
    expect(live).not.toBe(committed);
    const hist = history(doc);
    const tries: [string, () => unknown][] = [
      ['beginNew', () => newSketch(doc)],
      ['beginEdit of the same feature', () => doc.beginEdit(a.extrude)],
      ['beginEdit of another', () => doc.beginEdit(a.sketch)],
      ['rename', () => doc.rename(a.sketch, 'Profile')],
      ['remove', () => doc.remove(a.extrude)],
      ['editParams', () => doc.editParams({ add: [{ name: 'w', expr: '20 mm', quantity: 'length' }], change: [], remove: [] })],
      ['addParam', () => doc.addParam({ name: 'w', expr: '20 mm', quantity: 'length' })],
      ['setSuppressed', () => doc.setSuppressed(a.sketch, true)],
      ['undo', () => doc.undo()],
      ['redo', () => doc.redo()],
      ['setRollback', () => doc.setRollback(1)],
    ];
    for (const [what, fn] of tries) {
      let caught: unknown = null;
      try {
        st.run(fn);
      } catch (e) {
        caught = e;
      }
      expect(caught, what).toBeInstanceOf(PersonEditing);
      expect((caught as PersonEditing).feature, what).toBe(a.extrude);
      expect(doc.session(), what).toBe(person);
      expect(person.open, what).toBe(true);
      expect(doc.state.get().doc, what).toBe(live);
      expect(history(doc), what).toEqual(hist);
    }
    expect(doc.committed()).toBe(committed);
    // The person's open draft is no change of the Part yet: the step is still only its own.
    expect(st.clean).toBe(true);
    // The person's Done is theirs as usual, and from then on the step is no longer only its own.
    person.commit();
    expect(history(doc).undoLabel).toBe('Edit Extrude 1');
    expect(st.clean).toBe(false);
    st.end();
  });

  it('a person\'s edit outside run takes over the Assistant\'s open session: discarded, never committed', async () => {
    const { doc, takeOvers } = make();
    await doc.load();
    const a = block(doc);
    const cases: [string, () => void, string][] = [
      ['a one-shot edit', () => doc.rename(a.extrude, 'Base'), 'edit'],
      ['a new panel', () => doc.beginNew('extrude').discard(), 'edit'],
      ['a panel on the same feature', () => doc.beginEdit(a.sketch).discard(), 'edit'],
      ['the rollback bar', () => doc.setRollback(1), 'edit'],
      ['Ctrl+Z', () => doc.undo(), 'undo'],
      ['Ctrl+Y', () => doc.redo(), 'undo'],
    ];
    for (const [what, act, why] of cases) {
      takeOvers.length = 0;
      doc.setRollback(null);
      const committed = doc.state.get().doc;
      const hist = history(doc);
      const st = doc.assistant.begin(`assistant:${what}`);
      // A half-filled Assistant panel: its sketch is already in the model (live).
      const s = st.run(() => (what === 'a panel on the same feature' ? doc.beginEdit(a.sketch) : newSketch(doc)));
      if (what === 'a panel on the same feature') s.update({ points: { ...blockSketch().points, pt_2: [25, 0] } } as Partial<Feature>);
      expect(doc.state.get().doc, what).not.toBe(committed);
      act();
      expect(s.open, what).toBe(false);
      expect(takeOvers, what).toEqual([{ why }]);
      expect(st.takenOver, what).toBe(why);
      expect(st.clean, what).toBe(false);
      if (why === 'undo') {
        // The take-over was the person's undo: the panel went, and nothing else was undone.
        expect(doc.state.get().doc, what).toBe(committed);
        expect(history(doc), what).toEqual(hist);
      }
      expect(names(doc), what).not.toContain('Sketch 2');
      expect(() => st.seal('turn:t1', 'Assistant: x'), what).toThrow('The person took this step over');
      st.end();
    }
    // The rename went ahead and was never absorbed into an Assistant step.
    expect(names(doc)).toEqual(['Sketch 1', 'Base']);
    expect(doc.assistant.topGroup()).toBeNull();
  });

  it('takeOver (Escape on the Assistant\'s panel) discards its session, and the revert takes the rest of the step back', async () => {
    const { doc, takeOvers } = make();
    await doc.load();
    const a = block(doc);
    expect(doc.assistant.takeOver('escape')).toBe(false);
    const st = doc.assistant.begin('assistant:c1');
    const mark = st.mark;
    // The step's first part is committed (as an offset plane is), then its sketch opens.
    st.run(() => doc.rename(a.extrude, 'Base'));
    st.run(() => newSketch(doc));
    expect(doc.assistant.takeOver('escape')).toBe(true);
    expect(takeOvers).toEqual([{ why: 'escape' }]);
    expect(st.takenOver).toBe('escape');
    expect(st.clean).toBe(false);
    expect(doc.session()).toBeNull();
    expect(names(doc)).toEqual(['Sketch 1', 'Base']);
    // Only the Assistant changed the model: the revert completes the person's discard.
    expect(st.revert()).toEqual({ ok: true });
    expect(doc.state.get().doc).toBe(mark.doc);
    expect(names(doc)).toEqual(['Sketch 1', 'Extrude 1']);
    expect(history(doc).undoLabel).toBe('Extrude 1');
    expect(history(doc).canRedo).toBe(false);
    st.end();
  });

  it('takeOver with the step\'s owner (its Parameters panel, no session) marks the open step; another owner, no step or an ended one, nothing', async () => {
    const { doc, takeOvers } = make();
    await doc.load();
    block(doc);
    expect(doc.assistant.takeOver('escape', { owner: 'assistant:c1' })).toBe(false);
    const st = doc.assistant.begin('assistant:c1');
    expect(doc.assistant.takeOver('escape', { owner: 'assistant:c2' })).toBe(false);
    expect(doc.assistant.takeOver('escape')).toBe(false);
    expect(st.takenOver).toBeNull();
    expect(takeOvers).toEqual([]);
    expect(doc.assistant.takeOver('command', { owner: 'assistant:c1' })).toBe(true);
    expect(st.takenOver).toBe('command');
    expect(st.clean).toBe(false);
    expect(takeOvers).toEqual([{ why: 'command' }]);
    // The first why stays.
    expect(doc.assistant.takeOver('escape', { owner: 'assistant:c1' })).toBe(true);
    expect(st.takenOver).toBe('command');
    // Nothing was changed: the revert has nothing to do, and seal refuses.
    expect(st.revert()).toEqual({ ok: true });
    expect(() => st.seal('turn:t1', 'Assistant: x')).toThrow('The person took this step over');
    st.end();
    expect(doc.assistant.takeOver('escape', { owner: 'assistant:c1' })).toBe(false);
    expect(takeOvers).toHaveLength(2);
  });

  it('the person\'s Delete of the feature the Assistant is filling takes it over: discarded, then removed as the person\'s own step', async () => {
    const { doc, takeOvers } = make();
    await doc.load();
    const a = block(doc);
    const before = doc.state.get().doc;
    const st = doc.assistant.begin('assistant:c1');
    const s = st.run(() => doc.beginEdit(a.extrude));
    s.update({ extent: extentFor(0, 30) } as Partial<Feature>);
    expect(doc.remove(a.extrude)).toEqual({ ok: true });
    expect(s.open).toBe(false);
    expect(takeOvers).toEqual([{ why: 'edit' }]);
    expect(st.takenOver).toBe('edit');
    expect(names(doc)).toEqual(['Sketch 1']);
    // One undo step of the person's, with nothing of the Assistant's draft: Undo brings back the feature as it was.
    expect(history(doc).undoLabel).toBe('Delete Extrude 1');
    expect(doc.assistant.topGroup()).toBeNull();
    expect(st.revert().ok).toBe(false);
    st.end();
    doc.undo();
    expect(doc.state.get().doc).toBe(before);
    // A new feature the Assistant fills: taken over, and then there is nothing to remove.
    takeOvers.length = 0;
    const hist = history(doc);
    const st2 = doc.assistant.begin('assistant:c2');
    const n = st2.run(() => newSketch(doc));
    expect(names(doc)).toEqual(['Sketch 1', 'Extrude 1', 'Sketch 2']);
    expect(doc.remove(n.feature)).toEqual({ ok: false, reason: 'That feature is not in the part' });
    expect(n.open).toBe(false);
    expect(takeOvers).toEqual([{ why: 'edit' }]);
    expect(st2.takenOver).toBe('edit');
    expect(history(doc)).toEqual(hist);
    expect(doc.state.get().doc).toBe(before);
    expect(st2.revert()).toEqual({ ok: true });
    st2.end();
  });

  it('a person\'s panel opened between two opens: the revert puts the mark back under it, open and untouched', async () => {
    const { doc } = make();
    await doc.load();
    const a = block(doc);
    const st = doc.assistant.begin('assistant:c1');
    const mark = st.mark;
    // The step's first part (as an offset plane): a sketch committed.
    st.run(() => newSketch(doc).commit());
    expect(names(doc)).toEqual(['Sketch 1', 'Extrude 1', 'Sketch 2']);
    // The person opens Extrude from the toolbar (nothing picked yet: the model is unchanged).
    const person = doc.beginNew('extrude');
    expect(person.incomplete()).toBe('Pick a profile');
    // The step's next open meets it and stands back.
    expect(() => st.run(() => newSketch(doc, 100))).toThrow(PersonEditing);
    expect(st.clean).toBe(true);
    expect(st.revert()).toEqual({ ok: true });
    expect(doc.state.get().doc).toBe(mark.doc);
    expect(doc.session()).toBe(person);
    expect(person.open).toBe(true);
    expect(doc.committed()).toBe(mark.doc);
    st.end();
    // The person's panel goes on from the restored model: its Done is one step back to the mark,
    // never to the Assistant's half step.
    person.update({ profiles: [profileOf(a.sketch, blockSketch())], extent: extentFor(0, 10), op: 'new' } as Partial<Feature>);
    person.commit();
    expect(names(doc)).toEqual(['Sketch 1', 'Extrude 1', 'Extrude 2']);
    expect(history(doc).undoLabel).toBe('Extrude 2');
    doc.undo();
    expect(doc.state.get().doc).toBe(mark.doc);
  });

  it('a person\'s panel whose draft applied at once (a new sketch) between two opens: the revert puts the mark back under it, its draft on top, still the person\'s', async () => {
    const { doc } = make();
    await doc.load();
    const a = block(doc);
    const hist = history(doc);
    const st = doc.assistant.begin('assistant:c1');
    const mark = st.mark;
    st.run(() => newSketch(doc).commit());
    // (Review: this applied draft made the step unclean, so the revert was refused and the step's half kept.)
    const person = newSketch(doc, 100);
    expect(names(doc)).toEqual(['Sketch 1', 'Extrude 1', 'Sketch 2', 'Sketch 3']);
    expect(st.clean).toBe(true);
    // A view change of the step's under it (a body hidden) takes in nothing of the person's draft.
    st.run(() => doc.setBodyVisible(a.body!, false));
    expect(st.clean).toBe(true);
    expect(() => st.run(() => newSketch(doc, 150))).toThrow(PersonEditing);
    const r = st.revert();
    expect(r).toEqual({ ok: true });
    // The step's sketch is gone; the person's is on top of the mark, open and uncommitted.
    expect(names(doc)).toEqual(['Sketch 1', 'Extrude 1', 'Sketch 3']);
    expect(doc.committed()).toBe(mark.doc);
    expect(doc.session()).toBe(person);
    expect(person.open).toBe(true);
    expect(history(doc)).toEqual(hist);
    expect(st.clean).toBe(true);
    st.end();
    expect(st.revert()).toBe(r);
    // Its Done is one step of the person's on the mark.
    person.commit();
    expect(history(doc).undoLabel).toBe('Sketch 3');
    expect(doc.assistant.topGroup()).toBeNull();
    doc.undo();
    expect(doc.state.get().doc).toBe(mark.doc);
  });

  it('with the rollback bar set: the person\'s new feature goes back in at the bar, and its discard puts the bar back where the mark had it', async () => {
    const { doc } = make();
    await doc.load();
    const a = block(doc);
    doc.setRollback(1);
    const st = doc.assistant.begin('assistant:c1');
    const mark = st.mark;
    st.run(() => newSketch(doc).commit());
    expect(names(doc)).toEqual(['Sketch 1', 'Sketch 2', 'Extrude 1']);
    expect(doc.state.get().view.rollback).toBe(2);
    const person = newSketch(doc, 100);
    expect(names(doc)).toEqual(['Sketch 1', 'Sketch 2', 'Sketch 3', 'Extrude 1']);
    expect(doc.state.get().view.rollback).toBe(3);
    expect(st.clean).toBe(true);
    expect(st.revert()).toEqual({ ok: true });
    expect(names(doc)).toEqual(['Sketch 1', 'Sketch 3', 'Extrude 1']);
    expect(doc.state.get().view.rollback).toBe(2);
    expect(doc.committed()).toBe(mark.doc);
    expect(st.clean).toBe(true);
    st.end();
    person.discard();
    expect(doc.state.get().doc).toBe(mark.doc);
    expect(doc.state.get().view.rollback).toBe(1);
    expect(names(doc)).toEqual(['Sketch 1', 'Extrude 1']);
    expect(a.extrude).toBe(doc.state.get().doc.features[1].id);
  });

  it('a person\'s Edit with a live change, of a feature the step did not touch: kept open and put on the mark', async () => {
    const { doc } = make();
    await doc.load();
    const a = block(doc);
    const st = doc.assistant.begin('assistant:c1');
    const mark = st.mark;
    st.run(() => newSketch(doc, 50).commit());
    const person = doc.beginEdit(a.extrude);
    person.update({ extent: extentFor(0, 30) } as Partial<Feature>);
    expect(st.revert()).toEqual({ ok: true });
    expect(names(doc)).toEqual(['Sketch 1', 'Extrude 1']);
    expect(doc.committed()).toBe(mark.doc);
    expect(person.open).toBe(true);
    expect((doc.state.get().doc.features[1] as Feature & { extent: unknown }).extent).toEqual(extentFor(0, 30));
    st.end();
    person.commit();
    expect(history(doc).undoLabel).toBe('Edit Extrude 1');
    doc.undo();
    expect(doc.state.get().doc).toBe(mark.doc);
  });

  it('a person\'s panel on what the step changed: the revert (or the undo tool\'s restore) is refused, and nothing changes', async () => {
    const { doc } = make();
    await doc.load();
    const a = block(doc);
    const w = String(doc.addParam({ name: 'w', expr: '20 mm', quantity: 'length' }));
    /** Every refusal leaves the model, the person's session and the history as they were. */
    const refused = (st: AssistantStep, person: ReturnType<DocService['beginNew']>, attempt: () => unknown, reason: string) => {
      const live = doc.state.get().doc;
      // (committed() is the person's session's `before`.)
      const committed = doc.committed();
      const hist = history(doc);
      expect(st.clean, reason).toBe(true);
      expect(attempt(), reason).toEqual({ ok: false, reason });
      expect(doc.state.get().doc, reason).toBe(live);
      expect(doc.committed(), reason).toBe(committed);
      expect(doc.session(), reason).toBe(person);
      expect(person.open, reason).toBe(true);
      expect(history(doc), reason).toEqual(hist);
      st.end();
      person.discard();
    };
    // The step renamed Extrude 1; the person opened its Edit and changed nothing.
    const st1 = doc.assistant.begin('assistant:c1');
    st1.run(() => doc.rename(a.extrude, 'Base'));
    refused(st1, doc.beginEdit(a.extrude), () => st1.revert(), 'The person is editing Base, which this would change');
    // The step made Sketch 2; the person's new Extrude of it applied at once.
    doc.rename(a.extrude, 'Extrude 1');
    const st2 = doc.assistant.begin('assistant:c2');
    const sk = st2.run(() => {
      const s = newSketch(doc, 50);
      s.commit();
      return s.feature;
    });
    const ex = doc.beginNew('extrude', { profiles: [profileOf(sk, blockSketch(50, 0))], extent: extentFor(0, 10), op: 'new' } as Partial<Feature>);
    expect(names(doc)).toEqual(['Sketch 1', 'Extrude 1', 'Sketch 2', 'Extrude 2']);
    refused(st2, ex, () => st2.revert(), "The person's Extrude 2 uses Sketch 2, which this would change");
    // The step changed parameter w; inside its run, the undo tool's restore under the person's live
    // draft that names w (review: a restore under a live draft had no test).
    doc.remove(sk);
    const st3 = doc.assistant.begin('assistant:c3');
    st3.run(() => doc.editParams({ add: [], change: [{ id: w as ParamId, patch: { expr: '30 mm' } }], remove: [] }));
    const person = doc.beginEdit(a.extrude);
    person.update({ extent: { kind: 'blind', distance: 'w' } } as Partial<Feature>);
    refused(st3, person, () => st3.run(() => doc.assistant.restore(st3.mark)), "The person's Extrude 1 uses parameters, which this would change");
    // A draft its type cannot read (a pattern whose direction was cleared): what it uses is unknown, so it is not moved.
    doc.features.register(linearPatternDef as unknown as FeatureTypeDef);
    const st4 = doc.assistant.begin('assistant:c4');
    st4.run(() => doc.rename(a.sketch, 'Outline'));
    const pattern = doc.beginNew('pattern_linear', { of: 'features', features: [a.extrude] } as unknown as Partial<Feature>);
    expect(() => pattern.update({ dir1: undefined } as unknown as Partial<Feature>)).toThrow(TypeError);
    refused(st4, pattern, () => st4.revert(), `The person is editing ${pattern.draft.name}`);
  });

  it('a person\'s rollback bar move, or a reload, during a step: no longer clean, no seal, the revert refused', async () => {
    const { doc } = make();
    await doc.load();
    block(doc);
    const st = doc.assistant.begin('assistant:c1');
    st.run(() => newSketch(doc, 50).commit());
    doc.setRollback(1);
    expect(st.clean).toBe(false);
    expect(st.takenOver).toBeNull();
    expect(() => st.seal('turn:t1', 'Assistant: plate')).toThrow('The Part was changed during this step by someone else');
    expect(st.revert()).toEqual({ ok: false, reason: 'The Part was changed during this step by someone else, so it was kept as it is' });
    st.end();
    expect(names(doc)).toEqual(['Sketch 1', 'Extrude 1', 'Sketch 2']);
    // A reload in the middle of a step: the stored model is the mark (the save hold), so the
    // step's sketch is not in the reloaded Part, and the old step can only end.
    doc.setRollback(null);
    await doc.flush();
    const st2 = doc.assistant.begin('assistant:c2');
    st2.run(() => newSketch(doc, 80).commit());
    expect(names(doc)).toEqual(['Sketch 1', 'Extrude 1', 'Sketch 2', 'Sketch 3']);
    await doc.reload();
    expect(names(doc)).toEqual(['Sketch 1', 'Extrude 1', 'Sketch 2']);
    expect(st2.clean).toBe(false);
    expect(st2.revert()).toEqual({ ok: false, reason: 'The part was loaded again during this step' });
    expect(() => doc.assistant.begin('assistant:c3')).toThrow('An Assistant step is already open');
    st2.end();
    expect(doc.assistant.current()).toBeNull();
    doc.assistant.begin('assistant:c3').end();
  });
});

describe('doc.assistant: the save hold', () => {
  /** The feature names of every model write since the start. */
  const writes = (ws: ReturnType<typeof make>['ws']) => ws.log.dataWrites.filter((w) => w.rel === MODEL).map((w) => (w.doc as { doc: { features: { name: string }[] } }).doc.features.map((f) => f.name));
  const hide = () => {
    Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));
    delete (document as unknown as { visibilityState?: string }).visibilityState;
  };
  const saveState = (doc: DocService) => doc.state.get().save.state;

  it('during a clean step every write path stores the mark (blur, hidden, pagehide, the pointer leaving, flush); one write follows end()', async () => {
    // The budget's one write goes to the new Part: every later change waits for it, unless a leave writes it.
    const { doc, ws } = make({ interval: 60_000, burst: 1 });
    await doc.load();
    const w0 = writes(ws).length;
    // The person's change, not stored yet when the step begins.
    newSketch(doc, 0).commit();
    expect(saveState(doc)).toBe('pending');
    const st = doc.assistant.begin('assistant:c1');
    const s2 = st.run(() => {
      const s = newSketch(doc, 50);
      s.commit();
      return s.feature;
    });
    expect(names(doc)).toEqual(['Sketch 1', 'Sketch 2']);
    // The frame loses focus: what waits is written now, and it is the mark, not the step's sketch.
    window.dispatchEvent(new FocusEvent('blur'));
    await vi.waitFor(() => expect(saveState(doc)).toBe('saved'));
    expect(writes(ws).slice(w0)).toEqual([['Sketch 1']]);
    // More of the step's own changes: nothing waits, since the mark is what is stored.
    st.run(() => doc.rename(s2, 'Holes'));
    expect(saveState(doc)).toBe('saved');
    hide();
    window.dispatchEvent(new Event('pagehide'));
    document.documentElement.dispatchEvent(new MouseEvent('mouseleave'));
    window.dispatchEvent(new FocusEvent('blur'));
    await doc.flush();
    expect(writes(ws).slice(w0)).toEqual([['Sketch 1']]);
    expect(saveState(doc)).toBe('saved');
    st.seal('turn:t1', 'Assistant: holes');
    st.end();
    // The hold is released: the step's model is written, once.
    expect(saveState(doc)).toBe('pending');
    await doc.flush();
    expect(writes(ws).slice(w0)).toEqual([['Sketch 1'], ['Sketch 1', 'Holes']]);
    st.end();
    await doc.flush();
    expect(writes(ws).slice(w0)).toHaveLength(2);
  });

  for (const hostVersion of ['1.1', '1.2']) {
    it(`the page going mid-step (hidden, pagehide) stores the mark on a ${hostVersion} host; end() stores the step`, async () => {
      const { doc, ws } = make({ interval: 60_000, burst: 1, hostVersion });
      await doc.load();
      const stored = () => (ws.json(MODEL) as { doc: { features: { name: string }[] } }).doc.features.map((f) => f.name);
      expect(stored()).toEqual([]);
      // The person's change, waiting for the budget when the step begins.
      newSketch(doc, 0).commit();
      expect(saveState(doc)).toBe('pending');
      const st = doc.assistant.begin('assistant:c1');
      st.run(() => newSketch(doc, 50).commit());
      // The tab is hidden: what waits is written at once (leaveNow), and it is the mark.
      hide();
      await vi.waitFor(() => expect(saveState(doc)).toBe('saved'));
      expect(stored()).toEqual(['Sketch 1']);
      window.dispatchEvent(new Event('pagehide'));
      await doc.flush();
      expect(stored()).toEqual(['Sketch 1']);
      st.seal('turn:t1', 'Assistant: sketch');
      st.end();
      await doc.flush();
      await vi.waitFor(() => expect(saveState(doc)).toBe('saved'));
      expect(stored()).toEqual(['Sketch 1', 'Sketch 2']);
    });
  }

  it('the hold lifts the moment the person changes the model: their edit and the step\'s are both stored', async () => {
    const { doc, ws } = make({ interval: 60_000, burst: 1 });
    await doc.load();
    const w0 = writes(ws).length;
    const st = doc.assistant.begin('assistant:c1');
    st.run(() => newSketch(doc, 50).commit());
    window.dispatchEvent(new FocusEvent('blur'));
    await doc.flush();
    expect(writes(ws).slice(w0)).toEqual([]);
    // The person adds a parameter while the step is open.
    expect(typeof doc.addParam({ name: 'w', expr: '20 mm', quantity: 'length' })).toBe('string');
    expect(st.clean).toBe(false);
    expect(saveState(doc)).toBe('pending');
    window.dispatchEvent(new FocusEvent('blur'));
    await vi.waitFor(() => expect(saveState(doc)).toBe('saved'));
    expect(writes(ws).slice(w0)).toEqual([['Sketch 1']]);
    expect((ws.json(MODEL) as { doc: { params: { name: string }[] } }).doc.params.map((p) => p.name)).toEqual(['w']);
    expect(st.revert().ok).toBe(false);
    st.end();
    await doc.flush();
    expect(writes(ws).slice(w0)).toHaveLength(1);
  });

  it('the Assistant\'s own panel open with a live draft (a paced fill), then taken over: every write path stores the mark; nothing is written after the revert', async () => {
    const { doc, ws } = make({ interval: 60_000, burst: 1 });
    await doc.load();
    const w0 = writes(ws).length;
    // The person's change, not stored yet when the step begins.
    newSketch(doc, 0).commit();
    expect(saveState(doc)).toBe('pending');
    const st = doc.assistant.begin('assistant:c1');
    // The Assistant's sketch is open, half filled: in the model live, never committed.
    const s = st.run(() => newSketch(doc, 50));
    s.update({ points: { ...blockSketch(50, 0).points, pt_2: [75, 0] } } as Partial<Feature>);
    expect(names(doc)).toEqual(['Sketch 1', 'Sketch 2']);
    expect(doc.session()).toBe(s);
    // Reload or Back now (sketch-step:2): every write path stores the mark, never the half sketch.
    window.dispatchEvent(new FocusEvent('blur'));
    await vi.waitFor(() => expect(saveState(doc)).toBe('saved'));
    expect(writes(ws).slice(w0)).toEqual([['Sketch 1']]);
    s.update({ points: { ...blockSketch(50, 0).points, pt_2: [80, 0] } } as Partial<Feature>);
    hide();
    window.dispatchEvent(new Event('pagehide'));
    window.dispatchEvent(new FocusEvent('blur'));
    await doc.flush();
    expect(writes(ws).slice(w0)).toEqual([['Sketch 1']]);
    // The person's Escape takes it over: the window until the call's revert stores the mark too.
    expect(doc.assistant.takeOver('escape')).toBe(true);
    expect(s.open).toBe(false);
    window.dispatchEvent(new FocusEvent('blur'));
    hide();
    await doc.flush();
    expect(writes(ws).slice(w0)).toEqual([['Sketch 1']]);
    expect(st.revert()).toEqual({ ok: true });
    st.end();
    await doc.flush();
    expect(writes(ws).slice(w0)).toEqual([['Sketch 1']]);
    expect(saveState(doc)).toBe('saved');
  });

  it('a person\'s panel open on a clean step is held with it until its Done: then both are stored', async () => {
    const { doc, ws } = make({ interval: 60_000, burst: 1 });
    await doc.load();
    const w0 = writes(ws).length;
    const st = doc.assistant.begin('assistant:c1');
    st.run(() => newSketch(doc, 50).commit());
    // The person's new sketch, live and uncommitted, on top of the step's.
    const person = newSketch(doc, 100);
    expect(names(doc)).toEqual(['Sketch 1', 'Sketch 2']);
    window.dispatchEvent(new FocusEvent('blur'));
    await doc.flush();
    expect(writes(ws).slice(w0)).toEqual([]);
    // Its Done: the person changed the Part, the hold lifts, and both are stored.
    person.commit();
    expect(st.clean).toBe(false);
    window.dispatchEvent(new FocusEvent('blur'));
    await vi.waitFor(() => expect(saveState(doc)).toBe('saved'));
    expect(writes(ws).slice(w0)).toEqual([['Sketch 1', 'Sketch 2']]);
    expect(st.revert().ok).toBe(false);
    st.end();
  });

  it('a reverted step writes nothing at all', async () => {
    const { doc, ws } = make({ interval: 60_000, burst: 1 });
    await doc.load();
    const w0 = writes(ws).length;
    const st = doc.assistant.begin('assistant:c1');
    st.run(() => block(doc));
    window.dispatchEvent(new FocusEvent('blur'));
    expect(st.revert()).toEqual({ ok: true });
    st.end();
    await doc.flush();
    expect(writes(ws).slice(w0)).toEqual([]);
    expect(saveState(doc)).toBe('saved');
    expect(names(doc)).toEqual([]);
  });
});

describe('doc.assistant: seal, revert, undo groups', () => {
  it('seal merges a call into its turn\'s group, and the next call merges too; a person\'s edit between starts a new group and is never absorbed', async () => {
    const { doc } = make();
    await doc.load();
    const base = doc.state.get().doc;
    let first: ReturnType<typeof block> | null = null;
    // Call 1 pushes two steps (a sketch and an extrude): they become one.
    call(doc, 'assistant:c1', () => {
      first = block(doc);
    });
    expect(history(doc)).toMatchObject({ undoLabel: 'Assistant: plate', canRedo: false });
    // Call 2 joins the group: still one step back to the start of the turn.
    call(doc, 'assistant:c2', () => doc.rename(first!.extrude, 'Plate'));
    expect(doc.assistant.topGroup()).toEqual({ tag: 'turn:t1', label: 'Assistant: plate', after: doc.state.get().doc });
    // The person's own edit between two calls.
    expect(doc.rename(first!.sketch, 'Outline')).toEqual({ ok: true });
    call(doc, 'assistant:c3', () => block(doc, { at: [50, 0, 0] }));
    const end = doc.state.get().doc;
    expect(undoLabels(doc)).toEqual(['Assistant: plate', 'Rename Sketch 1', 'Assistant: plate']);
    expect(doc.state.get().doc).toBe(base);
    // Redo brings it all back, the person's rename in its place.
    while (history(doc).canRedo) doc.redo();
    expect(doc.state.get().doc).toBe(end);
    expect(names(doc)).toEqual(['Outline', 'Plate', 'Sketch 1', 'Extrude 1']);
  });

  it('a seal with a person\'s panel open on top (its draft live): the group ends at the step\'s model, and the person\'s Done is its own step after it', async () => {
    const { doc } = make();
    await doc.load();
    block(doc);
    const mark = doc.assistant.mark();
    const st = doc.assistant.begin('assistant:c1');
    st.run(() => newSketch(doc, 50).commit());
    const stepDoc = doc.state.get().doc;
    const person = newSketch(doc, 100);
    expect(doc.state.get().doc).not.toBe(stepDoc);
    expect(st.clean).toBe(true);
    st.seal('turn:t1', 'Assistant: sketch');
    st.end();
    expect(doc.assistant.topGroup()).toEqual({ tag: 'turn:t1', label: 'Assistant: sketch', after: stepDoc });
    expect(doc.committed()).toBe(stepDoc);
    expect(person.open).toBe(true);
    person.commit();
    expect(history(doc).undoLabel).toBe('Sketch 3');
    doc.undo();
    expect(doc.state.get().doc).toBe(stepDoc);
    expect(history(doc).undoLabel).toBe('Assistant: sketch');
    doc.undo();
    expect(doc.state.get().doc).toBe(mark.doc);
  });

  it('a call of another turn, or one that changed nothing, joins nothing', async () => {
    const { doc } = make();
    await doc.load();
    call(doc, 'assistant:c1', () => block(doc));
    call(doc, 'assistant:c2', () => block(doc, { at: [50, 0, 0] }), 'turn:t2', 'Assistant: second');
    const st = call(doc, 'assistant:c3', () => {});
    expect(st.clean).toBe(true);
    expect(undoLabels(doc)).toEqual(['Assistant: second', 'Assistant: plate']);
  });

  it('a person\'s Ctrl+Z between a parameter push and the seal (forced in a microtask) takes the step over: no seal, the history as the person left it', async () => {
    const { doc, undos } = make();
    await doc.load();
    let w: ParamId | null = null;
    call(doc, 'assistant:c1', () => {
      w = doc.editParams({ add: [{ name: 'w', expr: '20 mm', quantity: 'length' }], change: [], remove: [] }).ids!.w;
    });
    const st = doc.assistant.begin('assistant:c2');
    expect(st.run(() => doc.editParams({ add: [], change: [{ id: w!, patch: { expr: '30 mm' } }], remove: [] }))).toEqual({ ok: true, ids: {} });
    // The person's Ctrl+Z lands while the call waits for its rebuild.
    queueMicrotask(() => doc.undo());
    await doc.settled();
    expect(undos).toEqual([{ tag: 'assistant:c2', label: 'Parameters: 1 changed', redo: false }]);
    expect(st.takenOver).toBe('undo');
    expect(st.clean).toBe(false);
    expect(() => st.seal('turn:t1', 'Assistant: plate')).toThrow('The person took this step over');
    const hist = history(doc);
    expect(hist).toEqual({ canUndo: true, canRedo: true, undoLabel: 'Assistant: plate', redoLabel: 'Parameters: 1 changed' });
    // The call's revert is refused (the person moved the history) and changes nothing: the person keeps Redo.
    expect(st.revert().ok).toBe(false);
    st.end();
    expect(history(doc)).toEqual(hist);
    expect(doc.assistant.topGroup()!.after).toBe(doc.committed());
    expect(doc.state.get().doc.params.map((p) => p.expr)).toEqual(['20 mm']);
  });

  it('revert is exact, idempotent, and a no-op after end returning the first result', async () => {
    const { doc } = make();
    await doc.load();
    const a = block(doc);
    const hist = history(doc);
    const st = doc.assistant.begin('assistant:c1');
    const mark = st.mark;
    st.run(() => {
      block(doc, { at: [50, 0, 0] });
      doc.rename(a.extrude, 'Base');
      doc.editParams({ add: [{ name: 't', expr: '8 mm', quantity: 'length' }], change: [], remove: [] });
    });
    const s = st.run(() => newSketch(doc, 100));
    expect(s.open).toBe(true);
    const r = st.revert();
    expect(r).toEqual({ ok: true });
    expect(s.open).toBe(false);
    expect(doc.session()).toBeNull();
    expect(doc.state.get().doc).toBe(mark.doc);
    expect(doc.state.get().view.rollback).toBe(mark.rollback);
    expect(history(doc)).toEqual(hist);
    expect(st.revert()).toBe(r);
    st.end();
    expect(st.revert()).toBe(r);
    // The history is the mark's: one undo goes where it went before the step.
    doc.undo();
    expect(names(doc)).toEqual(['Sketch 1']);
    // Ended before any revert: refused, and that stays the answer.
    const st2 = doc.assistant.begin('assistant:c2');
    st2.end();
    const r2 = st2.revert();
    expect(r2).toEqual({ ok: false, reason: 'This Assistant step has ended' });
    expect(st2.revert()).toBe(r2);
  });

  it('end() discards a session of the step still open, and a draft its type cannot read leaves no dead session', async () => {
    const { doc } = make();
    await doc.load();
    doc.features.register(linearPatternDef as unknown as FeatureTypeDef);
    const a = block(doc);
    const st = doc.assistant.begin('assistant:c1');
    // A pattern without dir1 throws in incomplete(): no dangling open session, the step still clean.
    expect(() => st.run(() => doc.beginNew('pattern_linear', { of: 'features', features: [a.extrude], dir1: undefined } as unknown as Partial<Feature>))).toThrow(TypeError);
    expect(doc.session()).toBeNull();
    expect(st.clean).toBe(true);
    const s = st.run(() => newSketch(doc));
    st.end();
    expect(s.open).toBe(false);
    expect(doc.session()).toBeNull();
    expect(names(doc)).toEqual(['Sketch 1', 'Extrude 1']);
  });

  it('a 120-call turn stays one undo step', async () => {
    const { doc } = make();
    await doc.load();
    const a = block(doc);
    const before = doc.state.get().doc;
    for (let i = 0; i < 120; i++) call(doc, `assistant:c${i}`, () => doc.rename(a.extrude, `Name ${i}`), 'turn:long', 'Assistant: long');
    expect(names(doc)).toEqual(['Sketch 1', 'Name 119']);
    expect(history(doc).undoLabel).toBe('Assistant: long');
    doc.undo();
    expect(doc.state.get().doc).toBe(before);
    expect(history(doc).undoLabel).toBe('Extrude 1');
  });

  it('the step\'s own undo (the undo tool\'s previous turn) is no take-over, keeps Redo, and seal merges only what follows it', async () => {
    const { doc, undos, takeOvers } = make();
    await doc.load();
    const a = block(doc);
    call(doc, 'assistant:c1', () => doc.rename(a.extrude, 'Plate'), 'turn:t1', 'Assistant: first');
    const afterFirst = doc.state.get().doc;
    // Turn 2's undo tool, previous_turn: one undo of turn 1's group, so Redo brings it back.
    const st = doc.assistant.begin('assistant:c2');
    st.run(() => doc.undo());
    expect(undos).toEqual([]);
    expect(takeOvers).toEqual([]);
    expect(st.takenOver).toBeNull();
    expect(st.clean).toBe(true);
    expect(names(doc)).toEqual(['Sketch 1', 'Extrude 1']);
    const undone = history(doc);
    expect(undone).toEqual({ canUndo: true, canRedo: true, undoLabel: 'Extrude 1', redoLabel: 'Assistant: first' });
    st.seal('turn:t2', 'Assistant: second');
    expect(history(doc)).toEqual(undone);
    st.end();
    doc.redo();
    expect(doc.state.get().doc).toBe(afterFirst);
    // A restore inside a step, then a push: the push joins the group the restore left on top.
    const mark = doc.assistant.mark();
    call(doc, 'assistant:c3', () => doc.rename(a.sketch, 'Outline'), 'turn:t1', 'Assistant: first');
    const st2 = doc.assistant.begin('assistant:c4');
    st2.run(() => {
      expect(doc.assistant.restore(mark)).toEqual({ ok: true });
      doc.rename(a.extrude, 'Base');
    });
    st2.seal('turn:t1', 'Assistant: first');
    st2.end();
    expect(names(doc)).toEqual(['Sketch 1', 'Base']);
    expect(undoLabels(doc)).toEqual(['Assistant: first', 'Extrude 1', 'Sketch 1']);
    expect(names(doc)).toEqual([]);
  });

  it('restore (the undo tool), undoGroup (the chip) and the person-undo events', async () => {
    const { doc, undos, undoDocs } = make();
    await doc.load();
    const marks: ReturnType<DocService['assistant']['mark']>[] = [];
    const a = block(doc);
    for (const n of [1, 2]) {
      marks.push(doc.assistant.mark());
      call(doc, `assistant:c${n}`, () => doc.rename(a.extrude, `Plate ${n}`));
    }
    // The undo tool, steps 1: back to the mark of the turn's last call; the group as it was, no redo.
    const st = doc.assistant.begin('assistant:undo');
    expect(st.run(() => doc.assistant.restore(marks[1]))).toEqual({ ok: true });
    expect(doc.state.get().doc).toBe(marks[1].doc);
    expect(history(doc)).toEqual({ canUndo: true, canRedo: false, undoLabel: 'Assistant: plate', redoLabel: null });
    expect(st.clean).toBe(true);
    // The call's seal keeps the history the restore made: nothing is pushed or merged.
    const restored = history(doc);
    st.seal('turn:t1', 'Assistant: plate');
    expect(history(doc)).toEqual(restored);
    expect(doc.assistant.topGroup()).toEqual({ tag: 'turn:t1', label: 'Assistant: plate', after: marks[1].doc });
    st.end();
    expect(undos).toEqual([]);
    // The chip's Undo: only while the turn's group is the newest step.
    expect(doc.assistant.undoGroup('turn:other')).toEqual({ ok: false, reason: 'Those changes are no longer the newest step' });
    const before = doc.state.get().doc;
    expect(names(doc)).toEqual(['Sketch 1', 'Plate 1']);
    expect(doc.assistant.undoGroup('turn:t1')).toEqual({ ok: true });
    expect(undos).toEqual([{ tag: 'turn:t1', label: 'Assistant: plate', redo: false }]);
    // Heard before it applied: the model was still the one it undid.
    expect(undoDocs).toEqual([before]);
    expect(names(doc)).toEqual(['Sketch 1', 'Extrude 1']);
    doc.redo();
    expect(undos.at(-1)).toEqual({ tag: 'turn:t1', label: 'Assistant: plate', redo: true });
    // The person's own steps have no tag.
    doc.rename(a.sketch, 'Outline');
    doc.undo();
    expect(undos.at(-1)).toEqual({ tag: null, label: 'Rename Sketch 1', redo: false });
    // With a panel open, the chip's Undo waits for it.
    const p = newSketch(doc);
    expect(doc.assistant.undoGroup('turn:t1')).toEqual({ ok: false, reason: 'Close the open panel first' });
    p.discard();
    // A mark from before a reload is not put back.
    await doc.reload();
    expect(doc.assistant.restore(marks[0])).toEqual({ ok: false, reason: 'The part was loaded again since then' });
  });
});
