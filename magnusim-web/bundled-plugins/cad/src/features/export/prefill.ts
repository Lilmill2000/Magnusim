// What the next Export STEP panel opens with, when someone filled it in for the person (the
// Assistant's workspace export_step): the format, the file name and the bodies. Taken once, by the
// panel that opens next; the person still clicks Export (the download is theirs).
// Owner: P2-FEATURES.
// SPDX-License-Identifier: GPL-3.0-or-later
import type { AppServices } from '../../types/app';
import type { BodyId } from '../../types/doc';

export interface ExportPrefill {
  schema: 'AP214' | 'AP242';
  name: string;
  bodies: BodyId[];
}

const next = new WeakMap<AppServices, ExportPrefill>();

/** The next Export panel opens with these values. */
export function setExportPrefill(services: AppServices, p: ExportPrefill): void {
  next.set(services, { ...p, bodies: [...p.bodies] });
}

/** The values for the panel opening now (once), or null. */
export function takeExportPrefill(services: AppServices): ExportPrefill | null {
  const p = next.get(services) ?? null;
  next.delete(services);
  return p;
}
