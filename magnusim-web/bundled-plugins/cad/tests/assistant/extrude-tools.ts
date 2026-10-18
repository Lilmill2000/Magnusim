// Shared pieces of the extrude and revolve tests: each tool's input with every field ("" / [] /
// false when unused), and a call that must answer ok or must fail.
// SPDX-License-Identifier: GPL-3.0-or-later
import type { AssistantHarness } from './harness';
import type { Row } from './sketch-tools';

export const EXTRUDE = (o: Row = {}): Row => ({ edit: '', name: '', sketch: '', regions: ['all'], extent: 'blind', distance: '', distance2: '', to: '', flip: false, op: 'new', bodies: [], body_name: '', color: '', ...o });
export const REVOLVE = (o: Row = {}): Row => ({ edit: '', name: '', sketch: '', regions: ['all'], axis: 'Z axis', extent: 'full', angle: '', angle2: '', flip: false, op: 'new', bodies: [], body_name: '', color: '', ...o });

export type ToolErr = { code: string; message: string; hint: string; detail: Row };

/** A call that must answer ok: its result. */
export async function ok(x: AssistantHarness, tool: string, input: Row): Promise<{ text: string; data: Row }> {
  const r = await x.call(tool, input);
  if (!r.ok) throw new Error(`${tool} failed: ${JSON.stringify(r.error)}`);
  return r.result as { text: string; data: Row };
}

/** A call that must fail: its error as the SDK sends it. */
export async function fail(x: AssistantHarness, tool: string, input: Row): Promise<ToolErr> {
  const r = await x.call(tool, input);
  if (r.ok) throw new Error(`${tool} did not fail: ${JSON.stringify(r.result).slice(0, 400)}`);
  return r.error as ToolErr;
}

/** A body's volume now (null when it is not built). */
export const volume = (x: AssistantHarness, name = 'Body 1') => x.doc.state.get().rebuild.bodies.find((b) => b.name === name)?.volume ?? null;

/** The Part's feature names in history order. */
export const names = (x: AssistantHarness) => x.doc.state.get().doc.features.map((f) => f.name);
