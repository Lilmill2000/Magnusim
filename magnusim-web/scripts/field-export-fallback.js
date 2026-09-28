/**
 * A dead worker must not start a second OpenFOAMReader process.
 * That spawn used to freeze project open while a live solve was writing frames.
 */
export function fieldExportMaySpawnFallback(err) {
  if (err && err.name === 'WorkerUnavailableError') return false;
  const msg = String((err && err.message) || err || '');
  if (!msg) return true;
  return !/unavailable|worker stopped|worker exited|worker input closed|worker restarted|worker RPC timeout/i.test(
    msg
  );
}
