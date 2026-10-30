// The banana for scale's refit is the app's own camera move (D6): once the banana is placed, two
// animation frames later, the view refits when the part reaches off the screen of a view nobody
// has moved since its framing, and that call passes `auto: true`, so userCameraMoves does not
// count it as the person's. (The refit itself, and that a refit with auto is not counted while
// one without is: tests/viewport/camera-count.test.ts.) Taking the banana away refits nothing.
// The banana's mesh file and its drawing are left out here (the fetch and the WebGL layer): only
// the command's wiring runs.
// SPDX-License-Identifier: GPL-3.0-or-later
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createCommandRegistry } from '../../../src/app/commands';
import scale, { BANANA_COMMAND } from '../../../src/features/scale/index';
import { createStateStore } from '../../../src/lib/store';
import type { AppServices } from '../../../src/types/app';
import type { CameraCallOpts } from '../../../src/types/viewport';

vi.mock('../../../src/features/scale/banana-mesh', async (orig) => ({
  ...(await orig<typeof import('../../../src/features/scale/banana-mesh')>()),
  loadBanana: async () => ({ positions: new Float32Array(9), normals: new Float32Array(9), colors: new Float32Array(9), indices: new Uint16Array([0, 1, 2]), min: [-17, -104, 0], max: [17, 104, 82], length: 208 }),
}));
vi.mock('../../../src/features/scale/view', async (orig) => ({
  ...(await orig<typeof import('../../../src/features/scale/view')>()),
  installBananaView: () => () => {},
}));
vi.mock('../../../src/features/scale/sketch-banana', async (orig) => ({
  ...(await orig<typeof import('../../../src/features/scale/sketch-banana')>()),
  installSketchBanana: () => () => {},
}));

afterEach(() => {
  vi.useRealTimers();
});

function app() {
  const refits: (CameraCallOpts | undefined)[] = [];
  const handle = {
    refitIfOffScreen: (o?: CameraCallOpts) => {
      refits.push(o);
      return true;
    },
  };
  const state = createStateStore({ status: 'ready', view: { scaleModels: {} }, rebuild: { bodies: [{ id: 'b_1', visible: true, bbox: [0, 0, 0, 100, 50, 20] }] } } as never);
  const placed: unknown[] = [];
  let services: AppServices;
  const commands = createCommandRegistry(() => services);
  services = {
    commands,
    doc: {
      state,
      setScaleModel: (_k: string, p: unknown) => {
        placed.push(p);
        state.set((s: { view: object }) => ({ ...s, view: { ...s.view, scaleModels: p ? { banana: p } : {} } }) as never);
      },
    },
    viewport: createStateStore({ handle }),
    bridge: { toast: vi.fn(), projectLinks: () => true },
  } as unknown as AppServices;
  const off = scale.install!(services);
  return { services, commands, refits, placed, off };
}

describe('the banana for scale', () => {
  it("placed: the refit two frames later passes auto (not the person's camera move); taken away: no refit", async () => {
    vi.useFakeTimers({ toFake: ['requestAnimationFrame', 'cancelAnimationFrame'] });
    const a = app();
    const run = a.commands.get(BANANA_COMMAND)!;
    await run.run(a.services);
    expect(a.placed).toHaveLength(1);
    expect(a.placed[0]).not.toBeNull();
    // Not yet: the viewport has the banana after the next frames.
    expect(a.refits).toEqual([]);
    vi.advanceTimersToNextFrame();
    expect(a.refits).toEqual([]);
    vi.advanceTimersToNextFrame();
    expect(a.refits).toEqual([{ auto: true }]);

    await run.run(a.services);
    expect(a.placed).toEqual([a.placed[0], null]);
    vi.advanceTimersByTime(200);
    expect(a.refits).toEqual([{ auto: true }]);
    a.off?.();
  });
});
