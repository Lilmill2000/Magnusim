import { expect, test } from '@playwright/test';
import { randomBytes } from 'node:crypto';
import { startHost } from './support/host-server.mjs';
import { NO_WSL, wslBash, wslPathExists } from './toolchain.js';

// Every mesh and solve works in its own WSL copy (<case root>/<id>). A run that
// succeeds removes its copy (smoke.spec.js checks that); the server sweeps the rest
// after boot. Left alone they filled ~115 GB of WSL disk in 11 days. A second
// server with its own throwaway case root under /tmp (never the real one) and a
// max age of 0 (ctime cannot be set back) sweeps finished app cases and keeps a
// case a process works in, reserved ids and folders the app did not make.
const WSL = process.env.MAGNUSIM_E2E_WSL === '1';

test('the server sweeps finished WSL cases after boot and keeps busy, reserved and foreign ones', async () => {
  test.skip(!WSL, NO_WSL);
  test.setTimeout(300_000);
  const tag = randomBytes(6).toString('hex');
  const base = `/tmp/magnusim-e2e-prune-${tag}`;
  const root = `${base}/cases`;
  const marker = `magnusim-e2e-prune-${tag}`;
  const finished = ['cfddesk-w27-e2eold', 'cfddesk-cfdweb-e2eold2'];
  const busy = 'cfddesk-w27-e2ebusy';
  const kept = ['cfddesk-manual-e2e', 'zz-exp-e2e'];
  // A process works in the busy case; wait for it in the same shell (WSL ends a
  // session's processes when its shell exits, before a fresh child reaches setsid).
  const seed = wslBash(
    [
      'set -e',
      'root="$1"; marker="$2"; shift 2',
      'for n in "$@"; do mkdir -p "$root/$n/system"; echo x > "$root/$n/system/controlDict"; done',
      'cd "$root/' + busy + '"',
      `(setsid bash -c "exec -a $marker-holder sleep 600" </dev/null >/dev/null 2>&1 &)`,
      `for i in $(seq 50); do pgrep -f "^$marker-holder" >/dev/null && exit 0; sleep 0.1; done; exit 1`,
    ].join('\n'),
    [root, marker, ...finished, busy, ...kept],
  );
  expect(seed.status, `seed WSL cases: ${seed.stdout}${seed.stderr}`).toBe(0);

  let host = null;
  try {
    host = await startHost({
      name: 'prune',
      // This server's cases live in the throwaway root; the sweep runs 1 s after boot.
      env: { MAGNUSIM_WSL_CASE_ROOT: root, MAGNUSIM_WSL_PRUNE: '1', MAGNUSIM_WSL_PRUNE_MAX_AGE_H: '0', MAGNUSIM_WSL_PRUNE_DELAY_MS: '1000' },
    });
    await expect
      .poll(() => finished.filter((n) => wslPathExists(`${root}/${n}`)), { timeout: 120_000, message: `sweep log:\n${host.log().slice(-2000)}` })
      .toEqual([]);
    for (const n of [busy, ...kept]) expect(wslPathExists(`${root}/${n}`), `${n} kept`).toBe(true);
    await expect.poll(() => host.log(), { timeout: 30_000 }).toContain(`[CFD] WSL cases pruned: ${finished.length} removed`);
    expect(host.log()).toContain(`1 in use kept (${root})`);
  } finally {
    host?.stop();
    // Anchored: only the holder's command line starts with the marker.
    wslBash('pkill -f "^$1-holder"; rm -rf -- "$2"', [marker, base]);
  }
});
