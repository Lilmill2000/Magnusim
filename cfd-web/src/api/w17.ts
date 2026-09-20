const INCOMPRESSIBLE_KEYS = new Set([
  'incompressible',
  'incompressible_steady',
  'incompressible_transient',
  'Incompressible',
]);

/** Same gate as scripts/w17-simulation.js acceptsW17Analysis. */
export function acceptsW17Analysis(value: string | undefined | null): boolean {
  const s = String(value || '').trim();
  if (!s) return true;
  if (INCOMPRESSIBLE_KEYS.has(s)) return true;
  if (s.startsWith('incompressible_')) return true;
  return false;
}

export function analysisLabel(row: { key?: string; label?: string }): string {
  return String(row.label || row.key || 'Analysis');
}
