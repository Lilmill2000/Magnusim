// @vitest-environment node
// The help reference (CAD tools spec §10.2, the skeleton): every topic of the tool's enum is there;
// each is at most 8 KB as JSON (example topics 12 KB), every string at most 2000 characters (the
// app cuts longer ones in a reply's data), every container at most 6 deep in the reply's data
// (the app turns depth 8 into null); the guide topic is the guide; the features topic names each
// tool's fields; the sketch topic each entity kind with its parts and DOF and every relation and
// dimension with the solver's ref signatures; no vendor names.
// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { GUIDE } from '../../src/assistant/guide';
import { HELP, HELP_EXAMPLE_BYTES, HELP_STRING_MAX, HELP_TOPIC_BYTES } from '../../src/assistant/help';
import { CAD_TOOLS, HELP_TOPICS, SKETCH_CONSTRAINT_KINDS, SKETCH_ENTITY_KINDS } from '../../src/assistant/schemas';
import { signatureWords } from '../../src/assistant/sketch/signatures';
import { namesVendor } from './vendor';

/** The deepest container in `v` (an object or a list at the top is 1). */
function depth(v: unknown): number {
  if (!v || typeof v !== 'object') return 0;
  const kids = Array.isArray(v) ? v : Object.values(v as object);
  return 1 + Math.max(0, ...kids.map(depth));
}

function strings(v: unknown, out: string[] = []): string[] {
  if (typeof v === 'string') out.push(v);
  else if (v && typeof v === 'object') for (const x of Array.isArray(v) ? v : Object.values(v)) strings(x, out);
  return out;
}

describe('help', () => {
  it('has every topic of the tool, each within its size, its strings and its depth', () => {
    expect(Object.keys(HELP).sort()).toEqual([...HELP_TOPICS].sort());
    for (const topic of HELP_TOPICS) {
      const data = { topic, rows: HELP[topic] };
      const bytes = Buffer.byteLength(JSON.stringify(data));
      expect(bytes, topic).toBeLessThanOrEqual(topic.startsWith('example_') ? HELP_EXAMPLE_BYTES : HELP_TOPIC_BYTES);
      expect(HELP[topic].length, topic).toBeGreaterThan(0);
      expect(HELP[topic].length, topic).toBeLessThanOrEqual(200);
      for (const s of strings(data)) expect(s.length, topic).toBeLessThanOrEqual(HELP_STRING_MAX);
      // In the reply: {tool, ok, data: {topic, rows: [{...}]}}, data at depth 2 of the reply.
      expect(depth(data), topic).toBeLessThanOrEqual(6);
      expect(namesVendor(JSON.stringify(data)), topic).toBe(false);
    }
  });

  it('the guide topic is the guide, part by part', () => {
    expect(HELP.guide.map((r) => r.text).join('\n\n')).toBe(GUIDE);
    expect(HELP.guide.map((r) => r.about)).toEqual(['introduction', 'values', 'frame', 'loop', 'sketches', 'selectors', 'booleans', 'editing', 'errors', 'examples']);
  });

  it("the features topic gives each tool's fields; parameters says how expressions read", () => {
    expect(HELP.features.map((r) => r.about)).toEqual(CAD_TOOLS.map((t) => t.name));
    const extrude = HELP.features.find((r) => r.about === 'extrude')!;
    expect(extrude.text).toContain('Fields: edit, name, sketch, regions, extent, distance, distance2, to, flip, op, bodies, body_name, color.');
    expect(HELP.parameters.map((r) => r.about)).toEqual(['expressions', 'bare numbers', 'names', 'kinds']);
    expect(HELP.parameters[0].text).toContain('mm, cm, m, in, ft, deg, rad');
    // A topic whose tools come later says so.
    expect(HELP.traps).toEqual([{ about: 'not in this build yet', text: expect.stringContaining("Until then each tool's own description says what its fields take.") }]);
  });

  it("the sketch topic gives each entity kind, the solver's ref signatures, joins and the frames", () => {
    expect(HELP.sketch.map((r) => r.about)).toEqual([...SKETCH_ENTITY_KINDS, 'relations', 'dimensions', 'ids and refs', 'joins', 'infer', 'the solver', 'planes and faces', 'replace']);
    const text = (about: string) => HELP.sketch.find((r) => r.about === about)!.text;
    expect(text('rect')).toBe('rect [u1, v1, u2, v2] (two opposite corners): keeps its 2 horizontals and 2 verticals. Parts: x.bl x.br x.tr x.tl x.bottom x.right x.top x.left. 4 DOF.');
    expect(text('sector')).toContain('6 DOF');
    expect(text('polyline')).toContain('side x.k runs from x.p(k-1) to x.pk');
    for (const k of SKETCH_CONSTRAINT_KINDS) expect(`${text('relations')} ${text('dimensions')}`, k).toContain(`${k} [${signatureWords(k)}]`);
    expect(text('relations')).toContain('symmetric [point, point, line or point, point, point]');
    expect(text('dimensions')).toContain('distance_x [p, q] = q.u - p.u');
    // The frames are the guide's.
    const guideFaces = GUIDE.split(/\n/).find((l) => l.startsWith('- Faces by outward n:'))!;
    expect(text('planes and faces')).toContain(guideFaces.slice('- Faces by outward n: '.length, guideFaces.indexOf('. Origin')));
    expect(text('joins')).toContain('0.05 mm');
  });
});
