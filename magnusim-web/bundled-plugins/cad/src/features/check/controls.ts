// The Check panel's controls by id, each with what it is: the parity table (src/assistant/parity.ts
// CHECK) names the Assistant's way to each, and the Assistant's check tool's fields name these
// (control('check', id)); tests/assistant/parity.test.ts holds the two together.
// Owner: ASSISTANT (the person's side of check).
// SPDX-License-Identifier: GPL-3.0-or-later

export const CHECK_CONTROLS = {
  solids: "Solids: the kernel's check (BRepCheck) of each selected or shown body: valid, or its problems",
  interference: 'Interference: the pairs of bodies that overlap (their shared volume and where), and with a clearance the pairs closer than it',
  bodies: 'the bodies checked: the selected ones, else every shown body (Interference) or every body (Loose parts)',
  clearance: 'Clearance (Interference): list pairs closer than this too',
  stack: 'Loose parts: each axis bodies share, its parts in order, what holds each radially and along it, and what is free to slide or has nothing in its bore',
  play: 'Play (Loose parts): the radial and axial play still counted as held (0.5 mm when empty)',
  sweep: 'Rotation: a body turned a full turn about an axis, both ways: the first angle it meets each other body',
  turning: 'Turning (Rotation): the body that turns, or the selected bodies together',
  axis: 'Axis (Rotation): an axis round faces lie on (shared with other bodies or the body\'s own), X, Y, Z or a construction axis',
  stop: 'Stop: ends a check that is running',
  row: 'a result row: a click selects its bodies (Ctrl adds them), hovering lights them in the view',
} as const;

export type CheckControl = keyof typeof CHECK_CONTROLS;

/** The panel's modes (the first is the kernel's check of each body; the rest are the check tool's kinds). */
export const CHECK_MODES = ['solids', 'interference', 'stack', 'sweep'] as const;
export type CheckMode = (typeof CHECK_MODES)[number];

/** Each mode's name on its button. */
export const CHECK_MODE_LABELS: Readonly<Record<CheckMode, string>> = {
  solids: 'Solids',
  interference: 'Interference',
  stack: 'Loose parts',
  sweep: 'Rotation',
};
