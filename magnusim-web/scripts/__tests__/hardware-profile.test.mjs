import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { computeProfile } from '../hardware-profile.js';

describe('hardware profile MPI ranks', () => {
  it('caps Windows core counts to fewer WSL Open MPI slots', () => {
    const hw = computeProfile({ physical: 14, logical: 20, ram_gb: 64, wsl_slots: 10 });
    assert.equal(hw.n_procs, 10);
  });

  it('still reserves a Windows core when WSL has enough slots', () => {
    const hw = computeProfile({ physical: 16, logical: 32, ram_gb: 64, wsl_slots: 16 });
    assert.equal(hw.n_procs, 15);
  });
});
