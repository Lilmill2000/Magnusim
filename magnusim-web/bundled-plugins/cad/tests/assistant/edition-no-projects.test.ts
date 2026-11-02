// The Assistant in Magnusim CAD (Daniel 2026-10-29: hide every project and simulation item there,
// and what the person cannot see the Assistant is not told about either). The host's welcome says
// projectLinks false: the Part registers the same 22 tools, but the workspace tool has no
// send_to_simulation (enum and words), the direct tool no enclosure kind, fields or words, and help
// says none of them (features, workspace, details, errors); a call that still names them is
// refused in plain words. An Enclosure made in Magnusim stays as it is: get_model gives no inputs
// to resend, edit_feature refuses its values with the panel's words, and rename works. Absent, the
// flag means Magnusim: the registration and help are Magnusim's, byte for byte. The fillet and sized
// hole words (S4) are the same in both editions.
// SPDX-License-Identifier: GPL-3.0-or-later
import { afterEach, describe, expect, it } from 'vitest';
import { HELP, helpFor } from '../../src/assistant/help';
import { assistantTestHandle } from '../../src/assistant/install';
import { CAD_TOOLS, HELP_TOPICS, TOOL_NAMES } from '../../src/assistant/schemas';
import { KEPT_WORDS } from '../../src/features/enclosure/kept';
import type { EnclosureFeature } from '../../src/types/doc';
import { assistantHarness, REAL_KERNEL_MS, type AssistantHarness } from './harness';
import { plate } from './parts';

type Row = Record<string, unknown>;
type Node = { enum?: string[]; properties?: Record<string, Node> };

let h: AssistantHarness | null = null;
afterEach(() => {
  h?.dispose();
  h = null;
});

/** What the person or a model could read about a simulation or the Enclosure in a text. */
const PROJECT_WORDS = /simulation|enclosure|CFD|fluid|air volume/i;
const rowsOf = (r: { data: Row }) => r.data.rows as { about: string; text: string }[];

describe('the Assistant in Magnusim CAD (projectLinks false)', () => {
  it(
    'registers the 22 tools without send_to_simulation, the enclosure kind or their words, and help says none of them',
    async () => {
      h = await assistantHarness({ projectLinks: false });
      const reg = h.fake.registrations.at(-1)!;
      expect(reg.tools.map((t) => t.name)).toEqual(TOOL_NAMES);
      // The page's test handle (window.__CAD__.assistant.registered) reads the same tools, whole.
      expect(assistantTestHandle(h.services)!.registered).toEqual(JSON.parse(JSON.stringify(reg.tools)));
      const tool = (n: string) => reg.tools.find((t) => t.name === n)!;
      const workspace = tool('workspace');
      const actions = (workspace.inputSchema.properties.action as Node).enum!;
      expect(actions).not.toContain('send_to_simulation');
      expect(actions).toHaveLength(39);
      expect(workspace.description).not.toMatch(PROJECT_WORDS);
      const direct = tool('direct');
      expect((direct.inputSchema.properties.kind as Node).enum).toEqual(['press_pull', 'delete_faces', 'split', 'delete_body', 'move_body', 'repair', 'retry']);
      expect(Object.keys(direct.inputSchema.properties)).toEqual(['edit', 'name', 'kind', 'faces', 'distance', 'bodies', 'tool', 'keep_tool', 'move', 'turn', 'copy']);
      expect(direct.title).toBe('Direct edits');
      expect(JSON.stringify(direct)).not.toMatch(PROJECT_WORDS);
      // No tool says a word of a simulation or the Enclosure (the guide never did).
      for (const t of reg.tools) expect(JSON.stringify(t), t.name).not.toMatch(PROJECT_WORDS);
      expect(reg.guide).not.toMatch(PROJECT_WORDS);
      // Help, as the help tool gives it here.
      const ws = rowsOf(await h.ok('help', { topic: 'workspace' }));
      expect(ws.map((r) => r.about)).not.toContain('send_to_simulation');
      expect(ws.find((r) => r.about.startsWith('banana_'))!.text).toMatch(/^The banana for scale: never a body\. banana_place/);
      expect(JSON.stringify(ws)).not.toMatch(/simulation/i);
      const features = rowsOf(await h.ok('help', { topic: 'features' }));
      expect(features.find((r) => r.about === 'direct')!.text).toBe('Direct edits (edit). Fields: edit, name, kind, faces, distance, bodies, tool, keep_tool, move, turn, copy. Kinds, fields: help details.');
      expect(JSON.stringify(features)).not.toMatch(/simulation|enclosure/i);
      const details = rowsOf(await h.ok('help', { topic: 'details' }));
      expect(JSON.stringify(details)).not.toMatch(/enclosure|fluid/i);
      expect(details.find((r) => r.about === 'direct kinds')!.text).toContain('split: bodies, tool Top|Front|Right');
      // Move/copy body is the person's in Magnusim CAD too.
      expect(details.find((r) => r.about === 'direct kinds')!.text).toContain("move_body: bodies (one feature for them all), as the person's Move/copy body");
      // Delete faces takes fillets off as fillets, and gives the rest, in Magnusim CAD as in Magnusim (kernel API 8).
      expect(details.find((r) => r.about === 'direct kinds')!.text).toContain('delete_faces: faces; the neighbours grow over the gap; failing that, picked fillets (every one up to the largest) come off as fillets; a red one may list rest (get_model full) to add.');
      // Its panel's Add by size is the same selectors in both editions (S5).
      expect(details.find((r) => r.about === 'direct kinds')!.text).toContain('Its panel\'s Fillets up to R / Holes up to D add what "<body> faces fillet <= R" / "<body> faces hole <= D" name.');
      const errors = rowsOf(await h.ok('help', { topic: 'errors' }));
      expect(errors.map((r) => r.about)).not.toEqual(expect.arrayContaining([expect.stringMatching(/^(link_failed|no_link|opening_geometry) /)]));
      expect(errors.some((r) => r.about.startsWith('feature_failed '))).toBe(true);
      // Every topic, as a model reading them all gets them (the selectors' role list named the Enclosure).
      for (const topic of HELP_TOPICS) expect(JSON.stringify(rowsOf(await h.ok('help', { topic }))), topic).not.toMatch(PROJECT_WORDS);
      // Fillets and sized holes (S4) are nothing of a project's: the same words as Magnusim's, the
      // find tool's description, help's filters row and the guide's selector line.
      expect(JSON.stringify(tool('find'))).toBe(JSON.stringify(CAD_TOOLS.find((t) => t.name === 'find')));
      expect(tool('find').description).toContain('"Body 1 faces fillet <= 2 mm", "Body 1 faces hole <= 6 mm"');
      const filters = rowsOf(await h.ok('help', { topic: 'selectors' })).find((r) => r.about === 'filters');
      expect(filters).toEqual(HELP.selectors.find((r) => r.about === 'filters'));
      expect(filters!.text).toContain('fillet <= 2 mm (its largest radius)');
      expect(reg.guide).toContain('%cylinder, hole, largest, fillet <= 2 mm, hole <= 6 mm.');
    },
    REAL_KERNEL_MS,
  );

  it(
    'refuses send_to_simulation and an enclosure in plain words, changing nothing',
    async () => {
      h = await assistantHarness({ projectLinks: false });
      await plate(h);
      const before = h.doc.state.get().doc;
      const send = await h.call('workspace', { action: 'send_to_simulation', target: '', value: '', items: [], person_asked: false });
      expect(send).toMatchObject({ ok: false, error: { detail: { reason: 'bad_input' } } });
      const sendWords = (send as { error: { message: string } }).error.message;
      expect(sendWords).toMatch(/^bad_input: action must be one of roll_back_to, /);
      expect(sendWords).not.toContain('send_to_simulation');
      const enclose = await h.call('direct', { edit: '', name: '', kind: 'enclosure', faces: [], distance: '', bodies: [], tool: '', keep_tool: false, move: [], turn: { angle: '', axis: '', pivot: [] }, copy: false });
      expect(enclose).toMatchObject({ ok: false, error: { detail: { reason: 'bad_input' } } });
      expect((enclose as { error: { message: string } }).error.message).toContain('kind: one of press_pull, delete_faces, split, delete_body, move_body, repair, retry.');
      expect(h.doc.state.get().doc).toBe(before);
      expect(h.doc.state.get().doc.features.some((f) => f.type === 'enclosure')).toBe(false);
    },
    REAL_KERNEL_MS,
  );

  it(
    'keeps an Enclosure made in Magnusim as it is: get_model gives it no inputs, edit_feature refuses its values with the panel\'s words, and rename works',
    async () => {
      h = await assistantHarness({ projectLinks: false });
      await plate(h);
      const id = await h.add('enclosure', { padding: 'fixed', distance: '5 mm' });
      const full = (await h.ok('get_model', { detail: 'full', feature: 'Enclosure 1', regions: 'short' })).data as Row;
      const row = ((full.features as Row[] | undefined) ?? [full.feature as Row]).find((f) => f && f.name === 'Enclosure 1') as Row;
      expect(row).toMatchObject({ name: 'Enclosure 1', type: 'enclosure', state: 'ok', inputs: null, kept: KEPT_WORDS });
      expect(row).not.toHaveProperty('values');
      expect(row).not.toHaveProperty('choices');
      const before = h.doc.state.get().doc;
      const set = await h.call('edit_feature', { feature: 'Enclosure 1', set: [{ field: 'padding', value: 'zero' }], rename_to: '', suppress: 'keep', move: '' });
      expect(set).toMatchObject({ ok: false, error: { detail: { reason: 'bad_input' } } });
      expect((set as { error: { message: string } }).error.message).toBe(`bad_input: set: Enclosure 1: ${KEPT_WORDS} rename_to, suppress and move work.`);
      expect(h.doc.state.get().doc).toBe(before);
      await h.ok('edit_feature', { feature: 'Enclosure 1', set: [], rename_to: 'Box around', suppress: 'keep', move: '' });
      const f = h.doc.state.get().doc.features.find((g) => g.id === id) as EnclosureFeature;
      expect(f).toMatchObject({ name: 'Box around', padding: 'fixed', distance: '5 mm' });
    },
    REAL_KERNEL_MS,
  );
});

describe('the Assistant in Magnusim (projectLinks absent)', () => {
  it(
    'registers Magnusim\'s tools byte for byte, with send_to_simulation and the enclosure, and help is Magnusim\'s',
    async () => {
      h = await assistantHarness();
      const reg = h.fake.registrations.at(-1)!;
      expect(JSON.stringify(reg.tools)).toBe(JSON.stringify(CAD_TOOLS));
      expect(JSON.stringify(assistantTestHandle(h.services)!.registered)).toBe(JSON.stringify(CAD_TOOLS));
      expect((reg.tools.find((t) => t.name === 'workspace')!.inputSchema.properties.action as Node).enum).toContain('send_to_simulation');
      expect((reg.tools.find((t) => t.name === 'direct')!.inputSchema.properties.kind as Node).enum).toContain('enclosure');
      expect(helpFor(true)).toBe(HELP);
      const ws = rowsOf(await h.ok('help', { topic: 'workspace' }));
      expect(ws).toEqual(HELP.workspace);
      expect(ws.map((r) => r.about)).toContain('send_to_simulation');
      await plate(h);
      await h.add('enclosure', { padding: 'fixed', distance: '5 mm' });
      const full = (await h.ok('get_model', { detail: 'full', feature: 'Enclosure 1', regions: 'short' })).data as Row;
      const row = ((full.features as Row[] | undefined) ?? [full.feature as Row]).find((f) => f && f.name === 'Enclosure 1') as Row;
      expect(row).toMatchObject({ inputs: expect.objectContaining({ kind: 'enclosure', padding: 'fixed' }) });
      expect(row).not.toHaveProperty('kept');
    },
    REAL_KERNEL_MS,
  );
});
