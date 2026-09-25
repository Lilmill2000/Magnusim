export function analysisLabel(row: { key?: string; label?: string }): string {
  return String(row.label || row.key || 'Analysis');
}
