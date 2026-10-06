// Outline glyphs (24 viewBox, stroke 1.7, currentColor) of the PATTERN group, for the
// toolbar and the tree rows.
// Owner: P4b PATTERN.
// SPDX-License-Identifier: GPL-3.0-or-later
export const PATTERN_ICONS = {
  /** Three squares in a row and the arrow along them. */
  linear: 'M3 9h4v4H3z M10 9h4v4h-4z M17 9h4v4h-4z M3 18h17 M17.5 15.5L20 18l-2.5 2.5',
  /** Small squares round a centre on a circle. */
  circular: 'M12 12m-1 0a1 1 0 1 0 2 0a1 1 0 1 0-2 0 M10.5 2.5h3v3h-3z M18.5 10.5h3v3h-3z M10.5 18.5h3v3h-3z M2.5 10.5h3v3h-3z M17 6.5a7.5 7.5 0 0 1 .6 2.3',
  /** A shape and its reflection across a dashed line. */
  mirror: 'M12 2.5v2.5 M12 7.5v3 M12 13v3 M12 18.5v3 M9.5 6L3.5 18h6z M14.5 6l6 12h-6z',
} as const;
