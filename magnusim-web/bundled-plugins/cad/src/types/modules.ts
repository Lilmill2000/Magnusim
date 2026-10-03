// Modules: how a feature or an area plugs itself in without editing shared files
// (docs/p2p3-plan.md §3.1). A module is the default export of
//   src/features/<name>/index.ts   (one folder per feature type or tool)
//   src/sketch/index.ts            (sketch mode)
// src/modules.ts finds them with import.meta.glob (no list to edit), registers
// their feature types in the document's registry, their panels and tools with
// the UI shell, and calls install(services) after the UI's own install.
// Owner: INTEGRATE (contract). Each module's files belong to its builder.
// SPDX-License-Identifier: GPL-3.0-or-later
import type { ComponentType } from 'react';
import type { AppServices } from './app';
import type { FeatureId, FeatureType } from './doc';
import type { EditSession, FeatureTypeDef } from './doc-service';
import type { PickResult } from './selection';

/** Props of a feature's flyout panel (rendered inside the UI shell's Flyout; use PanelChrome from src/ui/kit). */
export interface FeaturePanelProps {
  session: EditSession;
  feature: FeatureId;
  isNew: boolean;
}

/** Props of a tool panel (a flyout that is not a feature: Measure, Mass properties, Check, Export). */
export interface ToolPanelProps {
  /** Close the panel (Done). */
  close(): void;
}

/** A non-feature flyout. Opened with uiFor(services).openTool(id); one panel is open at a time. */
export interface ToolDef {
  /** "inspect.measure". */
  id: string;
  label: string;
  panel: ComponentType<ToolPanelProps>;
  /** Wide flyout (tables). */
  wide?: boolean;
}

/** An item a module adds to the viewport's context menu (after the shell's own items, behind a separator). */
export interface ContextMenuContribution {
  id: string;
  label: string;
  /** Why it cannot run now (shown greyed with this tooltip), or null. */
  disabled?: string | null;
  run(): void;
}

/**
 * One module. Everything is optional; a module registers only what works end
 * to end (honest UI: a feature type without a working panel and command is not
 * registered at all).
 */
export interface CadModule {
  /** Unique, the folder name: "import", "extrude", "sketch-mode". */
  id: string;
  /** Feature types this module builds (registered in DocService.features before the Part loads). */
  features?: FeatureTypeDef[];
  /** Flyout panel per feature type (a module may give the panel of a type another module builds: sketch mode gives the sketch's). */
  panels?: Partial<Record<FeatureType, ComponentType<FeaturePanelProps>>>;
  tools?: ToolDef[];
  /**
   * Viewport context-menu items for what was right-clicked (`pick` null: empty
   * space). Return [] when nothing applies. Called on every right-click.
   */
  contextMenu?(services: AppServices, pick: PickResult | null): ContextMenuContribution[];
  /**
   * Chips this module shows in the status dock (bottom-left), after the shell's
   * own: sketch mode's "Under defined · 2 DOF". Each renders nothing when it has
   * nothing to say.
   */
  chips?: ComponentType[];
  /** Commands, key bindings, bus handlers, viewport layers. Called once after the UI shell installed; returns an uninstall. */
  install?(services: AppServices): () => void;
}

/** The modules found at start-up (services.modules). */
export interface ModuleRegistry {
  all(): readonly CadModule[];
  panelFor(type: FeatureType): ComponentType<FeaturePanelProps> | null;
  tool(id: string): ToolDef | null;
}

/**
 * Command ids other areas rely on (the UI shell runs these when present).
 * Delete with only faces selected runs DELETE_FACES_COMMAND when it is
 * registered and enabled; otherwise it says what Delete does (P1 behaviour).
 */
export const WELL_KNOWN_COMMANDS = {
  deleteFaces: 'modify.delete-faces',
  sketchNew: 'sketch.new',
  sketchFinish: 'sketch.finish',
  sketchUndo: 'sketch.undo',
  sketchRedo: 'sketch.redo',
  importStep: 'file.import-step',
  exportStep: 'file.export-step',
  extrude: 'solid.extrude',
  pressPull: 'modify.press-pull',
  measure: 'inspect.measure',
} as const;
