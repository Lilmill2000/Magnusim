// The P2 commands and panels as the user meets them, over the real document
// service and the real kernel (hybrid stand-ins for API 3 ops), with the UI
// shell mounted: the toolbar's groups and reasons, a dropped STEP's import
// with its progress and diagnostics, the size rule before any upload, Delete
// faces from the Delete key and viewport clicks, Split and Combine fields,
// Mass properties, Check and Export.
// SPDX-License-Identifier: GPL-3.0-or-later
import { act, fireEvent } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { forgetBreps } from '../../../src/features/import/feature';
import { MAX_FILE_BYTES } from '../../../src/types/files';
import type { ImportFeature } from '../../../src/types/doc';
import { realKernelAnywhere } from './kernel-anywhere';
import type { FakeWorkspace } from '../../fakes/workspace-sdk';
import { block, registerSolidFeatures } from '../../doc/blocks';
import { mountApp, type TestApp } from './app';
import { hybridKernel } from './hybrid-kernel';

const FLANGE = readFileSync(resolve(process.cwd(), 'fixtures/kernel/flange.step'));

let app: TestApp | null = null;
afterEach(() => {
  app?.dispose();
  app = null;
  forgetBreps();
});

async function start() {
  const real = realKernelAnywhere();
  await real.start();
  const kernel = hybridKernel(real);
  app = mountApp(kernel);
  await act(async () => {
    await app!.services.doc.load();
  });
  return app;
}

const texts = (a: TestApp, sel: string) => a.$$(sel).map((e) => e.textContent);
const toasts = (a: TestApp) => (a.services.bridge.raw as unknown as FakeWorkspace).log.toasts;

/** Poll outside act(), letting React render between tries (waiting inside one act() would hold the renders back). */
async function waitFor(fn: () => void, timeout = 30_000) {
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

async function importFlange(a: TestApp) {
  const file = new File([FLANGE.buffer.slice(FLANGE.byteOffset, FLANGE.byteOffset + FLANGE.byteLength) as ArrayBuffer], 'flange.step');
  act(() => a.services.bus.emit('import:file', { file }));
  await waitFor(() => expect(a.$('[data-import-diagnostics]')?.textContent).toBe('0 problems'));
  await waitFor(() => expect(a.services.doc.state.get().rebuild.bodies).toHaveLength(1));
}

describe('P2 commands and panels', () => {
  it('the toolbar shows the P2 groups, each command saying why it cannot run yet', async () => {
    const a = await start();
    // No SOLID group without the extrude module: the shell has no Box or Cylinder (decision 2026-10-01).
    expect(texts(a, '[data-cad-toolbar] .tb-group-label')).toEqual(['MODIFY', 'INSPECT', 'FILE', 'EDIT']);
    expect(texts(a, '[data-group="modify"] .tb-txt')).toEqual(['Parameters', 'Press-pull', 'Delete faces', 'Split', 'Combine']);
    expect(texts(a, '[data-group="inspect"] .tb-txt')).toEqual(['Measure', 'Mass properties', 'Check']);
    expect(texts(a, '[data-group="file"] .tb-txt')).toEqual(['Import STEP', 'Export STEP']);
    expect(a.$('[data-command="modify.press-pull"]')?.getAttribute('data-disabled-reason')).toBe('Make or import a body first');
    expect(a.$('[data-command="modify.combine"]')?.getAttribute('data-disabled-reason')).toBe('Combine needs two bodies');
    expect(a.$('[data-command="file.export-step"]')?.getAttribute('data-disabled-reason')).toBe('Nothing to export yet: make or import a body');
    expect(a.$('[data-command="file.import-step"]')?.getAttribute('data-disabled-reason')).toBeNull();
  });

  it('a dropped STEP imports with its progress, diagnostics and bodies; Done keeps it', async () => {
    const a = await start();
    await importFlange(a);
    const f = a.services.doc.state.get().doc.features[0] as ImportFeature;
    expect(a.$('[data-cad-panel] [data-panel-title]')?.textContent ?? a.$('[data-cad-panel] .mgk-panel-title')?.textContent).toBe('Imported 1 (flange.step)');
    expect(a.$('[data-import-file]')?.textContent).toMatch(/^flange\.step · 29\.\d KB$/);
    expect(texts(a, '[data-import-bodies] tbody td').slice(1)).toEqual(['Solid', '10', 'Valid']);
    expect(a.$(`[data-import-body="${f.items[0].body}"] td`)?.textContent?.trim()).toBe(a.services.doc.state.get().doc.bodies[f.items[0].body].name);
    // A clean part (0 problems, nothing knit): no "Healed at" line (UX review).
    expect(a.$('[data-import-diagnostics]')?.textContent).toBe('0 problems');
    expect(a.$('[data-import-healed]')).toBeNull();
    expect(a.$('[data-import-progress]')).toBeNull();
    act(() => void fireEvent.click(a.$('[data-panel-done]')!));
    expect(a.$('[data-feature-panel]')).toBeNull();
    expect(texts(a, '[data-cad-tree] [data-feature-row] > .tree-row .tl')).toEqual(['Imported 1 (flange.step)']);
    expect(a.services.doc.state.get().history.undoLabel).toBe('Imported 1 (flange.step)');
  });

  it('a STEP over 512 MB is refused before anything uploads', async () => {
    const a = await start();
    const big = new File([new Uint8Array(1)], 'huge.step');
    Object.defineProperty(big, 'size', { value: 600 * 1024 * 1024 });
    act(() => a.services.bus.emit('import:file', { file: big }));
    expect(toasts(a).at(-1)).toEqual({ message: 'This STEP is 600 MB. Parts can store files up to 512 MB.', kind: 'error' });
    expect(MAX_FILE_BYTES).toBe(512 * 1024 * 1024);
    expect(a.$('[data-feature-panel]')).toBeNull();
    expect([...a.folder.entries.keys()].some((k) => k.includes('/imports/'))).toBe(false);
  });

  it('a STEP the kernel cannot read: the panel says why, Done closes it, and nothing is left behind', async () => {
    const a = await start();
    act(() => a.services.bus.emit('import:file', { file: new File(['this is not STEP'], 'broken.step') }));
    await waitFor(() => expect(a.$('[data-cad-panel] [data-run-reason]')?.textContent).toMatch(/^Import failed: STEP read failed/));
    // While it ran, its progress said what it did; after the failure no red "still being imported" line.
    expect(a.$('[data-import-progress]')).toBeNull();
    expect(a.$$('[data-cad-panel] [data-run-reason]')).toHaveLength(1);
    const done = a.$('[data-panel-done]')!;
    expect(done.getAttribute('aria-disabled')).toBeNull();
    act(() => void fireEvent.click(done));
    expect(a.$('[data-feature-panel]')).toBeNull();
    expect(a.services.doc.state.get().doc.features).toHaveLength(0);
    // The uploaded source of the discarded import is deleted.
    await waitFor(() => expect([...a.folder.entries.keys()].filter((k) => k.includes('/imports/'))).toEqual([]));
  });

  it('a file that is not a STEP is refused with its name', async () => {
    const a = await start();
    act(() => a.services.bus.emit('import:file', { file: new File(['x'], 'notes.txt') }));
    expect(toasts(a).at(-1)).toEqual({ message: 'Import failed: notes.txt is not a STEP file (.step, .stp)', kind: 'error' });
  });

  it('Delete on a hole face opens Delete faces; clicking more holes adds them; the volume grows', async () => {
    const a = await start();
    await importFlange(a);
    act(() => void fireEvent.click(a.$('[data-panel-done]')!));
    const body = a.services.doc.state.get().rebuild.bodies[0];
    const topo = await a.services.kernel.call('topo', { id: body.shape, faces: 'all', edges: 'none', vertices: 'none', face_bbox: 'fast', face_mass: true });
    const holes = topo.result.faces.filter((x) => x.type === 'cylinder').map((x) => x.i);
    act(() => a.services.selection.set({ items: [{ kind: 'face', body: body.id, index: holes[0] }] }));
    await act(async () => {
      fireEvent.keyDown(document.body, { key: 'Delete' });
      await new Promise((r) => setTimeout(r, 50));
    });
    await waitFor(() => expect(a.$('[data-feature-panel="delete_faces"]')).not.toBeNull());
    expect(a.$$('[data-pick-field="faces"] [data-pick-row]')).toHaveLength(1);
    await waitFor(() => expect(a.services.doc.state.get().rebuild.bodies[0].faces).toBe(9));
    // Three more holes clicked in the viewport (the panel's picker takes them).
    for (const i of holes.slice(1)) {
      const now = a.services.doc.state.get().rebuild.bodies[0];
      // The face indices of the shown (already healed) body: find the hole by its name.
      const name = body.names!.faces[i];
      const at = now.names!.faces.indexOf(name);
      expect(at).toBeGreaterThanOrEqual(0);
      expect(a.view.click({ kind: 'face', body: now.id, index: at })).toBe(true);
      await waitFor(() => expect(a.$$('[data-pick-field="faces"] [data-pick-row]').length).toBe(holes.indexOf(i) + 1));
    }
    await waitFor(() => expect(a.services.doc.state.get().rebuild.bodies[0].faces).toBe(6));
    expect(a.services.doc.state.get().rebuild.bodies[0].volume).toBeCloseTo(100000, 2);
    expect(a.$('[data-pick-field="faces"] .cad-pick-label')?.textContent).toBe('Faces to delete (4)');
    // Each named as Measure named it when it was picked (the live result no longer has them), where it came from in the tooltip.
    expect(texts(a, '[data-pick-field="faces"] .cad-pick-name')[0]).toBe(`Face ${holes[0] + 1} of flange`);
    for (const t of texts(a, '[data-pick-field="faces"] .cad-pick-name')) expect(t).toMatch(/^Face \d+ of flange$/);
    // Each its own number, as the flange had them when the panel opened (L3 review polish 4: every
    // hole picked after the first was "Face 8" of the healed body at its click).
    expect(texts(a, '[data-pick-field="faces"] .cad-pick-name')).toEqual(holes.map((i) => `Face ${i + 1} of flange`));
    expect(a.$('[data-pick-field="faces"] .cad-pick-name')?.getAttribute('title')).toMatch(/^Face \d+ of flange, from Face \d+ of Imported 1 \(flange\.step\)$/);
    // Clicking a face of the body again takes it out of the list.
    act(() => void fireEvent.click(a.$$('[data-pick-remove]')[3]));
    await waitFor(() => expect(a.services.doc.state.get().rebuild.bodies[0].faces).toBe(7));
    act(() => void fireEvent.click(a.$('[data-panel-done]')!));
    expect(texts(a, '[data-cad-tree] [data-feature-row] > .tree-row .tl')).toEqual(['Imported 1 (flange.step)', 'Delete faces 1']);
  });

  it('Q with a flat face selected opens Press-pull with it; the distance applies live; a curved face is refused in the field', async () => {
    const a = await start();
    registerSolidFeatures(a.services.doc);
    // A 20 mm cube: a square sketched on Top, extruded 20 mm.
    await act(async () => {
      block(a.services.doc);
    });
    await waitFor(() => expect(a.services.doc.state.get().rebuild.bodies).toHaveLength(1));
    const b = a.services.doc.state.get().rebuild.bodies[0];
    const t = await a.services.kernel.call('topo', { id: b.shape, faces: 'all', edges: 'none', vertices: 'none', face_bbox: 'fast', face_mass: true });
    const top = t.result.faces.find((f) => f.normal && f.normal[2] > 0.99)!.i;
    act(() => a.services.selection.set({ items: [{ kind: 'face', body: b.id, index: top }] }));
    await act(async () => {
      fireEvent.keyDown(document.body, { key: 'q' });
      await new Promise((r) => setTimeout(r, 50));
    });
    await waitFor(() => expect(a.$('[data-feature-panel="press_pull"]')).not.toBeNull());
    expect(a.$$('[data-pick-field="faces"] [data-pick-row]')).toHaveLength(1);
    expect(a.$('[data-press-sense]')?.textContent).toBe('Adds material: the faces move out of the body');
    await waitFor(() => expect(a.services.doc.state.get().rebuild.bodies[0].volume).toBeCloseTo(12000, 3));
    const input = a.$<HTMLInputElement>('.nui[data-field="distance"] input')!;
    act(() => {
      fireEvent.focus(input);
      fireEvent.change(input, { target: { value: '-5' } });
      fireEvent.keyDown(input, { key: 'Enter' });
    });
    await waitFor(() => expect(a.services.doc.state.get().rebuild.bodies[0].volume).toBeCloseTo(6000, 3));
    expect(a.$('[data-press-sense]')?.textContent).toBe('Removes material: the faces move into the body');
    act(() => {
      fireEvent.focus(input);
      fireEvent.change(input, { target: { value: '0' } });
      fireEvent.keyDown(input, { key: 'Enter' });
    });
    expect(a.$('.nui[data-field="distance"] [data-nui-error]')?.textContent).toBe('Distance must not be 0');
    // A face the viewport says is not flat is refused in the field, with the reason.
    a.view.flat = new Set();
    expect(a.view.click({ kind: 'face', body: b.id, index: (top + 1) % 6 })).toBe(true);
    await waitFor(() => expect(a.$('[data-pick-error="faces"]')?.textContent).toBe('Press-pull works on flat faces: that face is curved'));
    expect(a.$$('[data-pick-field="faces"] [data-pick-row]')).toHaveLength(1);
  });

  it('Mass properties, Check and Export on the imported flange', { timeout: 120_000 }, async () => {
    const a = await start();
    await importFlange(a);
    act(() => void fireEvent.click(a.$('[data-panel-done]')!));
    await act(async () => {
      await a.run('inspect.mass');
    });
    await waitFor(() => expect(a.$('[data-mass-value="volume"]')?.textContent).toBe('96,858.4 mm³'));
    expect(a.$('[data-mass-value="size"]')?.textContent).toBe('100 mm × 100 mm × 10 mm');
    expect(a.$('[data-mass-value="faces"]')?.textContent).toBe('10, 24');
    // The kernel's -1.9e-13 mm on the symmetric flange reads as 0 (it showed "-1.9294e-13").
    expect(a.$('[data-mass-value="centroid"]')?.textContent).toBe('0, 0, 5 mm');
    await act(async () => {
      await a.run('inspect.check');
    });
    const id = a.services.doc.state.get().rebuild.bodies[0].id;
    await waitFor(() => expect(a.$(`[data-check-state="${id}"]`)?.textContent).toBe('Valid'));
    expect(a.$('[data-check-summary]')?.textContent).toMatch(/ is valid$/);
    const urls: Blob[] = [];
    const create = vi.spyOn(URL, 'createObjectURL').mockImplementation((b) => {
      urls.push(b as Blob);
      return 'blob:x';
    });
    const revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
    const clicks: string[] = [];
    const anchorClick = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
      clicks.push(this.download);
    });
    try {
      await act(async () => {
        await a.run('file.export-step');
      });
      expect(a.$('[data-field="schema"] select') as HTMLSelectElement).not.toBeNull();
      expect((a.$('#cad-export-name') as HTMLInputElement).value).toBe('Part 1.step');
      act(() => void fireEvent.click(a.$('[data-export-run]')!));
      await waitFor(() => expect(a.$('[data-export-done]')).not.toBeNull());
      expect(clicks).toEqual(['Part 1.step']);
      const text = await urls[0].text();
      expect(text.startsWith('ISO-10303-21;')).toBe(true);
      expect(text).toContain('AUTOMOTIVE_DESIGN');
      expect(toasts(a).at(-1)).toEqual({ message: 'Exported Part 1.step', kind: 'success' });
    } finally {
      create.mockRestore();
      revoke.mockRestore();
      anchorClick.mockRestore();
    }
  });

  it('Combine refuses a body in both fields, in the field itself', async () => {
    const a = await start();
    registerSolidFeatures(a.services.doc);
    // Two 20 mm cubes from sketches, 10 mm apart.
    await act(async () => {
      block(a.services.doc);
      block(a.services.doc, { at: [30, 0, 0] });
    });
    await waitFor(() => expect(a.services.doc.state.get().rebuild.bodies).toHaveLength(2));
    const [b1, b2] = a.services.doc.state.get().rebuild.bodies.map((b) => b.id);
    await act(async () => {
      await a.run('modify.combine');
    });
    expect(a.$('[data-pick-field="targets"]')?.getAttribute('data-active')).toBe('1');
    expect(a.view.click({ kind: 'body', body: b1 })).toBe(true);
    // The first target moves on to the tools.
    await waitFor(() => expect(a.$('[data-pick-field="tools"]')?.getAttribute('data-active')).toBe('1'));
    a.view.click({ kind: 'body', body: b1 });
    await waitFor(() => expect(a.$('[data-pick-error="tools"]')?.textContent).toBe('A body cannot be a target and a tool'));
    a.view.click({ kind: 'body', body: b2 });
    await waitFor(() => expect(a.services.doc.state.get().rebuild.bodies.map((b) => b.id)).toEqual([b1]));
    expect(a.services.doc.state.get().rebuild.bodies[0].volume).toBeCloseTo(16000, 3);
    // The joined tool is no longer built: the rebuild taking it out of the selection is not a pick
    // (it was taken as one: "A body cannot be a target and a tool" under Tools, and the tool listed as not there).
    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });
    expect(a.$('[data-pick-error]')).toBeNull();
    expect(texts(a, '[data-pick-field="tools"] .cad-pick-name')).toEqual(['Body 2']);
    expect(a.$$('[data-pick-field="tools"] .mat-assign-state')).toHaveLength(0);
  });

  it('Delete on a face of a native feature asks first (in the frame): Cancel by Escape, or delete the feature', async () => {
    const a = await start();
    registerSolidFeatures(a.services.doc);
    await act(async () => {
      block(a.services.doc);
    });
    await waitFor(() => expect(a.services.doc.state.get().rebuild.bodies).toHaveLength(1));
    const b = a.services.doc.state.get().rebuild.bodies[0];
    act(() => a.services.selection.set({ items: [{ kind: 'face', body: b.id, index: 2 }] }));
    act(() => void fireEvent.keyDown(document.body, { key: 'Delete' }));
    await waitFor(() => expect(document.querySelector('[data-cad-dialog]')).not.toBeNull());
    const dlg = document.querySelector<HTMLElement>('[data-cad-dialog]')!;
    expect(dlg.querySelector('h2')?.textContent).toBe('Delete faces of Extrude 1?');
    expect([...dlg.querySelectorAll('[data-dialog-choice]')].map((x) => x.textContent)).toEqual(['Delete feature Extrude 1', 'Delete faces and heal', 'Cancel']);
    // Focus is on Cancel, and Escape cancels: nothing is deleted, and the workspace's own Escape did not run.
    expect(document.activeElement?.getAttribute('data-dialog-choice')).toBe('cancel');
    act(() => void fireEvent.keyDown(document.activeElement!, { key: 'Escape' }));
    await waitFor(() => expect(document.querySelector('[data-cad-dialog]')).toBeNull());
    expect(a.services.doc.state.get().doc.features.map((f) => f.name)).toEqual(['Sketch 1', 'Extrude 1']);
    expect(a.services.selection.get().items).toHaveLength(1);
    // Again, and delete the feature.
    act(() => void fireEvent.keyDown(document.body, { key: 'Delete' }));
    await waitFor(() => expect(document.querySelector('[data-cad-dialog]')).not.toBeNull());
    act(() => (document.querySelector('[data-dialog-choice="feature"]') as HTMLElement).click());
    await waitFor(() => expect(a.services.doc.state.get().doc.features.map((f) => f.name)).toEqual(['Sketch 1']));
  });

  it('Delete faces and heal on a native face opens the panel with it', async () => {
    const a = await start();
    registerSolidFeatures(a.services.doc);
    await act(async () => {
      block(a.services.doc);
    });
    await waitFor(() => expect(a.services.doc.state.get().rebuild.bodies).toHaveLength(1));
    const b = a.services.doc.state.get().rebuild.bodies[0];
    act(() => a.services.selection.set({ items: [{ kind: 'face', body: b.id, index: 2 }] }));
    act(() => void fireEvent.keyDown(document.body, { key: 'Delete' }));
    await waitFor(() => expect(document.querySelector('[data-cad-dialog]')).not.toBeNull());
    act(() => (document.querySelector('[data-dialog-choice="faces"]') as HTMLElement).click());
    await waitFor(() => expect(a.$('[data-feature-panel="delete_faces"]')).not.toBeNull());
    // Named as Measure names it (its number on the body shown, and the body); where it came from is the tooltip.
    expect(texts(a, '[data-pick-field="faces"] .cad-pick-name')).toEqual(['Face 3 of Body 1']);
    expect(a.$('[data-pick-field="faces"] .cad-pick-name')?.getAttribute('title')).toMatch(/^Face 3 of Body 1, from (Side face|Start face|End face) of Extrude 1$/);
  });
});
