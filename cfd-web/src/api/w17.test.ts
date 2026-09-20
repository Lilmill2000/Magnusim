import { describe, expect, it } from 'vitest';
import { acceptsW17Analysis } from './w17';

describe('acceptsW17Analysis', () => {
  it('keeps incompressible keys', () => {
    expect(acceptsW17Analysis('incompressible')).toBe(true);
    expect(acceptsW17Analysis('incompressible_steady')).toBe(true);
    expect(acceptsW17Analysis('Incompressible')).toBe(true);
  });

  it('rejects the example plugin', () => {
    expect(acceptsW17Analysis('example_passthrough')).toBe(false);
  });
});
