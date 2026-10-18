// The tools this build answers: one line each, `export { tool as <name> } from './<name>'`, in
// the order of the 18 (schemas.ts holds every tool's schema; a tool with no line here answers
// not_ready "not in this build yet"). Each tool's file exports `tool: ToolImpl` and registers
// what else it brings (its features' readers, features-io.ts) when imported. A comment line
// sits between the lines, so commits that add different tools merge cleanly.
// Owner: ASSISTANT.
// SPDX-License-Identifier: GPL-3.0-or-later

// body: Name or colour a body.
export { tool as body } from './body';
// combine: Combine bodies.
export { tool as combine } from './combine';
// delete: Delete features.
export { tool as delete } from './delete';
// edit_feature: Change a feature.
export { tool as edit_feature } from './edit_feature';
// extrude: Extrude.
export { tool as extrude } from './extrude';
// find: Find faces, edges or regions.
export { tool as find } from './find';
// get_model: Read the Part.
export { tool as get_model } from './get_model';
// help: CAD reference.
export { tool as help } from './help';
// hole: Holes.
// measure: Measure.
export { tool as measure } from './measure';
// modify: Fillet, chamfer or shell.
export { tool as modify } from './modify';
// pattern: Pattern or mirror.
export { tool as pattern } from './pattern';
// revolve: Revolve.
export { tool as revolve } from './revolve';
// set_params: Set parameters.
export { tool as set_params } from './set_params';
// sketch: Sketch.
export { tool as sketch } from './sketch';
// sweep_loft: Sweep or loft.
// undo: Undo the Assistant's steps.
export { tool as undo } from './undo';
// view: Look at the Part.
export { tool as view } from './view';
