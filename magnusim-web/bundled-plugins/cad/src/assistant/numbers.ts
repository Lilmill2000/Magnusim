// Numbers as the Assistant's replies give them (CAD tools spec §3.1): lengths to 1e-4 mm, areas
// and volumes to 6 significant figures, -0 as 0, and JSON's sizes for the reply budgets.
// Owner: ASSISTANT.
// SPDX-License-Identifier: GPL-3.0-or-later

const clean = (v: number) => (Object.is(v, -0) ? 0 : v);

/** A length (or a coordinate, an angle) to 1e-4. */
export function len(v: number): number {
  return clean(Math.round(v * 1e4) / 1e4);
}

/** An area or a volume to 6 significant figures. */
export function sig6(v: number): number {
  if (!Number.isFinite(v) || v === 0) return clean(v || 0);
  return clean(Number(v.toPrecision(6)));
}

/** A point or a direction, each coordinate to 1e-4. */
export function vec<T extends readonly number[]>(v: T): number[] {
  return v.map(len);
}

/** A direction rounded to 1e-6 (unit vectors read as 0, 1, -1 where they are). */
export function dir(v: readonly number[]): number[] {
  return v.map((x) => clean(Math.round(x * 1e6) / 1e6));
}

/** The UTF-8 bytes of `v` as JSON (what the reply budgets count). */
export function jsonBytes(v: unknown): number {
  return new TextEncoder().encode(JSON.stringify(v) ?? '').length;
}

/** `text` cut to `max` characters on one line (results' text is one line). */
export function oneLine(text: string, max: number): string {
  const t = text.replace(/\s+/g, ' ').trim();
  return t.length <= max ? t : `${t.slice(0, max - 1)}…`;
}
