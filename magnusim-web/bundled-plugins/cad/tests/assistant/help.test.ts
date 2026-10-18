// @vitest-environment node
// The help reference (CAD tools spec §10.2): every topic of the tool's enum is there; each is at
// most 8 KB as JSON (example topics 12 KB), every string at most 2000 characters; the help tool's
// reply for each topic reaches the model whole through a copy of the app's own rules
// (sanitize-copy.ts: no `truncated`, no container turned null, nothing changed but the guide's
// line breaks), every container at most 6 deep in the reply's data (an example's call sits in its
// row, so a sketch's `at` lists are at depth 7, inside the app's 8); the guide topic is the guide;
// the features topic names each tool's fields and rules; the sketch topic each entity kind with
// its parts and DOF and every relation and dimension with the solver's ref signatures; checks,
// traps and the examples index are filled; the example topics are the worked parts, call by call
// (guide-example.test.ts runs them); no vendor names.
// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { WORKED_PARTS } from '../../src/assistant/examples';
import { GUIDE } from '../../src/assistant/guide';
import { HELP, HELP_EXAMPLE_BYTES, HELP_STRING_MAX, HELP_TOPIC_BYTES } from '../../src/assistant/help';
import { CAD_TOOLS, HELP_TOPICS, SKETCH_CONSTRAINT_KINDS, SKETCH_ENTITY_KINDS, type HelpTopic } from '../../src/assistant/schemas';
import { signatureWords } from '../../src/assistant/sketch/signatures';
import { tool as helpTool } from '../../src/assistant/tools/help';
import type { CallCtx, ToolReply } from '../../src/types/assistant';
import { resultAsSent } from './sanitize-copy';
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

/** The help tool's reply for `topic` as the call handler sends it (rev first, as call.ts adds it). */
async function reply(topic: HelpTopic): Promise<ToolReply> {
  const r = await helpTool.run({ services: {}, input: { topic } } as unknown as CallCtx);
  return { ...r, data: { rev: 3, ...r.data } };
}

/** Every string with its whitespace as the app sends it (one space between words). */
const oneSpace = (v: unknown): unknown => JSON.parse(JSON.stringify(v), (_k, x) => (typeof x === 'string' ? x.replace(/\s+/g, ' ').trim() : x));

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
      // In the reply: {tool, ok, data: {topic, rows: [{...}]}}, data at depth 2 of the reply; an
      // example's sketch call ({about, text, tool, input: {entities: [{at: [...]}]}}) is 7 deep.
      expect(depth(data), topic).toBeLessThanOrEqual(topic.startsWith('example_') ? 7 : 6);
      for (const row of HELP[topic]) if (!row.input) expect(depth(row), `${topic} ${row.about}`).toBe(1);
      expect(namesVendor(JSON.stringify(data)), topic).toBe(false);
      // Nothing is left of the skeleton's placeholder rows.
      expect(HELP[topic].map((r) => r.about), topic).not.toContain('not in this build yet');
    }
  });

  it("each topic's reply reaches the model whole: nothing cut, nothing turned null", async () => {
    for (const topic of HELP_TOPICS) {
      const r = await reply(topic);
      const sent = resultAsSent('cad__help', r);
      expect(sent.truncated, topic).toBeUndefined();
      expect(sent.text, topic).toBe(r.text);
      // Every value as the page sent it; only the guide's line breaks become spaces.
      expect(sent.data, topic).toEqual(oneSpace(r.data));
      if (topic !== 'guide') expect(sent.data, topic).toEqual(JSON.parse(JSON.stringify(r.data)));
      expect(r.text).toBe(`help ${topic}: ${HELP[topic].length} rows`);
    }
  });

  it('the guide topic is the guide, part by part', () => {
    expect(HELP.guide.map((r) => r.text).join('\n\n')).toBe(GUIDE);
    expect(HELP.guide.map((r) => r.about)).toEqual(['introduction', 'values', 'frame', 'loop', 'sketches', 'selectors', 'booleans', 'editing', 'errors', 'examples']);
  });

  it("the features topic gives each tool's fields and rules; parameters says how expressions read", () => {
    expect(HELP.features.map((r) => r.about)).toEqual(CAD_TOOLS.map((t) => t.name));
    const text = (about: string) => HELP.features.find((r) => r.about === about)!.text;
    expect(text('extrude')).toContain('Fields: edit, name, sketch, regions, extent, distance, distance2, to, flip, op, bodies, body_name, color.');
    for (const t of CAD_TOOLS) expect(text(t.name).startsWith(`${t.title} (${t.risk}). Fields: ${Object.keys(t.inputSchema.properties).join(', ')}. `), t.name).toBe(true);
    // The faces each feature tool names, and what hole writes.
    expect(text('extrude')).toContain('<Name>.start (on the sketch), <Name>.end (the far cap), <Name>.side(<entity>)');
    expect(text('sweep_loft')).toContain('<Name>.side(<profile entity>@<path entity>)');
    expect(text('modify')).toContain('<Name>.fillet(k)');
    expect(text('pattern')).toContain('"<body> (Instance k)"');
    expect(text('hole')).toContain('d (diameter of h1)');
    expect(text('hole')).toContain('on a -X face z "b/2" becomes h1y "-(b/2)"');
    expect(text('help')).toContain('Every field of every tool is required: "", [] or false when unused.');
    expect(HELP.parameters.map((r) => r.about)).toEqual(['expressions', 'bare numbers', 'names', 'kinds']);
    expect(HELP.parameters[0].text).toContain('mm, cm, m, in, ft, deg, rad');
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

  it("checks and traps hold the spec's lists; the examples index names each worked part", () => {
    expect(HELP.checks.map((r) => r.about)).toEqual(['volumes and areas', 'voids', 'overlap and union', 'sections', 'plan first', 'after each feature', 'sketches', 'the end', 'parameter walk', 'symmetry', 'pictures', 'files']);
    const checks = HELP.checks.map((r) => r.text).join(' ');
    for (const s of ['within 0.1%', 'Every sketch dof 0', 'voids 1', 'shells 2', 'overlap_mm3 0', 'union_solids 1', '+10%', 'centroid_mm', 'view iso', 'Export STEP']) expect(checks, s).toContain(s);
    expect(HELP.traps.map((r) => r.about)).toEqual([
      'bare numbers',
      'cuts into a face',
      'side face frames',
      'overlap',
      'regions',
      'joined points',
      'dimensions through 0',
      'fillets and shells',
      'split faces',
      'risky features',
      'counts',
      'holes',
      'words',
      'calls',
      'the person',
    ]);
    const traps = HELP.traps.map((r) => r.text).join(' ');
    for (const s of [
      'needs flip true',
      'v running -Z',
      'touching is not enough',
      'op new, then combine with "bodies of <pattern>"',
      '"all" is even-odd',
      'two circles drawn at one centre share it',
      'mirrors the sketch',
      'Fillet before shell',
      'tangent chain',
      '~1, ~2',
      'Sweep, loft and shell fail most often',
      'the original included',
      '"2 mm higher"',
      'Calls are limited',
      'never redo steps the person undid',
    ])
      expect(traps, s).toContain(s);
    expect(HELP.examples.map((r) => r.about)).toEqual(['example_plate', 'example_bracket', 'example_flange', 'example_chip']);
    expect(HELP.examples[0].text).toMatch(/^A 60 x 40 x 6 mm plate .*\. 6 calls: set_params, sketch, extrude, hole, measure\. help example_plate has every input whole\.$/);
  });

  it('each example topic is its worked part: the plan, every call with its whole input and key results, the checks', () => {
    for (const part of WORKED_PARTS) {
      const rows = HELP[part.topic];
      expect(rows[0]).toEqual({ about: 'the part', text: part.part });
      expect(rows[rows.length - 1]).toEqual({ about: 'checks', text: part.checks });
      const calls = rows.slice(1, -1);
      expect(calls.map((r) => r.about)).toEqual(part.calls.map((_, i) => `call ${i + 1}`));
      for (const [i, r] of calls.entries()) {
        expect(r).toEqual({ about: `call ${i + 1}`, text: part.calls[i].text, tool: part.calls[i].tool, input: part.calls[i].input, result: part.calls[i].result });
        // Results are flat: the reply's line and key values.
        expect(typeof r.result!.text, `${part.topic} ${r.about}`).toBe('string');
        for (const v of Object.values(r.result!)) expect(v === null || typeof v !== 'object', `${part.topic} ${r.about}`).toBe(true);
      }
    }
  });
});
