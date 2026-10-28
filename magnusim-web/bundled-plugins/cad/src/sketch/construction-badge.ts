// The construction drawing badge at the top of the sketch view (ux010 DRAW; Daniel's first test of
// the CAD desktop app: "Construction (X)" read as a close button, and clicking it did nothing).
// While construction drawing is on it says "Construction · X" (the shortcut, a hint) and has a
// real × button, "Turn off construction", that turns construction drawing off (as X does with
// nothing selected). Hidden while construction drawing is off. The key it names is the person's
// Construction keybind (keyOf; X by default), read again on every sync, so a change shows at once;
// with no key the badge says "Construction" and only the x turns it off.
// Owner: DRAW (ux010).
// SPDX-License-Identifier: GPL-3.0-or-later
import type { SketchMode } from './mode';

export const CONSTRUCTION_BADGE_TEXT = 'Construction · X';
export const TURN_OFF_CONSTRUCTION = 'Turn off construction';

export interface ConstructionBadge {
  readonly el: HTMLElement;
  sync(): void;
  dispose(): void;
}

export function createConstructionBadge(
  mode: Pick<SketchMode, 'drawConstruction' | 'setDrawConstruction' | 'state'>,
  keyOf: () => string | null | undefined = () => 'X',
): ConstructionBadge {
  const el = document.createElement('div');
  el.className = 'cad-sk-construction-badge';
  el.setAttribute('data-sketch-construction-badge', '1');
  el.setAttribute('role', 'group');
  el.setAttribute('aria-label', 'Construction drawing is on');
  const text = document.createElement('span');
  text.className = 'cad-sk-construction-text';
  text.setAttribute('data-sketch-construction-text', '1');
  // "Construction · X": the shortcut as a key cap, so it never reads as the close button.
  const key = document.createElement('kbd');
  key.className = 'cad-sk-construction-key';
  const lead = document.createTextNode('');
  text.append(lead, key);
  const off = document.createElement('button');
  off.type = 'button';
  off.className = 'cad-sk-construction-off';
  off.setAttribute('data-sketch-construction-off', '1');
  off.setAttribute('aria-label', TURN_OFF_CONSTRUCTION);
  off.textContent = '×';
  // The press is the badge's own: never a click in the sketch under it.
  off.addEventListener('pointerdown', (e) => e.stopPropagation());
  off.addEventListener('click', (e) => {
    e.stopPropagation();
    mode.setDrawConstruction(false);
  });
  el.append(text, off);
  const sync = () => {
    el.hidden = !mode.drawConstruction;
    const k = keyOf() || null;
    // "Construction · X": the shortcut as a key cap, so it never reads as the close button.
    lead.textContent = k ? `${CONSTRUCTION_BADGE_TEXT.slice(0, -1)}` : 'Construction';
    key.textContent = k ?? '';
    key.hidden = !k;
    el.title = `Construction drawing is on: what you draw now is construction geometry (dashed, never part of a profile). ${k ? `${k} or × turns it off.` : '× turns it off.'}`;
    off.title = k ? `${TURN_OFF_CONSTRUCTION} (${k})` : TURN_OFF_CONSTRUCTION;
  };
  const unsub = mode.state.subscribe(sync);
  sync();
  return {
    el,
    sync,
    dispose() {
      unsub();
      el.remove();
    },
  };
}
