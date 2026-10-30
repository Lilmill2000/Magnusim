// INSPECT's Check, the assembly modes (the person's side of the Assistant's check tool), with the UI
// shell mounted over the REAL document service and kernel, on parts built in code (sketches and
// extrudes as the app makes them; never a person's Parts):
//   - Interference: two blocks that share 4000 mm³: the line is the check tool's own words, the row
//     lists the pair with its volume (and where, on hover), a click selects both bodies and hovering lights them; a
//     clearance that does not read is refused under Check with its reason;
//   - Loose parts: a wheel on a headed shaft with nothing above it: the finding names the wheel and
//     +Z, the parts table says what holds each side, a click on the finding selects the wheel; a
//     collar pressed on above it: nothing is loose;
//   - Rotation: an arm on a pin turned about the axis they share meets a post at the angle the
//     geometry gives (atan2(8, 14) - asin(1.5 / |(14, 8)|) = 24.407 degrees);
//   - Stop ends a check before it reads anything ("Stopped: nothing was checked.") and the Part
//     changing after a check says so; the mode stays when the panel opens again.
// SPDX-License-Identifier: GPL-3.0-or-later
import { act, fireEvent } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { block, cylinder, registerSolidFeatures } from '../../doc/blocks';
import { mountApp, type TestApp } from '../p2/app';
import { hybridKernel } from '../p2/hybrid-kernel';
import { realKernelAnywhere } from '../p2/kernel-anywhere';

let app: TestApp | null = null;
afterEach(() => {
  app?.dispose();
  app = null;
});

/** Real-kernel tests: each one's ceiling (Linux CI runs on 2 slow cores). */
const MS = 120_000;

async function start(): Promise<TestApp> {
  const real = realKernelAnywhere();
  await real.start();
  app = mountApp(hybridKernel(real));
  await act(async () => {
    await app!.services.doc.load();
  });
  registerSolidFeatures(app.services.doc);
  return app;
}

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
      await new Promise((r) => setTimeout(r, 25));
    });
  }
}

const bodies = (a: TestApp) => a.services.doc.state.get().rebuild.bodies;
/** Waits for `n` bodies, then names the newest `name`. */
async function named(a: TestApp, n: number, name: string) {
  await waitFor(() => expect(bodies(a)).toHaveLength(n));
  await act(async () => {
    a.services.doc.renameBody(bodies(a)[n - 1].id, name);
  });
}
const settled = (a: TestApp) =>
  act(async () => {
    await a.services.doc.settled();
  });
const idOf = (a: TestApp, name: string) => bodies(a).find((b) => b.name === name)!.id;
const selectedIds = (a: TestApp) => a.services.selection.get().items.map((it) => (it.kind === 'body' ? it.body : `${it.kind}`));

async function openMode(a: TestApp, mode: string) {
  if (!a.$('[data-tool-panel="inspect.check"]')) await act(async () => void (await a.run('inspect.check')));
  act(() => void fireEvent.click(a.$(`[data-check-mode-button="${mode}"]`)!));
  expect(a.$('[data-tool-panel="inspect.check"]')?.getAttribute('data-check-mode')).toBe(mode);
}

async function check(a: TestApp, kind: string) {
  await waitFor(() => expect(a.$(`[data-check-run="${kind}"]`)?.getAttribute('data-disabled-reason') ?? null).toBeNull());
  act(() => void fireEvent.click(a.$(`[data-check-run="${kind}"]`)!));
  // It runs (its progress and Stop show), then its result replaces the last one.
  expect(a.$('[data-check-progress]')).not.toBeNull();
  await waitFor(() => {
    expect(a.$('[data-check-progress]')).toBeNull();
    expect(a.$(`[data-check-result="${kind}"]`)).not.toBeNull();
  });
  return a.$(`[data-check-result="${kind}"] [data-check-text]`)!.textContent;
}

/** A shaft (a head 12 across and 2 thick, a rod 4 across and 30 long) and a wheel (bore 4.4, rim 30, 4 thick) resting on the head. */
async function wheelOnShaft(a: TestApp) {
  const doc = a.services.doc;
  await act(async () => void cylinder(doc, { size: [12, 2] }));
  await named(a, 1, 'Shaft');
  await act(async () => void cylinder(doc, { size: [4, 30], op: 'join', scope: [idOf(a, 'Shaft')] }));
  await act(async () => void cylinder(doc, { at: [0, 0, 2], size: [30, 4] }));
  await named(a, 2, 'Wheel');
  await act(async () => void cylinder(doc, { at: [0, 0, 2], size: [4.4, 4], op: 'cut', scope: [idOf(a, 'Wheel')] }));
  await settled(a);
}

describe("INSPECT's Check: Interference, Loose parts, Rotation", () => {
  it(
    'Interference lists two overlapping blocks with their shared volume in the check tool\'s words; a row click selects both, hovering lights them',
    async () => {
      const a = await start();
      await act(async () => void block(a.services.doc));
      await named(a, 1, 'Block A');
      await act(async () => void block(a.services.doc, { at: [10, 0, 0] }));
      await named(a, 2, 'Block B');
      await settled(a);
      await openMode(a, 'interference');
      expect(a.$('[data-check-scope]')?.textContent).toBe('Checks every shown body (2)');
      // A clearance that does not read is refused under Check, with its reason.
      act(() => void fireEvent.change(a.$('[data-check-clearance]')!, { target: { value: 'wide' } }));
      expect(a.$('[data-check-run="interference"]')?.getAttribute('data-disabled-reason')).toMatch(/^Clearance: /);
      act(() => void fireEvent.change(a.$('[data-check-clearance]')!, { target: { value: '' } }));
      const text = await check(a, 'interference');
      expect(text).toBe('1 pair overlaps (2 bodies, 1 of 1 pairs near enough to measure): Block A and Block B 4000 mm3');
      const row = a.$('[data-check-pair="Block A|Block B"]')!;
      expect(Number(row.getAttribute('data-check-overlap-mm3'))).toBeCloseTo(4000, 6);
      expect(row.textContent).toBe('Block A and Block B4000 mm³ overlap');
      // Where, as the Assistant's at_mm says it.
      expect(row.getAttribute('title')).toBe('The middle of what they share: (15, 10, 10) mm');
      const flash = vi.spyOn(a.services.viewport.get().handle!, 'flash');
      act(() => void fireEvent.mouseEnter(row));
      expect(flash).toHaveBeenLastCalledWith([
        { kind: 'body', body: idOf(a, 'Block A') },
        { kind: 'body', body: idOf(a, 'Block B') },
      ]);
      act(() => void fireEvent.click(row));
      expect(selectedIds(a)).toEqual([idOf(a, 'Block A'), idOf(a, 'Block B')]);
      // Now the two selected bodies are what it checks.
      expect(a.$('[data-check-scope]')?.textContent).toBe('Checks the 2 selected bodies');
    },
    MS,
  );

  it(
    'Loose parts names a wheel free to slide off its shaft toward +Z and a click selects it; a collar pressed on above holds it: nothing is loose',
    async () => {
      const a = await start();
      await wheelOnShaft(a);
      await openMode(a, 'stack');
      expect(await check(a, 'stack')).toBe('1 part can slide along its shaft: Wheel (+Z)');
      const loose = a.$$('[data-check-loose]');
      expect(loose.map((li) => [li.getAttribute('data-check-loose'), li.getAttribute('data-check-side'), li.textContent])).toEqual([['Wheel', '+Z', 'Wheel can slide along Shaft toward +Z: nothing stops it before it comes off Shaft']]);
      expect(a.$('[data-check-part="Wheel"]')?.textContent).toBe('Wheelon Shaft, play 0.2 mmShaft, 0 mmnothing: it comes off');
      expect(a.$('[data-check-part="Wheel"]')?.getAttribute('title')).toBe("Along the axis from 2 mm to 6 mm; its bore's radius 2.2 mm");
      act(() => void fireEvent.click(loose[0]));
      expect(selectedIds(a)).toEqual([idOf(a, 'Wheel')]);
      act(() => a.services.selection.set((s) => ({ ...s, items: [] })));

      // A collar pressed on above the wheel (its bore the shaft's size): the old result says the Part changed.
      const doc = a.services.doc;
      await act(async () => void cylinder(doc, { at: [0, 0, 6], size: [10, 3] }));
      await named(a, 3, 'Collar');
      await act(async () => void cylinder(doc, { at: [0, 0, 6], size: [4, 3], op: 'cut', scope: [idOf(a, 'Collar')] }));
      await settled(a);
      await waitFor(() => expect(a.$('[data-check-stale]')).not.toBeNull());
      expect(await check(a, 'stack').then(() => a.$('[data-check-stale]'))).toBeNull();
      expect(a.$('[data-check-result="stack"] [data-check-text]')?.textContent).toBe('Nothing is loose: 1 part on 1 axis, each held both ways within 0.5 mm');
      expect(a.$$('[data-check-loose]')).toHaveLength(0);
      expect(a.$('[data-check-part="Wheel"]')?.textContent).toBe('Wheelon Shaft, play 0.2 mmShaft, 0 mmCollar, 0 mm');
    },
    MS,
  );

  it(
    'Rotation turns an arm about the axis it shares with its pin: it meets the post at 24.407 degrees, and the row selects both',
    async () => {
      const a = await start();
      const doc = a.services.doc;
      // A pin along Z, an arm (a hub 8 across with a 30 mm bar 3 wide, bore 2.4) on it, a post in its way.
      await act(async () => void cylinder(doc, { at: [0, 0, -3], size: [2, 10] }));
      await named(a, 1, 'Pin');
      await act(async () => void cylinder(doc, { size: [8, 3] }));
      await named(a, 2, 'Arm');
      await act(async () => void block(doc, { at: [0, -1.5, 0], size: [30, 3, 3], op: 'join', scope: [idOf(a, 'Arm')] }));
      await act(async () => void cylinder(doc, { size: [2.4, 3], op: 'cut', scope: [idOf(a, 'Arm')] }));
      await act(async () => void block(doc, { at: [10, 8, 0], size: [4, 4, 3] }));
      await named(a, 3, 'Post');
      await settled(a);
      act(() => a.services.selection.set((s) => ({ ...s, items: [{ kind: 'body', body: idOf(a, 'Arm') }] })));
      await openMode(a, 'sweep');
      // The axis it shares with the pin comes first once the axes are found.
      await waitFor(() => expect(a.$<HTMLSelectElement>('[data-check-axis-pick] select')?.value).toMatch(/^found:/));
      expect(a.$<HTMLSelectElement>('[data-check-turning] select')?.value).toBe(`body:${idOf(a, 'Arm')}`);
      const axisLabel = a.$<HTMLSelectElement>('[data-check-axis-pick] select')!.selectedOptions[0].textContent;
      expect(axisLabel).toBe('along Z through (0, 0, 0): shared with Pin');
      const text = await check(a, 'sweep');
      expect(text).toMatch(/^Arm turned along Z through \(0, 0, 0\) hits Post at 24\.40\d+ deg \(\d+(\.\d+)? deg the other way\)$/);
      const hit = a.$('[data-check-hit="Post"]')!;
      const want = (Math.atan2(8, 14) - Math.asin(1.5 / Math.hypot(14, 8))) * (180 / Math.PI);
      expect(Number(hit.getAttribute('data-check-first-deg'))).toBeCloseTo(want, 2);
      // Where they meet, and the kernel's word on it (the turned copy 1 degree past overlaps the post).
      expect(hit.getAttribute('title')).toMatch(/^They meet first at \(1[34][\d.]*, 8, 1\.5\) mm; turned 1° past that, the kernel finds [\d.]+ mm³ shared$/);
      act(() => void fireEvent.click(hit));
      expect(selectedIds(a)).toEqual([idOf(a, 'Arm'), idOf(a, 'Post')]);
      // Z axis (a reference axis: the same line) gives the same contact.
      const pick = a.$<HTMLSelectElement>('[data-check-axis-pick] select')!;
      act(() => void fireEvent.change(pick, { target: { value: 'ref:Z axis' } }));
      // The turning body stays the one it ran with, though the click selected two.
      expect(a.$<HTMLSelectElement>('[data-check-turning] select')?.value).toBe(`body:${idOf(a, 'Arm')}`);
      expect(a.$<HTMLSelectElement>('[data-check-axis-pick] select')?.value).toBe('ref:Z axis');
      expect(await check(a, 'sweep')).toMatch(/^Arm turned along Z through \(0, 0, 0\) hits Post at 24\.40\d+ deg/);
      expect(Number(a.$('[data-check-hit="Post"]')!.getAttribute('data-check-first-deg'))).toBeCloseTo(want, 2);
    },
    MS,
  );

  it(
    'Stop ends a check before it reads anything; the panel opens again in the mode it was left in',
    async () => {
      const a = await start();
      await act(async () => void block(a.services.doc));
      await act(async () => void block(a.services.doc, { at: [10, 0, 0] }));
      await settled(a);
      await openMode(a, 'interference');
      await waitFor(() => expect(a.$('[data-check-run="interference"]')?.getAttribute('data-disabled-reason') ?? null).toBeNull());
      act(() => {
        fireEvent.click(a.$('[data-check-run="interference"]')!);
      });
      expect(a.$('[data-check-progress]')).not.toBeNull();
      expect(a.$('[data-check-run="interference"]')?.getAttribute('data-disabled-reason')).toBe('Checking now');
      act(() => void fireEvent.click(a.$('[data-check-stop]')!));
      await waitFor(() => expect(a.$('[data-check-stopped]')?.textContent).toBe('Stopped: nothing was checked.'));
      expect(a.$('[data-check-progress]')).toBeNull();
      expect(a.$('[data-check-result="interference"]')).toBeNull();
      // Closed and opened again: Interference still.
      await act(async () => void (await a.run('inspect.check')));
      expect(a.$('[data-tool-panel="inspect.check"]')).toBeNull();
      await act(async () => void (await a.run('inspect.check')));
      expect(a.$('[data-tool-panel="inspect.check"]')?.getAttribute('data-check-mode')).toBe('interference');
      act(() => void fireEvent.click(a.$('[data-check-mode-button="solids"]')!));
    },
    MS,
  );
});
