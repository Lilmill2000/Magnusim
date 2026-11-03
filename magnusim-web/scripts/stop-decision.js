// @ts-check
/**
 * What a Stop of a solving run does (run health spec RH1 §3.4), the one rule the run's Stop
 * route (w27-solve.js), its legacy path and the fake solve (test-solve.js) share: `force` ends
 * it at once; a plain Stop is graceful (the current step is written first), and a repeated
 * plain Stop stays graceful: it answers that the run is already stopping, never a forced stop.
 * Pure, with no imports.
 * @param {{ stop?: unknown, stop_requested?: unknown } | null | undefined} rec the runner record (`stop`) or the run doc (`stop_requested`)
 * @param {unknown} force
 * @returns {{ forced: boolean, already: boolean, note: 'Force-stopping.' | 'Stopping.' }}
 */
export function stopDecision(rec, force) {
  const forced = force === true;
  const already = !!(rec && (rec.stop || rec.stop_requested === true));
  return { forced, already, note: forced ? 'Force-stopping.' : 'Stopping.' };
}
