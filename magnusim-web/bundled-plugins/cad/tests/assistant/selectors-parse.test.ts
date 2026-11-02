// @vitest-environment node
// The selector language (CAD tools spec §5.2, §12.1 selectors-parse.test.ts): every form of the
// grammar reads to what it names; the longest known name wins ("Body 10" before "Body 1", names
// with ".", " of ", " & " in them, quotes); a body and a feature both named "Bracket" are read by
// the grammar (Bracket.end the feature, Bracket faces >Z the body, feature Bracket faces the
// feature); levels count from [1]; errors give the column they could not read; and every label
// labels.ts writes reads back to the same face key (sweep sides with "@" included).
// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { baseLabel, LabelIndex, quoteName } from '../../src/assistant/labels';
import { parseSelector, SelectorSyntaxError, type KnownNames, type Sel } from '../../src/assistant/selectors/parse';

const NAMES: KnownNames = {
  features: [
    { id: 'f_base', name: 'Base', type: 'extrude' },
    { id: 'f_bracket', name: 'Bracket', type: 'extrude' },
    { id: 'f_sk', name: 'Plate sketch', type: 'sketch' },
    { id: 'f_prof', name: 'Profile', type: 'sketch' },
    { id: 'f_boss', name: 'Boss.v2', type: 'extrude' },
    { id: 'f_of', name: 'Cut of top', type: 'extrude' },
    { id: 'f_amp', name: 'A & B', type: 'extrude' },
    { id: 'f_pl', name: 'Mid plane', type: 'ref_plane' },
    { id: 'f_ax', name: 'Spin axis', type: 'ref_axis' },
    { id: 'f_fil', name: 'Fillet 1', type: 'fillet' },
    { id: 'f_sh', name: 'Shell 1', type: 'shell' },
    { id: 'f_pipe', name: 'Pipe', type: 'sweep' },
    { id: 'f_pat', name: 'Pattern 1', type: 'pattern_linear' },
    { id: 'f_mir', name: 'Mirror 1', type: 'mirror' },
  ],
  bodies: [
    { id: 'b_1', name: 'Body 1' },
    { id: 'b_10', name: 'Body 10' },
    { id: 'b_br', name: 'Bracket' },
  ],
};

const p = (text: string, want: Parameters<typeof parseSelector>[2] = 'any') => parseSelector(text, NAMES, want);
const err = (text: string, want: Parameters<typeof parseSelector>[2] = 'any'): SelectorSyntaxError => {
  try {
    p(text, want);
  } catch (e) {
    if (e instanceof SelectorSyntaxError) return e;
    throw e;
  }
  throw new Error(`"${text}" parsed`);
};

describe('the selector grammar', () => {
  it('reads handles and selection', () => {
    expect(p('#f3')).toEqual({ t: 'handle', of: 'face', n: 3, text: '#f3' });
    expect(p('#e12', 'edge')).toMatchObject({ t: 'handle', of: 'edge', n: 12 });
    expect(p('#v2')).toMatchObject({ of: 'vertex' });
    expect(p('#b1', 'body')).toMatchObject({ of: 'body', n: 1 });
    expect(p('selection', 'face')).toEqual({ t: 'selection' });
    expect(p('SELECTION', 'edge')).toEqual({ t: 'selection' });
    // A handle of another kind in a face place says what it is.
    expect(err('#e3', 'face').message).toMatch(/#e3 is an edge; this place takes a face/);
    expect(err('#f0', 'face').column).toBe(1);
  });

  it('reads role references with their details and ~k', () => {
    expect(p('Base.start', 'face')).toMatchObject({ t: 'role', feature: { id: 'f_base' }, role: 'start', detail: null, k: null });
    expect(p('base.END', 'face')).toMatchObject({ t: 'role', feature: { id: 'f_base', name: 'Base' }, role: 'end' });
    expect(p('Base.end(2)', 'face')).toMatchObject({ role: 'end', detail: '2' });
    expect(p('Base.side', 'face')).toMatchObject({ role: 'side', detail: null });
    expect(p('Base.side(l2)', 'face')).toMatchObject({ role: 'side', detail: 'l2' });
    expect(p('Base.side(r.top)', 'face')).toMatchObject({ role: 'side', detail: 'r__top' });
    expect(p('Base.side(p.3)~2', 'face')).toMatchObject({ role: 'side', detail: 'p__3', k: 2 });
    expect(p('Pipe.side(o@a2)', 'face')).toMatchObject({ role: 'side', detail: 'o@a2' });
    expect(p('Fillet 1.fillet(3)', 'face')).toMatchObject({ feature: { id: 'f_fil' }, role: 'fillet', detail: '3' });
    expect(p('Shell 1.inner(Base.end)', 'face')).toMatchObject({ role: 'inner', detail: 'f_base\u0000end\u0000' });
    expect(p('Shell 1.inner(Base.side(r.top))', 'face')).toMatchObject({ role: 'inner', detail: 'f_base\u0000side\u0000r__top' });
    expect(p('Pattern 1.copy(3)', 'face')).toMatchObject({ role: 'copy', detail: '3' });
    expect(p('Pattern 1.copy(2.1)~4', 'face')).toMatchObject({ role: 'copy', detail: '2.1', k: 4 });
    expect(p('Mirror 1.mirror', 'face')).toMatchObject({ role: 'mirror', detail: null });
    expect(p('Base.cut', 'face')).toMatchObject({ role: 'cut' });
    expect(p('Base.enclosure(+X)', 'face')).toMatchObject({ role: 'enclosure', detail: '+x' });
    expect(p('Base.import(12)', 'face')).toMatchObject({ role: 'import', detail: '12' });
    // Any other word reads (resolving it lists the feature's roles).
    expect(p('Base.top', 'face')).toMatchObject({ t: 'role', role: 'top' });
    expect(err('Base.end(0)', 'face').message).toMatch(/end\(\.\.\.\) takes a profile number from 1/);
    expect(err('Base.cut(1)', 'face').message).toMatch(/takes no detail/);
    expect(err('Base.side(l2', 'face').message).toMatch(/not closed/);
    expect(err('Base.end~0', 'face').message).toMatch(/~k with k 1 or more/);
  });

  it('reads queries with every filter, scope by body, feature or all', () => {
    const q = p('Body 1 faces >Z', 'face') as Extract<Sel, { t: 'query' }>;
    expect(q).toMatchObject({ t: 'query', of: 'face', scope: { s: 'body', body: { id: 'b_1' } } });
    expect(q.filters).toEqual([{ f: '>', ax: { dir: [0, 0, 1], text: 'Z' }, n: 1, col: 14, text: '>Z' }]);
    const all = p('Body 1 faces >Z[2] <x +Z -y |Z #(0, 0, 2) %cylinder hole boss radius 3 mm largest smallest nearest (1, 2, 3)', 'face') as Extract<Sel, { t: 'query' }>;
    expect(all.filters.map((f) => f.f)).toEqual(['>', '<', '+', '-', '|', '#', '%', 'hole', 'boss', 'radius', 'largest', 'smallest', 'nearest']);
    expect(all.filters[0]).toMatchObject({ n: 2 });
    expect(all.filters[5]).toMatchObject({ ax: { dir: [0, 0, 1] } });
    expect(all.filters[6]).toMatchObject({ type: 'cylinder' });
    expect(all.filters[9]).toMatchObject({ expr: '3 mm' });
    expect(all.filters[12]).toMatchObject({ p: [1, 2, 3] });
    expect(p('Body 1 edges |Z %line', 'edge')).toMatchObject({ t: 'query', of: 'edge', filters: [{ f: '|' }, { f: '%', type: 'line' }] });
    expect(p('all faces', 'face')).toMatchObject({ scope: { s: 'all' } });
    expect(p('Body 1 vertices >X', 'vertex')).toMatchObject({ of: 'vertex' });
    // A plain feature name scopes by the feature when no body has the name.
    expect(p('Base faces', 'face')).toMatchObject({ scope: { s: 'feature', feature: { id: 'f_base' } } });
    expect(p('Body 1 faces radius r/2 >Z', 'face')).toMatchObject({ filters: [{ f: 'radius', expr: 'r/2' }, { f: '>' }] });
    // Filters a kind does not have are refused where they stand.
    expect(err('Body 1 edges +Z', 'edge')).toMatchObject({ column: 14 });
    expect(err('Body 1 edges +Z', 'edge').message).toMatch(/filters faces/);
    expect(err('Body 1 edges hole', 'edge').message).toMatch(/hole filters round faces/);
    expect(err('Body 1 faces %line', 'face').message).toMatch(/expected %plane/);
    expect(err('Body 1 faces >Z[0]', 'face').message).toMatch(/levels count from \[1\]/);
    expect(err('Body 1 faces >W', 'face')).toMatchObject({ column: 15 });
    expect(err('Body 1 faces >Z junk', 'face')).toMatchObject({ column: 17 });
  });

  it('reads points, edges of a face, pairs of faces', () => {
    expect(p('Body 1 face at (0, 0, 6)', 'face')).toMatchObject({ t: 'at', of: 'face', body: { id: 'b_1' }, p: [0, 0, 6] });
    expect(p('face at (1.5,-2,3e1)', 'face')).toMatchObject({ t: 'at', body: null, p: [1.5, -2, 30] });
    expect(p('edge at (0, 0, 6)', 'edge')).toMatchObject({ t: 'at', of: 'edge' });
    expect(p('Body 1 vertex at (0, 0, 0)', 'vertex')).toMatchObject({ t: 'at', of: 'vertex' });
    expect(p('edges of Base.end', 'edge')).toMatchObject({ t: 'edges-of', face: { t: 'role', role: 'end' }, filters: [] });
    expect(p('edges of Base.end %line', 'edge')).toMatchObject({ t: 'edges-of', filters: [{ f: '%', type: 'line' }] });
    expect(p('edges of #f2 |X', 'edge')).toMatchObject({ t: 'edges-of', face: { t: 'handle' }, filters: [{ f: '|' }] });
    // A face query goes in brackets with its own filters; the filters after them are the edges'.
    expect(p('edges of (Body 1 faces >Z) >X', 'edge')).toMatchObject({ t: 'edges-of', face: { t: 'query', of: 'face', filters: [{ f: '>', ax: { text: 'Z' } }] }, filters: [{ f: '>', ax: { text: 'X' } }] });
    expect(p('edges of (Body 1 faces >Z) %line', 'edge')).toMatchObject({ face: { t: 'query', filters: [{ f: '>' }] }, filters: [{ f: '%', type: 'line' }] });
    expect(p('edges of (Body 1 faces >Z |X)', 'edge')).toMatchObject({ face: { t: 'query', filters: [{ f: '>' }, { f: '|' }] }, filters: [] });
    expect(p('edges of (Base.end) |X', 'edge')).toMatchObject({ face: { t: 'role', role: 'end' }, filters: [{ f: '|' }] });
    expect(p('edges of Body 1 faces', 'edge')).toMatchObject({ face: { t: 'query', filters: [] }, filters: [] });
    // Bare with a filter it could be read either way: refused, naming both bracket forms.
    for (const tail of ['>X', '|X', '%line']) {
      const e = err(`edges of Body 1 faces >Z ${tail}`, 'edge');
      expect(e).toMatchObject({ column: 23 });
      expect(e.message).toContain(`put a face query in brackets here, the faces' filters inside and the edges' after them: "edges of (Body 1 faces >Z ${tail})" takes every edge of those faces, "edges of (Body 1 faces) >Z ${tail}" filters the edges`);
    }
    expect(err('edges of (Body 1 faces >Z', 'edge').message).toMatch(/expected "\)" after the face/);
    expect(p('Base.end & Base.side(r.top)', 'edge')).toMatchObject({ t: 'pair', a: { role: 'end' }, b: { role: 'side', detail: 'r__top' } });
    expect(p('Bracket.side(p.3) & Bracket.side(p.4)', 'edge')).toMatchObject({ t: 'pair', a: { feature: { id: 'f_bracket' }, detail: 'p__3' }, b: { detail: 'p__4' } });
    expect(err('face at (0, 0)', 'face').message).toMatch(/expected ","/);
  });

  it('reads bodies, planes, axes and regions', () => {
    expect(p('Body 1', 'body')).toEqual({ t: 'body', of: 'body', body: { id: 'b_1', name: 'Body 1' } });
    expect(p('bodies of Base', 'body')).toMatchObject({ t: 'bodies-of', feature: { id: 'f_base' } });
    expect(p('all bodies', 'body')).toEqual({ t: 'all-bodies', of: 'body' });
    expect(p('bodies')).toEqual({ t: 'all-bodies', of: 'body' });
    expect(p('Top', 'plane')).toMatchObject({ t: 'plane', base: { b: 'origin', plane: 'origin:top' }, offset: null, flip: false });
    expect(p('xz', 'plane')).toMatchObject({ base: { plane: 'origin:front' } });
    expect(p('YZ', 'plane')).toMatchObject({ base: { plane: 'origin:right' } });
    expect(p('Top offset 12 mm', 'plane')).toMatchObject({ offset: '12 mm', flip: false });
    expect(p('Front offset t/2 flip', 'plane')).toMatchObject({ base: { plane: 'origin:front' }, offset: 't/2', flip: true });
    expect(p('Mid plane offset 3 mm', 'plane')).toMatchObject({ base: { b: 'feature', feature: { id: 'f_pl' } }, offset: '3 mm' });
    expect(p('Base.end offset 2 mm', 'plane')).toMatchObject({ base: { b: 'face', face: { t: 'role', role: 'end' } }, offset: '2 mm' });
    expect(p('Base.end offset 2 mm')).toMatchObject({ t: 'plane' });
    expect(p('Z axis', 'axis')).toMatchObject({ t: 'axis', base: { b: 'origin', axis: 'origin:z' } });
    expect(p('x', 'axis')).toMatchObject({ base: { axis: 'origin:x' } });
    expect(p('Profile.ax', 'axis')).toMatchObject({ base: { b: 'sketch-line', sketch: { id: 'f_prof' }, entity: 'ax' } });
    expect(p('Profile.r.left', 'axis')).toMatchObject({ base: { b: 'sketch-line', entity: 'r__left' } });
    expect(p('Spin axis', 'axis')).toMatchObject({ base: { b: 'feature', feature: { id: 'f_ax' } } });
    expect(p('axis of Base.side(c1)', 'axis')).toMatchObject({ base: { b: 'face-axis', face: { role: 'side', detail: 'c1' } } });
    expect(p('normal of Top', 'axis')).toMatchObject({ base: { b: 'normal', plane: { base: { plane: 'origin:top' } } } });
    expect(p('Base.end & Base.side(l2)', 'axis')).toMatchObject({ base: { b: 'edge', edge: { t: 'pair' } } });
    expect(p('r2', 'region')).toMatchObject({ t: 'region', sketch: null, which: { w: 'r', n: 2 } });
    expect(p('all', 'region')).toMatchObject({ which: { w: 'all' } });
    expect(p('largest', 'region')).toMatchObject({ which: { w: 'largest' } });
    expect(p('at(10, -5)', 'region')).toMatchObject({ which: { w: 'at', uv: [10, -5] } });
    expect(p('at (10, -5)', 'region')).toMatchObject({ which: { w: 'at', uv: [10, -5] } });
    expect(p('Plate sketch r2', 'region')).toMatchObject({ sketch: { id: 'f_sk' }, which: { w: 'r', n: 2 } });
    expect(p('Plate sketch', 'region')).toMatchObject({ sketch: { id: 'f_sk' }, which: { w: 'all' } });
    expect(p('Plate sketch regions')).toMatchObject({ t: 'region', which: { w: 'regions' } });
    expect(p('Plate sketch at(1, 2)')).toMatchObject({ t: 'region', which: { w: 'at' } });
    expect(p('+e_1[p:a>p:b] +e_2[p:b>p:a]', 'region')).toMatchObject({ which: { w: 'key', key: '+e_1[p:a>p:b] +e_2[p:b>p:a]' } });
  });

  it('matches the longest known name, quotes, and names holding the grammar\'s words', () => {
    expect(p('Body 10 faces', 'face')).toMatchObject({ scope: { body: { id: 'b_10' } } });
    expect(p('Body 1 faces', 'face')).toMatchObject({ scope: { body: { id: 'b_1' } } });
    expect(p('Boss.v2.end', 'face')).toMatchObject({ feature: { id: 'f_boss' }, role: 'end' });
    expect(p('"Boss.v2".end', 'face')).toMatchObject({ feature: { id: 'f_boss' }, role: 'end' });
    expect(p('Cut of top.end', 'face')).toMatchObject({ feature: { id: 'f_of' } });
    expect(p('edges of Cut of top.end', 'edge')).toMatchObject({ t: 'edges-of', face: { feature: { id: 'f_of' } } });
    expect(p('A & B.end', 'face')).toMatchObject({ feature: { id: 'f_amp' }, role: 'end' });
    expect(p('A & B.end & Base.end', 'edge')).toMatchObject({ t: 'pair', a: { feature: { id: 'f_amp' } }, b: { feature: { id: 'f_base' } } });
    expect(p('Body 1 face at (0, 0, 1)', 'face')).toMatchObject({ body: { id: 'b_1' } });
    // A name is never read as syntax: an unknown name is an error at its first character.
    const e = err('Bodyy 1 faces >Z', 'face');
    expect(e.column).toBe(1);
    expect(e.message).toMatch(/no (body|feature) starts here/);
    expect(err('"Nope".end', 'face').message).toMatch(/nothing in this Part is called "Nope"/);
    expect(quoteName('Boss.v2')).toBe('"Boss.v2"');
    expect(quoteName('Body 1')).toBe('Body 1');
    expect(quoteName('Cut of top')).toBe('"Cut of top"');
    expect(quoteName('Say "hi"')).toBe('"Say \\"hi\\""');
  });

  it('reads a name that is both a body and a feature by the grammar', () => {
    expect(p('Bracket.end', 'face')).toMatchObject({ t: 'role', feature: { id: 'f_bracket' } });
    expect(p('Bracket faces >Z', 'face')).toMatchObject({ t: 'query', scope: { s: 'body', body: { id: 'b_br' } } });
    expect(p('feature Bracket faces', 'face')).toMatchObject({ t: 'query', scope: { s: 'feature', feature: { id: 'f_bracket' } } });
    expect(p('bodies of Bracket', 'body')).toMatchObject({ t: 'bodies-of', feature: { id: 'f_bracket' } });
    expect(p('Bracket', 'body')).toMatchObject({ t: 'body', body: { id: 'b_br' } });
    expect(p('Bracket')).toMatchObject({ t: 'body', body: { id: 'b_br' } });
    expect(p('Bracket face at (0, 0, 0)', 'face')).toMatchObject({ t: 'at', body: { id: 'b_br' } });
  });

  it('gives the column where it stopped, and says what it needs', () => {
    expect(err('', 'face').message).toMatch(/a face selector is needed here/);
    expect(err('Body 1 fcaes', 'face')).toMatchObject({ column: 8 });
    expect(err('Top offset', 'plane').message).toMatch(/expected a length after "offset"|expected "offset/);
    expect(err('Base.end &', 'edge').column).toBeGreaterThanOrEqual(10);
    expect(err('Body 1 faces >Z', 'body').column).toBeGreaterThanOrEqual(8);
  });
});

describe('fillets and sized holes (S4: faces found by their shape)', () => {
  const filters = (text: string) => (p(text, 'face') as Extract<Sel, { t: 'query' }>).filters;

  it('reads fillet with no size, a plain size (equal), <= and >=', () => {
    expect(filters('Body 1 faces fillet')).toEqual([{ f: 'fillet', size: null, col: 14, text: 'fillet' }]);
    expect(filters('Body 1 faces fillet 2 mm')).toEqual([{ f: 'fillet', size: { cmp: '=', expr: '2 mm' }, col: 14, text: 'fillet 2 mm' }]);
    expect(filters('Body 1 faces fillet <= 2 mm')).toEqual([{ f: 'fillet', size: { cmp: '<=', expr: '2 mm' }, col: 14, text: 'fillet <= 2 mm' }]);
    expect(filters('Body 1 faces fillet >= 5 mm')).toEqual([{ f: 'fillet', size: { cmp: '>=', expr: '5 mm' }, col: 14, text: 'fillet >= 5 mm' }]);
    expect(filters('Body 1 faces fillet <=2mm')).toMatchObject([{ size: { cmp: '<=', expr: '2mm' } }]);
    // An expression of parameters, brackets and all; it stops at the next filter.
    expect(filters('Body 1 faces fillet <= (r + 1) mm >Z')).toMatchObject([{ f: 'fillet', size: { cmp: '<=', expr: '(r + 1) mm' } }, { f: '>' }]);
    expect(filters('all faces fillet r/2 largest')).toMatchObject([{ f: 'fillet', size: { cmp: '=', expr: 'r/2' } }, { f: 'largest' }]);
    // With no size, the next filter reads as a filter: "<Z" is a level, "hole" plain.
    expect(filters('Body 1 faces fillet <Z')).toMatchObject([{ f: 'fillet', size: null }, { f: '<', ax: { text: 'Z' } }]);
    expect(filters('Body 1 faces fillet >Z[2]')).toMatchObject([{ f: 'fillet', size: null }, { f: '>', n: 2 }]);
    expect(filters('Body 1 faces fillet hole')).toMatchObject([{ f: 'fillet', size: null }, { f: 'hole' }]);
    expect(filters('Body 1 faces fillet %torus')).toMatchObject([{ f: 'fillet', size: null }, { f: '%', type: 'torus' }]);
  });

  it('reads a sized hole as whole drilled holes, and a plain hole as the per-face filter it was', () => {
    expect(filters('Body 1 faces hole <= 6 mm')).toEqual([{ f: 'sized-hole', size: { cmp: '<=', expr: '6 mm' }, col: 14, text: 'hole <= 6 mm' }]);
    expect(filters('Body 1 faces hole 6 mm')).toEqual([{ f: 'sized-hole', size: { cmp: '=', expr: '6 mm' }, col: 14, text: 'hole 6 mm' }]);
    expect(filters('Body 1 faces hole >= 10 mm')).toMatchObject([{ f: 'sized-hole', size: { cmp: '>=', expr: '10 mm' } }]);
    expect(filters('Body 1 faces hole')).toEqual([{ f: 'hole', col: 14, text: 'hole' }]);
    // help's own example ("hole radius <r>") is still a plain hole then a radius.
    expect(filters('Body 1 faces hole radius 3 mm')).toMatchObject([{ f: 'hole' }, { f: 'radius', expr: '3 mm', cmp: '=' }]);
    expect(filters('Body 1 faces hole <Z')).toMatchObject([{ f: 'hole' }, { f: '<' }]);
    expect(filters('Body 1 faces hole boss')).toMatchObject([{ f: 'hole' }, { f: 'boss' }]);
  });

  it('reads radius <= and >=; a plain radius as it was; a radius stops at fillet', () => {
    expect(filters('Body 1 faces radius <= 3 mm')).toEqual([{ f: 'radius', expr: '3 mm', cmp: '<=', col: 14, text: 'radius <= 3 mm' }]);
    expect(filters('Body 1 faces radius >= 3 mm')).toMatchObject([{ f: 'radius', expr: '3 mm', cmp: '>=' }]);
    expect(filters('Body 1 faces radius 3 mm')).toMatchObject([{ f: 'radius', expr: '3 mm', cmp: '=' }]);
    expect(filters('Body 1 faces radius 2 mm fillet')).toMatchObject([{ f: 'radius', expr: '2 mm', cmp: '=' }, { f: 'fillet', size: null }]);
    expect(filters('Body 1 faces radius 2 mm fillet <= 3 mm')).toMatchObject([{ f: 'radius', expr: '2 mm' }, { f: 'fillet', size: { cmp: '<=', expr: '3 mm' } }]);
  });

  it('ends a size at a bracket, "&" and "offset" (an edge query, two faces, a plane)', () => {
    expect(p('edges of (Body 1 faces fillet <= 2 mm) |X', 'edge')).toMatchObject({ t: 'edges-of', face: { t: 'query', filters: [{ f: 'fillet', size: { expr: '2 mm' } }] }, filters: [{ f: '|' }] });
    expect(p('edges of (Body 1 faces radius 3 mm) |X', 'edge')).toMatchObject({ face: { t: 'query', filters: [{ f: 'radius', expr: '3 mm' }] }, filters: [{ f: '|' }] });
    expect(p('Body 1 faces fillet 2 mm & Base.end', 'edge')).toMatchObject({ t: 'pair', a: { t: 'query', filters: [{ f: 'fillet', size: { expr: '2 mm' } }] } });
    expect(p('Body 1 faces hole 6 mm >Z offset 2 mm', 'plane')).toMatchObject({ t: 'plane', offset: '2 mm', base: { b: 'face', face: { filters: [{ f: 'sized-hole', size: { expr: '6 mm' } }, { f: '>' }] } } });
  });

  it('refuses fillet and a sized hole on edges or vertices, naming the faces form', () => {
    const e = err('Body 1 edges fillet');
    expect(e.message).toBe('fillet filters faces: Body 1 faces fillet <= 2 mm');
    expect(e.column).toBe(14);
    expect(err('Body 1 vertices fillet').message).toBe('fillet filters faces: Body 1 faces fillet <= 2 mm');
    expect(err('Body 1 edges fillet >= 5 mm').message).toBe('fillet filters faces: Body 1 faces fillet >= 5 mm');
    expect(err('all edges hole <= 6 mm').message).toBe('hole <= 6 mm filters faces: all faces hole <= 6 mm');
    expect(err('edges of Base.end fillet', 'edge').message).toBe('fillet filters faces: Body 1 faces fillet <= 2 mm');
    // A plain hole keeps its words.
    expect(err('Body 1 edges hole', 'edge').message).toBe('hole filters round faces');
  });

  it('refuses a bare < or > after fillet, hole or radius (<Z and >Z are levels), with the form to write', () => {
    const e = err('Body 1 faces fillet < 2 mm');
    expect(e.message).toBe('write <= or >= after fillet (<Z and >Z are levels): fillet <= 2 mm');
    expect(e.column).toBe(21);
    expect(err('Body 1 faces fillet > 5 mm').message).toBe('write <= or >= after fillet (<Z and >Z are levels): fillet >= 5 mm');
    expect(err('Body 1 faces fillet <3').message).toBe('write <= or >= after fillet (<Z and >Z are levels): fillet <= 3');
    expect(err('Body 1 faces fillet <').message).toBe('write <= or >= after fillet (<Z and >Z are levels): fillet <= 2 mm');
    expect(err('Body 1 faces hole < 6 mm').message).toBe('write <= or >= after hole (<Z and >Z are levels): hole <= 6 mm');
    expect(err('Body 1 faces radius > 3 mm').message).toBe('write <= or >= after radius (<Z and >Z are levels): radius >= 3 mm');
    expect(err('Body 1 faces fillet <=').message).toBe('expected a size after "fillet <=" (fillet <= 2 mm)');
    expect(err('Body 1 faces radius').message).toMatch(/expected a radius after "radius"/);
  });

  it('a bare fillet <= 2 mm, with no scope, does not read (resolve adds "put the scope first")', () => {
    for (const q of ['fillet <= 2 mm', 'fillet', 'hole <= 6 mm']) expect(() => p(q)).toThrow(SelectorSyntaxError);
  });
});

describe('labels', () => {
  const featureName = (id: string) => NAMES.features.find((f) => f.id === id)?.name ?? null;
  const names = { featureName };
  const keyOf = (s: Sel) => {
    const r = s as Extract<Sel, { t: 'role' }>;
    return `${r.feature.id}\u0000${r.role}\u0000${r.detail ?? ''}`;
  };

  it('every label written reads back to the same face (sweep sides with @, inner, copies, mirror)', () => {
    const body = [
      'F:f_base:start',
      'F:f_base:end:1',
      'F:f_base:side:e_1[p:pt_a>p:pt_b]',
      'F:f_base:side:r__top.b[x:e_1|e_2#0>p:pt_b]',
      'F:f_base:side:p__3[p:p__p2>p:p__p3]',
      'F:f_pipe:side:o[]@a2',
      'F:f_pipe:side:o[]@l1.b[p:a>p:b]',
      'F:f_fil:fillet:E:F:f_base:end:1&F:f_base:side:e_1[p:pt_a>p:pt_b]',
      'F:f_fil:fillet:E:F:f_base:end:1&F:f_base:side:p__3[p:p__p2>p:p__p3]',
      'F:f_sh:inner:F:f_base:start',
      'F:f_pat:i3:F:f_base:end:1',
      'F:f_mir:m:F:f_base:start',
      'F:f_of:cut',
      'F:f_amp:import:0:11',
      'F:f_amp:enclosure:+x',
    ];
    const want = [
      'Base.start',
      'Base.end(2)',
      'Base.side(e_1)',
      'Base.side(r.top)',
      'Base.side(p.3)',
      'Pipe.side(o@a2)',
      'Pipe.side(o@l1)',
      'Fillet 1.fillet(1)',
      'Fillet 1.fillet(2)',
      'Shell 1.inner(Base.start)',
      'Pattern 1.copy(3)',
      'Mirror 1.mirror',
      '"Cut of top".cut',
      '"A & B".import(12)',
      '"A & B".enclosure(+x)',
    ];
    body.forEach((name, i) => {
      const lb = baseLabel(name, names, body)!;
      expect(lb.text, name).toBe(want[i]);
      expect(keyOf(p(lb.text, 'face')), lb.text).toBe(lb.key);
    });
    // No label: an unnamed role, a positional or edge side.
    expect(baseLabel('F:f_base:new', names, body)).toBeNull();
    expect(baseLabel('F:f_base:side:E:F:a:end&F:b:start', names, body)).toBeNull();
    expect(baseLabel('F:f_base:side:e3', names, body)).toBeNull();
    expect(baseLabel('F:f_gone:end', names, body)).toBeNull();
  });

  it('numbers faces that share a label ~1, ~2 in a fixed order, and a split face warns', () => {
    const idx = new LabelIndex(
      [
        { id: 'b_1', names: { faces: ['F:f_base:end#1', 'F:f_base:end#0', 'F:f_base:side:c1[x:c1|l2#1>x:c1|l2#0]', 'F:f_base:side:c1[x:c1|l2#0>x:c1|l2#1]', 'F:f_base:start|F:f_of:end'] } },
        { id: 'b_2', names: { faces: ['F:f_base:start:0'] } },
      ],
      names,
    );
    expect(idx.of(0, 1)).toMatchObject({ label: 'Base.end~1', warning: expect.stringContaining('split face') });
    expect(idx.of(0, 0)).toMatchObject({ label: 'Base.end~2' });
    expect(idx.of(0, 3).label).toBe('Base.side(c1)~1');
    expect(idx.of(0, 2).label).toBe('Base.side(c1)~2');
    expect(idx.of(0, 2).warning).toBeNull();
    // A merged face: the label of its first part with one; both select it.
    expect(idx.of(0, 4)).toMatchObject({ label: 'Base.start', keys: ['f_base\u0000start\u0000', 'f_of\u0000end\u0000'] });
    expect(idx.of(1, 0).label).toBe('Base.start(1)');
    // ~k order is what members() gives.
    expect(idx.members('f_base\u0000end\u0000')).toEqual([
      { body: 0, face: 1 },
      { body: 0, face: 0 },
    ]);
    expect(idx.rolesOf('f_base')).toEqual(
      new Map([
        ['end', 2],
        ['side', 2],
        ['start', 2],
      ]),
    );
  });
});
