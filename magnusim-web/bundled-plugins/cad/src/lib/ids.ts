// Opaque ids with a type prefix: f_ feature, b_ body, p_ param, s_ session. Frozen (scaffold).
// SPDX-License-Identifier: GPL-3.0-or-later

export type IdPrefix = 'f' | 'b' | 'p' | 's' | 'e' | 'c' | 'pt' | 'imp';

/** A new id, e.g. "f_k3j9x2m1q0". 60 bits of randomness; crypto when available. */
export function newId(prefix: IdPrefix): string {
  const bytes = new Uint8Array(8);
  if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') crypto.getRandomValues(bytes);
  else for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
  let n = 0n;
  for (const b of bytes) n = (n << 8n) | BigInt(b);
  return `${prefix}_${(n & ((1n << 60n) - 1n)).toString(36).padStart(12, '0')}`;
}

/** The next free "<Label> <n>" name ("Box 1", "Box 2") among existing names. */
export function nextName(label: string, existing: Iterable<string>): string {
  const re = new RegExp(`^${label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} (\\d+)$`);
  let max = 0;
  for (const name of existing) {
    const m = re.exec(name);
    if (m) max = Math.max(max, Number(m[1]));
  }
  return `${label} ${max + 1}`;
}
