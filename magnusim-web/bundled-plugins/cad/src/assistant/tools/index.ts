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
// delete: Delete features.
// edit_feature: Change a feature.
export { tool as edit_feature } from './edit_feature';
// extrude: Extrude.
// find: Find faces, edges or regions.
// get_model: Read the Part.
export { tool as get_model } from './get_model';
// help: CAD reference.
export { tool as help } from './help';
// hole: Holes.
// measure: Measure.
// modify: Fillet, chamfer or shell.
// pattern: Pattern or mirror.
// revolve: Revolve.
// set_params: Set parameters.
export { tool as set_params } from './set_params';
// sketch: Sketch.
// sweep_loft: Sweep or loft.
// undo: Undo the Assistant's steps.
export { tool as undo } from './undo';
// view: Look at the Part.
