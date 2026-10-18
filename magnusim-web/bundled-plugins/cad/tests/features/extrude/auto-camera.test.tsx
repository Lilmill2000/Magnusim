// A new Extrude seen straight along its direction turns the view to Isometric once (review P2/P3
// round 2): the app's own turn, so it passes `auto: true` (userCameraMoves does not count it),
// and it asks apis.assistant.autoCamera('extrude-iso', the session's id) first (D6). Without the
// Assistant, or when it allows it, the view turns as before; when it says no, the view stays.
// SPDX-License-Identifier: GPL-3.0-or-later
import { act, cleanup, fireEvent } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import type { AssistantPageApi, AutoCameraReason } from '../../../src/types/assistant';
import type { Feature, SavedCamera, SketchFeature } from '../../../src/types/doc';
import type { ViewportHandle } from '../../../src/types/viewport';
import { rectRegion } from '../sketch/fake-profiles-kernel';
import { startApp, type FakeApp } from './fake-app';

let app: FakeApp | null = null;
afterEach(() => {
  cleanup();
  app?.dispose();
  app = null;
});

const KEY = '+e_1[p:origin>p:pt_b] +e_2[p:pt_b>p:pt_c] +e_3[p:pt_c>p:pt_d] +e_4[p:pt_d>p:origin]';
const rect = (): Partial<SketchFeature> => ({
  id: 'f_sk',
  points: { pt_b: [20, 0], pt_c: [20, 10], pt_d: [0, 10] },
  entities: [
    { id: 'e_1', kind: 'line', p: ['origin', 'pt_b'] },
    { id: 'e_2', kind: 'line', p: ['pt_b', 'pt_c'] },
    { id: 'e_3', kind: 'line', p: ['pt_c', 'pt_d'] },
    { id: 'e_4', kind: 'line', p: ['pt_d', 'origin'] },
  ],
  constraints: [],
  solved: { values: {}, dof: 4, state: 'under' },
});

/** Looking straight down at the Top plane (as right after Finish sketch). */
const TOP: SavedCamera = { position: [10, 5, 100], target: [10, 5, 0], up: [0, 1, 0], orthoHeight: 40, projection: 'perspective' };

/** A Part with one closed profile on the Top plane, the camera looking down at it, and Extrude opened on it. */
async function openExtrude(assistant: AssistantPageApi | null) {
  app = await startApp();
  const a = app;
  a.kernel.regionsFor = () => ({ regions: [rectRegion(KEY, ['e_1', 'e_2', 'e_3', 'e_4'], 0, 0, 20, 10)] });
  act(() => a.doc.beginNew('sketch', rect() as Partial<Feature>).commit());
  await a.settle();
  const views: [string, unknown][] = [];
  Object.assign(a.vp.handle as ViewportHandle, {
    camera: () => TOP,
    setView: (v: string, o?: unknown) => void views.push([v, o]),
  });
  if (assistant) a.services.apis.set((s) => ({ ...s, assistant }));
  act(() => void a.vp.offer(a.vp.at('click', [5, 5, 0])));
  act(() => void fireEvent.click(a.$('[data-command="solid.extrude"]')!));
  await a.settle();
  expect(a.$('[data-feature-panel="extrude"]')).not.toBeNull();
  return { a, views, session: a.doc.session()! };
}

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

describe("a new Extrude's turn to Isometric", () => {
  it('without the Assistant: turns once, as the app\'s own move (auto)', async () => {
    const { a, views } = await openExtrude(null);
    expect(views).toEqual([['iso', { auto: true }]]);
    // Once only: later renders of the panel do not turn again.
    act(() => void fireEvent.click(a.$('[data-profile-remove="0"]')!));
    await a.settle();
    expect(views).toHaveLength(1);
  });

  it('the Assistant allows it: the same turn, asked with the reason and the session', async () => {
    const g = gate(true);
    const { views, session } = await openExtrude(g.api);
    expect(views).toEqual([['iso', { auto: true }]]);
    expect(g.asked).toEqual([['extrude-iso', session.id]]);
  });

  it('the Assistant says no: the view stays, and it is not asked again', async () => {
    const g = gate(false);
    const { a, views } = await openExtrude(g.api);
    expect(views).toEqual([]);
    act(() => void fireEvent.click(a.$('[data-profile-remove="0"]')!));
    await a.settle();
    expect(views).toEqual([]);
    expect(g.asked).toHaveLength(1);
  });
});
