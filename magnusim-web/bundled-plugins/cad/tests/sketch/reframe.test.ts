// @vitest-environment node
// A sketch reopened with features after it (P2+P3 review round 4): entering it looks at its
// plane at once, and once the rebuild that stops after it has rolled the later features back
// (the bodies they made are no longer drawn), the view frames again what is drawn now: the
// sketch and the bodies before it. Not for a rebuild still running, nor for an older rebuild
// that lands with the later features still built, and only once.
// SPDX-License-Identifier: GPL-3.0-or-later
import { afterEach, describe, expect, it } from 'vitest';
import type { Feature } from '../../src/types/doc';
import type { DocState } from '../../src/types/doc-service';
import type { StateStore } from '../../src/types/state';
import { sketchHarness, type Harness } from './harness';

let h: Harness | null = null;
afterEach(() => {
  h?.dispose();
  h = null;
});

const LATER = { id: 'f_box', type: 'extrude', name: 'Extrude 1' } as unknown as Feature;

function viewport() {
  const calls: string[] = [];
  return {
    calls,
    handle: {
      lookAt: () => void calls.push('lookAt'),
      reframe: () => {
        calls.push('reframe');
        return true;
      },
    },
  };
}

const store = (hh: Harness) => hh.services.doc.state as unknown as StateStore<DocState>;
const rebuild = async (hh: Harness, status: 'running' | 'done', later: 'ok' | 'rolled-back') => {
  store(hh).set((s) => ({ ...s, rebuild: { ...s.rebuild, status, seq: s.rebuild.seq + (status === 'done' ? 1 : 0), features: { ...s.rebuild.features, f_box: { state: later } } } }));
  // What the listeners left for later (the viewport's turn first) has run.
  await new Promise((r) => setTimeout(r, 0));
};

describe('reopening a sketch with features after it', () => {
  it('frames again once the rebuild has rolled the later features back, once', async () => {
    const v = viewport();
    h = await sketchHarness({}, { handle: v.handle, later: [{ feature: LATER, state: 'ok' }] });
    expect(v.calls).toEqual(['lookAt']);
    // The rebuild that stops after the sketch is running; an older one lands with Extrude 1 built.
    await rebuild(h, 'running', 'ok');
    await rebuild(h, 'done', 'ok');
    expect(v.calls).toEqual(['lookAt']);
    // Now Extrude 1 is rolled back: the view frames what is drawn.
    await rebuild(h, 'running', 'ok');
    await rebuild(h, 'done', 'rolled-back');
    expect(v.calls).toEqual(['lookAt', 'reframe']);
    // Later rebuilds (edits in the sketch) leave the camera alone.
    await rebuild(h, 'done', 'rolled-back');
    await rebuild(h, 'done', 'ok');
    await rebuild(h, 'done', 'rolled-back');
    expect(v.calls).toEqual(['lookAt', 'reframe']);
  });

  it('a sketch with nothing after it, or whose later features are already rolled back, frames once on entry', async () => {
    let v = viewport();
    h = await sketchHarness({}, { handle: v.handle });
    await rebuild(h, 'done', 'rolled-back');
    expect(v.calls).toEqual(['lookAt']);
    h.dispose();
    v = viewport();
    h = await sketchHarness({}, { handle: v.handle, later: [{ feature: LATER, state: 'rolled-back' }] });
    await rebuild(h, 'done', 'rolled-back');
    expect(v.calls).toEqual(['lookAt']);
  });

  it('a sketch left before its rebuild lands does not move the camera afterwards', async () => {
    const v = viewport();
    h = await sketchHarness({}, { handle: v.handle, later: [{ feature: LATER, state: 'ok' }] });
    h.session.commit();
    await rebuild(h, 'done', 'rolled-back');
    expect(v.calls).toEqual(['lookAt']);
  });
});
