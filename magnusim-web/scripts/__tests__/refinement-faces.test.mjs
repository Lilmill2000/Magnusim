import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { resolveRefinementFaces } from '../w26-mesh-refinements.js';

describe('refinement faces survive a settings save', () => {
  it('keeps the assigned face when a slider POST sends []', () => {
    const existing = { faces: ['face 1@Body1'], face: 'face 1@Body1' };
    assert.deepEqual(resolveRefinementFaces({ faces: [] }, existing), ['face 1@Body1']);
  });

  it('keeps the assigned face when the POST omits faces', () => {
    const existing = { faces: ['face 1@Body1'] };
    assert.deepEqual(resolveRefinementFaces({ fineness: 8 }, existing), ['face 1@Body1']);
  });

  it('writes a newly assigned face', () => {
    assert.deepEqual(
      resolveRefinementFaces({ faces: ['face 1@Body1'] }, { faces: [] }),
      ['face 1@Body1']
    );
  });

  it('clears faces only when the client says so', () => {
    const existing = { faces: ['face 1@Body1'] };
    assert.deepEqual(resolveRefinementFaces({ faces: [], faces_explicit: true }, existing), []);
  });
});
