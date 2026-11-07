// A real kernel whose commons with volume come back as OCCT 7.9.3 gave GitHub issue 15's: empty,
// answered as if apart although the inputs overlap (kernel API 10, as_if_apart 'wrong', warnings and
// words). For the readers of a common (the flip hint, the Assistant's miss diagnosis, the rotation
// check's confirmation), whose own shapes OCCT gets right: only the answer is OCCT's failure.
// SPDX-License-Identifier: GPL-3.0-or-later
import type { KernelAdapter } from '../../src/types/kernel';

export interface AsIfApartKernel {
  kernel: KernelAdapter;
  /** From now on (true) or no longer (false), commons with volume answer as if apart. */
  set(on: boolean): void;
}

export function commonsAsIfApart(real: KernelAdapter): AsIfApartKernel {
  let on = false;
  const call = async (op: string, params: Record<string, unknown>, opts?: object) => {
    const r = await (real.call as (o: string, q: unknown, s?: object) => Promise<{ result: Record<string, unknown> }>)(op, params, opts);
    if (!on || op !== 'boolean' || params.op !== 'common' || r.result.empty) return r;
    return { ...r, result: { ...r.result, empty: true, as_if_apart: 'wrong', warnings: true, warning_text: 'the common is empty although the tool overlaps the target (a point of the tool at (0, 0, 0) mm lies inside the target): OCCT took them for apart' } };
  };
  const kernel = new Proxy(real, {
    get(t, p) {
      if (p === 'call') return call;
      const v = Reflect.get(t, p);
      return typeof v === 'function' ? v.bind(t) : v;
    },
  });
  return { kernel, set: (v) => void (on = v) };
}

/**
 * A real kernel whose cuts with more than one tool come back flagged as OCCT's issue-15 failure for
 * one tool of several (kernel API 10, as_if_apart 'wrong'): the real cut stands, so the volume
 * went down, but the answer says a tool that overlaps the target was left out as if apart.
 * For the readers of a many-tool cut (a modelled thread's grooves) that must not take a smaller
 * volume for a whole cut.
 */
export function multiToolCutsAsIfApart(real: KernelAdapter): AsIfApartKernel {
  let on = false;
  const call = async (op: string, params: Record<string, unknown>, opts?: object) => {
    const r = await (real.call as (o: string, q: unknown, s?: object) => Promise<{ result: Record<string, unknown> }>)(op, params, opts);
    if (!on || op !== 'boolean' || params.op !== 'cut' || !Array.isArray(params.tools) || params.tools.length < 2) return r;
    return { ...r, result: { ...r.result, as_if_apart: 'wrong', warnings: true, warning_text: 'one tool of several removed nothing although it overlaps the target (a point of the target at (0, 0, 0) mm lies inside the tool): OCCT took them for apart' } };
  };
  const kernel = new Proxy(real, {
    get(t, p) {
      if (p === 'call') return call;
      const v = Reflect.get(t, p);
      return typeof v === 'function' ? v.bind(t) : v;
    },
  });
  return { kernel, set: (v) => void (on = v) };
}
