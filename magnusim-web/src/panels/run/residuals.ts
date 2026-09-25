export interface ResidualRow {
  t?: number;
  U?: number;
  p?: number;
  k?: number;
  omega?: number;
  epsilon?: number;
  R?: number;
  co_mean?: number;
}

const KEYS = ['U', 'p', 'k', 'omega', 'epsilon', 'R', 'co_mean'] as const;

export function residualPaths(series: ResidualRow[], width = 280, height = 120): string[] {
  const rows = series.filter((row) => Number.isFinite(Number(row.t)));
  if (!rows.length) return [];
  const times = rows.map((row) => Number(row.t));
  const xmax = Math.max(...times, 1);
  const logs: number[] = [];
  for (const row of rows) {
    for (const key of KEYS) {
      const value = Number(row[key]);
      if (Number.isFinite(value) && value > 0) logs.push(Math.log10(value));
    }
  }
  if (!logs.length) return [];
  let y0 = Math.min(...logs);
  let y1 = Math.max(...logs);
  if (y0 === y1) {
    y0 -= 1;
    y1 += 1;
  }
  const pad = 8;
  const xOf = (t: number) => pad + (t / xmax) * (width - pad * 2);
  const yOf = (value: number) => {
    const lg = Math.log10(Math.max(value, 1e-16));
    return pad + (1 - (lg - y0) / (y1 - y0)) * (height - pad * 2);
  };
  const paths: string[] = [];
  for (const key of KEYS) {
    const pts = rows
      .map((row) => {
        const value = Number(row[key]);
        if (!Number.isFinite(value) || value <= 0) return '';
        return `${xOf(Number(row.t)).toFixed(1)},${yOf(value).toFixed(1)}`;
      })
      .filter(Boolean);
    if (pts.length) paths.push(pts.join(' '));
  }
  return paths;
}

export function sameProjectRuns(
  projectId: string,
  runs: Array<{ id?: string; project_id?: string; case_dir?: string }>,
  runA: string,
  runB: string,
): { ok: true } | { ok: false; error: string } {
  const left = runs.find((run) => String(run.id || '') === runA);
  const right = runs.find((run) => String(run.id || '') === runB);
  if (!projectId || !left || !right || runA === runB) {
    return { ok: false, error: 'Both runs must belong to the open project' };
  }
  for (const run of [left, right]) {
    if (run.project_id && run.project_id !== projectId) {
      return { ok: false, error: 'Run belongs to another project' };
    }
    const dir = String(run.case_dir || '').replace(/\\/g, '/').toLowerCase();
    if (dir && !dir.includes(`/projects/${projectId.toLowerCase()}/`)) {
      return { ok: false, error: 'case_dir is outside this project' };
    }
  }
  return { ok: true };
}
