// Edit in CAD (host API 1.7): the project geometry a Part was opened to edit, its
// source file and its face table, as the host's bridge gives them
// (ws.context.geometry / launch, ws.project.geometrySource / geometryFaces): the
// SDK's own types (src/types/workspace-sdk.d.ts, generated from the host), named
// here for CAD's code; and CAD's own record of the adoption kept on the study
// (`cad_adopt`).
// SPDX-License-Identifier: GPL-3.0-or-later
import type { LaunchTarget, LinkFile } from '@magnusim/workspace';

export type { EditedGeometry, GeometryFace, GeometryFaces, GeometryFaceUse, GeometrySource } from '@magnusim/workspace';

/** Where the user right-clicked when they chose Edit in CAD (one-shot, not persisted). */
export type EditLaunch = LaunchTarget;

/** LinkOptions.originalNames (1.7): the sidecar that names the ORIGINAL geometry's faces in host order. */
export type OriginalNamesRef = LinkFile;

/** The study record's `cad_adopt`: CAD's own note of the geometry it was opened to edit. */
export interface CadAdopt {
  geometryId: string;
  /**
   * The Imported feature (its id) the record describes: the one the SAVED Part holds. Another tab's
   * import (two tabs opened the Part at once) has another id, and the record is made again for it.
   */
  importId: string | null;
  /** The Part's save counter right after the import: Back at this version links nothing. */
  baselineVersion: number;
  /**
   * The design right after the import (designDigest: its features, bodies and parameters): Back
   * with a saved design equal to it (an Undo back to the import) links nothing either.
   */
  baselineDigest: string | null;
  /** The original-names sidecar, or null when it could not be made (faces then match by shape only). */
  originalNames: { rel: string; sha256: string } | null;
  matched: number;
  total: number;
  /** Why the face matching failed (the sidecar is then null), or null. */
  error: string | null;
}
