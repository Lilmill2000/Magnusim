// Transient events between areas (state lives in stores; events are one-off
// notifications). APPEND-ONLY: add keys only in your own section; never rename
// or change another area's payload. Bus implementation: src/lib/bus.ts.
// SPDX-License-Identifier: GPL-3.0-or-later
import type { FeatureId } from './doc';
import type { PickResult } from './selection';

export interface CadEvents {
  // ---- app (INTEGRATE) ----
  /** The app finished bootstrapping (services ready, first render done). */
  'app:ready': { ms: number };
  /** Escape pressed with nothing else handling it: close menus, clear tools. */
  'app:escape': Record<string, never>;

  // ---- kernel (DOC-CORE) ----
  /** The kernel worker was respawned and is ready again (all shape ids died). */
  'kernel:respawned': { reason: string; count: number };

  // ---- doc (DOC-CORE) ----
  /** A rebuild finished (the viewport and chips also watch DocService.state). */
  'doc:rebuilt': { seq: number; ms: number; failed: FeatureId[] };

  // ---- viewport (VIEWPORT) ----
  /** Right-click without drag in the viewport: open the context menu here. */
  'viewport:contextmenu': { pick: PickResult | null; clientX: number; clientY: number };
  /** Double-click on a body face: edit the feature that made it. */
  'viewport:dblclick': { pick: PickResult };

  // ---- ui (UI-SHELL) ----
  /** Open a feature's panel (tree double-click, context menu "Edit feature"). */
  'ui:edit-feature': { feature: FeatureId };

  // ---- sketch mode (P3-SKETCH) ----
  /** Sketch mode was entered (a panel session opened on a sketch) or left (`feature` null). */
  'sketch:mode': { feature: FeatureId | null };

  // ---- import (P2-FEATURES) ----
  /** A STEP was dropped on the frame or picked; the import panel takes it. */
  'import:file': { file: File };
}

export type CadEventName = keyof CadEvents;
