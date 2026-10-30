// The name nearest to one that matches nothing, for a not_found's "closest" (a feature the model
// named a little wrong: "Join and Inlay" for "Join inlay"). Only a name with the same words:
// case, spaces, punctuation, a plural s, "and", "of" and "the" aside, in any order; or one typo in
// one word (two letters swapped in a word of 6 or more, or a doubled letter in one of 5 or more).
// Never a name with another word ("Gear A" is not "Gear B", "Top plate" not "Top plane",
// "Extrude 3" not "Extrude 3 copy") or other numbers ("Extrude 12" never gives "Extrude 1"). The
// first of equally near names wins (history order).
// Owner: ASSISTANT.
// SPDX-License-Identifier: GPL-3.0-or-later

const FILLER = new Set(['and', 'of', 'the']);

/** A name's words, lower case, a plural s off; letters and digits apart ("Extrude1": extrude, 1). */
const wordsOf = (s: string): string[] =>
  (s.toLowerCase().match(/[a-z]+|\d+/g) ?? []).filter((w) => !FILLER.has(w)).map((w) => (w.length > 3 && w.endsWith('s') && !w.endsWith('ss') ? w.slice(0, -1) : w));
const numbersOf = (ws: string[]) => ws.filter((w) => /^\d/.test(w)).join(' ');
const sorted = (ws: string[]) => [...ws].sort().join(' ');

/** `a` and `b` differ by one typo: two letters side by side swapped (6 letters or more), or a letter doubled (5 or more). */
function typo(a: string, b: string): boolean {
  if (a.length === b.length) {
    if (a.length < 6) return false;
    const at = [...a].findIndex((c, i) => c !== b[i]);
    return at >= 0 && at + 1 < a.length && a[at] === b[at + 1] && a[at + 1] === b[at] && a.slice(at + 2) === b.slice(at + 2);
  }
  const [s, l] = a.length < b.length ? [a, b] : [b, a];
  if (l.length !== s.length + 1 || l.length < 5) return false;
  const at = [...s].findIndex((c, i) => c !== l[i]);
  const i = at < 0 ? s.length : at;
  // The extra letter doubles its neighbour ("Filet", "Fillet").
  return (l[i] === l[i - 1] || l[i] === l[i + 1]) && s.slice(i) === l.slice(i + 1);
}

/** How near `n` is to `w` (both as words): 0 the same words, 1 one typo in one word, null not near. */
function nearness(w: string[], n: string[]): 0 | 1 | null {
  if (sorted(w) === sorted(n) || w.join('') === n.join('')) return 0;
  if (w.length !== n.length) return null;
  const off = w.flatMap((x, i) => (x === n[i] ? [] : [i]));
  return off.length === 1 && typo(w[off[0]], n[off[0]]) ? 1 : null;
}

/** The name of `names` nearest to `want`, or null when none is near (an exact match is the caller's). */
export function closestName(want: string, names: readonly string[]): string | null {
  const w = wordsOf(want);
  if (!w.length) return null;
  const wn = numbersOf(w);
  let best: { name: string; d: number } | null = null;
  for (const name of names) {
    const n = wordsOf(name);
    if (!n.length || numbersOf(n) !== wn) continue;
    const d = nearness(w, n);
    if (d !== null && (!best || d < best.d)) best = { name, d };
  }
  return best?.name ?? null;
}

/** ' Closest: "Join inlay".' for a message, or '' when no name is near. */
export function closestWords(closest: string | null): string {
  return closest ? ` Closest: "${closest}".` : '';
}
