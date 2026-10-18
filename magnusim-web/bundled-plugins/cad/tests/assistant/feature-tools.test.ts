// The new-feature path of modify, pattern and combine (src/assistant/feature-tools.ts) on the REAL
// kernel, each race forced at a hold point (CAD tools spec §7.3, §12.4), never slept for:
//   - at the watch pace the call waits at its pace points (progress names the feature) and leaves
//     no panel open;
//   - a Stop while the Assistant's new Fillet panel is open (before-commit) reverts synchronously:
//     no feature, no panel and no step once abort() returns, then busy stopped;
//   - Escape on the Assistant's new Chamfer panel (after-open) is a take-over: nothing kept, the
//     Assistant paused in this Part;
//   - a mirror about an offset plane opens two panels: a person's panel opened between them
//     (between-opens) is waited for, the step goes back under it (the plane too), and once it
//     closes the call plans anew and keeps the plane and the mirror as one undo group; a person's
//     one-shot change there answers busy changed with what stayed.
// SPDX-License-Identifier: GPL-3.0-or-later
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runtimeOf } from '../../src/assistant/runtime';
import { uiFor } from '../../src/ui/controller';
import { assistantHarness, REAL_KERNEL_MS, type AssistantHarness } from './harness';
import { plate, undoLabel } from './parts';

let h: AssistantHarness | null = null;
afterEach(() => {
  h?.dispose();
  h = null;
});

const MODIFY = (o: Record<string, unknown>) => ({ edit: '', name: '', kind: 'fillet', targets: [], size: '', size2: '', flip: false, inward: false, ...o });
const MIRROR = { edit: '', name: '', kind: 'mirror', of: 'bodies', items: ['Body 1'], about: 'Right offset 40 mm', count: '', spacing: '', symmetric: false, flip: false, about2: '', count2: '', spacing2: '', flip2: false, op: 'new', bodies: [] };
const names = (x: AssistantHarness) => x.doc.state.get().doc.features.map((f) => f.name);

describe('a new feature mid-call', () => {
  it(
    'at the watch pace the panel opens, waits and commits, and progress names the feature',
    async () => {
      h = await assistantHarness({ pace: 'watch', paceScale: 0.01 });
      await plate(h);
      const r = await h.ok('modify', MODIFY({ targets: ['Extrude 1.end'], size: '1 mm' }));
      expect(r.data).toMatchObject({ feature: { name: 'Fillet 1', state: 'ok' } });
      expect(h.fake.progress.filter((x) => x.label === 'Fillet').length).toBeGreaterThanOrEqual(2);
      expect(uiFor(h.services).state.get().panel).toBeNull();
    },
    REAL_KERNEL_MS,
  );

  it(
    'a Stop at before-commit reverts synchronously: no feature, no panel, no step',
    async () => {
      h = await assistantHarness();
      await plate(h);
      const rt = runtimeOf(h.services)!;
      const before = h.doc.state.get().doc;
      rt.holds.hold('before-commit');
      const ctl = new AbortController();
      const r = h.call('modify', MODIFY({ targets: ['Extrude 1.end'], size: '1 mm' }), { signal: ctl.signal });
      await vi.waitFor(() => expect(rt.holds.waiting()).toEqual(['before-commit']), { timeout: 60_000 });
      // The Assistant's own Fillet panel, its draft live in the Part.
      expect(uiFor(h.services).state.get().panel).toMatchObject({ kind: 'feature', owner: 'assistant', type: 'fillet', isNew: true });
      expect(names(h)).toEqual(['Sketch 1', 'Extrude 1', 'Fillet 1']);
      ctl.abort();
      expect(h.doc.state.get().doc).toBe(before);
      expect(h.doc.session()).toBeNull();
      expect(h.doc.assistant.current()).toBeNull();
      expect(uiFor(h.services).state.get().panel).toBeNull();
      expect(await r).toMatchObject({ ok: false, error: { code: 'busy', detail: { reason: 'stopped' } } });
      expect(h.doc.state.get().doc).toBe(before);
      expect(rt.madeBy.size).toBe(0);
    },
    REAL_KERNEL_MS,
  );

  it(
    "Escape on the Assistant's new panel takes over: nothing kept, and the Assistant pauses",
    async () => {
      h = await assistantHarness();
      await plate(h);
      const rt = runtimeOf(h.services)!;
      h.fake.emitTurn({ id: 't-1', title: 'Chamfer it' });
      const before = h.doc.state.get().doc;
      rt.holds.hold('after-open');
      const r = h.call('modify', MODIFY({ kind: 'chamfer', targets: ['Extrude 1.end'], size: '1 mm' }), { turn: 't-1' });
      await vi.waitFor(() => expect(rt.holds.waiting()).toEqual(['after-open']), { timeout: 60_000 });
      uiFor(h.services).closePanel();
      rt.holds.release('after-open');
      expect(await r).toMatchObject({ ok: false, error: { code: 'busy', message: 'taken_over: You took over (Escape): Chamfer was not kept.', detail: { reason: 'taken_over', why: 'escape' } } });
      expect(h.doc.state.get().doc).toBe(before);
      expect(rt.pause.get()).toMatchObject({ why: 'take_over', turn: 't-1' });
    },
    REAL_KERNEL_MS,
  );
});

describe('two panels in one call (a mirror about an offset plane)', () => {
  it(
    "a person's panel opened between them is waited for; the call then keeps the plane and the mirror as one undo group",
    async () => {
      h = await assistantHarness();
      const p = await plate(h);
      const rt = runtimeOf(h.services)!;
      const ui = uiFor(h.services);
      const label = undoLabel(h);
      rt.holds.hold('between-opens');
      const r = h.call('pattern', MIRROR);
      await vi.waitFor(() => expect(rt.holds.waiting()).toEqual(['between-opens']), { timeout: 60_000 });
      // The plane is made; the person opens Extrude 1 before the mirror's panel opens.
      expect(names(h)).toEqual(['Sketch 1', 'Extrude 1', 'Plane 1']);
      ui.openEdit(p.extrude);
      const session = h.doc.session()!;
      rt.holds.release('between-opens');
      await vi.waitFor(() => expect(rt.store.get()).toMatchObject({ phase: 'waiting', note: 'close the Extrude 1 panel' }), { timeout: 60_000 });
      // The step went back under the person's panel: no plane, the panel open and theirs.
      expect(names(h)).toEqual(['Sketch 1', 'Extrude 1']);
      expect(h.doc.session()).toBe(session);
      expect(session.open).toBe(true);
      expect(session.owner).toBeUndefined();
      ui.closePanel();
      expect(await r).toMatchObject({ ok: true, result: { data: { plane: 'Plane 1', feature: { name: 'Mirror 1', state: 'ok' } } } });
      expect(names(h)).toEqual(['Sketch 1', 'Extrude 1', 'Plane 1', 'Mirror 1']);
      // One undo group for the call: the plane and the mirror go together.
      h.doc.undo();
      expect(names(h)).toEqual(['Sketch 1', 'Extrude 1']);
      expect(undoLabel(h)).toBe(label);
    },
    REAL_KERNEL_MS,
  );

  it(
    "a person's one-shot change between them: busy changed, and what stayed is listed",
    async () => {
      h = await assistantHarness();
      await plate(h);
      const rt = runtimeOf(h.services)!;
      rt.holds.hold('between-opens');
      const r = h.call('pattern', MIRROR);
      await vi.waitFor(() => expect(rt.holds.waiting()).toEqual(['between-opens']), { timeout: 60_000 });
      h.doc.addParam({ name: 'q', expr: '1 mm', quantity: 'length' });
      rt.holds.release('between-opens');
      expect(await r).toMatchObject({ ok: false, error: { code: 'busy', detail: { reason: 'changed', kept: ['added Plane 1 (ref_plane)', 'added parameter q = 1 mm'] } } });
      expect(h.doc.state.get().doc.params.map((x) => x.name)).toContain('q');
      expect(names(h)).not.toContain('Mirror 1');
    },
    REAL_KERNEL_MS,
  );

  it(
    "a tree rename of the person's while the mirror's panel is open takes it over: the plane stays (the revert would undo the rename), and the chip names it",
    async () => {
      h = await assistantHarness();
      const p = await plate(h);
      const rt = runtimeOf(h.services)!;
      const ui = uiFor(h.services);
      h.fake.emitTurn({ id: 't-1', title: 'Mirror it' });
      // The plane is made (between-opens), then the mirror's own panel opens (after-open).
      rt.holds.hold('between-opens');
      const r = h.call('pattern', MIRROR, { turn: 't-1' });
      await vi.waitFor(() => expect(rt.holds.waiting()).toEqual(['between-opens']), { timeout: 60_000 });
      rt.holds.hold('after-open');
      rt.holds.release('between-opens');
      await vi.waitFor(() => expect(rt.holds.waiting()).toEqual(['after-open']), { timeout: 60_000 });
      expect(ui.state.get().panel).toMatchObject({ owner: 'assistant' });
      expect(names(h)).toContain('Plane 1');
      expect(ui.renameFeature(p.extrude, 'Base')).toBeNull();
      rt.holds.release('after-open');
      expect(await r).toMatchObject({ ok: false, error: { code: 'busy', detail: { reason: 'taken_over', why: 'command', kept: ['renamed Extrude 1 to Base', 'added Plane 1 (ref_plane)'] } } });
      expect(names(h)).toEqual(['Sketch 1', 'Base', 'Plane 1']);
      // The person sees what stayed, not only "you took over".
      expect(rt.store.get()).toMatchObject({ phase: 'paused', note: 'you took over · Plane 1 stayed' });
    },
    REAL_KERNEL_MS,
  );
});
