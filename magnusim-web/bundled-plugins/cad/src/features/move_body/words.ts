// Move/copy body in words, for the history's readers (the Assistant's get_model and the person's
// changes it is told, src/assistant/model.ts and rev.ts): "moved Body 1 by (20, 0, 0) mm",
// "copied Body 1, turned 90 deg about Z through its centre, then moved by (0, 0, 5) mm". The
// expressions as stored ("L / 2" stays "L / 2"); the same unit on all three is said once.
// Owner: P2-FEATURES.
// SPDX-License-Identifier: GPL-3.0-or-later
import type { AxisRef } from '../../types/references';
import type { BodyId, MoveBodyFeature } from '../../types/doc';

const PLAIN = /^\s*([-+]?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?)\s*([a-zµ°]*)\s*$/i;

/** A stored expression that is plainly zero ("0", "0 mm", "-0.0 deg"). */
export function isZeroExpr(e: string | number | null | undefined): boolean {
  const m = PLAIN.exec(String(e ?? ''));
  return !!m && Number(m[1]) === 0;
}

/** "(20, 0, 0) mm" when all three are plain numbers in one unit (or bare), else each as stored. */
export function vecWords(v: readonly (string | number)[]): string {
  const parts = v.map((e) => PLAIN.exec(String(e)));
  if (parts.every((m) => !!m)) {
    const nonZero = parts.filter((m) => Number(m![1]) !== 0);
    const units = new Set(nonZero.map((m) => m![2].toLowerCase()));
    if (units.size <= 1) {
      const unit = [...units][0] ?? '';
      return `(${parts.map((m) => (Number(m![1]) === 0 ? '0' : m![1])).join(', ')})${unit ? ` ${unit}` : ''}`;
    }
  }
  return `(${v.map((e) => String(e).trim()).join(', ')})`;
}

const andList = (xs: readonly string[]) => (xs.length <= 1 ? (xs[0] ?? 'no body') : `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`);

/**
 * What the feature does, in words. `bodyName`: a body's name by id; `axisWords`: a picked axis in
 * the reader's words (a selector for the Assistant).
 */
export function moveWords(f: MoveBodyFeature, bodyName: (id: BodyId) => string, axisWords: (a: AxisRef) => string): string {
  const ids = [...new Set(f.bodies ?? [])];
  const verb = f.copy ? 'copied' : 'moved';
  const names = andList(ids.map(bodyName));
  const turning = !isZeroExpr(f.angle);
  const moving = !(f.move ?? []).every((e) => isZeroExpr(e));
  let about = '';
  if (turning) {
    if (f.about === 'axis') about = f.axis ? axisWords(f.axis) : 'an axis not picked yet';
    else about = `${f.about.toUpperCase()} through ${f.pivot ? vecWords(f.pivot) : ids.length > 1 ? 'their centre' : 'its centre'}`;
  }
  const turn = turning ? `, turned ${String(f.angle).trim()} about ${about}` : '';
  const move = moving ? `${turning ? ', then moved' : ''} by ${vecWords(f.move)}` : '';
  return `${verb} ${names}${turn}${move}${!turning && !moving ? ' in place' : ''}`;
}
