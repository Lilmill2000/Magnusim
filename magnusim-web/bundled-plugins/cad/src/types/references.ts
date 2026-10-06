// P4a: references to geometry (an axis, a plane, a point, a curve, a face) that
// features keep, and what the CONSTRUCT features (reference Plane, Axis, Point;
// src/features/refgeom/) publish for later features to read.
// A stored reference follows upstream edits: it is resolved at every rebuild
// (src/features/refgeom/resolve.ts) and a lost one is the feature's error, in
// the panels' words; nothing is repaired silently.
// Owner: REFERENCE (P4a). SOLIDS reads it (Revolve's axis; patterns and mirror in P4b).
// SPDX-License-Identifier: GPL-3.0-or-later
import type { BodyId, FeatureId, OriginAxisRef, OriginPlaneRef, PersistentRef, PlaneFrame, SketchEntityId, Vec3 } from './doc';

/** Something that gives an axis (a line in space with a direction). */
export type AxisRef =
  | { kind: 'origin'; axis: OriginAxisRef }
  /** A straight line of a sketch (a centerline, or any line), by its stable entity id. */
  | { kind: 'sketch-line'; sketch: FeatureId; entity: SketchEntityId }
  /** A straight model edge (its line), or a circular edge (the circle's axis through its centre). */
  | { kind: 'edge'; body: BodyId; ref: PersistentRef }
  /** The axis of a cylindrical, conical, spherical or toroidal face. */
  | { kind: 'face-axis'; body: BodyId; ref: PersistentRef }
  /** A CONSTRUCT axis (its AxisOutput). */
  | { kind: 'feature'; feature: FeatureId }
  /**
   * The normal of a plane, through the plane's origin (an origin plane, a flat face or a CONSTRUCT
   * plane): Extrude "Along" a plane goes along its normal (P4a integration).
   */
  | { kind: 'normal'; plane: PlaneRef };

/** Something that gives a plane. */
export type PlaneRef =
  | { kind: 'origin'; plane: OriginPlaneRef }
  /** A flat face (its plane; the normal points out of the material). */
  | { kind: 'face'; body: BodyId; ref: PersistentRef }
  /** A CONSTRUCT plane (its PlaneOutput). */
  | { kind: 'feature'; feature: FeatureId };

/** Something that gives a point. */
export type PointRef =
  | { kind: 'origin'; point: 'origin:point' }
  | { kind: 'vertex'; body: BodyId; ref: PersistentRef }
  | { kind: 'sketch-point'; sketch: FeatureId; point: string }
  /** A CONSTRUCT point (its PointOutput). */
  | { kind: 'feature'; feature: FeatureId };

/** A curve of a body: an edge (Point on an edge, Plane normal to a curve, the centre of an arc). */
export interface EdgeRef {
  kind: 'edge';
  body: BodyId;
  ref: PersistentRef;
}

/** A curve (line, arc, circle) of a sketch by its stable entity id: a Sweep path's curve for the "normal to path" plane. */
export interface SketchCurveRef {
  kind: 'sketch-curve';
  sketch: FeatureId;
  entity: SketchEntityId;
}

/** A face of a body (the axis of a cylinder, the centre of a sphere). */
export interface FaceRef {
  kind: 'face';
  body: BodyId;
  ref: PersistentRef;
}

/** Any of the above (lists of what a feature keeps: parents, bodies, words). */
export type GeomRef = AxisRef | PlaneRef | PointRef | EdgeRef | FaceRef | SketchCurveRef;

/** A curve: an edge of a body, or a curve of a sketch. */
export type CurveRef = EdgeRef | SketchCurveRef;

/** A CONSTRUCT axis as built: a point on it and its unit direction (mm). */
export interface AxisOutput {
  type: 'axis';
  origin: Vec3;
  dir: Vec3;
}

/** A CONSTRUCT plane as built: its frame (a sketch on it uses this frame; the normal is unit length). */
export interface PlaneOutput {
  type: 'plane';
  frame: PlaneFrame;
}

/** A CONSTRUCT point as built (mm). */
export interface PointOutput {
  type: 'point';
  p: Vec3;
}

/** What a CONSTRUCT feature publishes (RebuildState.outputs, BuildContext.outputs). */
export type ConstructOutput = AxisOutput | PlaneOutput | PointOutput;
