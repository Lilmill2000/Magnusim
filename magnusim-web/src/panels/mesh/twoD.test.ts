import { describe, expect, it } from 'vitest';
import { lengthWords, twoDNote } from './twoD';

describe('One cell across (2D): the note under the setting', () => {
  it('says how the part is meshed: depth, axis, the two ends and their Symmetry', () => {
    const answer = {
      ok: true,
      available: true,
      two_d: { axis: 'z', depth_m: 0.01, cells_across: 1, front: { faces: ['Face 5@Body1'], bc: 'Sides' }, back: { faces: ['Face 3@Body1'], bc: 'Sides' } },
    };
    expect(twoDNote(answer)).toBe('2D: one cell across, 10 mm deep along z, between Face 5@Body1 and Face 3@Body1 (Symmetry "Sides").');
    // Two Symmetry BCs, one per end; several faces at one end.
    const two = { ...answer, two_d: { ...answer.two_d, depth_m: 0.4, front: { faces: ['Face 1@Body1', 'Face 2@Body1'], bc: 'Front' }, back: { faces: ['Face 9@Body1'], bc: 'Back' } } };
    expect(twoDNote(two)).toBe('2D: one cell across, 400 mm deep along z, between Face 1@Body1, Face 2@Body1 and Face 9@Body1 (Symmetry "Front" and "Back").');
  });

  it('says why it is not available, and that Generate refuses', () => {
    expect(twoDNote({ ok: true, available: false, reason: 'No boundary condition is a Symmetry.' })).toBe(
      'Not available on this part: No boundary condition is a Symmetry. Generate refuses until it is.',
    );
  });

  it('says when the part could not be checked, and while it is being checked', () => {
    expect(twoDNote({ ok: false, error: 'the study has no geometry' })).toBe("Couldn't check the part: the study has no geometry");
    expect(twoDNote(null, true)).toBe('Checking the part…');
    expect(twoDNote(null, false)).toBe('');
  });

  it('words lengths as the mesh summary does', () => {
    expect([lengthWords(2.5), lengthWords(0.01), lengthWords(0.0012), lengthWords(5e-5), lengthWords(0), lengthWords('x')]).toEqual([
      '2.5 m',
      '10 mm',
      '1.2 mm',
      '50 µm',
      '',
      '',
    ]);
  });
});
