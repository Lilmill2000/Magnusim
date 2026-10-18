// A feature as its tool's input, and its expression fields by the tool's field names (CAD tools
// spec §4 "Full", §7.7): get_model full shows each feature's `inputs` ready to resend with edit,
// and `values` for edit_feature. Each tool that makes a feature type registers that type's
// reader here, from its own file (registerFeatureIo); a type with none reads `inputs: null`,
// a one-line summary, and its expression fields by their paths in the feature.
// Owner: ASSISTANT.
// SPDX-License-Identifier: GPL-3.0-or-later
import { featureExprFields } from '../doc/features/hooks';
import { isDimension } from '../sketch/model';
import type { AppServices } from '../types/app';
import type { Feature, FeatureType, SketchDimension } from '../types/doc';
import type { RefBodies } from './feature-tools';

/** One expression field: its name in the tool's input (or its path in the feature), and its text. */
export interface FeatureValue {
  field: string;
  expr: string;
}

export interface FeatureIo {
  /** The tool whose input these features are written in ("extrude"). */
  tool: string;
  /**
   * The feature as that tool's input, `edit` set to its name; null when it cannot be resent (with
   * why in `notes`). `at`: the bodies just before it, which its stored face and edge references
   * are written against (feature-tools.ts refBodiesOf; null: the shown bodies).
   */
  inputsOf(f: Feature, services: AppServices, at?: RefBodies | null): Record<string, unknown> | null;
  /** Its inputs name faces, edges or axes of bodies (get_model builds the bodies before it first). */
  refs?: boolean;
  /** Its expression fields by the tool's field names (edit_feature's `set[].field`). */
  values?(f: Feature, services: AppServices): FeatureValue[];
  /** The path in the feature of one of those field names ("distance" → "extent.distance"), or null. */
  pathOf?(f: Feature, field: string, services: AppServices): string | null;
}

const IO = new Map<FeatureType, FeatureIo>();

/** A tool's reader of its feature types (one call per type, from the tool's own file). */
export function registerFeatureIo(type: FeatureType, io: FeatureIo): void {
  IO.set(type, io);
}

export function featureIoOf(type: FeatureType): FeatureIo | null {
  return IO.get(type) ?? null;
}

/** The feature as its tool's input, or null (no tool writes this type yet, or it cannot be resent). */
export function inputsOf(f: Feature, services: AppServices, at: RefBodies | null = null): Record<string, unknown> | null {
  const io = IO.get(f.type);
  return io ? io.inputsOf(f, services, at) : null;
}

/** Whether the feature's inputs name faces, edges or axes (written against the bodies just before it). */
export function inputsNameRefs(f: Feature): boolean {
  return !!IO.get(f.type)?.refs;
}

/**
 * Its expression fields: by the tool's field names when its tool registered them; a sketch's
 * dimensions by their ids; otherwise by their paths in the feature ("extent.distance").
 */
export function valuesOf(f: Feature, services: AppServices): FeatureValue[] {
  const io = IO.get(f.type);
  if (io?.values) return io.values(f, services);
  if (f.type === 'sketch') return f.constraints.filter((c) => isDimension(c) && c.driving).map((c) => ({ field: c.id, expr: (c as SketchDimension).expr }));
  return featureExprFields(services.doc.features, f).map((x) => ({ field: x.path, expr: x.expr }));
}

/** One line about a feature of a type with no tool: its kind and its plain choices ("Plane · offset"). */
export function summaryOf(f: Feature, services: AppServices): string {
  const label = services.doc.features.get(f.type)?.label ?? f.type;
  const r = f as unknown as Record<string, unknown>;
  const bits = [label];
  for (const k of ['method', 'kind', 'op', 'of', 'mode', 'shape']) if (typeof r[k] === 'string' && r[k]) bits.push(`${k} ${String(r[k])}`);
  return bits.join(' · ');
}

/**
 * The path in the feature of an expression field as edit_feature names it (its tool's field name
 * when the tool registered one, else its path as valuesOf lists it), or null.
 */
export function pathOfField(f: Feature, field: string, services: AppServices): string | null {
  const io = IO.get(f.type);
  const mapped = io?.pathOf?.(f, field, services);
  if (mapped) return mapped;
  // Without a map the names valuesOf gives are the paths themselves (a sketch's are its dimension ids).
  if (io?.values || f.type === 'sketch') return null;
  return valuesOf(f, services).some((v) => v.field === field) ? field : null;
}
