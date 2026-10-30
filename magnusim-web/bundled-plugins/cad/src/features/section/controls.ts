// The Section view panel's controls by id, each with what it is: the parity table
// (src/assistant/parity.ts SECTION) names the Assistant's way to each (the workspace tool's section;
// the panel's note: get_model's section reads it),
// and tests/assistant/parity.test.ts holds the two together. The view tools' popover drives the same
// state (Top, Front, Right, the slider, Flip side, Middle).
// Owner: VIEWPORT (the section view's plane).
// SPDX-License-Identifier: GPL-3.0-or-later

export const SECTION_CONTROLS = {
  on: 'Cut the view: the section view on or off (the panel opens with it on)',
  plane: 'Plane: a construction plane or a flat face clicked in the view, or a plane clicked in the tree',
  origin: "Top, Front or Right: the origin's planes as buttons",
  offset: "Offset: a length along the plane's normal (the Part's units, parameters and expressions as any length field)",
  middle: "Middle: the cut through the middle of the shown bodies along the plane's normal",
  flip: 'Keep the other side',
  arrow: "the arrow on the cut in the view: a drag moves the cut along the plane's normal and sets Offset (Ctrl: whole steps)",
  note: 'the note under the panel: why the section turned off, or why the cut stays where it last was',
} as const;

export type SectionControl = keyof typeof SECTION_CONTROLS;
