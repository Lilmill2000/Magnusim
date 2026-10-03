// The exported STEP's header (src/features/export/header.ts): FILE_NAME names the
// file and leaves the author blank; the rest of the file is the kernel's, byte for
// byte (review P2/P3 round 3: 'Open CASCADE Shape Model', ('Author')).
// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { stepString, withStepHeader } from '../../../src/features/export/header';

/** What OCCT 7.9's writer puts at the top of a file (as in the reviewer's "Part 3.step"). */
const KERNEL = [
  'ISO-10303-21;',
  'HEADER;',
  "FILE_DESCRIPTION(('Open CASCADE Model'),'2;1');",
  "FILE_NAME('Open CASCADE Shape Model','2026-10-02T01:18:13',('Author'),(",
  "    'Open CASCADE'),'Open CASCADE STEP processor 7.9','Open CASCADE 7.9'",
  "  ,'Unknown');",
  "FILE_SCHEMA(('AUTOMOTIVE_DESIGN { 1 0 10303 214 1 1 1 1 }'));",
  'ENDSEC;',
  'DATA;',
  "#7 = PRODUCT('Vortex CFD Test v1','Vortex CFD Test v1','',(#8));",
  'ENDSEC;',
  'END-ISO-10303-21;',
  '',
].join('\n');

const bytes = (t: string) => Uint8Array.from(t, (c) => c.charCodeAt(0));
const text = (b: Uint8Array) => String.fromCharCode(...b);

describe('STEP header', () => {
  it("names the file, leaves author, organization and authorization blank, keeps the time and OCCT's processor", () => {
    const out = text(withStepHeader(bytes(KERNEL), 'Part 3.step')!);
    expect(out).toContain("FILE_NAME('Part 3.step','2026-10-02T01:18:13',(''),(''),'Open CASCADE STEP processor 7.9','Magnusim CAD','');\nFILE_SCHEMA(");
    expect(out).not.toContain('Open CASCADE Shape Model');
    expect(out).not.toContain("'Author'");
    // Everything else as the kernel wrote it.
    expect(out.slice(0, out.indexOf('FILE_NAME'))).toBe(KERNEL.slice(0, KERNEL.indexOf('FILE_NAME')));
    expect(out.slice(out.indexOf('FILE_SCHEMA'))).toBe(KERNEL.slice(KERNEL.indexOf('FILE_SCHEMA')));
  });

  it('writes names with quotes, backslashes and non-ASCII letters as STEP strings', () => {
    expect(stepString("Daniel's part")).toBe("'Daniel''s part'");
    expect(stepString('a\\b')).toBe("'a\\\\b'");
    expect(stepString('Größe 1.step')).toBe("'Gr\\X2\\00F600DF\\X0\\e 1.step'");
    const out = text(withStepHeader(bytes(KERNEL), "Daniel's Größe.step")!);
    expect(out).toContain("FILE_NAME('Daniel''s Gr\\X2\\00F600DF\\X0\\e.step',");
    expect([...out].every((c) => c.charCodeAt(0) < 128)).toBe(true);
  });

  it('leaves a file it does not recognise alone (null)', () => {
    expect(withStepHeader(bytes('ISO-10303-21;\nDATA;\nENDSEC;\n'), 'x.step')).toBeNull();
    expect(withStepHeader(bytes("ISO-10303-21;\nHEADER;\nFILE_NAME('a','b');\nENDSEC;\n"), 'x.step')).toBeNull();
  });
});
