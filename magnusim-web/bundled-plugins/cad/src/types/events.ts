// Transient events between areas (state lives in stores; events are one-off
// notifications). APPEND-ONLY: add keys only in your own section; never rename
// or change another area's payload. Bus implementation: src/lib/bus.ts.
// SPDX-License-Identifier: GPL-3.0-or-later
import type { FeatureId } from './doc';
import type { TakeOverWhy } from './doc-service';
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

  // ---- assistant steps (DOC-CORE, doc.assistant) ----
  /** The person took over the Assistant's open session: it was discarded (the step is reverted by its call). */
  'assistant:taken-over': { why: TakeOverWhy };
  /**
   * The person undid or redid a step (Ctrl+Z, Ctrl+Y, the toolbar, the chip's Undo), sent before it
   * applies: `tag` and `label` are that step's (`tag` null for the person's own steps).
   */
  'assistant:person-undo': { tag: string | null; label: string | null; redo: boolean };
  /** An Assistant step ended (AssistantStep.end): a panel it showed with no session (its Parameters panel) goes with it. */
  'assistant:step-ended': { owner: string };

  // ---- the Assistant's tools (ASSISTANT, src/assistant) ----
  /** A tool call of the app's Assistant started, or ended (`ok` with the end). `turn` is AssistantCall.turn ('' for an outside client's). */
  'assistant:call': { turn: string; call: string; tool: string; phase: 'start' | 'end'; ok?: boolean };
}

export type CadEventName = keyof CadEvents;
