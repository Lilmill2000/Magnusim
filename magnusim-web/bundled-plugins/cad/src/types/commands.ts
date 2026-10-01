// Commands, the toolbar and the keyboard.
// Registry and keyboard implementations: src/app/commands.ts, src/app/keyboard.ts
// (INTEGRATE). Any area registers its own commands from its index.ts
// (registerCommands(services)); the toolbar (UI-SHELL) renders the registry.
// SPDX-License-Identifier: GPL-3.0-or-later
import type { AppServices } from './app';

/** Toolbar groups by mode, in display order (proposal §3.1). */
export type ModelGroup = 'sketch' | 'solid' | 'modify' | 'pattern' | 'construct' | 'inspect' | 'file';
export type SketchGroup = 'draw' | 'constrain' | 'dimension' | 'sketch-modify';
export type ToolbarGroup = ModelGroup | SketchGroup;
export type Mode = 'model' | 'sketch';

export const GROUP_LABELS: Record<ToolbarGroup, string> = {
  sketch: 'SKETCH',
  solid: 'SOLID',
  modify: 'MODIFY',
  pattern: 'PATTERN',
  construct: 'CONSTRUCT',
  inspect: 'INSPECT',
  file: 'FILE',
  draw: 'DRAW',
  constrain: 'CONSTRAIN',
  dimension: 'DIMENSION',
  'sketch-modify': 'MODIFY',
};

export const MODEL_GROUPS: ModelGroup[] = ['sketch', 'solid', 'modify', 'pattern', 'construct', 'inspect', 'file'];
export const SKETCH_GROUPS: SketchGroup[] = ['draw', 'constrain', 'dimension', 'sketch-modify'];

/**
 * A command. Only commands that work end to end are registered (honest UI:
 * nothing greyed "for later"). A command may be temporarily unavailable:
 * `enabled` returns a reason, shown as the tooltip, and the button is disabled.
 */
export interface CommandDef {
  /** "solid.box", "edit.undo", "view.fit". */
  id: string;
  /** Sentence case, verb-first where it is an action: "Box", "Undo", "Fit". */
  label: string;
  /** Toolbar group; omit for keyboard / context-menu-only commands. */
  group?: ToolbarGroup;
  /** Which mode shows it. Default 'model'. */
  mode?: Mode | 'any';
  /** SVG path d (24x24, stroke 1.7, currentColor), required when `group` is set. */
  icon?: string;
  /** "Ctrl+Z", "Shift+F", "E", "Delete", "Escape". Ctrl means Ctrl or Cmd. */
  shortcut?: string;
  /** Longer tooltip text; the label and shortcut are added by the toolbar. */
  hint?: string;
  /** Order within its group (ascending). */
  order?: number;
  /** true, or the reason it is unavailable right now ("Nothing to undo"). */
  enabled?(services: AppServices): true | string;
  /**
   * Its shortcut, pressed while the command cannot run, says why in a toast
   * (Normal to: "Select a planar face or a plane…"). Off for commands whose
   * reason is obvious (Undo with nothing to undo).
   */
  explainRefusal?: boolean;
  run(services: AppServices): void | Promise<void>;
}

export interface CommandRegistry {
  /** Registers (or replaces, same id) a command. Returns unregister. */
  register(def: CommandDef): () => void;
  get(id: string): CommandDef | undefined;
  all(): CommandDef[];
  /** Commands of a mode's toolbar, grouped in display order (empty groups left out). */
  toolbar(mode: Mode): { group: ToolbarGroup; label: string; commands: CommandDef[] }[];
  /** Runs a command if it is enabled; returns the reason when it is not. */
  run(id: string): Promise<true | string>;
  /** Notified when commands are added or removed (the toolbar re-renders). */
  subscribe(fn: () => void): () => void;
}

export interface KeyBinding {
  /** Normalised combo, "Ctrl+Shift+Z". */
  combo: string;
  run(e: KeyboardEvent): void;
  /** Also fires while an input or textarea has focus (default false; Escape usually true). */
  inInputs?: boolean;
}

/**
 * Frame keyboard. The host (API 1.2) gives the frame the keyboard when it
 * connects and after its own dialogs and Settings close; a click on the host's
 * header takes it away until the next click in the frame.
 */
export interface KeyboardManager {
  bind(binding: KeyBinding): () => void;
  /** Normalise "ctrl+z", "Cmd+Z" -> "Ctrl+Z". */
  normalise(combo: string): string;
  dispose(): void;
}
