// The choice and on/off fields of each feature type, as edit_feature sets them and get_model full
// lists them (`choices`): the field's name (its tool field name where the tool has one, else its
// name in the feature; both are taken), where it is in the feature, and its words. A word is
// stored as the feature keeps it (Top -> origin:top, Z -> origin:z, "true" -> true). A field that
// only matters in another mode (dir2 with no second direction, keepTool of a split by a plane) is
// listed only where it applies.
// Owner: ASSISTANT.
// SPDX-License-Identifier: GPL-3.0-or-later
import type { Feature, FeatureType } from '../types/doc';

/** One choice field of a feature. */
export interface ChoiceField {
  /** Its name in edit_feature's set[].field. */
  field: string;
  /** Other names it is taken by (the feature's own key, a tool's field name). */
  aliases?: readonly string[];
  /** Its path in the feature ("dir1.mode", "tool.keepTool"). */
  path: string;
  /** 'bool' (true/false), or its words with what each is stored as. */
  words: 'bool' | readonly (readonly [word: string, stored: string])[];
  /** Whether the feature has this field now (dir2 only with a second direction). */
  when?: (f: Feature) => boolean;
}

const same = (...w: string[]) => w.map((x) => [x, x] as const);
const BODY_OP = same('new', 'join', 'cut', 'intersect');
const PATTERN_OP = same('source', 'new', 'join', 'cut', 'intersect');
const AXES = [
  ['X', 'origin:x'],
  ['Y', 'origin:y'],
  ['Z', 'origin:z'],
] as const;
const PLANES = [
  ['Top', 'origin:top'],
  ['Front', 'origin:front'],
  ['Right', 'origin:right'],
] as const;

type Rec = Record<string, unknown>;
const dir2 = (f: Feature) => !!(f as unknown as Rec).dir2;
const splitBy = (kind: string) => (f: Feature) => ((f as unknown as { tool?: { kind?: string } }).tool?.kind ?? '') === kind;

export const CHOICE_FIELDS: Readonly<Partial<Record<FeatureType, readonly ChoiceField[]>>> = {
  extrude: [
    { field: 'flip', path: 'flip', words: 'bool' },
    { field: 'op', path: 'op', words: BODY_OP },
  ],
  revolve: [
    { field: 'flip', path: 'flip', words: 'bool' },
    { field: 'op', path: 'op', words: BODY_OP },
  ],
  sweep: [
    { field: 'orientation', path: 'orientation', words: same('follow', 'fixed') },
    { field: 'op', path: 'op', words: BODY_OP },
  ],
  loft: [
    { field: 'ruled', path: 'ruled', words: 'bool' },
    { field: 'op', path: 'op', words: BODY_OP },
  ],
  chamfer: [
    { field: 'flip', path: 'flip', words: 'bool' },
    { field: 'mode', path: 'mode', words: same('distance', 'two') },
  ],
  shell: [{ field: 'direction', path: 'direction', words: same('inside', 'outside') }],
  combine: [
    { field: 'op', path: 'op', words: same('join', 'cut', 'intersect') },
    { field: 'keep_tools', aliases: ['keepTools'], path: 'keepTools', words: 'bool' },
  ],
  pattern_linear: [
    { field: 'op', path: 'op', words: PATTERN_OP },
    { field: 'flip', aliases: ['dir1.flip'], path: 'dir1.flip', words: 'bool' },
    { field: 'symmetric', aliases: ['dir1.symmetric'], path: 'dir1.symmetric', words: 'bool' },
    { field: 'mode', aliases: ['dir1.mode'], path: 'dir1.mode', words: same('spacing', 'extent') },
    { field: 'flip2', aliases: ['dir2.flip'], path: 'dir2.flip', words: 'bool', when: dir2 },
    { field: 'symmetric2', aliases: ['dir2.symmetric'], path: 'dir2.symmetric', words: 'bool', when: dir2 },
    { field: 'mode2', aliases: ['dir2.mode'], path: 'dir2.mode', words: same('spacing', 'extent'), when: dir2 },
  ],
  pattern_circular: [
    { field: 'op', path: 'op', words: PATTERN_OP },
    { field: 'flip', path: 'flip', words: 'bool' },
    { field: 'symmetric', path: 'symmetric', words: 'bool' },
    { field: 'mode', path: 'mode', words: same('full', 'angle') },
  ],
  mirror: [{ field: 'op', path: 'op', words: PATTERN_OP }],
  // Move/copy body: Keep a copy, and the turn about X, Y or Z (a picked axis is sent with direct).
  move_body: [
    { field: 'copy', path: 'copy', words: 'bool' },
    {
      field: 'about',
      path: 'about',
      words: [
        ['X', 'x'],
        ['Y', 'y'],
        ['Z', 'z'],
      ],
    },
  ],
  split: [
    { field: 'plane', aliases: ['tool.plane'], path: 'tool.plane', words: PLANES, when: splitBy('plane') },
    { field: 'keep_tool', aliases: ['keepTool', 'tool.keepTool'], path: 'tool.keepTool', words: 'bool', when: splitBy('body') },
  ],
  enclosure: [
    { field: 'shape', path: 'shape', words: same('box', 'cylinder') },
    { field: 'axis', path: 'axis', words: AXES },
    { field: 'padding', path: 'padding', words: same('zero', 'percent', 'fixed') },
  ],
  ref_plane: [
    { field: 'method', path: 'method', words: same('offset', 'angle', 'three_points', 'midplane', 'normal_to_curve') },
    { field: 'flip', path: 'flip', words: 'bool' },
  ],
  ref_axis: [
    { field: 'method', path: 'method', words: same('two_points', 'cylinder', 'edge', 'two_planes') },
    { field: 'flip', path: 'flip', words: 'bool' },
  ],
  ref_point: [
    { field: 'method', path: 'method', words: same('vertex', 'center', 'on_edge', 'edge_plane', 'coordinates') },
    { field: 'along', path: 'along', words: same('distance', 'percent') },
    { field: 'from_end', aliases: ['fromEnd'], path: 'fromEnd', words: 'bool' },
  ],
};

/** The choice fields feature `f` has now. */
export function choiceFieldsOf(f: Feature): ChoiceField[] {
  return (CHOICE_FIELDS[f.type] ?? []).filter((c) => !c.when || c.when(f));
}

/** The choice field `name` names on `f` (its field name or an alias, any case), or null. */
export function choiceField(f: Feature, name: string): ChoiceField | null {
  const want = name.trim().toLowerCase();
  return choiceFieldsOf(f).find((c) => c.field.toLowerCase() === want || (c.aliases ?? []).some((a) => a.toLowerCase() === want)) ?? null;
}

const read = (f: Feature, path: string): unknown => path.split('.').reduce<unknown>((node, k) => (node && typeof node === 'object' ? (node as Rec)[k] : undefined), f);

/** A choice's words ("true, false" or "new, join, cut, intersect"). */
export function choiceWords(c: ChoiceField): string[] {
  return c.words === 'bool' ? ['true', 'false'] : c.words.map((w) => w[0]);
}

/** The value a word stores, or an error in words. */
export function storedChoice(c: ChoiceField, word: string): { ok: true; value: unknown } | { ok: false; why: string } {
  const w = word.trim().toLowerCase();
  if (c.words === 'bool') {
    if (['true', 'on', 'yes'].includes(w)) return { ok: true, value: true };
    if (['false', 'off', 'no'].includes(w)) return { ok: true, value: false };
    return { ok: false, why: `${c.field} is on or off: "true" or "false"` };
  }
  const hit = c.words.find((x) => x[0].toLowerCase() === w || x[1].toLowerCase() === w);
  return hit ? { ok: true, value: hit[1] } : { ok: false, why: `${c.field} is one of ${choiceWords(c).join(', ')}` };
}

/** A stored value as its word. */
function wordOf(c: ChoiceField, v: unknown): string {
  if (c.words === 'bool') return v ? 'true' : 'false';
  return c.words.find((x) => x[1] === v)?.[0] ?? String(v ?? '');
}

/** The choice fields of `f` with their words now and the words they take (get_model full's `choices`). */
export function choicesOf(f: Feature): { field: string; value: string; words: string[] }[] {
  return choiceFieldsOf(f).map((c) => ({ field: c.field, value: wordOf(c, read(f, c.path)), words: choiceWords(c) }));
}
