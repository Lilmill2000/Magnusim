import { describe, expect, it, afterEach } from 'vitest';
import { readSetupTree } from './treeModel';

afterEach(() => {
  delete window.__CFD_JOB_ACTIVITY__;
  delete window.__CFD_W16_STATE__;
  delete window.__CFD_W17_STATE__;
  delete window.__CFD_W20_STATE__;
  delete window.__CFD_W27_STATE__;
});

function seedStudy() {
  window.__CFD_W16_STATE__ = {
    geometries: [{ id: 'g1', name: 'Part', bodies: ['Body1'] }],
  };
  window.__CFD_W17_STATE__ = {
    activeId: 's1',
    simulation: { id: 's1', name: 'Study', geometry_id: 'g1' },
    simulations: [{ id: 's1', name: 'Study', geometry_id: 'g1' }],
  };
  window.__CFD_W20_STATE__ = {
    meshes_all: [
      { id: 'mesh_1', name: 'Mesh 1', simulation_id: 's1', generated: true, case_dir: '/c', status: 'done' },
      { id: 'mesh_2', name: 'Mesh 2', simulation_id: 's1', generated: false },
    ],
  };
  window.__CFD_W27_STATE__ = {
    runs_all: [
      { id: 'run1', name: 'Run 1', mesh_id: 'mesh_1', simulation_id: 's1', status: 'draft' },
      { id: 'run2', name: 'Run 2', mesh_id: 'mesh_1', simulation_id: 's1', status: 'running' },
    ],
  };
}

describe('readSetupTree study order', () => {
  it('keeps drag order instead of alphabetical names', () => {
    window.__CFD_W16_STATE__ = {
      geometries: [{ id: 'g1', name: 'Part', bodies: ['Body1'] }],
    };
    window.__CFD_W17_STATE__ = {
      activeId: 's2',
      simulation: { id: 's2', name: 'Main', geometry_id: 'g1' },
      simulations: [
        { id: 's2', name: 'Main', geometry_id: 'g1', sort_index: 0 },
        { id: 's1', name: 'Inverse', geometry_id: 'g1', sort_index: 1 },
      ],
    };
    expect(readSetupTree().geoms[0].studies.map((s) => s.name)).toEqual(['Main', 'Inverse']);
  });
});

describe('readSetupTree job marks', () => {
  it('marks the live mesh and numbers queued jobs', () => {
    seedStudy();
    window.__CFD_JOB_ACTIVITY__ = {
      kind: 'mesh',
      mesh_id: 'mesh_2',
      run_id: null,
      queue: [
        { kind: 'solve', run_id: 'run1', mesh_id: 'mesh_1' },
        { kind: 'mesh', mesh_id: 'mesh_1', run_id: null },
      ],
    };
    const study = readSetupTree().geoms[0].studies[0];
    expect(study.meshes.find((m) => m.id === 'mesh_2')).toMatchObject({ busy: true, queuePos: 0 });
    expect(study.meshes.find((m) => m.id === 'mesh_1')).toMatchObject({ busy: false, queuePos: 2, ready: true });
    expect(study.runs.find((r) => r.id === 'run1')).toMatchObject({ busy: false, queuePos: 1 });
    expect(study.runs.find((r) => r.id === 'run2')).toMatchObject({ busy: true, ready: false, hasResults: false });
  });

  it('exposes Results on a live run once frames exist', () => {
    seedStudy();
    window.__CFD_W27_STATE__.runs_all[1] = {
      id: 'run2',
      name: 'Run 2',
      mesh_id: 'mesh_1',
      simulation_id: 's1',
      status: 'running',
      n_saved_times: 12,
      last_saved_iteration: 0.4,
    };
    const study = readSetupTree().geoms[0].studies[0];
    expect(study.runs.find((r) => r.id === 'run2')).toMatchObject({
      busy: true,
      ready: false,
      hasResults: true,
    });
  });

  it('renumbers tree badges when the queue array is reordered', () => {
    seedStudy();
    window.__CFD_JOB_ACTIVITY__ = {
      kind: 'mesh',
      mesh_id: 'mesh_2',
      run_id: null,
      queue: [
        { kind: 'mesh', mesh_id: 'mesh_1', run_id: null },
        { kind: 'solve', run_id: 'run1', mesh_id: 'mesh_1' },
      ],
    };
    const study = readSetupTree().geoms[0].studies[0];
    expect(study.meshes.find((m) => m.id === 'mesh_1')).toMatchObject({ queuePos: 1 });
    expect(study.runs.find((r) => r.id === 'run1')).toMatchObject({ queuePos: 2 });
  });

  it('replaces a leftover generating mark with a check when that mesh is done', () => {
    seedStudy();
    window.__CFD_W20_STATE__.meshes_all[1] = {
      id: 'mesh_2',
      name: 'Mesh 2',
      simulation_id: 's1',
      generated: true,
      case_dir: '/mesh2/case',
      n_cells: 678038,
      live_mesh_result: { status: 'done', n_cells: 678038, case_dir: '/mesh2/case' },
    };
    window.__CFD_JOB_ACTIVITY__ = { kind: 'mesh', mesh_id: 'mesh_2', run_id: null, queue: [] };
    const study = readSetupTree().geoms[0].studies[0];
    expect(study.meshes.find((m) => m.id === 'mesh_2')).toMatchObject({ busy: false, ready: true });
    expect(study.meshes.find((m) => m.id === 'mesh_1')).toMatchObject({ busy: false, ready: true });
  });

  it('does not mark a finished mesh busy when a solve is the live job', () => {
    seedStudy();
    window.__CFD_W20_STATE__.meshes_all[0].live_mesh_result = { status: 'running' };
    window.__CFD_JOB_ACTIVITY__ = {
      kind: 'solve',
      mesh_id: 'mesh_1',
      run_id: 'run2',
      queue: [],
    };
    const study = readSetupTree().geoms[0].studies[0];
    expect(study.meshes.find((m) => m.id === 'mesh_1')).toMatchObject({ busy: false, ready: true });
    expect(study.runs.find((r) => r.id === 'run2')).toMatchObject({ busy: true });
  });
});
