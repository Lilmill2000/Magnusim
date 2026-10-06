// F10: a run's ranks (w27-solve.js runRanks) with and without its Cores setting.
// Auto (unset) keeps the rule before it: serial below the analysis's
// serial_below_cells, else one rank per physical core (hardwareRankCap) at most the
// saved WSL slots. A set count wins over the cell threshold (1 = serial), still at
// most hardwareRankCap and the WSL slots; a launch that is not parallel stays serial.
import { after, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ROOT = mkdtempSync(join(tmpdir(), 'magnusim-run-ranks-'));
mkdirSync(join(ROOT, 'projects'), { recursive: true });
process.env.MAGNUSIM_PROJECTS_ROOT = join(ROOT, 'projects');
process.env.MAGNUSIM_LOCAL_JSON = join(ROOT, 'local.json');
process.env.MAGNUSIM_QUEUE_QUIET = '1';

const { runRanks } = await import('../w27-solve.js');
const { hardwareRankCap, runCoresSetting, runRankCap } = await import('../ranks.js');
const { writeLocalDoc } = await import('../prefs.js');

after(() => {
  try {
    rmSync(ROOT, { recursive: true, force: true });
  } catch {
    /* Windows may hold a file */
  }
});

const BIG = 1_000_000;
const SMALL = 100;
const steady = { serialBelowCells: 1000, parallel: true };

describe('runRanks', () => {
  beforeEach(() => writeLocalDoc({ hardware: null }));

  it('Auto: serial below serial_below_cells, else the PC cap (unchanged)', () => {
    assert.equal(runRanks(SMALL, steady), 1);
    assert.equal(runRanks(BIG, steady), hardwareRankCap());
    assert.equal(runRanks(BIG, { ...steady, cores: null }), hardwareRankCap());
    // Unknown cell count: not serial by size.
    assert.equal(runRanks(0, steady), hardwareRankCap());
    // A launch that is not parallel.
    assert.equal(runRanks(BIG, { ...steady, parallel: false }), 1);
    // Blank, "auto", 0 and junk mean Auto.
    for (const cores of ['', 'auto', 0, -3, 'x', true]) {
      assert.equal(runRanks(SMALL, { ...steady, cores }), 1, `cores ${JSON.stringify(cores)}`);
      assert.equal(runRanks(BIG, { ...steady, cores }), hardwareRankCap(), `cores ${JSON.stringify(cores)}`);
    }
  });

  it('Auto without a serial_below_cells keeps the legacy thresholds', () => {
    assert.equal(runRanks(150_000, { parallel: true }), 1);
    assert.equal(runRanks(150_000, { parallel: true, transient: true }), hardwareRankCap());
  });

  it('an explicit count under the cap runs on that many', () => {
    assert.ok(hardwareRankCap() >= 2);
    assert.equal(runRanks(BIG, { ...steady, cores: 2 }), 2);
    assert.equal(runRanks(BIG, { ...steady, cores: '2' }), 2);
  });

  it('an explicit count over the cap is clamped to it', () => {
    assert.equal(runRanks(BIG, { ...steady, cores: 999 }), hardwareRankCap());
    writeLocalDoc({ hardware: { n_procs: 2 } });
    assert.equal(hardwareRankCap(), 2);
    assert.equal(runRanks(BIG, { ...steady, cores: 3 }), 2);
  });

  it('the saved WSL slots clamp an explicit count too', () => {
    writeLocalDoc({ hardware: { wsl_mpi_slots: 2 } });
    assert.equal(runRanks(BIG, { ...steady, cores: 999 }), 2);
    assert.equal(runRankCap(), 2);
  });

  it('an explicit count wins over serial_below_cells', () => {
    assert.equal(runRanks(SMALL, { ...steady, cores: 2 }), 2);
    assert.equal(runRanks(SMALL, { parallel: true, cores: 2 }), 2);
  });

  it('1 is serial, on any mesh', () => {
    assert.equal(runRanks(BIG, { ...steady, cores: 1 }), 1);
    assert.equal(runRanks(SMALL, { ...steady, cores: 1 }), 1);
  });

  it('a launch that is not parallel stays serial whatever the count', () => {
    assert.equal(runRanks(BIG, { ...steady, parallel: false, cores: 4 }), 1);
  });
});

describe('runRankCap / runCoresSetting', () => {
  beforeEach(() => writeLocalDoc({ hardware: null }));

  it('the cap the Run panel offers is the one runRanks clamps to', () => {
    assert.equal(runRankCap(), hardwareRankCap());
    assert.equal(runRanks(BIG, { ...steady, cores: 4096 }), runRankCap());
  });

  it('a Cores value is a whole number of at least 1, else Auto (null)', () => {
    assert.deepEqual(
      [3, '3', 3.7, 1, 0, -1, '', 'auto', null, undefined, false, 'abc'].map(runCoresSetting),
      [3, 3, 3, 1, null, null, null, null, null, null, null, null],
    );
  });
});
