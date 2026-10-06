import { describe, expect, it } from 'vitest';
import { readSetupTree, type ProjectTreeDoc } from './treeModel';
import type { TreeActivity } from './treeSession';

function treeDoc(): ProjectTreeDoc {
  return {
    project_id: 'p1',
    geometries: [
      {
        id: 'g1',
        name: 'Part',
        key: 'p:p1/g:g1',
        bodies: ['Body1'],
        studies: [
          {
            id: 's1',
            name: 'Study',
            geometry_id: 'g1',
            key: 'p:p1/g:g1/s:s1',
            active: true,
            wall_default: 'No-slip',
            meshes: [
              {
                id: 'mesh_1',
                name: 'Mesh 1',
                key: 'p:p1/g:g1/s:s1/mesh:mesh_1',
                generated: true,
                case_dir: '/c',
                live_status: 'done',
              },
              { id: 'mesh_2', name: 'Mesh 2', key: 'p:p1/g:g1/s:s1/mesh:mesh_2' },
            ],
            runs: [
              { id: 'run1', name: 'Run 1', mesh_id: 'mesh_1', status: 'draft' },
              { id: 'run2', name: 'Run 2', mesh_id: 'mesh_1', status: 'running' },
            ],
          },
        ],
      },
    ],
  };
}

function activity(extra: Partial<TreeActivity> = {}): TreeActivity {
  return {
    project_id: 'p1',
    simulation_id: 's1',
    kind: 'mesh',
    mesh_id: 'mesh_2',
    run_id: null,
    queue: [],
    ...extra,
  };
}

describe('readSetupTree study order', () => {
  it('keeps drag order instead of alphabetical names', () => {
    const doc = treeDoc();
    doc.geometries![0].studies = [
      { id: 's2', name: 'Main', geometry_id: 'g1', sort_index: 0, active: true },
      { id: 's1', name: 'Inverse', geometry_id: 'g1', sort_index: 1 },
    ];
    expect(readSetupTree(doc).geoms[0].studies.map((s) => s.name)).toEqual(['Main', 'Inverse']);
  });
});

describe('readSetupTree material name', () => {
  it('keeps the saved name and stores blank when the study has none', () => {
    const doc = treeDoc();
    expect(readSetupTree(doc).geoms[0].studies[0].materialName).toBe('');
    doc.geometries![0].studies![0].material_name = 'Water';
    expect(readSetupTree(doc).geoms[0].studies[0].materialName).toBe('Water');
  });
});

describe('readSetupTree job marks', () => {
  it('marks the live mesh and numbers queued jobs', () => {
    const study = readSetupTree(
      treeDoc(),
      activity({
        queue: [
          { kind: 'solve', run_id: 'run1', mesh_id: 'mesh_1', project_id: 'p1', simulation_id: 's1' },
          { kind: 'mesh', mesh_id: 'mesh_1', run_id: null, project_id: 'p1', simulation_id: 's1' },
        ],
      }),
    ).geoms[0].studies[0];
    expect(study.meshes.find((m) => m.id === 'mesh_2')).toMatchObject({ busy: true, queuePos: 0 });
    expect(study.meshes.find((m) => m.id === 'mesh_1')).toMatchObject({ busy: false, queuePos: 2, ready: true });
    expect(study.runs.find((r) => r.id === 'run1')).toMatchObject({ busy: false, queuePos: 1 });
    expect(study.runs.find((r) => r.id === 'run2')).toMatchObject({ busy: true, ready: false, hasResults: false });
  });

  it('a finished run that converged carries it (its tree badge); a running one does not', () => {
    const doc = treeDoc();
    doc.geometries![0].studies![0].runs = [
      { id: 'run1', name: 'Run 1', status: 'done', converged: { by: 'residuals', iteration: 215 } },
      { id: 'run2', name: 'Run 2', status: 'running', converged: { by: 'residuals', iteration: 9 } },
      { id: 'run3', name: 'Run 3', status: 'done' },
    ];
    const runs = readSetupTree(doc, null).geoms[0].studies[0].runs;
    expect(runs.map((r) => r.converged ?? null)).toEqual([{ by: 'residuals', iteration: 215 }, null, null]);
  });

  it('exposes Results on a live run once frames exist', () => {
    const doc = treeDoc();
    doc.geometries![0].studies![0].runs![1] = {
      id: 'run2',
      name: 'Run 2',
      mesh_id: 'mesh_1',
      status: 'running',
      n_saved_times: 12,
      last_saved_iteration: 0.4,
    };
    const study = readSetupTree(doc, activity({ kind: 'solve', mesh_id: 'mesh_1', run_id: 'run2' })).geoms[0]
      .studies[0];
    expect(study.runs.find((r) => r.id === 'run2')).toMatchObject({
      busy: true,
      ready: false,
      hasResults: true,
    });
  });

  it('renumbers tree badges when the queue array is reordered', () => {
    const study = readSetupTree(
      treeDoc(),
      activity({
        kind: 'mesh',
        mesh_id: 'mesh_2',
        queue: [
          { kind: 'mesh', mesh_id: 'mesh_1', run_id: null, project_id: 'p1', simulation_id: 's1' },
          { kind: 'solve', run_id: 'run1', mesh_id: 'mesh_1', project_id: 'p1', simulation_id: 's1' },
        ],
      }),
    ).geoms[0].studies[0];
    expect(study.meshes.find((m) => m.id === 'mesh_1')).toMatchObject({ queuePos: 1 });
    expect(study.runs.find((r) => r.id === 'run1')).toMatchObject({ queuePos: 2 });
  });

  it('numbers queued jobs by their place in the whole queue, not among this project', () => {
    // Three jobs from other projects wait ahead of this project's two.
    const study = readSetupTree(
      treeDoc(),
      activity({
        queue: [
          { kind: 'mesh', mesh_id: 'mesh_1', run_id: null, project_id: 'p1', simulation_id: 's1', position: 4 },
          { kind: 'solve', run_id: 'run1', mesh_id: 'mesh_1', project_id: 'p1', simulation_id: 's1', position: 5 },
        ],
      }),
    ).geoms[0].studies[0];
    expect(study.meshes.find((m) => m.id === 'mesh_1')).toMatchObject({ queuePos: 4 });
    expect(study.runs.find((r) => r.id === 'run1')).toMatchObject({ queuePos: 5 });
  });

  it('replaces a leftover generating mark with a check when that mesh is done', () => {
    const doc = treeDoc();
    doc.geometries![0].studies![0].meshes![1] = {
      id: 'mesh_2',
      name: 'Mesh 2',
      generated: true,
      case_dir: '/mesh2/case',
      n_cells: 678038,
      live_status: 'done',
    };
    const study = readSetupTree(doc, activity()).geoms[0].studies[0];
    expect(study.meshes.find((m) => m.id === 'mesh_2')).toMatchObject({ busy: false, ready: true });
    expect(study.meshes.find((m) => m.id === 'mesh_1')).toMatchObject({ busy: false, ready: true });
  });

  it('does not mark a finished mesh busy when a solve is the live job', () => {
    const doc = treeDoc();
    doc.geometries![0].studies![0].meshes![0].live_status = 'running';
    const study = readSetupTree(
      doc,
      activity({ kind: 'solve', mesh_id: 'mesh_1', run_id: 'run2' }),
    ).geoms[0].studies[0];
    expect(study.meshes.find((m) => m.id === 'mesh_1')).toMatchObject({ busy: false, ready: true });
    expect(study.runs.find((r) => r.id === 'run2')).toMatchObject({ busy: true });
  });

  it('gate:h0-leak ignores another project and another study', () => {
    const doc = treeDoc();
    doc.geometries![0].studies!.push({
      id: 's2',
      name: 'Other',
      geometry_id: 'g1',
      meshes: [{ id: 'mesh_2', name: 'Mesh 2' }],
      runs: [{ id: 'run2', name: 'Run 2', status: 'draft' }],
    });
    const foreign = readSetupTree(
      doc,
      activity({ project_id: 'other-project', simulation_id: 's1' }),
    ).geoms[0].studies[0];
    expect(foreign.meshes.find((m) => m.id === 'mesh_2')?.busy).toBe(false);
    const otherStudy = readSetupTree(doc, activity()).geoms[0].studies[1];
    expect(otherStudy.meshes.find((m) => m.id === 'mesh_2')?.busy).toBe(false);
    expect(otherStudy.runs.find((r) => r.id === 'run2')?.busy).toBe(false);
  });
});

describe('readSetupTree with the workbench studies', () => {
  // Baseline, and its copy that was open (active) when this read was sent.
  function twoStudies(): ProjectTreeDoc {
    const doc = treeDoc();
    doc.geometries![0].studies = [
      { id: 's1', name: 'Baseline', geometry_id: 'g1', key: 'p:p1/g:g1/s:s1', sort_index: 0 },
      { id: 's2', name: 'Baseline copy', geometry_id: 'g1', key: 'p:p1/g:g1/s:s2', sort_index: 1, active: true },
    ];
    return doc;
  }
  const rows = (doc: ProjectTreeDoc, studies?: Parameters<typeof readSetupTree>[3]) =>
    readSetupTree(doc, null, null, studies).geoms[0].studies.map((s) => [s.id, s.active]);

  it('drops a study the workbench has seen go; the study it has open is the active one', () => {
    expect(rows(twoStudies(), { projectId: 'p1', gone: ['s2'], activeId: 's1' })).toEqual([['s1', true]]);
  });

  it('no study open: no row is active', () => {
    expect(rows(twoStudies(), { projectId: 'p1', gone: [], activeId: '' })).toEqual([
      ['s1', false],
      ['s2', false],
    ]);
  });

  it("keeps the read's own marks until the workbench has this project's list", () => {
    expect(rows(twoStudies())).toEqual([
      ['s1', false],
      ['s2', true],
    ]);
    expect(rows(twoStudies(), { projectId: 'p2', gone: ['s2'], activeId: 's1' })).toEqual([
      ['s1', false],
      ['s2', true],
    ]);
  });
});
