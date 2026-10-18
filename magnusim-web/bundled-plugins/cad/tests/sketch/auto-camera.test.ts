// @vitest-environment node
// Sketch mode's two automatic camera moves are the app's own and ask first (D6): entering a
// sketch looks straight at its plane, and a reopened sketch frames again once the later
// features are rolled back. Both pass `auto: true` (userCameraMoves does not count them), and
// both ask apis.assistant.autoCamera with the reason and the session's id: false keeps the
// view, true (or no Assistant: the person's own sketches as before) moves it.
// SPDX-License-Identifier: GPL-3.0-or-later
import { afterEach, describe, expect, it } from 'vitest';
import type { AssistantPageApi, AutoCameraReason } from '../../src/types/assistant';
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

/** A viewport that records its camera calls with their options. */
function viewport() {
  const calls: [string, unknown][] = [];
  return {
    calls,
    handle: {
      lookAt: (_n: unknown, _u: unknown, o?: unknown) => void calls.push(['lookAt', o]),
      reframe: (o?: unknown) => {
        calls.push(['reframe', o]);
        return true;
      },
    },
  };
}

/** The Assistant's gate, answering `allow` and recording what it was asked. */
function gate(allow: boolean) {
  const asked: [AutoCameraReason, string | null][] = [];
  const api: AssistantPageApi = {
    autoCamera: (reason, sessionId) => {
      asked.push([reason, sessionId]);
      return allow;
    },
  };
  return { asked, api };
}

const store = (hh: Harness) => hh.services.doc.state as unknown as StateStore<DocState>;
/** A rebuild that rolls Extrude 1 back (the reopened sketch's own), then what the listeners left for later. */
const rolledBack = async (hh: Harness) => {
  store(hh).set((s) => ({ ...s, rebuild: { ...s.rebuild, status: 'done', seq: s.rebuild.seq + 1, features: { ...s.rebuild.features, f_box: { state: 'rolled-back' } } } }));
  await new Promise((r) => setTimeout(r, 0));
};

describe("sketch mode's automatic camera moves", () => {
  it("without the Assistant: entry and the reframe move the camera as before, passing auto", async () => {
    const v = viewport();
    h = await sketchHarness({}, { handle: v.handle, later: [{ feature: LATER, state: 'ok' }] });
    await rolledBack(h);
    expect(v.calls).toEqual([
      ['lookAt', { auto: true }],
      ['reframe', { auto: true }],
    ]);
  });

  it('the Assistant allows them: the same moves, asked with the reason and the session', async () => {
    const v = viewport();
    const g = gate(true);
    h = await sketchHarness({}, { handle: v.handle, later: [{ feature: LATER, state: 'ok' }], apis: { assistant: g.api } });
    await rolledBack(h);
    expect(v.calls).toEqual([
      ['lookAt', { auto: true }],
      ['reframe', { auto: true }],
    ]);
    expect(g.asked).toEqual([
      ['sketch-entry', h.session.id],
      ['sketch-reframe', h.session.id],
    ]);
  });

  it('the Assistant says no: the view stays where it is, on entry and after the rollback', async () => {
    const v = viewport();
    const g = gate(false);
    h = await sketchHarness({}, { handle: v.handle, later: [{ feature: LATER, state: 'ok' }], apis: { assistant: g.api } });
    await rolledBack(h);
    expect(v.calls).toEqual([]);
    expect(g.asked.map((a) => a[0])).toEqual(['sketch-entry', 'sketch-reframe']);
  });
});
