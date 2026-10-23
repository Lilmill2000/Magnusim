import { describe, expect, it } from 'vitest';
import { cloneResultControls, runCopyBody, type RunCopyInput } from './runCopyBody';
import { carrySettle } from './runSettle';

let n = 0;
const base = (o: Partial<RunCopyInput> = {}): RunCopyInput => ({
  src: {
    id: 'r1',
    simulation_id: 's1',
    mesh_id: 'm1',
    endTime: 200,
    writeInterval: 50,
    time_dependency: 'Steady-state',
    result_controls: [{ id: 'rc-1', name: 'Area average 1', results: [1], series: [2], results_available: true }],
    settle: { id: 'rc-1', source: 'monitor', window: 50 },
  },
  dest: { id: 'r2', simulation_id: 's1', mesh_id: 'm2', result_controls: [{ id: 'rc-9' }] },
  studyId: 's1',
  fallback: { endTime: 100, writeInterval: 10 },
  insideCreate: false,
  studyTransient: false,
  srcTransient: false,
  transient: { end_time: 2 },
  cores: 4,
  studyBcIds: [],
  newRcId: () => `rc-new-${(n += 1)}`,
  carry: carrySettle,
  ...o,
});

describe('runCopyBody: "Copy settings from" for a run, shared by the run panel and the Assistant', () => {
  it('a run of this study: its mesh, times, monitors (new ids, no results), cores; its settle follows its monitor', () => {
    const { body, otherStudy, note } = runCopyBody(base());
    expect(otherStudy).toBe(false);
    expect(note).toBe('');
    expect(body).toMatchObject({ run_id: 'r2', mesh_id: 'm1', endTime: 200, writeInterval: 50, time_dependency: 'Steady-state', transient: { end_time: 2 }, cores: 4, settle_time_dependency: 'Steady-state' });
    const rcs = body.result_controls as Array<Record<string, unknown>>;
    expect(rcs).toHaveLength(1);
    expect(rcs[0].id).not.toBe('rc-1');
    expect([rcs[0].results, rcs[0].series, rcs[0].results_available]).toEqual([null, null, false]);
    expect((body.settle as { id: string }).id).toBe(rcs[0].id);
  });

  it('a run of another study: only the time settings; the mesh and monitors stay, the settle is off with why', () => {
    const { body, otherStudy, note } = runCopyBody(base({ studyId: 's2' }));
    expect(otherStudy).toBe(true);
    expect(body.mesh_id).toBe('m2');
    expect(body.result_controls).toEqual([{ id: 'rc-9' }]);
    expect(body.settle).toBeNull();
    expect(note).toMatch(/stays with the other study/);
  });

  it('inside Add run the new run follows the study; missing times come from the fallback', () => {
    const { body } = runCopyBody(base({ insideCreate: true, studyTransient: true, src: { id: 'r1', simulation_id: 's1', mesh_id: 'm1' } }));
    expect([body.time_dependency, body.endTime, body.writeInterval, body.settle_time_dependency]).toEqual(['Transient', 100, 10, 'Transient']);
  });

  it('cloneResultControls gives each control a new id and no results', () => {
    expect(cloneResultControls([{ id: 'a', name: 'x' }], () => 'b')).toEqual([{ id: 'b', name: 'x', results: null, series: null, chart_values: null, results_available: false }]);
    expect(cloneResultControls(null, () => 'b')).toEqual([]);
  });
});
