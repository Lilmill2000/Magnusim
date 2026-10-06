// Colours of the profile overlay, read from the design tokens (three.js needs
// numbers, so the CSS custom properties are read once at start; the fallbacks
// are the tokens' own values, for DOM-less tests).
// Proposal §3.3: profiles shaded --mg-primary (#1570ef) at 12% opacity.
// Picked profiles in the core's pick green, hover in its pre-highlight blue
// (src/viewport/colors.ts), as faces are.
// Owner: P3-PROFILES (src/features/sketch/).
// SPDX-License-Identifier: GPL-3.0-or-later
import { HOVER_COLOR, PICK_COLOR } from '../../viewport/colors';

function token(name: string, fallback: number): number {
  try {
    const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    const m = /^#([0-9a-f]{6})$/i.exec(v);
    if (m) return parseInt(m[1], 16);
  } catch {
    /* no DOM */
  }
  return fallback;
}

export interface OverlayColors {
  region: { color: number; opacity: number };
  hover: { color: number; opacity: number };
  picked: { color: number; opacity: number };
  /** A sketch's lines in model mode: under defined (--cad-sketch-under) and fully defined (--cad-sketch-full). */
  under: number;
  full: number;
  over: number;
  construction: number;
  /** P4b (SELECT): linked (projected, intersection) curves, and a lost reference's. */
  linked: number;
  lost: number;
}

export function overlayColors(): OverlayColors {
  return {
    region: { color: token('--mg-primary', 0x1570ef), opacity: 0.12 },
    hover: { color: HOVER_COLOR, opacity: 0.55 },
    picked: { color: PICK_COLOR, opacity: 0.4 },
    under: token('--mg-primary', 0x1570ef),
    full: token('--mg-text', 0x101828),
    over: token('--mg-danger', 0xb42318),
    construction: token('--mg-text-muted', 0x667085),
    linked: token('--cad-sketch-projected', 0x7a3fd1),
    lost: token('--cad-sketch-lost', 0xb54708),
  };
}
