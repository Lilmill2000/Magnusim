// The face-name sidecar's words and form (LINK, host API 1.5): match keys without
// the "#k" suffix, readable labels, unique body names, the canonical bytes.
// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { cap, cleanText, faceKey, faceLabeler, faceNamesText, LABEL_MAX, NAME_MAX, natural, pieceName, uniqueNames } from '../../src/link/sidecar';

const features: Record<string, string> = { f_ex: 'Extrude 1', f_ex2: 'Extrude 2', f_enc: 'Enclosure 1', f_imp: 'Imported 1', f_sp: 'Split 1' };
const featureName = (id: string) => features[id] ?? null;

describe('sidecar: names and labels', () => {
  it('a face name is the persistent name without its internal #k split suffix', () => {
    expect(faceKey('F:f_ex:side:e_1[p:pt_a>p:pt_b]#2')).toBe('F:f_ex:side:e_1[p:pt_a>p:pt_b]');
    expect(faceKey('F:f_ex:end')).toBe('F:f_ex:end');
    // A crossing's ordinal inside a token's brackets is not a split suffix.
    expect(faceKey('F:f_ex:side:x:e_1|e_2#0]')).toBe('F:f_ex:side:x:e_1|e_2#0]');
    expect(faceKey(null)).toBeNull();
  });

  it('a name longer than the app takes keeps its start and a hash of the whole: stable and at most 200 characters', () => {
    const long = Array.from({ length: 12 }, (_, i) => `F:f_ex:side:e_${i}[p:pt_${i}>p:pt_${i + 1}]`).join('|');
    const a = faceKey(long)!;
    expect(a.length).toBeLessThanOrEqual(NAME_MAX);
    expect(faceKey(long)).toBe(a);
    expect(faceKey(`${long}x`)).not.toBe(a);
    expect(a.startsWith('F:f_ex:side:e_0')).toBe(true);
  });

  it('labels in words: sides numbered within their feature, caps, enclosure sides, imports, split pieces, merged faces', () => {
    const names = ['F:f_ex:side:e_10', 'F:f_ex:side:e_2', 'F:f_ex:end', 'F:f_ex:start#1', 'F:f_enc:enclosure:+x', 'F:f_imp:import:0:11', 'F:f_ex:end|F:f_ex2:end', 'F:gone:end', null];
    const label = faceLabeler(names, featureName);
    expect(names.map(label)).toEqual([
      'Extrude 1 · Side 2',
      'Extrude 1 · Side 1',
      'Extrude 1 · End',
      'Extrude 1 · Start · part 2',
      'Enclosure 1 · +X face',
      'Imported 1 · Face 12',
      'Extrude 1 · End + Extrude 2 · End',
      null,
      null,
    ]);
  });

  it('a label never passes the app limit of 120 characters', () => {
    const merged = Array.from({ length: 20 }, (_, i) => `F:f_ex:side:e_${i}`).join('|');
    const l = faceLabeler([merged], featureName)(merged)!;
    expect(l.length).toBeLessThanOrEqual(LABEL_MAX);
    expect(l).toBe('Extrude 1 · Side 1 + 19 more');
  });

  it('body names are unique in one export ("Body 1 (2)")', () => {
    expect(uniqueNames(['Body 1', 'Body 1', 'Fluid', 'Body 1'])).toEqual(['Body 1', 'Body 1 (2)', 'Fluid', 'Body 1 (3)']);
  });

  it('the pieces of one body read "Bar · piece 2" (link review polish), within the app\'s name limit', () => {
    expect(pieceName('Bar', 2)).toBe('Bar · piece 2');
    expect(uniqueNames(['Bar', pieceName('Bar', 2), pieceName('Bar', 3)])).toEqual(['Bar', 'Bar · piece 2', 'Bar · piece 3']);
    const long = pieceName('x'.repeat(400), 12);
    expect(long.length).toBeLessThanOrEqual(NAME_MAX - 6);
    expect(long.endsWith('… · piece 12')).toBe(true);
  });

  it('cap() never splits a surrogate pair (an emoji at the cut)', () => {
    const smile = String.fromCodePoint(0x1f600);
    const text = `${'a'.repeat(8)}${smile}${'b'.repeat(5)}`;
    // The cut lands between the two halves of the emoji: the whole emoji goes.
    const out = cap(text, 10);
    expect(out).toBe(`${'a'.repeat(8)}…`);
    expect(out.length).toBeLessThanOrEqual(10);
    expect(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(out)).toBe(false);
    expect(cap(`${'a'.repeat(7)}${smile}bbbb`, 10)).toBe(`${'a'.repeat(7)}${smile}…`);
  });

  it('text is cleaned as the app cleans it (no control or bidi characters)', () => {
    expect(cleanText(` A${String.fromCharCode(0x202e)}B${String.fromCharCode(7)} `)).toBe('AB');
  });

  it('natural order: digit runs as numbers, no locale', () => {
    expect(['e_10', 'e_2', 'e_1', 'd'].sort(natural)).toEqual(['d', 'e_1', 'e_2', 'e_10']);
  });
});

describe('sidecar: the canonical bytes', () => {
  it('sorted keys, no whitespace, rows by index, empty values left out, one line and a newline', () => {
    const text = faceNamesText(
      [{ index: 2, id: 'b2', name: 'Fluid', label: 'Fluid', color: '#8a9bb0' }, { index: 1, id: 'b1', name: 'Body 1', label: undefined }],
      [{ index: 2, body: 1, name: 'F:a:end' }, { index: 1, body: 1, name: undefined, label: undefined }],
      'ABCDEF'.padEnd(64, '0'),
    );
    expect(text).toBe(
      '{"bodies":[{"id":"b1","index":1,"name":"Body 1"},{"color":"#8a9bb0","id":"b2","index":2,"label":"Fluid","name":"Fluid"}],' +
        '"faces":[{"body":1,"index":1},{"body":1,"index":2,"name":"F:a:end"}],' +
        `"format":"magnusim.face-names","length_unit":"mm","shape_sha256":"${'abcdef'.padEnd(64, '0')}","version":1}\n`,
    );
  });
});
