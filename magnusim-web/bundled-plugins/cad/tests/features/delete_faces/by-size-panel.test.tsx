// The Delete faces panel's Add by size and box select as the person meets them (S5, the Analysis
// Situs plan §3.3), in the mounted UI over the real document service and the real kernel (API 8),
// on the rounded block made in the test with kernel ops and imported as a STEP (never a file of
// Daniel's: tests/assistant/rounded-block.ts, R5 verticals, R2 round the top, four 6 mm holes and a
// 6/10 mm counterbore):
//   - MODIFY > Delete faces with nothing picked: the sizes start at 1 mm and Ø 2 mm (the block's
//     96.4 mm diagonal / 50 and / 20); Fillets up to 2, Enter: the 8 R2 faces, "Added 8 faces: 1
//     fillet chain, R2", the body set, the build live; Holes up to Ø 6, Add: the 4 holes, "(4
//     through)"; Add again: what the body has, in words, nothing added;
//   - a Ctrl+drag box in the view while the panel is open adds the faces it selected (useBoxPicks):
//     without it the count stays; a face a right-click selects for its menu is not added;
//   - two solid bodies and none picked: Add is disabled with "Click a face of the body first"; a face
//     clicked, it works on that body;
//   - the Assistant's Delete faces panel: Add disabled with the Assistant's reason, and a box the
//     person draws is not taken into it.
// SPDX-License-Identifier: GPL-3.0-or-later
import { act, fireEvent } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { forgetBreps } from '../../../src/features/import/feature';
import type { DeleteFacesFeature } from '../../../src/types/doc';
import { uiFor } from '../../../src/ui/controller';
import { ASSISTANT_PANEL_DONE } from '../../../src/ui/kit';
import { roundedBlockStep } from '../../assistant/rounded-block';
import { mountApp, type TestApp } from '../p2/app';
import { hybridKernel } from '../p2/hybrid-kernel';
import { realKernelAnywhere } from '../p2/kernel-anywhere';

let app: TestApp | null = null;
afterEach(() => {
  app?.dispose();
  app = null;
  forgetBreps();
});

const MS = 180_000;

/** Poll outside act(), letting React render between tries. */
async function waitFor(fn: () => void, timeout = 60_000) {
  const t0 = Date.now();
  for (;;) {
    try {
      fn();
      return;
    } catch (err) {
      if (Date.now() - t0 > timeout) throw err;
    }
    await act(async () => {
      await new Promise((r) => setTimeout(r, 20));
    });
  }
}

/** The app over the real kernel, the rounded block (and a 20 mm box beside it with `body2`) imported as the person's Import STEP. */
async function start(o: { body2?: boolean } = {}) {
  const real = realKernelAnywhere();
  await real.start();
  const kernel = hybridKernel(real);
  app = mountApp(kernel);
  const a = app;
  await act(async () => {
    await a.services.doc.load();
  });
  const made = await roundedBlockStep(kernel.call.bind(kernel), o);
  const file = new File([new Uint8Array(made.step).buffer as ArrayBuffer], 'rounded-block.step');
  act(() => a.services.bus.emit('import:file', { file }));
  await waitFor(() => expect(a.$('[data-import-diagnostics]')).not.toBeNull());
  act(() => void fireEvent.click(a.$('[data-panel-done]')!));
  await waitFor(() => expect(a.services.doc.state.get().rebuild.bodies).toHaveLength(o.body2 ? 2 : 1));
  await act(async () => {
    await a.services.doc.settled();
  });
  return { a, made };
}

const facesPicked = (a: TestApp) => a.$$('[data-pick-field="faces"] [data-pick-row]').length;
const input = (a: TestApp, kind: 'fillets' | 'holes') => a.$<HTMLInputElement>(`.nui[data-field="add-${kind}"] input`)!;
const addButton = (a: TestApp, kind: 'fillets' | 'holes') => a.$<HTMLButtonElement>(`[data-delete-add="${kind}"]`)!;
const line = (a: TestApp) => a.$('[data-delete-added]')?.textContent ?? null;
const draft = (a: TestApp) => a.services.doc.session()!.draft as DeleteFacesFeature;

/** Type a size and press Enter, as the person does. */
function typeSize(a: TestApp, kind: 'fillets' | 'holes', text: string, enter: boolean) {
  const el = input(a, kind);
  act(() => {
    el.focus();
    fireEvent.focus(el);
    fireEvent.change(el, { target: { value: text } });
  });
  if (enter) act(() => void fireEvent.keyDown(el, { key: 'Enter' }));
  else act(() => void fireEvent.blur(el, { relatedTarget: addButton(a, kind) }));
}

describe('Delete faces: Add by size and box select (kernel API 8)', () => {
  it(
    'Fillets up to and Holes up to add the faces by size, say what they added, and nothing twice; a Ctrl+drag box adds its faces, a right-click\'s selection does not',
    async () => {
      const { a } = await start();
      const body = a.services.doc.state.get().rebuild.bodies[0];
      expect(body.name).toBe('Body 1');
      // MODIFY > Delete faces with nothing selected: the panel, no face yet.
      expect(await act(() => a.run('modify.delete-faces'))).toBe(true);
      await waitFor(() => expect(a.$('[data-feature-panel="delete_faces"]')).not.toBeNull());
      expect(facesPicked(a)).toBe(0);
      // The rows, the sizes from the block's box (96.4 mm diagonal: 1.93 -> 1 mm, 4.82 -> 2 mm), the hint.
      expect([...a.$$('[data-delete-by-size] .cad-field')].map((r) => r.getAttribute('data-field-row'))).toEqual(['add-fillets', 'add-holes']);
      expect(input(a, 'fillets').value).toBe('1');
      expect(input(a, 'holes').value).toBe('2');
      expect(addButton(a, 'fillets').getAttribute('data-disabled-reason')).toBeNull();
      expect(a.$('[data-delete-hint]')?.textContent).toBe('The faces around each deleted face grow to close the gap (holes, fillets, bosses). Fillets up to and Holes up to add faces by size.');

      // Fillets up to 2 mm, Enter: the 8 R2 faces round the top.
      typeSize(a, 'fillets', '2', true);
      await waitFor(() => expect(line(a)).toBe('Added 8 faces: 1 fillet chain, R2'));
      expect(facesPicked(a)).toBe(8);
      expect(a.$('[data-pick-field="faces"] .cad-pick-label')?.textContent).toBe('Faces to delete (8)');
      expect(draft(a).body).toBe(body.id);
      expect(a.$('[data-delete-body]')?.textContent).toBe('Body 1');
      // The build runs live: Body 1 without the R2 round its top.
      await waitFor(() => expect(a.services.doc.state.get().rebuild.bodies[0].faces).toBe(17));

      // Holes up to Ø 6 mm, Add: the four 6 mm holes, all through (the counterbore is 10 mm at its widest).
      typeSize(a, 'holes', '6', false);
      act(() => void fireEvent.click(addButton(a, 'holes')));
      await waitFor(() => expect(line(a)).toBe('Added 4 faces: 4 holes up to Ø6 mm (4 through)'));
      expect(facesPicked(a)).toBe(12);
      expect(input(a, 'holes').value).toBe('6');

      // Again: nothing new, and what Body 1 has (before this Delete faces), in words.
      act(() => void fireEvent.click(addButton(a, 'fillets')));
      await waitFor(() => expect(line(a)).toBe('No fillets up to 2 mm on Body 1 that are not already picked (Body 1 has 12 fillet faces, R2 to R5)'));
      expect(a.$('[data-delete-added]')?.getAttribute('data-delete-added')).toBe('none');
      expect(facesPicked(a)).toBe(12);

      await waitFor(() => expect(a.services.doc.state.get().rebuild.status).toBe('done'));
      const shown = a.services.doc.state.get().rebuild.bodies[0];
      const topo = await a.services.kernel.call('topo', { id: shown.shape, faces: 'all', edges: 'none', vertices: 'none', face_bbox: 'none' });
      // The 4 R5 verticals of the body as shown (not the counterbore's 10 mm wall, round the block's middle at x 40).
      const r5 = topo.result.faces.filter((x) => x.type === 'cylinder' && Math.abs((x.radius ?? 0) - 5) < 1e-6 && Math.abs((x.axis?.origin[0] ?? 40) - 40) > 1).map((x) => x.i);
      expect(r5).toHaveLength(4);
      // A right-click on one selects it for its menu (viewport/bind.ts): that is not a pick for the field.
      act(() => a.services.selection.set((s) => ({ ...s, items: [{ kind: 'face', body: shown.id, index: r5[0] }] })));
      await act(async () => {
        await new Promise((r) => setTimeout(r, 200));
      });
      expect(facesPicked(a)).toBe(12);
      // A Ctrl+drag box that touched the 4 of them: the panel takes them into its faces.
      a.view.box(
        r5.map((index) => ({ kind: 'face' as const, body: shown.id, index })),
        a.services.selection,
      );
      await waitFor(() => expect(facesPicked(a)).toBe(16));
      expect(a.$('[data-pick-field="faces"] .cad-pick-error')).toBeNull();
      act(() => void fireEvent.click(a.$('[data-panel-done]')!));
      const del = a.services.doc.state.get().doc.features.find((f) => f.type === 'delete_faces') as DeleteFacesFeature;
      expect(del.faces).toHaveLength(16);
    },
    MS,
  );

  it(
    'two solid bodies and no face picked: Add says to click a face first; a face clicked, it adds on that body',
    async () => {
      const { a } = await start({ body2: true });
      const [b1] = a.services.doc.state.get().rebuild.bodies;
      expect(await act(() => a.run('modify.delete-faces'))).toBe(true);
      await waitFor(() => expect(a.$('[data-feature-panel="delete_faces"]')).not.toBeNull());
      expect(addButton(a, 'fillets').getAttribute('data-disabled-reason')).toBe('Click a face of the body first');
      expect(addButton(a, 'holes').getAttribute('data-disabled-reason')).toBe('Click a face of the body first');
      act(() => void fireEvent.click(addButton(a, 'holes')));
      expect(line(a)).toBeNull();
      // A face of Body 1 clicked in the view (its top): Add works on Body 1.
      const topo = await a.services.kernel.call('topo', { id: b1.shape, faces: 'all', edges: 'none', vertices: 'none', face_bbox: 'none' });
      const top = topo.result.faces.find((x) => x.type === 'plane' && x.normal && x.normal[2] > 0.99)!.i;
      expect(a.view.click({ kind: 'face', body: b1.id, index: top })).toBe(true);
      await waitFor(() => expect(facesPicked(a)).toBe(1));
      await waitFor(() => expect(addButton(a, 'holes').getAttribute('data-disabled-reason')).toBeNull());
      typeSize(a, 'holes', '6', true);
      await waitFor(() => expect(line(a)).toBe('Added 4 faces: 4 holes up to Ø6 mm (4 through)'));
      expect(facesPicked(a)).toBe(5);
    },
    MS,
  );

  it(
    "the Assistant's Delete faces panel: Add disabled with the Assistant's reason; a box the person draws is not taken",
    async () => {
      const { a } = await start();
      const b = a.services.doc.state.get().rebuild.bodies[0];
      const step = a.services.doc.assistant.begin('assistant:s5');
      let opened: unknown = null;
      act(() => void (opened = uiFor(a.services).openForAssistant(step, 'delete_faces')));
      expect(typeof opened).not.toBe('string');
      await waitFor(() => expect(a.$('[data-feature-panel="delete_faces"]')).not.toBeNull());
      expect(a.$('[data-cad-panel="feature"]')?.getAttribute('data-panel-owner')).toBe('assistant');
      expect(addButton(a, 'fillets').getAttribute('data-disabled-reason')).toBe(ASSISTANT_PANEL_DONE);
      expect(addButton(a, 'holes').getAttribute('data-disabled-reason')).toBe(ASSISTANT_PANEL_DONE);
      expect(input(a, 'fillets').disabled).toBe(true);
      a.view.box([{ kind: 'face', body: b.id, index: 0 }], a.services.selection);
      await act(async () => {
        await new Promise((r) => setTimeout(r, 100));
      });
      expect(facesPicked(a)).toBe(0);
      act(() => uiFor(a.services).dropForAssistant(step));
      act(() => {
        step.revert();
        step.end();
      });
    },
    MS,
  );
});
