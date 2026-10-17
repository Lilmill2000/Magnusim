// The toy kernel (BlockKernel) with hold points, to force the timing of a race
// in document tests: hold(op) keeps the next call of that op waiting until the
// test releases it; holdRespawn() keeps the next respawn 'restarting' (the new
// worker not ready yet) until the test releases it. A call held across a
// respawn is dropped when released ('restarted'), as the worker client drops
// what was queued for a worker that died.
// SPDX-License-Identifier: GPL-3.0-or-later
import type { KernelReadyInfo, KernelReply } from '../../src/types/kernel';
import type { KernelOp } from '../../src/types/kernel-protocol';
import { BlockKernel } from './blocks';

export interface Held {
  /** Resolves once the held call or respawn got to its hold point. */
  readonly reached: Promise<void>;
  /** Let it go on. */
  release(): void;
}

interface Gate {
  handle: Held;
  reach(): void;
  opened: Promise<void>;
}

function gate(): Gate {
  let reach!: () => void;
  let open!: () => void;
  const reached = new Promise<void>((r) => (reach = r));
  const opened = new Promise<void>((r) => (open = r));
  return { handle: { reached, release: () => open() }, reach, opened };
}

export class HeldKernel extends BlockKernel {
  private readonly holds: { op: KernelOp; g: Gate }[] = [];
  private respawnHold: Gate | null = null;
  /** Bumped by every respawn: a call held across one finds its worker gone. */
  private generation = 0;

  /** The next call of `op` waits at its start until released. */
  hold(op: KernelOp): Held {
    const g = gate();
    this.holds.push({ op, g });
    return g.handle;
  }

  /** The next respawn says 'restarting' and stays there until released; then it is FakeKernel's. */
  holdRespawn(): Held {
    const g = gate();
    this.respawnHold = g;
    return g.handle;
  }

  override async call<Op extends KernelOp>(op: Op, params: Record<string, unknown> & object, opts: { timeoutMs?: number } = {}): Promise<KernelReply<Op>> {
    const i = this.holds.findIndex((h) => h.op === op);
    if (i >= 0) {
      const [{ g }] = this.holds.splice(i, 1);
      const generation = this.generation;
      g.reach();
      await g.opened;
      if (generation !== this.generation) throw Object.assign(new Error(`The kernel restarted; ${op} was dropped`), { kind: 'restarted', op });
    }
    return super.call(op, params, opts);
  }

  override async respawn(reason: string): Promise<KernelReadyInfo> {
    this.generation++;
    const g = this.respawnHold;
    this.respawnHold = null;
    if (g) {
      // The old worker is gone at once (its shape ids with it); the new one is not ready yet.
      this.shapes.clear();
      this.status.set({ state: 'restarting', message: reason });
      g.reach();
      await g.opened;
    }
    return super.respawn(reason);
  }
}
