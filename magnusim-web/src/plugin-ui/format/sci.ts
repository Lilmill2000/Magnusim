const SMALL = 1e-3;
const LARGE = 1e6;

/** Tiny and huge magnitudes read as zero in a plain input, so show them as 1.5290e-5. */
export function formatSci(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return '';
  if (value === 0) return '0';
  const magnitude = Math.abs(value);
  if (magnitude < SMALL || magnitude >= LARGE) return value.toExponential(4);
  // Converted units (62.31559031… lb/ft³) read as 62.3156; typed values keep their digits.
  return String(Number(value.toPrecision(6)));
}

export function parseSci(text: string): number | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  const n = Number(trimmed);
  return Number.isFinite(n) ? n : null;
}
