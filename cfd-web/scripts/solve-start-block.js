/**
 * Whether Start should refuse, force-kill a draining stop, or proceed.
 * Used so a dead Node handle cannot spawn a second WSL solve.
 */
export function solveStartBlockReason(draft, { windowsLive = false, wslLive = false } = {}) {
  if (!draft) return null;
  const st = String(draft.status || '');
  if (st === 'done') return 'finished';
  if (st !== 'running' && st !== 'starting') return null;
  const alive = !!(windowsLive || wslLive);
  if (!alive) return null;
  if (draft.stop_requested === true) return 'draining';
  return 'already_running';
}
