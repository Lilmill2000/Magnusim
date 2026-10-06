// Outline glyphs (24 viewBox, stroke 1.7, currentColor) of the P4a solids, for the
// toolbar and the tree rows.
// Owner: P4a SOLIDS.
// SPDX-License-Identifier: GPL-3.0-or-later
export const SOLIDS_ICONS = {
  /** A profile beside an axis, and the turn round it. */
  revolve: 'M5 3v18 M8 8h5v8H8z M16 6.5a7 7 0 0 1 0 11 M16 17.5l-2.6-.2 M16 17.5l.6-2.5',
  /** A small profile and the path it runs along. */
  sweep: 'M3 15h4v4H3z M5 15c0-6 4-10 10-10h6 M18.5 2.5L21 5l-2.5 2.5',
  /** Two profiles joined by straight sides. */
  loft: 'M4 4.5h9v3H4z M9 16.5h11v3H9z M4 7.5l5 9 M13 7.5l7 9',
  /** A rounded corner. */
  fillet: 'M4 20V11a7 7 0 0 1 7-7h9 M4 20h3 M20 4v3',
  /** A cut corner. */
  chamfer: 'M4 20V10l6-6h10 M4 20h3 M20 4v3',
  /** A box hollowed out, open at the top. */
  shell: 'M4 6v14h16V6 M7.5 6v10.5h9V6',
} as const;
