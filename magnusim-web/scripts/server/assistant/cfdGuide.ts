/**
 * The CFD guide (RH1, spec 3.15): how the Assistant judges and fixes CFD runs, sent with the
 * system prompt in Magnusim only (never in the Magnusim CAD edition, whose words name no
 * simulation): the request's system blocks (loop.ts buildRequest), the MCP instructions
 * (mcp/server.ts) and an agent's note (agents/acp.ts, agents/turn.ts). Server-only static
 * product text, at most 2,500 characters.
 *
 * Rule 2's advice is the one advice text (magnusim_sdk.numerics_advice, written by
 * `npm run gen:registry` into scripts/generated/numerics-advice.json); Max Courant is warned
 * about, never capped (A1). Later lanes add the pre-run check (RH2) and the numerics (RH3) rules.
 * The guide is read when first asked for, so the CAD edition never reads it.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { isCadEdition } from '../../edition.js';

export const CFD_GUIDE_MAX = 2500;

export type AdviceTable = Record<string, { rule: string; more: string }>;

let advice: AdviceTable | null = null;
let guide: string | null = null;

/** The advice table as gen:registry wrote it. */
export function adviceTable(): AdviceTable {
  if (!advice) {
    const path = fileURLToPath(new URL('../../generated/numerics-advice.json', import.meta.url));
    advice = JSON.parse(readFileSync(path, 'utf8')) as AdviceTable;
  }
  return advice;
}

/** The guide's text. */
export function cfdGuideText(): string {
  if (guide === null) {
    const a = adviceTable();
    guide = [
      'Judging and fixing CFD runs',
      '1. Is a run healthy: read_results status, then health; log_tail with filter_key "issues" only for evidence. Give numbers with units and when they began. Repeat health\'s verdict word (Healthy, Watch closely, Unhealthy, Failed); never soften it. Healthy means no stability problem was found: never present it as accurate or converged.',
      `2. Courant: ${a.max_co.rule} If max Courant is far above the mean, a few small cells set the time step: a mesh matter.`,
      '3. Velocity clipped (limitVelocity) is a safety cap at 10x the reference speed. Clipping after the first steps means the run is unstable and its results there are not physical. Fix the cause; never raise or remove the cap to hide it.',
      '4. k, omega or epsilon bounded: a few early steps are normal; most steps means the run is unstable.',
      '5. Linear solvers at their iteration limit on most steps: the time step is too large or the mesh is poor. Raising the limit hides it.',
      '6. Steady runs: residuals should fall 3 or more decades. If they stall while monitors oscillate, the flow is unsteady: propose a transient run.',
      '7. After a blow-up (health restart "from_zero"): do not Continue. Make a new run in one call (setup_edit kind run, action add, other_id the old run, values the fix), start it, read health again after 50-100 steps. Keep the old run. "continue_after_fix" never means Continue will be fine; follow health\'s next.',
      '8. A stopped transient run (its study still Transient): its Max Courant, outer and pressure correctors and max time step can apply when it continues (setup_edit type "at_continue", results kept) or start it over (type "start_over", results deleted). Ask the person which; later changes of the four join the pending one.',
      '9. Mesh: non-orthogonality above 70 degrees needs 1-2 non-orthogonal correctors; skewness above 4 is a risk. y+ (field_range of yPlus): about 1 resolves the wall, 30-300 suits wall functions; k-omega SST handles both.',
      '10. Stop a run once; force_stop only when the person agrees.',
      '11. Change settings when the person asked for a fix; otherwise say what you would change and what it costs.',
    ].join('\n');
  }
  return guide;
}

/** The guide when this server is Magnusim (null in Magnusim CAD: its words name no simulation). */
export function cfdGuide(cad: boolean = isCadEdition()): string | null {
  return cad ? null : cfdGuideText();
}

/** `text`, then the guide when this server is Magnusim (the MCP instructions, an agent's note). */
export function withCfdGuide(text: string, cad: boolean = isCadEdition()): string {
  const g = cfdGuide(cad);
  return g ? `${text}\n\n${g}` : text;
}
