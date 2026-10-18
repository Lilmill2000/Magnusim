// @vitest-environment node
// The CAD notes the Part registers with its tools, and help's text (CAD tools spec §10.1, §10.2):
// the guide is at most 3950 characters (the app keeps 4000), ASCII, LF line breaks, unchanged by
// the bridge's cleaning; its facts are what the code does (the planes as ORIGIN_PLANES, the six
// axis faces as faceFrame makes them, the 0.05 mm join, the parts of each kind it names); every
// tool, field, value and help topic the guide and help name exists in schemas.ts (and every other
// snake_case word is a reason or a reply key the tools give); every worked part's input is valid
// for its tool's schema (all fields, types, values, sizes) and every selector in it reads; the
// guide says how a file is made (Export STEP) and how busy answers end a turn; no vendor names
// and no project data. The worked parts are built on the real kernel in guide-example.test.ts.
// The guide of a Part that offers only some tools (the eval's core set, guideWithout): it names
// none of the others but in the one line that lists them, and is the guide otherwise.
// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { HINTS, REASONS } from '../../src/assistant/errors';
import { WORKED_PARTS } from '../../src/assistant/examples';
import { GUIDE, GUIDE_TOOL_WORDS, guideWithout, notOfferedLine } from '../../src/assistant/guide';
import { HELP } from '../../src/assistant/help';
import { CAD_TOOLS, CORE_TOOLSET, HELP_TOPICS, TOOL_NAMES, toolNamed } from '../../src/assistant/schemas';
import { parseSelector, type KnownNames, type Want } from '../../src/assistant/selectors/parse';
import { expandEntity, JOIN_TOL, type EntityKind } from '../../src/assistant/sketch/macros';
import { faceFrame, ydirOf } from '../../src/features/sketch/plane';
import { ORIGIN_PLANES, type PlaneFrame, type Vec3 } from '../../src/types/doc';
import { namesVendor } from './vendor';

/** The controls the bridge turns into spaces (all but LF and tab), with the two Unicode line breaks. */
const CONTROLS = new RegExp(`[${[[0, 8], [11, 12], [14, 31], [127, 159], [0x2028, 0x2029]].map(([a, b]) => `${String.fromCharCode(a)}-${String.fromCharCode(b)}`).join('')}]`, 'g');

/** The bridge's cleaning of a guide (src/workspace/bridge.ts checkAssistantTools): lines and tabs kept, other controls a space, trimmed, 4000 characters. */
const bridgeClean = (g: string) =>
  g
    .replace(/\r\n?/g, '\n')
    .replace(CONTROLS, ' ')
    .trim()
    .slice(0, 4000);

/** "+X" for a unit axis vector. */
const axis = (v: readonly number[]) => {
  const i = [0, 1, 2].find((k) => Math.abs(Math.abs(v[k]) - 1) < 1e-9)!;
  return `${v[i] > 0 ? '+' : '-'}${'XYZ'[i]}`;
};
const frameText = (p: PlaneFrame) => `u${axis(p.xdir)} v${axis(ydirOf(p))}`;

type S = { type?: string; enum?: string[]; properties?: Record<string, S>; required?: string[]; additionalProperties?: boolean; items?: S; minLength?: number; maxLength?: number; minimum?: number; maximum?: number; minItems?: number; maxItems?: number };

/** Every problem of `v` against `s`, in the subset the tools' schemas use (the app's validateInput rules). */
function problems(s: S, v: unknown, path: string, out: string[] = []): string[] {
  const kind = Array.isArray(v) ? 'array' : v === null ? 'null' : typeof v;
  if (s.type === 'integer' ? !Number.isInteger(v) : s.type === 'number' ? typeof v !== 'number' || !Number.isFinite(v) : kind !== s.type) {
    out.push(`${path} is ${kind}, not ${s.type}`);
    return out;
  }
  if (s.enum && !s.enum.includes(v as string)) out.push(`${path} "${String(v)}" is not one of ${s.enum.join(', ')}`);
  if (typeof v === 'string') {
    if (s.minLength !== undefined && v.length < s.minLength) out.push(`${path} is shorter than ${s.minLength}`);
    if (s.maxLength !== undefined && v.length > s.maxLength) out.push(`${path} is longer than ${s.maxLength}`);
  }
  if (typeof v === 'number') {
    if (s.minimum !== undefined && v < s.minimum) out.push(`${path} is below ${s.minimum}`);
    if (s.maximum !== undefined && v > s.maximum) out.push(`${path} is above ${s.maximum}`);
  }
  if (Array.isArray(v)) {
    if (s.minItems !== undefined && v.length < s.minItems) out.push(`${path} has fewer than ${s.minItems} items`);
    if (s.maxItems !== undefined && v.length > s.maxItems) out.push(`${path} has more than ${s.maxItems} items`);
    v.forEach((x, i) => problems(s.items!, x, `${path}[${i}]`, out));
  }
  if (kind === 'object') {
    const o = v as Record<string, unknown>;
    for (const k of s.required ?? []) if (!(k in o)) out.push(`${path} is missing ${k}`);
    for (const k of Object.keys(o)) {
      if (!s.properties?.[k]) out.push(`${path}.${k} is not a field`);
      else problems(s.properties[k], o[k], `${path}.${k}`, out);
    }
  }
  return out;
}

/** Every field name at every depth of every tool, and every value of every enum. */
const FIELDS = new Set<string>();
const VALUES = new Map<string, Set<string>>();
for (const t of CAD_TOOLS) {
  const walk = (s: S, at: string) => {
    if (s.enum) VALUES.set(at, new Set(s.enum));
    for (const [k, x] of Object.entries(s.properties ?? {})) {
      FIELDS.add(k);
      walk(x, `${at}.${k}`);
    }
    if (s.items) walk(s.items, `${at}[]`);
  };
  walk(t.inputSchema as unknown as S, t.name);
}
const ALL_VALUES = new Set([...VALUES.values()].flatMap((s) => [...s]));
const value = (at: string, v: string) => expect(VALUES.get(at), at).toContain(v);

/** Reply keys the guide and help name (each one a key the tools' replies carry). */
const REPLY_KEYS = ['dropped_inferred', 'user_changes', 'made_by', 'kept_as', 'overlap_mm3', 'union_solids', 'union_voids', 'point_mm', 'centroid_mm', 'params_cut'];

/** Every text of help, and the guide. */
const helpTexts = () => Object.values(HELP).flatMap((rows) => rows.flatMap((r) => [r.about, r.text]));

describe('the CAD guide', () => {
  it('is at most 3950 characters of ASCII with LF line breaks, as the bridge keeps it', () => {
    expect(GUIDE.length).toBeLessThanOrEqual(3950);
    expect(GUIDE).toMatch(/^[\x20-\x7e\n]*$/);
    expect(GUIDE).not.toContain('\r');
    expect(bridgeClean(GUIDE)).toBe(GUIDE);
  });

  it('states the origin planes as ORIGIN_PLANES has them', () => {
    const line = GUIDE.split('\n').find((l) => l.startsWith('- Planes:'))!;
    const want = (['origin:top', 'origin:front', 'origin:right'] as const).map((id, i) => `${['Top', 'Front', 'Right'][i]} n${axis(ORIGIN_PLANES[id].normal)} ${frameText(ORIGIN_PLANES[id])}`);
    expect(line).toBe(`- Planes: ${want.join('; ')}.`);
  });

  it('states the six axis faces as faceFrame makes them (outward normal, u, v)', () => {
    const line = GUIDE.split('\n').find((l) => l.startsWith('- Faces by outward n:'))!;
    const normals: Vec3[] = [
      [0, 0, 1],
      [0, 0, -1],
      [0, 1, 0],
      [0, -1, 0],
      [1, 0, 0],
      [-1, 0, 0],
    ];
    const want = normals.map((n) => `${axis(n)} ${frameText(faceFrame(n, [3, 4, 5]))}`);
    expect(line.startsWith(`- Faces by outward n: ${want.join('; ')}.`)).toBe(true);
    // The origin of a face's frame: the model origin projected onto it.
    expect(faceFrame([0, 0, 1], [10, 20, 6]).origin).toEqual([0, 0, 6]);
    expect(faceFrame([-1, 0, 0], [-5, 3, 2]).origin).toEqual([-5, 0, 0]);
  });

  it("states the sketch tool's join and the parts it names as the macros make them", () => {
    expect(GUIDE).toContain(`- Ends within ${JOIN_TOL} mm are joined.`);
    const parts = (kind: EntityKind, at: number[]) => {
      const r = expandEntity('x', kind, at, false);
      if (!r.ok) throw new Error(r.problem);
      return Object.keys(r.macro.parts);
    };
    const line = GUIDE.split('\n').find((l) => l.startsWith('- Parts:'))!;
    expect(line).toBe('- Parts: l.start l.end c.center a.end r.top r.bl r.center origin; polyline p: points p.p0, p.p1...; side p.k runs from p.p(k-1) to p.pk.');
    expect(parts('line', [0, 0, 1, 0])).toEqual(expect.arrayContaining(['start', 'end']));
    expect(parts('circle', [0, 0, 1])).toContain('center');
    expect(parts('arc', [0, 0, 1, 0, 90])).toContain('end');
    expect(parts('rect', [0, 0, 2, 1])).toEqual(expect.arrayContaining(['top', 'bl']));
    expect(parts('center_rect', [0, 0, 2, 1])).toContain('center');
    // A closed polyline of 3 corners: points p0..p2, side k from p(k-1) to pk (the last back to p0).
    const tri = expandEntity('p', 'polyline', [0, 0, 4, 0, 4, 3, 0, 0], false);
    if (!tri.ok) throw new Error(tri.problem);
    expect(Object.keys(tri.macro.parts).sort()).toEqual(['1', '2', '3', 'p0', 'p1', 'p2']);
    const side = (k: string) => tri.macro.entities.find((e) => e.id === tri.macro.parts[k]) as unknown as { p: string[] };
    expect(side('1').p).toEqual([tri.macro.parts.p0, tri.macro.parts.p1]);
    expect(side('3').p).toEqual([tri.macro.parts.p2, tri.macro.parts.p0]);
  });

  it('names only tools, fields, values and help topics that exist', () => {
    const tools = ['get_model', 'set_params', 'sketch', 'extrude', 'hole', 'measure', 'view', 'find', 'modify', 'pattern', 'combine', 'undo', 'edit_feature', 'revolve', 'delete'];
    for (const t of tools) expect(GUIDE, t).toMatch(new RegExp(`\\b${t}\\b`));
    for (const t of tools) expect(TOOL_NAMES).toContain(t);
    for (const m of GUIDE.matchAll(/\bhelp ([a-z_]+)/g)) expect([...HELP_TOPICS], m[0]).toContain(m[1]);
    // The fields and values the guide's text and examples use, each in its tool's schema.
    for (const [tool, field] of [
      ['get_model', 'detail'],
      ['sketch', 'on'],
      ['sketch', 'infer'],
      ['sketch', 'edit'],
      ['extrude', 'regions'],
      ['extrude', 'flip'],
      ['extrude', 'op'],
      ['revolve', 'axis'],
      ['hole', 'centers'],
      ['hole', 'diameter'],
      ['find', 'query'],
      ['pattern', 'count'],
      ['pattern', 'spacing'],
    ] as const)
      expect(Object.keys(toolNamed(tool)!.inputSchema.properties), `${tool}.${field}`).toContain(field);
    value('get_model.detail', 'full');
    for (const v of ['blind', 'symmetric']) value('extrude.extent', v);
    value('extrude.op', 'new');
    value('revolve.extent', 'full');
    value('hole.depth', 'through');
    value('modify.kind', 'fillet');
    value('pattern.kind', 'circular');
    value('pattern.of', 'features');
    for (const k of ['center_rect', 'polyline', 'rect', 'sector']) value('sketch.entities[].kind', k);
    for (const k of ['coincident', 'distance', 'horizontal', 'distance_x']) value('sketch.constraints[].kind', k);
    for (const k of ['join', 'cut', 'intersect']) value('combine.op', k);
    // Every help topic the guide and help point to exists.
    for (const t of [GUIDE, ...helpTexts()]) for (const m of t.matchAll(/\bhelp ([a-z_]+)/g)) expect([...HELP_TOPICS], m[0]).toContain(m[1]);
  });

  it('every snake_case word in the guide and help is a tool, a field, a value, an error code or reason, or a reply key', () => {
    const known = new Set([...TOOL_NAMES, ...FIELDS, ...ALL_VALUES, ...Object.keys(REASONS), ...Object.keys(HINTS), ...REPLY_KEYS]);
    const unknown = new Set<string>();
    for (const t of [GUIDE, ...helpTexts()]) for (const m of t.matchAll(/(?<![\w.#])([a-z][a-z0-9]*_[a-z0-9_]*[a-z0-9])(?!\w)/g)) if (!known.has(m[1])) unknown.add(m[1]);
    expect([...unknown]).toEqual([]);
  });

  it('says how a file is made, how busy ends a turn, and that delete asks the person', () => {
    expect(GUIDE).toContain('Files: the person uses Export STEP.');
    expect(GUIDE).toContain('busy: the person comes first: follow the hint; most end your turn.');
    expect(GUIDE).toContain('delete asks the person');
    // The hints the busy line points to end the turn, or say what to do instead.
    for (const r of ['person_editing', 'rolled_back', 'paused', 'taken_over', 'stopped', 'other_turn'] as const) expect(HINTS[r], r).toMatch(/end your turn/);
    expect(HINTS.step_declined).toMatch(/ask what to change/);
    expect(HINTS.changed).toMatch(/get_model/);
  });

  it('names no vendor and holds no project data', () => {
    expect(namesVendor(GUIDE)).toBe(false);
    expect(GUIDE).not.toMatch(/proj-|st-[a-z0-9]|\\Users\\|\/home\//);
  });
});

/** Whether `text` names tool `t` as a word (not inside a longer name, a selector or a handle). */
const names = (text: string, t: string) => new RegExp(`(?<![\\w.#])${t}(?!\\w)`).test(text);

describe("the guide of a Part that offers only some of its tools (the eval's core set)", () => {
  it('is the guide itself when every tool is offered', () => {
    expect(guideWithout([])).toBe(GUIDE);
  });

  it("each of the guide's words that send the model to a tool is there once and names that tool; no other left-out tool is named", () => {
    for (const [tool, words] of GUIDE_TOOL_WORDS) {
      expect(GUIDE.split(words).length - 1, tool).toBe(1);
      expect(names(words, tool), tool).toBe(true);
    }
    for (const t of TOOL_NAMES) if (!CORE_TOOLSET.includes(t)) expect(names(GUIDE, t), t).toBe(GUIDE_TOOL_WORDS.some(([x]) => x === t));
  });

  it("without the core set's 5: none of them named but in the line under the introduction; ASCII within 3950; the rest as the guide", () => {
    const missing = TOOL_NAMES.filter((t) => !CORE_TOOLSET.includes(t));
    const g = guideWithout(missing);
    expect(g.length).toBeLessThanOrEqual(3950);
    expect(g).toMatch(/^[\x20-\x7e\n]*$/);
    expect(bridgeClean(g)).toBe(g);
    const lines = g.split('\n');
    expect(lines[0]).toBe(GUIDE.split('\n')[0]);
    expect(lines[1]).toBe(notOfferedLine(missing));
    expect(lines[1]).toBe('Tools not offered now: body, delete, edit_feature, sweep_loft, view.');
    const rest = lines.filter((_, i) => i !== 1).join('\n');
    for (const t of missing) expect(names(rest, t), t).toBe(false);
    for (const t of CORE_TOOLSET) expect(names(rest, t), t).toBe(names(GUIDE, t));
    // Only those words changed.
    expect(rest).toContain('5 measure against the plan.\nDone:');
    expect(rest).toContain('EDITING: change sizes via parameters; else call the tool again with edit');
    expect(rest).toContain('undo takes back your own steps. Leave the person');
    expect(rest.length).toBe(GUIDE.length - GUIDE_TOOL_WORDS.reduce((n, [, w, wo]) => n + w.length - wo.length, 0));
  });

  it("each tool the core set leaves out, left out alone, is named only in that line", () => {
    for (const t of TOOL_NAMES.filter((x) => !CORE_TOOLSET.includes(x))) {
      const lines = guideWithout([t]).split('\n');
      expect(lines[1], t).toBe(notOfferedLine([t]));
      expect(names(lines.filter((_, i) => i !== 1).join('\n'), t), t).toBe(false);
    }
  });
});

describe("help's worked parts", () => {
  it("every input is whole and valid for its tool's schema", () => {
    for (const p of WORKED_PARTS) {
      for (const c of p.calls) {
        const t = toolNamed(c.tool);
        expect(t, `${p.topic} ${c.about}`).not.toBeNull();
        expect(problems(t!.inputSchema as unknown as S, c.input, `${p.topic} ${c.about} ${c.tool}`)).toEqual([]);
      }
    }
  });

  it('every selector in the inputs reads', () => {
    for (const p of WORKED_PARTS) {
      // The part's names: every feature and body its calls make (and those the tools name by default).
      const made = p.calls.flatMap((c) => [c.input.name, ...(c.tool === 'hole' ? [`${c.input.name || 'Hole 1'} sketch`] : [])]).filter((n): n is string => typeof n === 'string' && n !== '');
      const names: KnownNames = {
        features: [...made, 'Hole 1', 'Hole 2', 'Hole 1 sketch', 'Fillet 1', 'Circular pattern 1'].map((n, i) => ({ id: `f_${i}`, name: n, type: n.endsWith('sketch') || n === 'L profile' ? 'sketch' : 'extrude' })),
        bodies: ['Body 1', 'Plate', 'Red', 'White', 'Ring'].map((n, i) => ({ id: `b_${i}`, name: n })),
      };
      const reads = (text: string, want: Want, what: string) => expect(() => parseSelector(text, names, want), `${p.topic} ${what}: ${text}`).not.toThrow();
      for (const c of p.calls) {
        const i = c.input as Record<string, unknown>;
        const what = `${c.about} ${c.tool}`;
        if (c.tool === 'sketch' && i.on) reads(i.on as string, 'plane', what);
        if (c.tool === 'revolve') reads(i.axis as string, 'axis', what);
        if (c.tool === 'hole') reads(i.face as string, 'face', what);
        if (c.tool === 'modify') for (const s of i.targets as string[]) reads(s, 'any', what);
        if (c.tool === 'pattern') reads(i.about as string, i.kind === 'mirror' ? 'plane' : 'axis', what);
        if (c.tool === 'pattern' && i.of === 'bodies') for (const s of i.items as string[]) reads(s, 'body', what);
        if (c.tool === 'combine') for (const s of [...(i.targets as string[]), ...(i.tools as string[])]) reads(s, 'body', what);
        if (c.tool === 'extrude') for (const s of i.bodies as string[]) reads(s, 'body', what);
        if (c.tool === 'measure') {
          for (const s of i.targets as string[]) reads(s, 'any', what);
          if (i.section) reads(i.section as string, 'plane', what);
        }
        if (c.tool === 'find') reads(i.query as string, 'any', what);
      }
    }
  });
});
