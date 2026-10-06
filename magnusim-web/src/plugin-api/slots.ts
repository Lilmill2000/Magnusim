/**
 * In-page settings slots an analysis fills with its own component (API 1.1).
 *
 * The study panel and the run panel are core chrome: title, rename, Done and
 * Delete, the Start gate, progress, residuals and monitors. Between them sits
 * the analysis's settings, drawn by the plugin that registers the analysis:
 * its contract's `ui.study_settings` / `ui.run_settings` name the component it
 * registers here. An analysis that names none gets the core's generic form
 * built from its schemas.
 */
import { useSyncExternalStore, type ComponentType } from 'react';
import type { BcFamilyRow, RegistryRow } from '../api/registry.gen';
import type { BcRecord, RunState, StudyState, TimeDependency } from '../panels/legacyBridge';

/**
 * 'bc-settings' (API 1.4): a BC family's fields in the BC editor, between the
 * Type row and the assigned faces, named by the family's `ui`. 'bc-faces-note'
 * is an optional line the same family draws under the assigned faces.
 */
export type SettingsSlot = 'study-settings' | 'run-settings' | 'bc-settings' | 'bc-faces-note';

/** What a study-settings component gets. The core shows a failed save's message. */
export interface StudySettingsProps {
  study: StudyState;
  /** The study's analysis row (registry.describe). */
  row: RegistryRow | undefined;
  /** Every analysis, for the sibling of the other time dependency. */
  rows: RegistryRow[];
  save: (patch: Record<string, unknown>) => Promise<void>;
  setTimeDependency: (value: TimeDependency) => Promise<void>;
}

/** What a run-settings component gets. Settings are locked once a run has started. */
export interface RunSettingsProps {
  run: RunState;
  /** The run's analysis row (registry.describe). */
  row: RegistryRow | undefined;
  /** A steady run's iteration count and write interval. */
  saveSteady: (patch: { end_time?: number; write_interval?: number }) => Promise<void>;
  /** A transient run's whole control block, as the analysis's run model defines it. */
  saveTransient: (settings: Record<string, unknown>) => Promise<void>;
  /**
   * API 1.4: the run's "Stop when a monitor settles" (null: off), stored on the run as
   * its analysis's run model cleans it (`settle`); `run.settle` and `run.monitors` show it.
   */
  saveSettle?: (settle: Record<string, unknown> | null) => Promise<void>;
}

/** What a bc-settings component gets (API 1.4). The core shows a failed save's message. */
export interface BcSettingsProps {
  /** The BC as saved (its faces are the ones being assigned). */
  bc: BcRecord;
  /** Its family's registry row (registry kind bc_family). */
  family: BcFamilyRow;
  /** The open project shows Imperial units. */
  imperial: boolean;
  /** The faces assigned to it now. */
  faces: string[];
  /** Merge fields into the BC and save it. A unit change alone converts the value. */
  save: (patch: Record<string, unknown>) => Promise<void>;
  /** The mean area of one of these faces (m²; null without geometry) and the study's fluid density (kg/m³; 0 when unknown). */
  flowBasis: (faces: string[]) => { face_area_m2: number | null; density: number };
  /** The study's record as saved (its turbulence model, time dependency, ...); null when not known. */
  study?: Record<string, unknown> | null;
}

type AnyComponent = ComponentType<never>;

const slots = new Map<string, { owner: string; Component: AnyComponent }>();
let version = 0;
const listeners = new Set<() => void>();

function slotKey(slot: SettingsSlot, name: string): string {
  return `${slot}:${name}`;
}

function notify(): void {
  version += 1;
  for (const listener of listeners) listener();
}

export function registerSlotFor(owner: string, slot: SettingsSlot, name: string, Component: AnyComponent): string {
  const key = slotKey(slot, String(name || '').trim());
  if (!name) {
    const where = slot.startsWith('bc-') ? "the BC family's ui" : `the contract's ui.${slot.replace('-', '_')}`;
    throw new Error(`${slot} components need a name (${where})`);
  }
  slots.set(key, { owner, Component });
  notify();
  return key;
}

export function unregisterSlot(key: string, owner: string): void {
  if (slots.get(key)?.owner === owner) {
    slots.delete(key);
    notify();
  }
}

export function slotComponent<P>(slot: SettingsSlot, name: string | undefined): ComponentType<P> | null {
  if (!name) return null;
  return (slots.get(slotKey(slot, name))?.Component as unknown as ComponentType<P>) || null;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** The registered component for a slot name, re-rendering when plugins (re)register. */
export function useSlotComponent<P>(slot: SettingsSlot, name: string | undefined): ComponentType<P> | null {
  useSyncExternalStore(subscribe, () => version);
  return slotComponent<P>(slot, name);
}

/** True once the boot load of plugin UIs has finished (a declared slot may still be missing). */
export function pluginUiLoaded(): boolean {
  return typeof window !== 'undefined' && !!window.__CFD_PLUGINS_READY__;
}

function subscribeLoaded(listener: () => void): () => void {
  window.addEventListener('cfd:plugins-ready', listener);
  return () => window.removeEventListener('cfd:plugins-ready', listener);
}

export function usePluginUiLoaded(): boolean {
  return useSyncExternalStore(subscribeLoaded, pluginUiLoaded, () => false);
}

/** The slot name an analysis row declares (`ui.study_settings` / `ui.run_settings`). */
export function declaredSlot(row: RegistryRow | undefined, slot: SettingsSlot): string {
  return String(row?.ui?.[slot === 'study-settings' ? 'study_settings' : 'run_settings'] || '');
}

/**
 * The component an analysis draws in a settings slot, or null for the core's
 * generic form. `waiting` while plugin UIs are still loading, so the generic
 * form never flashes up in place of the plugin's.
 */
export function useSettingsSlot<P>(slot: SettingsSlot, row: RegistryRow | undefined) {
  const name = declaredSlot(row, slot);
  const Component = useSlotComponent<P>(slot, name);
  const loaded = usePluginUiLoaded();
  return { Component, waiting: !!name && !Component && !loaded };
}
