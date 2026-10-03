// Outline icons (24 viewBox, stroke 1.7 in the toolbar, 1.8 in the tree; one
// path d with several M subpaths), design-language §6. Owner: P2-FEATURES.
// SPDX-License-Identifier: GPL-3.0-or-later
export const P2_ICONS = {
  importStep: 'M12 3v11 M7.5 9.5L12 14l4.5-4.5 M4 15v5h16v-5',
  exportStep: 'M12 14V3 M7.5 7.5L12 3l4.5 4.5 M4 15v5h16v-5',
  imported: 'M4 8l8-4 8 4v8l-8 4-8-4z M4 8l8 4 8-4 M12 12v8 M9 2.5h6',
  pressPull: 'M4 14l8-4 8 4-8 4z M4 14v3l8 4 8-4v-3 M12 2v8 M9 5l3-3 3 3',
  deleteFaces: 'M4 8l8-4 8 4v8l-8 4-8-4z M4 8l8 4 8-4 M12 12v8 M14.5 13.5l4 4 M18.5 13.5l-4 4',
  split: 'M3 6l6-2v16l-6 2z M15 4l6-2v16l-6 2z M12 1v22',
  combine: 'M9 12m-6 0a6 6 0 1 0 12 0a6 6 0 1 0 -12 0 M15 12m-6 0a6 6 0 1 0 12 0a6 6 0 1 0 -12 0',
  measure: 'M3 17L17 3l4 4L7 21z M7 13l2 2 M10 10l1.5 1.5 M13 7l2 2',
  mass: 'M9 7a3 3 0 1 1 6 0 M5 9h14l2 11H3z',
  check: 'M10 10m-6.5 0a6.5 6.5 0 1 0 13 0a6.5 6.5 0 1 0 -13 0 M15 15l6 6 M7.5 8.5L10 7l2.5 1.5v3L10 13l-2.5-1.5z',
} as const;
