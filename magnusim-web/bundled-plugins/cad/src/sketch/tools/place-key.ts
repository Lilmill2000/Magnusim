// The key that places what a sketch tool is drawing (Place or finish: Enter by default, the
// person's keybind), as a tool's hint words it: "Enter or " before the tool's own button, or ""
// when the person cleared it.
// Owner: P4b SKETCH.
// SPDX-License-Identifier: GPL-3.0-or-later
import { keyLabel } from '../../app/keybinds';
import type { SketchMode } from '../mode';

export function placeKey(mode: Pick<SketchMode, 'services'>): string {
  const k = keyLabel(mode.services, 'sketch.enter');
  return k ? `${k} or ` : '';
}
