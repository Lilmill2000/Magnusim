// The worked parts of help (example_plate, example_bracket, example_flange, example_chip;
// src/assistant/examples.ts) build on the REAL kernel, call by call as the model would send them
// (CAD tools spec §10.1, §10.2, §12.1 guide-example): every call answers ok with the key results the
// help row gives (its reply line exactly, every other key a path into its data); at the end every
// feature is ok, every sketch fully defined (dof 0), and each body's volume and box are within 1e-6
// (relative) of the part's formula:
//   plate    60 x 40 x 6 less 4 holes 5 mm across                         13,928.8 mm3
//   bracket  the L (50 x 5 and 5 x 35) x 30, the inner R4, a 6 mm hole in each flange
//   flange   a ring 80/20 x 8 less 6 holes 6.5 mm across on a 60 mm circle (6 holes found)
//   chip     Red and White, 1 solid each, Red with its sealed pocket (voids 1), overlap 0
// The guide's EXAMPLES lines are these parts abridged: each line is checked to hold the calls as
// the worked part sends them, so the guide, help and the tools cannot drift apart.
// SPDX-License-Identifier: GPL-3.0-or-later
import { afterEach, describe, expect, it } from 'vitest';
import { WORKED_PARTS, type ResultValue, type WorkedPart } from '../../src/assistant/examples';
import { GUIDE } from '../../src/assistant/guide';
import type { SketchFeature } from '../../src/types/doc';
import { assistantHarness, REAL_KERNEL_MS, type AssistantHarness } from './harness';
import type { Row } from './sketch-tools';

let h: AssistantHarness | null = null;
afterEach(() => {
  h?.dispose();
  h = null;
});

const part = (topic: WorkedPart['topic']) => WORKED_PARTS.find((p) => p.topic === topic)!;
const callOf = (topic: WorkedPart['topic'], tool: string, n = 0) => part(topic).calls.filter((c) => c.tool === tool)[n].input as Row;

/** The value at a path into a reply's data: "solver.dof", "bodies.created[0].volume_mm3", "centers_mm[1][0]". */
function valueAt(data: unknown, path: string): unknown {
  let v: unknown = data;
  for (const [, key, index] of path.matchAll(/([^.[\]]+)|\[(\d+)\]/g)) {
    if (v === null || typeof v !== 'object') return undefined;
    v = key !== undefined ? (v as Row)[key] : (v as unknown[])[Number(index)];
  }
  return v;
}

/** A reply's value against the help row's: numbers to 1e-9 (relative), else exactly. */
function same(got: unknown, want: ResultValue, what: string): void {
  if (typeof want === 'number') {
    expect(typeof got, what).toBe('number');
    expect(Math.abs((got as number) - want), `${what}: ${String(got)} vs ${want}`).toBeLessThanOrEqual(1e-9 * Math.max(1, Math.abs(want)));
  } else expect(got, what).toEqual(want);
}

/** Run a worked part's calls in order; each answers ok with the results its row gives. */
async function build(x: AssistantHarness, p: WorkedPart): Promise<void> {
  for (const c of p.calls) {
    const what = `${p.topic} ${c.about} (${c.tool})`;
    const r = await x.call(c.tool, c.input);
    if (!r.ok) throw new Error(`${what} failed: ${JSON.stringify(r.error)}`);
    const res = r.result as { text: string; data: Row };
    expect(res.text, what).toBe(c.result.text);
    for (const [path, want] of Object.entries(c.result)) if (path !== 'text') same(valueAt(res.data, path), want, `${what} ${path}`);
  }
}

/** Every feature ok, every sketch fully defined; the bodies by name, their volume and box against the formula. */
function check(x: AssistantHarness, bodies: Record<string, { volume: number; bbox: number[] }>): void {
  const s = x.doc.state.get();
  for (const f of s.doc.features) {
    expect(s.rebuild.features[f.id]?.state, f.name).toBe('ok');
    if (f.type === 'sketch') expect((f as SketchFeature).solved, f.name).toMatchObject({ state: 'fully', dof: 0 });
  }
  expect(s.rebuild.bodies.map((b) => b.name).sort()).toEqual(Object.keys(bodies).sort());
  for (const [name, want] of Object.entries(bodies)) {
    const b = s.rebuild.bodies.find((x) => x.name === name)!;
    expect(Math.abs(b.volume! - want.volume) / want.volume, `${name} volume ${b.volume} vs ${want.volume}`).toBeLessThan(1e-6);
    b.bbox.forEach((c, i) => expect(Math.abs(c - want.bbox[i]), `${name} bbox[${i}] ${c} vs ${want.bbox[i]}`).toBeLessThan(1e-6 * Math.max(1, Math.abs(want.bbox[i]))));
    expect(b.solids, `${name} solids`).toBe(1);
  }
}

/** The guide's own line for example `n` (under its EXAMPLES heading). */
const line = (n: number) => GUIDE.slice(GUIDE.indexOf('\nEXAMPLES')).split('\n').find((l) => l.startsWith(`${n} `)) ?? '';

/** A set_params call as the guide abridges it: "set_params w 60 mm, d 40 mm". */
const paramsWords = (input: Row) => `set_params ${(input.set as Row[]).map((r) => `${r.name} ${r.expr}`).join(', ')}`;

/** A sketch call as the guide abridges it: 'sketch on Top: rect r [0,0,2,1]; coincident [r.bl, origin]; distance [r.bottom] "w", [r.left] "d"'. */
function sketchWords(input: Row): string {
  const entities = (input.entities as Row[]).map((e) => `${e.kind} ${e.id} [${(e.at as number[]).join(',')}]`).join('; ');
  const groups: string[] = [];
  let last = '';
  for (const c of input.constraints as Row[]) {
    const one = `[${(c.refs as string[]).join(', ')}]${c.value ? ` "${c.value}"` : ''}`;
    if (c.kind === last) groups[groups.length - 1] += `, ${one}`;
    else groups.push(`${c.kind} ${one}`);
    last = c.kind as string;
  }
  return `sketch on ${input.on}: ${entities}${input.infer ? ', infer' : ''}; ${groups.join('; ')}`;
}

const SA = Math.PI / 9; // 20 deg
/** The chip's White: 6 spots (sa wide, r1 to r2, through t) and the ring (17 to 18 mm, dt), less the ring inside the spots. */
const WHITE = 6 * (SA / 2) * (18.5 ** 2 - 16.5 ** 2) * 3.3 + Math.PI * (18 ** 2 - 17 ** 2) * 1 - 6 * (SA / 2) * (18 ** 2 - 17 ** 2) * 1;

describe("help's worked parts on the real kernel", () => {
  it(
    "example_plate: the plate with its 4 holes (the guide's example 1)",
    async () => {
      const g = line(1);
      expect(g).toContain(paramsWords(callOf('example_plate', 'set_params')));
      expect(g).toContain(sketchWords(callOf('example_plate', 'sketch')));
      expect(g).toContain('extrude "Plate" ["all"] blind "t" new');
      expect(callOf('example_plate', 'extrude')).toMatchObject({ name: 'Plate', regions: ['all'], extent: 'blind', distance: 't', op: 'new' });
      expect(g).toContain('hole on "Plate.end": 4 centers, x "w/2 - e" or "-(w/2 - e)", y the same with d, z ""; diameter "hd"; through');
      const hole = callOf('example_plate', 'hole');
      expect(hole).toMatchObject({ face: 'Plate.end', diameter: 'hd', depth: 'through' });
      expect((hole.centers as Row[]).map((c) => [c.x, c.y, c.z])).toEqual([
        ['w/2 - e', 'd/2 - e', ''],
        ['-(w/2 - e)', 'd/2 - e', ''],
        ['-(w/2 - e)', '-(d/2 - e)', ''],
        ['w/2 - e', '-(d/2 - e)', ''],
      ]);
      h = await assistantHarness({ sketchMode: true });
      await build(h, part('example_plate'));
      // 60 x 40 x 6 less 4 x pi 2.5^2 x 6: 13,928.8 mm3.
      check(h, { Plate: { volume: 60 * 40 * 6 - 4 * Math.PI * 2.5 * 2.5 * 6, bbox: [-30, -20, 0, 30, 20, 6] } });
    },
    REAL_KERNEL_MS,
  );

  it(
    "example_bracket: the L bracket, its inner fillet and a hole in each flange (the guide's example 2)",
    async () => {
      const g = line(2);
      expect(g).toContain(sketchWords(callOf('example_bracket', 'sketch')));
      expect(g).toContain('extrude "Bracket" symmetric "wid" new');
      expect(callOf('example_bracket', 'extrude')).toMatchObject({ name: 'Bracket', extent: 'symmetric', distance: 'wid', op: 'new' });
      expect(g).toContain('modify fillet ["Bracket.side(p.3) & Bracket.side(p.4)"] "r"');
      expect(callOf('example_bracket', 'modify')).toMatchObject({ kind: 'fillet', targets: ['Bracket.side(p.3) & Bracket.side(p.4)'], size: 'r' });
      h = await assistantHarness({ sketchMode: true });
      await build(h, part('example_bracket'));
      // The L (50 x 5 and 5 x 35) times 30, the inner round adds (1 - pi/4) r^2 along 30 mm, less two
      // holes of radius 3 through 5 mm.
      check(h, { 'Body 1': { volume: (50 * 5 + 5 * 35) * 30 + (1 - Math.PI / 4) * 16 * 30 - 2 * Math.PI * 9 * 5, bbox: [0, -15, 0, 50, 15, 40] } });
    },
    REAL_KERNEL_MS,
  );

  it(
    "example_flange: the flange with its pattern of 6 holes (the guide's example 3)",
    async () => {
      const g = line(3);
      expect(g).toContain(sketchWords(callOf('example_flange', 'sketch')));
      expect(g).toContain('revolve "Flange" axis "Z axis" full new');
      expect(callOf('example_flange', 'revolve')).toMatchObject({ name: 'Flange', axis: 'Z axis', extent: 'full', op: 'new' });
      expect(g).toContain('hole on "Flange.side(r.top)" at x "pcd/2" y "0" z "" diameter "hd", then pattern circular features ["Hole 1"] about "Z axis" count "n" spacing "360 deg"');
      expect(callOf('example_flange', 'hole')).toMatchObject({ face: 'Flange.side(r.top)', centers: [{ x: 'pcd/2', y: '0', z: '' }], diameter: 'hd' });
      expect(callOf('example_flange', 'pattern')).toMatchObject({ kind: 'circular', of: 'features', items: ['Hole 1'], about: 'Z axis', count: 'n', spacing: '360 deg' });
      h = await assistantHarness({ sketchMode: true });
      await build(h, part('example_flange'));
      // n = 6 holes of 6.5 mm through the 8 mm ring, all at 30 mm from Z (replies give points to 1e-4
      // mm); the bore is the 7th hole.
      check(h, { 'Body 1': { volume: Math.PI * (40 * 40 - 10 * 10) * 8 - 6 * Math.PI * 3.25 * 3.25 * 8, bbox: [-40, -40, 0, 40, 40, 8] } });
      const rows = (await h.ok('find', { query: 'Body 1 faces hole', limit: 50 })).data.rows as { radius_mm: number; axis: { point_mm: number[] } }[];
      const fromZ = (r: (typeof rows)[number]) => Math.hypot(r.axis.point_mm[0], r.axis.point_mm[1]);
      expect(rows.map((r) => [r.radius_mm, Number(fromZ(r).toFixed(3))]).sort((a, b) => a[0] - b[0])).toEqual([...Array(6).fill([3.25, 30]), [10, 0]]);
    },
    REAL_KERNEL_MS,
  );

  it(
    'example_chip: two bodies, a sealed pocket, sector spots joined by "bodies of", no overlap',
    async () => {
      const calls = part('example_chip').calls;
      // What the topic shows: op new and combine with "bodies of", a pocket on an offset plane, sector spots, a voids check.
      expect(calls.some((c) => c.tool === 'combine' && (c.input.tools as string[]).includes('bodies of Spots'))).toBe(true);
      expect(calls.some((c) => c.tool === 'sketch' && String(c.input.on).includes(' offset '))).toBe(true);
      expect(calls.some((c) => c.tool === 'sketch' && (c.input.entities as Row[]).some((e) => e.kind === 'sector'))).toBe(true);
      expect(calls.some((c) => c.tool === 'measure' && c.result.voids === 1)).toBe(true);
      h = await assistantHarness({ sketchMode: true });
      await build(h, part('example_chip'));
      const red = Math.PI * 19.5 ** 2 * 3.3 - Math.PI * 15.975 ** 2 * 1 - WHITE;
      check(h, { Red: { volume: red, bbox: [-19.5, -19.5, 0, 19.5, 19.5, 3.3] }, White: { volume: WHITE, bbox: [-18.5, -18, 0, 18.5, 18, 3.3] } });
      // At the end: Red keeps its one sealed void, White has none, and the two do not overlap.
      expect((await h.ok('measure', { targets: ['Red'], section: '' })).data).toMatchObject({ solids: 1, voids: 1 });
      expect((await h.ok('measure', { targets: ['White'], section: '' })).data).toMatchObject({ solids: 1, voids: 0 });
      expect((await h.ok('measure', { targets: ['Red', 'White'], section: '' })).data).toMatchObject({ overlap_mm3: 0, union_solids: 1, union_voids: 1 });
    },
    2 * REAL_KERNEL_MS,
  );
});
