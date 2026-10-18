// The camera latch (CAD tools spec §8.5): the Assistant's own sketches and extrudes turn the view
// the way the person's do (Normal to on sketch entry, the reframe of a reopened sketch, a new
// Extrude's Isometric), but only while the person lets them. Each key (turn:<id>, ext:<n>,
// mcp:<session>) takes a baseline of the person's camera moves (ViewportHandle.userCameraMoves:
// every camera call without `auto`, every drag and wheel step) when its turn starts running (the
// host's turn events), else at its first call. Once the count moved, automatic moves are off for
// the rest of that key: the person looked somewhere and the view stays there. They are also off
// at the fast pace, while the window is hidden or covered, and while a pointer is held in the
// frame. After an edit call the view frames again when bodies left it (refitIfOffScreen with
// auto, which respects a view the person framed), under the same rule. The Assistant never calls
// setCamera, fit or setView itself, and its pictures (view) never move the camera.
// Owner: ASSISTANT.
// SPDX-License-Identifier: GPL-3.0-or-later
import type { AppServices } from '../types/app';
import type { SoftInput } from './busy';
import type { PaceControl } from './pace';

export interface CameraLatch {
  /** The host says the key's turn runs: its baseline is the person's camera moves now (once per key). */
  turnRuns(key: string): void;
  /** A call of `key` starts: its baseline when it has none yet (an outside client, a host without turn events). */
  callStarts(key: string): void;
  /** The person moved the camera since the key's baseline; it stays so for the rest of the key. */
  latched(key: string): boolean;
  /**
   * Whether an automatic camera move may run now for a session of the Assistant's under `key`:
   * watch pace, the window shown, the key not latched, no pointer held in the frame.
   */
  allows(key: string | null): boolean;
  /** After an edit call of `key`: frame again when bodies left the view (auto), when allowed. */
  afterCall(key: string): void;
}

/** Keys kept (the newest). */
const KEYS_KEPT = 32;

interface Entry {
  base: number | null;
  latched: boolean;
}

export function createCameraLatch(o: { viewport: AppServices['viewport']; pace: Pick<PaceControl, 'get' | 'hidden'>; soft: Pick<SoftInput, 'held'> }): CameraLatch {
  const keys = new Map<string, Entry>();
  const moves = (): number | null => {
    const h = o.viewport.get().handle;
    const n = h?.userCameraMoves?.();
    return typeof n === 'number' && Number.isFinite(n) ? n : null;
  };
  const take = (key: string) => {
    if (keys.has(key)) return;
    keys.set(key, { base: moves(), latched: false });
    if (keys.size > KEYS_KEPT) keys.delete(keys.keys().next().value as string);
  };
  const latched = (key: string) => {
    const e = keys.get(key);
    if (!e) return false;
    if (e.latched) return true;
    const m = moves();
    if (m === null) return false;
    // A viewport that came after the baseline: its count is the baseline.
    if (e.base === null) e.base = m;
    else if (m !== e.base) e.latched = true;
    return e.latched;
  };
  const allows = (key: string | null) => o.pace.get() === 'watch' && !o.pace.hidden() && !(key !== null && latched(key)) && !o.soft.held();
  return {
    turnRuns: take,
    callStarts: take,
    latched,
    allows,
    afterCall(key) {
      if (!allows(key)) return;
      try {
        o.viewport.get().handle?.refitIfOffScreen?.({ auto: true });
      } catch {
        // A view that cannot frame now changes nothing of the call.
      }
    },
  };
}
