// The name nearest to one that matches nothing, for a not_found's "closest" (a feature the model
// named a little wrong: "Join and Inlay" for "Join inlay"). Case, spaces and punctuation aside,
// the fewest letters added, removed or changed, at most 40% of the longer name (2 for short
// ones); the numbers in the two must be the same ("Extrude 12" never gives "Extrude 1"). The
// first of equally near names wins (history order).
// Owner: ASSISTANT.
// SPDX-License-Identifier: GPL-3.0-or-later

const words = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
const numbers = (s: string) => (s.match(/\d+/g) ?? []).join(' ');

/** Letters added, removed or changed to make `a` into `b` (Levenshtein). */
function distance(a: string, b: string): number {
  if (a === b) return 0;
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    for (let j = 1; j <= b.length; j++) row[j] = Math.min(prev[j] + 1, row[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = row;
  }
  return prev[b.length];
}

/** The name of `names` nearest to `want`, or null when none is near (an exact match is the caller's). */
export function closestName(want: string, names: readonly string[]): string | null {
  const w = words(want);
  if (!w) return null;
  const wn = numbers(w);
  let best: { name: string; d: number } | null = null;
  for (const name of names) {
    const n = words(name);
    if (!n || numbers(n) !== wn) continue;
    const d = Math.min(distance(w, n), distance(w.replace(/ /g, ''), n.replace(/ /g, '')));
    if (d > Math.max(2, Math.floor(0.4 * Math.max(w.length, n.length)))) continue;
    if (!best || d < best.d) best = { name, d };
  }
  return best?.name ?? null;
}

/** ' Closest: "Join inlay".' for a message, or '' when no name is near. */
export function closestWords(closest: string | null): string {
  return closest ? ` Closest: "${closest}".` : '';
}
