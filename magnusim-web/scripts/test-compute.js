// @ts-check
/**
 * MAGNUSIM_TEST_COMPUTE=fake (tests only; as MAGNUSIM_TEST_THUMB_FAIL, read on every
 * call): the compute the app starts runs a stand-in, so tests of what the person sees
 * while it runs need no OpenFOAM, no WSL and no minutes.
 *
 * - The hardware check (Settings > This PC): each probe is a Node process that answers
 *   after MAGNUSIM_TEST_HW_PROBE_MS (default 1500), as a slow WSL does, with a plausible PC.
 *
 * Unset, everything runs for real.
 */

/** The switch is on. */
export function fakeCompute() {
  return process.env.MAGNUSIM_TEST_COMPUTE === 'fake';
}

/** @param {string} name @param {number} fallback @param {number} max */
function envMs(name, fallback, max) {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n >= 0 ? Math.min(max, n) : fallback;
}

/**
 * The hardware check's probe stand-in: the same runner (`run`, hardware-profile.js
 * runProbe) on a slow child process of its own, a Node that waits
 * MAGNUSIM_TEST_HW_PROBE_MS and prints what the real probe would (4 cores; OpenFOAM's
 * usage line). So a test of the server answering meanwhile goes through the real spawn.
 * @param {(command: string, args: string[], timeoutMs: number) => Promise<{ status: number | null, stdout: string }>} run
 * @param {string[]} args the real probe's arguments
 * @param {number} timeoutMs
 */
export function fakeHardwareProbe(run, args, timeoutMs) {
  const ms = envMs('MAGNUSIM_TEST_HW_PROBE_MS', 1500, 120_000);
  const out = /simpleFoam/.test(args.join(' ')) ? 'Usage: simpleFoam [OPTIONS]' : '4';
  return run(process.execPath, ['-e', `setTimeout(() => process.stdout.write(${JSON.stringify(out)}), ${ms})`], timeoutMs);
}
