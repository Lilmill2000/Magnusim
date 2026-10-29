// The help tool's worked parts (CAD tools spec §10.2 example_plate, example_bracket,
// example_flange, example_chip): each one's complete calls in build order, every input whole (every
// field, "" / [] / false when unused) as the model sends it, and each call's key results as a flat
// object: `text` is the reply's line, every other key a path into the reply's data
// ("solver.dof", "bodies.created[0].volume_mm3"). tests/assistant/guide-example.test.ts runs every
// call on the real kernel and checks each result and the finished part against its formula, so
// what these say is what the tools answer. `brief` is a part's calls abridged in one line (help
// examples gives it; the guide's EXAMPLES once held them).
// Owner: ASSISTANT.
// SPDX-License-Identifier: GPL-3.0-or-later

export type ResultValue = string | number | boolean | null;

/** One call of a worked part: why, the tool, its whole input and its key results. */
export interface ExampleCall {
  about: string;
  text: string;
  tool: string;
  input: Record<string, unknown>;
  result: Record<string, ResultValue>;
}

/** A worked part: what it is, its calls, and what to check at the end. */
export interface WorkedPart {
  topic: 'example_plate' | 'example_bracket' | 'example_flange' | 'example_chip';
  /** One line for help examples. */
  title: string;
  /** Its calls abridged in one line, for help examples (guide-example.test.ts holds it to the calls). */
  brief?: string;
  /** The part, its parameters and its expected numbers (the formulas). */
  part: string;
  calls: ExampleCall[];
  /** What the finished part shows. */
  checks: string;
}

// ------------------------------------------------------------ whole inputs

type Row = Record<string, unknown>;
const P = (name: string, expr: string, comment: string, kind = 'length'): Row => ({ name, kind, expr, comment, rename_to: '' });
const PARAMS = (rows: Row[]): Row => ({ set: rows, remove: [] });
const SKETCH = (o: Row): Row => ({ edit: '', name: '', on: 'Top', entities: [], constraints: [], infer: false, ...o });
const E = (id: string, kind: string, at: number[]): Row => ({ id, kind, at, construction: false });
const C = (id: string, kind: string, refs: string[], value = ''): Row => ({ id, kind, refs, value });
const EXTRUDE = (o: Row): Row => ({ edit: '', name: '', sketch: '', regions: ['all'], face: '', direction: '', extent: 'blind', distance: '', distance2: '', to: '', flip: false, op: 'new', bodies: [], body_name: '', color: '', ...o });
const REVOLVE = (o: Row): Row => ({ edit: '', name: '', sketch: '', regions: ['all'], axis: 'Z axis', extent: 'full', angle: '', angle2: '', flip: false, op: 'new', bodies: [], body_name: '', color: '', ...o });
const HOLE = (o: Row): Row => ({ name: '', face: '', centers: [], diameter: '', depth: 'through', distance: '', ...o });
const XYZ = (x: string, y: string, z: string): Row => ({ x, y, z });
const MODIFY = (o: Row): Row => ({ edit: '', name: '', kind: 'fillet', targets: [], size: '', size2: '', flip: false, inward: false, ...o });
const PATTERN = (o: Row): Row => ({ edit: '', name: '', kind: 'circular', of: 'features', items: [], about: '', count: '', spacing: '', flip: false, about2: '', count2: '', spacing2: '', options: [], skip: [], op: 'source', bodies: [], ...o });
const COMBINE = (o: Row): Row => ({ edit: '', name: '', op: 'join', targets: [], tools: [], keep_tools: false, ...o });
const MEASURE = (targets: string[], section = ''): Row => ({ targets, section });
const FIND = (query: string, limit = 10): Row => ({ query, limit });

// ------------------------------------------------------------ the parts

const PLATE: WorkedPart = {
  topic: 'example_plate',
  brief: 'set_params w 60 mm, d 40 mm, t 6 mm, hd 5 mm, e 8 mm. sketch on Top: center_rect r [0,0,60,40]; coincident [r.center, origin]; distance [r.bottom] "w", [r.left] "d". extrude "Plate" ["all"] blind "t" new. hole on "Plate.end": 4 centers, x "w/2 - e" or "-(w/2 - e)", y the same with d, z ""; diameter "hd"; through.',
  title: 'A 60 x 40 x 6 mm plate with 4 through holes 5 mm across, 8 mm from its edges, all from parameters',
  part: 'Plan: parameters w 60 mm, d 40 mm, t 6 mm, hd 5 mm, e 8 mm; a centred rectangle on Top, extruded t as the body Plate; 4 holes in its top face. Expect 1 body, 1 solid, 0 voids, volume w*d*t - 4*pi*(hd/2)^2*t = 13928.8 mm3, box 60 x 40 x 6 mm (x and y from -30 and -20, z from 0).',
  calls: [
    {
      about: 'call 1',
      text: 'Every size as a parameter, with units.',
      tool: 'set_params',
      input: PARAMS([P('w', '60 mm', 'width'), P('d', '40 mm', 'depth'), P('t', '6 mm', 'thickness'), P('hd', '5 mm', 'hole diameter'), P('e', '8 mm', 'hole centre to edge')]),
      result: { text: 'Parameters set: w = 60 mm, d = 40 mm, t = 6 mm (+2 more)', 'params[4].value': 8 },
    },
    {
      about: 'call 2',
      text: 'The outline: the rectangle anchored at its centre and sized by w and d, so dof is 0.',
      tool: 'sketch',
      input: SKETCH({ name: 'Plate sketch', entities: [E('r', 'center_rect', [0, 0, 60, 40])], constraints: [C('c', 'coincident', ['r.center', 'origin']), C('dw', 'distance', ['r.bottom'], 'w'), C('dd', 'distance', ['r.left'], 'd')] }),
      result: { text: 'Sketch "Plate sketch" on Top: fully defined, 1 region (2400 mm²)', 'solver.dof': 0, 'regions[0].id': 'r1', 'plane.words': 'u runs +X, v runs +Y, origin (0, 0, 0)' },
    },
    {
      about: 'call 3',
      text: 'Up t along +Z as a new body named Plate (the feature may share the name).',
      tool: 'extrude',
      input: EXTRUDE({ name: 'Plate', sketch: 'Plate sketch', distance: 't', body_name: 'Plate' }),
      result: { text: 'Extrude Plate ok · Plate made (14400 mm³)', 'feature.state': 'ok', 'bodies.created[0].volume_mm3': 14400, 'bodies.created[0].solids': 1 },
    },
    {
      about: 'call 4',
      text: 'Plate.end is the top face (+Z, z 6): the centres in model x and y, z "" on it. The hole sketch dimensions them from the face origin, so they follow w, d and e.',
      tool: 'hole',
      input: HOLE({ face: 'Plate.end', centers: [XYZ('w/2 - e', 'd/2 - e', ''), XYZ('-(w/2 - e)', 'd/2 - e', ''), XYZ('-(w/2 - e)', '-(d/2 - e)', ''), XYZ('w/2 - e', '-(d/2 - e)', '')], diameter: 'hd' }),
      result: { text: 'Hole 1 ok: 4 holes 5 mm across, through, in Plate.end · Plate 14400 → 13929 mm³', 'made[0]': 'Hole 1 sketch', 'made[1]': 'Hole 1', 'centers_mm[1][0]': -22, 'dimensions.h2x': '-(w/2 - e)', 'bodies.changed[0].volume_mm3[1]': 13928.8 },
    },
    {
      about: 'call 5',
      text: 'The numbers against the plan: volume, solids and voids.',
      tool: 'measure',
      input: MEASURE(['Plate']),
      result: { text: 'Plate: volume 13928.8 mm3, 1 solid, 0 voids', volume_mm3: 13928.8, solids: 1, voids: 0, 'bbox_mm[1][2]': 6 },
    },
    {
      about: 'call 6',
      text: 'A section half way up shows the 4 holes.',
      tool: 'measure',
      input: MEASURE(['Plate'], 'Top offset t/2'),
      result: { text: 'Plate cut at Top offset t/2: area 2321.46 mm2 in 1 piece, 4 holes', 'section.area_mm2': 2321.46, 'section.holes': 4 },
    },
  ],
  checks: 'Every feature ok, both sketches dof 0, 1 solid, 0 voids, 13928.8 mm3. Then view iso. To make the holes 6 mm: set_params hd "6 mm" (every hole follows).',
};

const BRACKET: WorkedPart = {
  brief: 'sketch on Front: polyline p [0,0,50,0,50,5,5,5,5,40,0,40,0,0], infer; coincident [p.p0, origin]; distance [p.1] "a", [p.6] "b", [p.2] "t", [p.5] "t". extrude "Bracket" symmetric "wid" new. modify fillet ["Bracket.side(p.3) & Bracket.side(p.4)"] "r".',
  topic: 'example_bracket',
  title: 'An L bracket 50 x 40, 5 thick, 30 wide, an inner fillet R4 and a 6 mm hole in each flange',
  part: 'Plan: parameters a 50 mm, b 40 mm, t 5 mm, wid 30 mm, r 4 mm, hd 6 mm; the L as a closed polyline on Front (u +X, v +Z), extruded symmetric wid (y from -15 to 15); the inner corner rounded; one hole down through the foot, one across through the upright. Expect 1 solid, volume (a*t + t*(b - t))*wid + (1 - pi/4)*r^2*wid - 2*pi*(hd/2)^2*t = 12570.3 mm3, box 50 x 30 x 40 mm.',
  calls: [
    {
      about: 'call 1',
      text: 'The sizes.',
      tool: 'set_params',
      input: PARAMS([P('a', '50 mm', 'foot length'), P('b', '40 mm', 'upright height'), P('t', '5 mm', 'thickness'), P('wid', '30 mm', 'width'), P('r', '4 mm', 'inner fillet'), P('hd', '6 mm', 'hole diameter')]),
      result: { text: 'Parameters set: a = 50 mm, b = 40 mm, t = 5 mm (+3 more)', 'params[5].value': 6 },
    },
    {
      about: 'call 2',
      text: 'The L: p0 (0,0), p1 (50,0), p2 (50,5), p3 (5,5), p4 (5,40), p5 (0,40), back to p0. Side p.k runs from p.p(k-1) to p.pk: p.1 the bottom, p.2 the foot end, p.3 the foot top, p.4 the inner upright face, p.5 the upright top, p.6 the outer face. infer adds the 6 horizontals and verticals; the anchor and 4 lengths make dof 0.',
      tool: 'sketch',
      input: SKETCH({ name: 'L profile', on: 'Front', entities: [E('p', 'polyline', [0, 0, 50, 0, 50, 5, 5, 5, 5, 40, 0, 40, 0, 0])], constraints: [C('o', 'coincident', ['p.p0', 'origin']), C('da', 'distance', ['p.1'], 'a'), C('db', 'distance', ['p.6'], 'b'), C('t1', 'distance', ['p.2'], 't'), C('t2', 'distance', ['p.5'], 't')], infer: true }),
      result: { text: 'Sketch "L profile" on Front: fully defined, 1 region (425 mm²)', 'solver.dof': 0, 'inferred[5]': 'vertical p.6', 'plane.words': 'u runs +X, v runs +Z, origin (0, 0, 0)' },
    },
    {
      about: 'call 3',
      text: 'Half the width each side of Front. Its side faces are named by the polyline sides: Bracket.side(p.3) is the foot top.',
      tool: 'extrude',
      input: EXTRUDE({ name: 'Bracket', sketch: 'L profile', extent: 'symmetric', distance: 'wid' }),
      result: { text: 'Extrude Bracket ok · Body 1 made (12750 mm³)', 'bodies.created[0].body': 'Body 1', 'bodies.created[0].volume_mm3': 12750 },
    },
    {
      about: 'call 4',
      text: 'The inner corner is the edge between the foot top and the inner upright face.',
      tool: 'modify',
      input: MODIFY({ targets: ['Bracket.side(p.3) & Bracket.side(p.4)'], size: 'r' }),
      result: { text: 'Fillet 1 ok: 1 edge (a fixed set) on Body 1 · Body 1 12750 → 12853 mm³', 'edges.rounded': 1 },
    },
    {
      about: 'call 5',
      text: 'The foot top faces +Z at z 5: x half way along the foot, y 0, z "".',
      tool: 'hole',
      input: HOLE({ face: 'Bracket.side(p.3)', centers: [XYZ('(a + t)/2', '0', '')], diameter: 'hd' }),
      result: { text: 'Hole 1 ok: 1 hole 6 mm across, through, in Bracket.side(p.3) · Body 1 12853 → 12712 mm³', 'centers_mm[0][0]': 27.5, 'dimensions.h1x': '(a + t)/2' },
    },
    {
      about: 'call 6',
      text: 'The outer upright face faces -X at x 0, where u runs +Y and v runs -Z: give x "" and the model z; hole writes h1y as -((b + t)/2) for you.',
      tool: 'hole',
      input: HOLE({ face: 'Bracket.side(p.6)', centers: [XYZ('', '0', '(b + t)/2')], diameter: 'hd' }),
      result: { text: 'Hole 2 ok: 1 hole 6 mm across, through, in Bracket.side(p.6) · Body 1 12712 → 12570 mm³', 'resolved.frame': 'u runs +Y, v runs -Z, origin (0, 0, 0)', 'centers_mm[0][2]': 22.5, 'dimensions.h1y': '-((b + t)/2)' },
    },
    {
      about: 'call 7',
      text: 'The numbers.',
      tool: 'measure',
      input: MEASURE(['Body 1']),
      result: { text: 'Body 1: volume 12570.3 mm3, 1 solid, 0 voids', volume_mm3: 12570.3, solids: 1 },
    },
    {
      about: 'call 8',
      text: 'Both holes, by query.',
      tool: 'find',
      input: FIND('Body 1 faces hole'),
      result: { text: 'find "Body 1 faces hole": 2 faces', count: 2, 'rows[0].radius_mm': 3 },
    },
  ],
  checks: 'Every feature ok, every sketch dof 0, 1 solid, 12570.3 mm3, 2 holes of radius 3. Then view iso.',
};

const FLANGE: WorkedPart = {
  brief: 'sketch on Front: rect r [10,0,40,8]; horizontal [r.bl, origin]; distance_x [origin, r.bl] "bore/2", [origin, r.br] "od/2"; distance [r.left] "t". revolve "Flange" axis "Z axis" full new. hole on "Flange.side(r.top)" at x "pcd/2" y "0" z "" diameter "hd", then pattern circular features ["Hole 1"] about "Z axis" count "n" spacing "360 deg".',
  topic: 'example_flange',
  title: 'A flange 80 across and 8 thick with a 20 mm bore and 6 holes 6.5 mm across on a 60 mm circle',
  part: 'Plan: parameters od 80 mm, bore 20 mm, t 8 mm, pcd 60 mm, hd 6.5 mm, n 6 (a number); its half section as a rectangle on Front, from x bore/2 to od/2 and z 0 to t, revolved a full turn about the Z axis; one hole on the top face at radius pcd/2, repeated n times round Z. Expect 1 solid, volume pi*((od/2)^2 - (bore/2)^2)*t - n*pi*(hd/2)^2*t = 36106.3 mm3, box 80 x 80 x 8 mm.',
  calls: [
    {
      about: 'call 1',
      text: 'The sizes; n has kind number.',
      tool: 'set_params',
      input: PARAMS([P('od', '80 mm', 'outer diameter'), P('bore', '20 mm', 'bore diameter'), P('t', '8 mm', 'thickness'), P('pcd', '60 mm', 'hole circle diameter'), P('hd', '6.5 mm', 'hole diameter'), P('n', '6', 'hole count', 'number')]),
      result: { text: 'Parameters set: od = 80 mm, bore = 20 mm, t = 8 mm (+3 more)', 'params[5].value': 6 },
    },
    {
      about: 'call 2',
      text: 'The half section beside the Z axis: its bottom on the origin line (horizontal), its inner and outer edges at bore/2 and od/2 from the origin, its height t.',
      tool: 'sketch',
      input: SKETCH({ name: 'Flange sketch', on: 'Front', entities: [E('r', 'rect', [10, 0, 40, 8])], constraints: [C('hz', 'horizontal', ['r.bl', 'origin']), C('ib', 'distance_x', ['origin', 'r.bl'], 'bore/2'), C('io', 'distance_x', ['origin', 'r.br'], 'od/2'), C('th', 'distance', ['r.left'], 't')] }),
      result: { text: 'Sketch "Flange sketch" on Front: fully defined, 1 region (240 mm²)', 'solver.dof': 0 },
    },
    {
      about: 'call 3',
      text: 'A full turn about Z; the rectangle stays on one side of the axis.',
      tool: 'revolve',
      input: REVOLVE({ name: 'Flange', sketch: 'Flange sketch' }),
      result: { text: 'Revolve Flange ok · Body 1 made (37699 mm³)', 'bodies.created[0].volume_mm3': 37699.1 },
    },
    {
      about: 'call 4',
      text: 'Flange.side(r.top) is the top face (+Z, z 8): one hole at x pcd/2, y 0.',
      tool: 'hole',
      input: HOLE({ face: 'Flange.side(r.top)', centers: [XYZ('pcd/2', '0', '')], diameter: 'hd' }),
      result: { text: 'Hole 1 ok: 1 hole 6.5 mm across, through, in Flange.side(r.top) · Body 1 37699 → 37434 mm³', 'centers_mm[0][0]': 30 },
    },
    {
      about: 'call 5',
      text: 'n copies all round (the original counts): 360 deg spreads them evenly. op source repeats the hole\'s own cut.',
      tool: 'pattern',
      input: PATTERN({ items: ['Hole 1'], about: 'Z axis', count: 'n', spacing: '360 deg' }),
      result: { text: 'Circular pattern 1 ok: 5 copies of Hole 1 · Body 1 37434 → 36106 mm³', 'copies.made': 5 },
    },
    {
      about: 'call 6',
      text: 'The numbers.',
      tool: 'measure',
      input: MEASURE(['Body 1']),
      result: { text: 'Body 1: volume 36106.3 mm3, 1 solid, 0 voids', volume_mm3: 36106.3, solids: 1 },
    },
    {
      about: 'call 7',
      text: 'The holes by size (a radius filter takes parameters).',
      tool: 'find',
      input: FIND('Body 1 faces hole radius hd/2'),
      result: { text: 'find "Body 1 faces hole radius hd/2": 6 faces', count: 6 },
    },
  ],
  checks: 'Every feature ok, the sketch dof 0, 1 solid, 36106.3 mm3, 6 holes of radius 3.25 at 30 mm from Z. To make 8 holes: set_params n "8".',
};

const CHIP: WorkedPart = {
  topic: 'example_chip',
  title: 'A two-colour chip: a red disc 39 x 3.3 mm with a sealed pocket for a 1.25 in x 1 mm insert, and white edge spots held by a hidden ring',
  part: 'Plan: parameters d 39 mm, t 3.3 mm, disc 1.25 in, gap 0.2 mm, dt 1 mm, floor (t - dt)/2, r1 16.5 mm, r2 18.5 mm, sa 20 deg, n 6. Red: a disc d x t with a pocket disc + gap across and dt deep inside it (sealed: voids 1). White: n ring-piece spots (r1 to r2, sa wide) through the chip, joined by a ring at mid thickness, then cut out of Red. Expect 2 bodies of 1 solid each, overlap 0, Red voids 1, White 315.206 mm3, Red pi*(d/2)^2*t - pi*((disc + gap)/2)^2*dt - White = 2825.21 mm3.',
  calls: [
    {
      about: 'call 1',
      text: 'The sizes; an inch value converts (disc reads 31.75 mm); floor is worked out from the others.',
      tool: 'set_params',
      input: PARAMS([
        P('d', '39 mm', 'chip diameter'),
        P('t', '3.3 mm', 'chip thickness'),
        P('disc', '1.25 in', 'insert diameter'),
        P('gap', '0.2 mm', 'diametral clearance'),
        P('dt', '1 mm', 'insert thickness'),
        P('floor', '(t - dt)/2', 'pocket floor'),
        P('r1', '16.5 mm', 'spot inner radius'),
        P('r2', '18.5 mm', 'spot outer radius'),
        P('sa', '20 deg', 'spot angle', 'angle'),
        P('n', '6', 'spots', 'number'),
      ]),
      result: { text: 'Parameters set: d = 39 mm, t = 3.3 mm, disc = 31.75 mm (+7 more)', 'params[5].value': 1.15 },
    },
    {
      about: 'call 2',
      text: 'The chip outline.',
      tool: 'sketch',
      input: SKETCH({ name: 'Chip sketch', entities: [E('c', 'circle', [0, 0, 19.5])], constraints: [C('o', 'coincident', ['c.center', 'origin']), C('dc', 'diameter', ['c'], 'd')] }),
      result: { text: 'Sketch "Chip sketch" on Top: fully defined, 1 region (1194.59 mm²)', 'solver.dof': 0 },
    },
    {
      about: 'call 3',
      text: 'The red body, named and coloured.',
      tool: 'extrude',
      input: EXTRUDE({ name: 'Red', sketch: 'Chip sketch', distance: 't', body_name: 'Red', color: '#c0392b' }),
      result: { text: 'Extrude Red ok · Red made (3942 mm³)', 'bodies.created[0].volume_mm3': 3942.15 },
    },
    {
      about: 'call 4',
      text: 'The pocket floor is inside the chip: sketch on an offset plane (it makes "Pocket sketch plane").',
      tool: 'sketch',
      input: SKETCH({ name: 'Pocket sketch', on: 'Top offset floor', entities: [E('p', 'circle', [0, 0, 16])], constraints: [C('o', 'coincident', ['p.center', 'origin']), C('dp', 'diameter', ['p'], 'disc + gap')] }),
      result: { text: 'Sketch "Pocket sketch" on Pocket sketch plane: fully defined, 1 region (801.736 mm²)', 'plane.origin_mm[2]': 1.15 },
    },
    {
      about: 'call 5',
      text: 'Cut dt up from the floor, Red only: it stays inside, so the pocket is sealed.',
      tool: 'extrude',
      input: EXTRUDE({ name: 'Pocket', sketch: 'Pocket sketch', distance: 'dt', op: 'cut', bodies: ['Red'] }),
      result: { text: 'Extrude Pocket ok · Red 3942 → 3140 mm³', 'bodies.changed[0].volume_mm3[1]': 3140.41 },
    },
    {
      about: 'call 6',
      text: 'The void check: shells 2 alone could also be two solids; voids 1 is one sealed void.',
      tool: 'measure',
      input: MEASURE(['Red']),
      result: { text: 'Red: volume 3140.41 mm3, 1 solid, 1 void', solids: 1, shells: 2, voids: 1 },
    },
    {
      about: 'call 7',
      text: 'One spot: a sector anchored at the origin, its radii r1 and r2, its start line at -sa/2 from +u and sa between its two lines (6 dof, all set).',
      tool: 'sketch',
      input: SKETCH({ name: 'Spot sketch', entities: [E('s', 'sector', [0, 0, 16.5, 18.5, -10, 10])], constraints: [C('o', 'coincident', ['s.center', 'origin']), C('ri', 'radius', ['s.inner'], 'r1'), C('ro', 'radius', ['s.outer'], 'r2'), C('a0', 'angle', ['s.start'], '-sa/2'), C('aw', 'angle', ['s.start', 's.end'], 'sa')] }),
      result: { text: 'Sketch "Spot sketch" on Top: fully defined, 1 region (12.2173 mm²)', 'solver.dof': 0 },
    },
    {
      about: 'call 8',
      text: 'The spot through the chip as its own body (op new: it may overlap Red for now).',
      tool: 'extrude',
      input: EXTRUDE({ name: 'Spot', sketch: 'Spot sketch', distance: 't', body_name: 'White', color: '#f2f2f2' }),
      result: { text: 'Extrude Spot ok · White made (40 mm³)', 'bodies.created[0].body': 'White' },
    },
    {
      about: 'call 9',
      text: 'n spots round Z as new bodies "White (Instance k)": the pattern\'s bodies.',
      tool: 'pattern',
      input: PATTERN({ name: 'Spots', of: 'bodies', items: ['White'], about: 'Z axis', count: 'n', spacing: '360 deg', op: 'new' }),
      result: { text: 'Spots ok: 5 copies of White · White (Instance 2) made (40 mm³)', 'copies.made': 5, 'bodies.created[4].body': 'White (Instance 6)' },
    },
    {
      about: 'call 10',
      text: 'A ring at mid thickness through every spot (the same offset plane is used again). Concentric circles drawn at one centre share it: anchor it once. "all" keeps the inner disc open, so the region is the ring.',
      tool: 'sketch',
      input: SKETCH({ name: 'Ring sketch', on: 'Top offset floor', entities: [E('a', 'circle', [0, 0, 17]), E('b', 'circle', [0, 0, 18])], constraints: [C('o', 'coincident', ['a.center', 'origin']), C('ra', 'radius', ['a'], 'r1 + 0.5 mm'), C('rb', 'radius', ['b'], 'r2 - 0.5 mm')] }),
      result: { text: 'Sketch "Ring sketch" on Pocket sketch plane: fully defined, 2 regions (largest 907.92 mm²)', 'joined[0]': 'a.center = b.center', 'solver.dof': 0 },
    },
    {
      about: 'call 11',
      text: 'The ring as a body of its own.',
      tool: 'extrude',
      input: EXTRUDE({ name: 'Ring', sketch: 'Ring sketch', distance: 'dt', body_name: 'Ring' }),
      result: { text: 'Extrude Ring ok · Ring made (110 mm³)', 'bodies.created[0].volume_mm3': 109.956 },
    },
    {
      about: 'call 12',
      text: 'White joins the ring and the copies: each touches the ring, so White is one solid.',
      tool: 'combine',
      input: COMBINE({ targets: ['White'], tools: ['Ring', 'bodies of Spots'] }),
      result: { text: 'Combine 1 ok: joined Ring, White (Instance 2), White (Instance 3), White (Instance 4), White (Instance 5) and White (Instance 6) to White · White 40 → 315 mm³', 'bodies.changed[0].solids[1]': 1 },
    },
    {
      about: 'call 13',
      text: 'White out of Red, keeping White: the two no longer overlap.',
      tool: 'combine',
      input: COMBINE({ op: 'cut', targets: ['Red'], tools: ['White'], keep_tools: true }),
      result: { text: 'Combine 2 ok: cut White from Red · Red 3140 → 2825 mm³', 'bodies.changed[0].volume_mm3[1]': 2825.21 },
    },
    {
      about: 'call 14',
      text: 'The pair: no interference, and together one solid with the one sealed void.',
      tool: 'measure',
      input: MEASURE(['Red', 'White']),
      result: { text: 'Red to White: distance 0 mm, overlap 0 mm3, joined 1 solid and 1 void', overlap_mm3: 0, touching: true, union_solids: 1, union_voids: 1 },
    },
  ],
  checks: 'Every feature ok, every sketch dof 0, 2 bodies (Red, White) of 1 solid each, Red voids 1, overlap 0, White 315.206 mm3, Red 2825.21 mm3. Then view iso and a section ("Top offset t/2") to see the pocket and the ring.',
};

/** The worked parts, in the order help examples lists them. */
export const WORKED_PARTS: readonly WorkedPart[] = Object.freeze([PLATE, BRACKET, FLANGE, CHIP]);
