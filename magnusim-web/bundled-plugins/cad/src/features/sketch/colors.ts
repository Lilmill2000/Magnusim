// Colours of the profile overlay: a finished sketch's lines in model mode take the view's
// palette's sketch inks (src/viewport/palette.ts: LIGHT, or DARK with the host's dark theme).
// Proposal §3.3: profiles shaded the primary blue (#1570ef) at 12% opacity, a surface tint that
// stays the same in both themes (D2, E5). Picked profiles in the core's pick green, hover in its
// pre-highlight blue (src/viewport/colors.ts), as faces are.
// Owner: P3-PROFILES (src/features/sketch/).
// SPDX-License-Identifier: GPL-3.0-or-later
import { HOVER_COLOR, PICK_COLOR } from '../../viewport/colors';
import { hexNumber, LIGHT, type MarkPalette } from '../../viewport/palette';

/** The closed regions' shading: the primary blue at 12%, in both themes (it reads as well on either background). */
export const REGION_TINT: Readonly<{ color: number; opacity: number }> = Object.freeze({ color: 0x1570ef, opacity: 0.12 });

export interface OverlayColors {
  region: { color: number; opacity: number };
  hover: { color: number; opacity: number };
  picked: { color: number; opacity: number };
  /** A sketch's lines in model mode: under defined and fully defined. */
  under: number;
  full: number;
  over: number;
  construction: number;
  /** P4b (SELECT): linked (projected, intersection) curves, and a lost reference's. */
  linked: number;
  lost: number;
}

export function overlayColors(p: MarkPalette = LIGHT): OverlayColors {
  return {
    region: { ...REGION_TINT },
    hover: { color: HOVER_COLOR, opacity: 0.55 },
    picked: { color: PICK_COLOR, opacity: 0.4 },
    under: hexNumber(p.sketch.under),
    full: hexNumber(p.sketch.fully),
    over: hexNumber(p.sketch.over),
    construction: hexNumber(p.sketch.construction),
    linked: hexNumber(p.sketch.linked),
    lost: hexNumber(p.sketch.lost),
  };
}
