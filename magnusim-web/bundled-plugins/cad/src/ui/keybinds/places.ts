// Where the person sets each command's keybind themselves (Set keybind…), in words the Assistant
// can pass on (keybind_get's set_in, the not_asked hint) and that tests/ui/keybind-places.test.ts
// holds to the app: every command of the registry has one (Daniel: anything the AI can change, the
// person can too).
//  - toolbar: a right-click on the command on the toolbar (bar, More, flyout, VIEW, EDIT, Finish
//    sketch: Toolbar.tsx customizer);
//  - views-menu: a right-click on its row in the views menu (ViewportChrome);
//  - tree: Delete and Rename in the right-click menu of the Part's row (always there, an empty Part
//    too: DesignTree), and of a feature's row (Rename also a body's: controller featureMenu, bodyMenu);
//  - rail: a right-click on the arrow that collapses the design tree or the Sketch panel;
//  - sketch-menu: Delete and Copy in the right-click menu of the selected sketch geometry, Paste in
//    every right-click menu of the sketch (overlay);
//  - sketch-finish: Place or finish in Finish sketch's right-click menu and the sketch's.
// Owner: INTEGRATE.
// SPDX-License-Identifier: GPL-3.0-or-later
import { KEYMAP, keymapEntry } from '../../app/keymap';
import { VIEW_TOOLBAR } from '../Toolbar';

export type KeybindPlace = 'toolbar' | 'views-menu' | 'tree' | 'rail' | 'sketch-menu' | 'sketch-finish';

/** The commands set somewhere other than their own right-click on the toolbar. */
const EXPLICIT: Readonly<Record<string, { place: KeybindPlace; words: string }>> = Object.freeze({
  'ui.delete': { place: 'tree', words: "right-click the Part's row at the top of the design tree (or a feature's or a body's row), then Set keybind for Delete…" },
  'ui.rename': { place: 'tree', words: "right-click the Part's row at the top of the design tree (or a feature's or a body's row), then Set keybind for Rename…" },
  'ui.toggle-rail': { place: 'rail', words: 'right-click the arrow that collapses the design tree or the Sketch panel, then Set keybind…' },
  'sketch.delete': { place: 'sketch-menu', words: 'in a sketch, right-click the selected geometry, then Set keybind for Delete…' },
  'sketch.copy': { place: 'sketch-menu', words: 'in a sketch, right-click the selected geometry, then Set keybind for Copy…' },
  'sketch.paste': { place: 'sketch-menu', words: 'in a sketch, right-click the selected geometry or an empty place of the sketch, then Set keybind for Paste…' },
  'sketch.enter': { place: 'sketch-finish', words: 'in a sketch, right-click Finish sketch on the toolbar (or an empty place of the sketch), then Set keybind for Place or finish…' },
});

/** The views menu's rows (ViewportChrome): the standard views and Normal to. */
const VIEWS_MENU = new Set(['view.front', 'view.back', 'view.left', 'view.right', 'view.top', 'view.bottom', 'view.iso', 'view.iso_back', 'view.normal-to']);

/** Where the person sets a command's keybind, and how to say it; null for an id the registry does not have. */
export function keybindPlace(id: string): { place: KeybindPlace; words: string } | null {
  const e = keymapEntry(id);
  if (!e) return null;
  if (EXPLICIT[id]) return EXPLICIT[id];
  // (VIEW_TOOLBAR read here, not at load: Toolbar.tsx imports this folder.)
  if (VIEWS_MENU.has(id) && !VIEW_TOOLBAR.some((v) => v.id === id)) return { place: 'views-menu', words: 'right-click its row in the views menu (the Views button at the bottom right of the view), then Set keybind…' };
  return { place: 'toolbar', words: `${e.context === 'sketch' ? 'in a sketch, ' : ''}right-click ${e.label} on the toolbar, then Set keybind…` };
}

/** Every registry id with its place (tests). */
export const keybindPlaces = (): { id: string; place: KeybindPlace; words: string }[] => KEYMAP.map((e) => ({ id: e.id, ...keybindPlace(e.id)! }));
