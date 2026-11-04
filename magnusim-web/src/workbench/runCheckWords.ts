/**
 * The pre-run check's words (run health RH2, spec 4.4-4.5): the one source the Run panel's
 * "Before you start" block, its Start title, "Checked at start" and the Assistant's answers
 * share, so the person and the Assistant read the same text.
 *
 * No row blocks Start: the words say how many warnings a run starts with, never that it cannot.
 *
 * Pure, with no imports: the server imports this file as it is.
 */

export type CheckLevel = 'error' | 'warn' | 'info';
export type CheckTarget = 'run' | 'study' | 'mesh' | 'bcs' | 'steady_copy';

export interface CheckFix {
  label: string;
  target: CheckTarget;
  values: Array<{ key: string; value: unknown }>;
  cost?: { steps: number | null; wall_s: number | null } | null;
}

export interface CheckRow {
  code: string;
  level: CheckLevel;
  text: string;
  short?: string;
  fix?: CheckFix | null;
  alt?: CheckFix | null;
  kept?: boolean;
}

export interface CheckEstimate {
  line?: string;
  delta_t_s?: number | null;
  steps?: number | null;
  wall_s?: number | null;
  flow_through_s?: number | null;
  velocity_cap?: number | null;
  ranks?: number | null;
  [k: string]: unknown;
}

export interface Precheck {
  ok?: boolean;
  checked?: boolean;
  checks: CheckRow[];
  estimate?: CheckEstimate | null;
  [k: string]: unknown;
}

/** The most rows the block shows at once (problems, then warnings, then notes). */
export const SHOWN_ROWS = 6;

const LEVEL_RANK: Record<string, number> = { error: 0, warn: 1, info: 2 };
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/** The rows in the block's order: problems, warnings, notes (the check's own order within each). */
export function orderedRows(rows: CheckRow[] | null | undefined): CheckRow[] {
  return (rows || [])
    .map((r, i) => ({ r, i }))
    .sort((a, b) => (LEVEL_RANK[a.r.level] ?? 3) - (LEVEL_RANK[b.r.level] ?? 3) || a.i - b.i)
    .map((x) => x.r);
}

/** The rows not kept as set, and the kept ones. */
export function splitKept(rows: CheckRow[] | null | undefined, kept: string[] | null | undefined): { open: CheckRow[]; kept: CheckRow[] } {
  const set = new Set(kept || []);
  const all = orderedRows(rows);
  return { open: all.filter((r) => !r.kept && !set.has(r.code)), kept: all.filter((r) => r.kept || set.has(r.code)) };
}

/** "about 6 days", "about 15 minutes" (magnusim_sdk.runcheck.wall_words). */
export function wallWords(s: number): string {
  if (!(s >= 0)) return 'unknown';
  if (s < 60) return 'under a minute';
  if (s < 3600) {
    const m = Math.max(1, Math.round(s / 60));
    return `about ${m} minute${m === 1 ? '' : 's'}`;
  }
  const h = s / 3600;
  if (h < 48) {
    const n = Math.max(1, Math.round(h));
    return `about ${n} hour${n === 1 ? '' : 's'}`;
  }
  return `about ${Math.round(h / 24)} days`;
}

/** The Apply button's words: "Use 3 outer correctors, Max Courant 5", "Open mesh", "Make a steady copy". */
export function applyLabel(fix: CheckFix): string {
  return fix.target === 'run' || fix.target === 'study' ? `Use ${fix.label}` : fix.label;
}

/** An alternative as its link reads: "Max Courant 1 (about 6 days)". */
export function altLabel(fix: CheckFix): string {
  const wall = fix.cost && isNum(fix.cost.wall_s) ? ` (${wallWords(fix.cost.wall_s)})` : '';
  return `${fix.label}${wall}`;
}

/** The rows a run starts with that count: problems and warnings not kept as set. */
function counted(rows: CheckRow[] | null | undefined, opts: { kept?: boolean } = {}): { errors: CheckRow[]; warns: CheckRow[] } {
  const list = (rows || []).filter((r) => opts.kept || !r.kept);
  return { errors: list.filter((r) => r.level === 'error'), warns: list.filter((r) => r.level === 'warn') };
}

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** "1 problem and 2 warnings", "1 warning", "" when none. */
export function countWords(rows: CheckRow[] | null | undefined, opts: { kept?: boolean } = {}): string {
  const { errors, warns } = counted(rows, opts);
  const bits: string[] = [];
  if (errors.length) bits.push(plural(errors.length, 'problem', 'problems'));
  if (warns.length) bits.push(plural(warns.length, 'warning', 'warnings'));
  return bits.join(' and ');
}

/** Start's title while rows are open: "Starts with 1 warning (see Before you start)"; null with none. */
export function startTitle(rows: CheckRow[] | null | undefined): string | null {
  const n = countWords(rows);
  return n ? `Starts with ${n} (see Before you start)` : null;
}

/** The short names of the rows that count, kept ones marked: "Max Courant 100 with PISO, kept as set". */
function names(rows: CheckRow[]): string {
  return rows.map((r) => `${r.short || r.code}${r.kept ? ', kept as set' : ''}`).join('; ');
}

/**
 * What the run started with (its prepare_run.checks, RunStatus): "Checked at start: 1 warning
 * (Max Courant 100 with PISO)"; "Checked at start: no warnings" when none counted. Rows kept as
 * set still count (the run started with them) and say so. Null when it was not checked.
 */
export function checkedAtStartLine(checks: CheckRow[] | null | undefined): string | null {
  if (!Array.isArray(checks)) return null;
  const { errors, warns } = counted(checks, { kept: true });
  const all = [...errors, ...warns];
  if (!all.length) return 'Checked at start: no warnings';
  return `Checked at start: ${countWords(checks, { kept: true })} (${names(all)})`;
}

/** compute run_start's words: "Started with 1 warning: Max Courant 100 with PISO." ("" with none). */
export function startedWithWords(checks: CheckRow[] | null | undefined): string {
  if (!Array.isArray(checks)) return '';
  const { errors, warns } = counted(checks, { kept: true });
  const all = [...errors, ...warns];
  if (!all.length) return '';
  return `Started with ${countWords(checks, { kept: true })}: ${names(all)}.`;
}

/** The values of a fix as one comparable text. */
function valuesKey(values: Array<{ key: string; value: unknown }>): string {
  return JSON.stringify(
    [...(values || [])]
      .map((v) => [String(v.key), v.value])
      .sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
  );
}

/**
 * The precheck's cost of a fix with these values (spec 3.10: the Health block's fix label uses the
 * precheck estimate when present): the cost of a row's fix or alternative with the same values,
 * from the run's checks at start, else null.
 */
export function precheckCost(checks: CheckRow[] | null | undefined, values: Array<{ key: string; value: unknown }>): { steps: number; wall_s: number } | null {
  const want = valuesKey(values);
  for (const row of checks || []) {
    for (const f of [row.fix, row.alt]) {
      if (f && f.cost && isNum(f.cost.steps) && isNum(f.cost.wall_s) && valuesKey(f.values) === want) {
        return { steps: f.cost.steps, wall_s: f.cost.wall_s };
      }
    }
  }
  return null;
}

/**
 * A health record whose new-run fixes carry the precheck's cost of the same values when the run's
 * checks at start have one (spec 3.10: "once RH2 lands, the precheck estimate is used when
 * present"); the record as it is otherwise.
 */
export function withPrecheckCosts<T extends { findings?: Array<{ fix?: Array<{ values: Array<{ key: string; value: unknown }>; cost?: unknown }> }> }>(
  h: T,
  checks: CheckRow[] | null | undefined,
): T {
  if (!h || !Array.isArray(checks) || !checks.length || !Array.isArray(h.findings)) return h;
  return {
    ...h,
    findings: h.findings.map((f) => ({
      ...f,
      fix: Array.isArray(f.fix)
        ? f.fix.map((x) => {
            const c = precheckCost(checks, x.values || []);
            return c ? { ...x, cost: c } : x;
          })
        : f.fix,
    })),
  };
}
