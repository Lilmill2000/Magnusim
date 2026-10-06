// Persistent naming (proposal §4.5 point 3): every built body carries a name per
// face, computed by the feature that made or changed it from the kernel's
// operation history. Stored references (PersistentRef, src/types/doc.ts) resolve
// against these names, then the semantic hint, then the signature.
// Implementation: src/naming/ (pure functions, no kernel calls of their own).
// Owner: DOC-CORE (written by the P2/P3 architect; P2-FEATURES and P3-PROFILES
// extend it only through the functions listed in docs/p2p3-plan.md §3.6).
// SPDX-License-Identifier: GPL-3.0-or-later
import type { FeatureId, PersistentRef, RefSignature } from './doc';
import type { OpHistory, ShapeId, TopoResult } from './kernel-protocol';

/**
 * Names of one built body's faces: `faces[i]` is the name of face index i of
 * the body's shape (kernel index space). Edge names are derived on demand from
 * the two faces of each edge (`E:<faceA>&<faceB>`, sorted).
 */
export interface FaceNames {
  faces: string[];
}

/** The faces a sweep (extrude, press-pull prism) generated, by what generated them. */
export interface SweepNaming {
  /** Side face index per generator key (a sub-segment token, an edge name). */
  sides: Record<string, number>;
  start?: number | null;
  end?: number | null;
}

/** Everything namesAfter needs about one operation. */
export interface NamingInput {
  /** The feature doing the operation (names it creates start with `F:<feature>:`). */
  feature: FeatureId;
  /** Face count of the result. */
  faces: number;
  /** The kernel's history of the operation (against the input shape ids). */
  history: OpHistory;
  /** Names of the input shapes the history refers to (shape id -> names). An input with no names gets `F:<shape>:<i>` names (a bug; never silent: the result carries a warning). */
  inputs: ReadonlyMap<ShapeId, FaceNames>;
  /**
   * Names for faces that come from the feature's own tool (a sweep's sides and
   * caps, a split's cut faces) when the history says `generated` with a seg/cap,
   * or nothing at all. Default role for faces with no source: 'new'.
   */
  role?: string;
  /**
   * Geometry of the result's faces (topo with face_mass), used only to order
   * faces that would get the same name (`#k` suffixes, ordered by centroid along
   * x, then y, then z). Absent: ordered by face index (stable for one kernel build).
   */
  topo?: Pick<TopoResult, 'faces'> | null;
}

/** namesAfter's answer: the names, and anything that was not clean (shown as a feature warning by the caller). */
export interface NamingResult {
  names: FaceNames;
  /** "2 faces have no history and were named by position" ... */
  warnings: string[];
}

/** How a stored reference resolved. */
export type RefResolution =
  | {
      ok: true;
      /** Face (or edge / vertex) index in the body's current shape. */
      index: number;
      /**
       * 'name': the name matched and the signature agrees; 'moved': the name
       * matched but the geometry moved beyond tolerance (a warning: "Reference
       * repaired · check"); 'signature': no name matched, the signature did
       * (a warning too). A caller re-anchors (stores the new signature) only on
       * a user edit, never during a rebuild.
       */
      how: 'name' | 'moved' | 'signature';
      /** The warning text when how != 'name'. */
      warning?: string;
      /** The signature found now (for re-anchoring). */
      signature: RefSignature;
    }
  | { ok: false; message: string };

/** The kernel-backed lookups a resolution may need (topo of some faces of a body's shape). */
export interface NamingLookup {
  /** Topo of the given faces (face_mass on, face_bbox 'fast' is enough). */
  faces(shape: ShapeId, indices: number[] | 'all'): Promise<TopoResult['faces']>;
  /** Edges with their faces (P4a: also their ends and a line's direction, topo edge_ends). */
  edges?(shape: ShapeId, indices: number[] | 'all'): Promise<TopoResult['edges']>;
  /** P4a: vertices with the faces at each (topo vertex_faces), for vertex references (src/naming/edges.ts). */
  vertices?(shape: ShapeId, indices: number[] | 'all'): Promise<TopoResult['vertices']>;
}

/** A stored reference resolved against one body (helper input). */
export interface ResolveInput {
  ref: PersistentRef;
  shape: ShapeId;
  names: FaceNames;
  lookup: NamingLookup;
}
