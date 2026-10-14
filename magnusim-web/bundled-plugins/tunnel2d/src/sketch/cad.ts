// The CAD plugin's sketcher pieces the tunnel's sketch bodies use: the sketch's data model,
// its PlaneGCS solver client, the model and status helpers, dimension planning and layout,
// relation glyphs, geometry and spline maths. Pure modules (no three.js, kernel or document
// service), bundled into the tunnel at build time; this is the one file that names CAD's
// sources (tests/cad-imports.test.ts guards it, so a CAD refactor that breaks it fails here).
// The solver's worker and wasm are copied into tunnel2d/workspace/solver/ by vite.config.ts.
// SPDX-License-Identifier: GPL-3.0-or-later
export type {
  SketchConstraint,
  SketchDimension,
  SketchDimensionKind,
  SketchEntity,
  SketchFeature,
  SketchRelation,
  SketchRelationKind,
  SketchSplineEntity,
  Vec2,
} from '../../../cad/src/types/doc';
export type { SolverAnalysis, SolverSolveResult, SolverValues } from '../../../cad/src/types/sketch';
export {
  DIMENSION_LABELS,
  ORIGIN,
  RELATION_LABELS,
  arcGeom,
  closestOn,
  distanceTo,
  entityEnds,
  entityOf,
  entityPoints,
  isDimension,
  measureDimension,
  pointAt,
  pointIdOf,
  refKindOf,
  toSolverSketch,
  withSolved,
} from '../../../cad/src/sketch/model';
export { colourOf, overIds, statusOf, statusText } from '../../../cad/src/sketch/dof';
export { defaultLabelAt, formatDimNumber, layoutDimension, planDimension } from '../../../cad/src/sketch/dimensions';
export { GLYPH_ICON, SKETCH_ICONS } from '../../../cad/src/sketch/icons';
export { createSolverClient, type SolverClient } from '../../../cad/src/sketch/solver-client';
export { angleOf, ccwSweep, circleThrough, dist, lineLine, norm, perp, polygonArea, sub, add, scale, dot, cross, len } from '../../../cad/src/sketch/geom';
export { splineOf, splineSamples } from '../../../cad/src/sketch/tools/spline-entity';
export { newId } from '../../../cad/src/lib/ids';

/** Where the copied solver worker is served from (vite.config.ts copies it there). */
export const SOLVER_WORKER = 'solver/solver-worker.js';
