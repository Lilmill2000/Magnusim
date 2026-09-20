import { describe, expect, it } from 'vitest';
import {
  bindJobQueuePointerDrag,
  canQueueSolveJob,
  dropMissingQueueJobs,
  JOB_QUEUE_STORAGE_KEY,
  isJobQueueStorageKey,
  mergeStoredQueueItems,
  parseStoredQueueItems,
  dropQueueJobsForMesh,
  isTerminalJobStatus,
  meshGenerateButtonKind,
  meshIsQueuedOrGenerating,
  meshProgressPhase,
  resolveRunMeshId,
  insertMeshBeforeDependentSolves,
  insertSolveAfterMesh,
  ignoreForeignCaseSnap,
  keepResultsWhileStartingRun,
  mergeRunCatalogRow,
  catalogReplacesStudyRuns,
  selectedRunAfterCatalog,
  runPanelDoc,
  runOwnerStudyIds,
  orderedQueueItems,
  runHasVisibleResults,
  pickLiveSolveFromCatalog,
  shouldKickQueueAfterLiveHandleLost,
  solveHandleStillLive,
  runDisplayedSimTime,
  solveDisplayStage,
  transientFrameCountLabel,
  startShouldEnqueue,
  queueHasMeshDepViolation,
  queueInsertFromY,
  queueKickAfterStart,
  resultsAttachStealsServerCase,
  resultsAttachWaitMs,
  resultsOpenWaitsFullPrefetchQueue,
  resultsPrefetchMayStealAttach,
  RESULTS_ATTACH_WAIT_MS,
  foamTimeDirIsComplete,
  liveFramesShouldOpenResults,
  pickReadyResultTime,
  previousResultTime,
  snapMatchesLiveMeshJob,
  viewportChipPrefersResultsLoad,
} from './jobQueueOrder';

const items = [
  { id: 'a', kind: 'mesh', mesh_id: 'm1' },
  { id: 'b', kind: 'solve', run_id: 'r1' },
  { id: 'c', kind: 'mesh', mesh_id: 'm2' },
];

describe('orderedQueueItems', () => {
  it('reorders by id and keeps leftovers at the end', () => {
    expect(orderedQueueItems(items, ['c', 'a']).map((r) => r.id)).toEqual(['c', 'a', 'b']);
  });

  it('ignores unknown ids and does not drop jobs', () => {
    expect(orderedQueueItems(items, ['c', 'nope', 'a', 'b']).map((r) => r.id)).toEqual(['c', 'a', 'b']);
  });

  it('returns the same objects so kick still has settings', () => {
    const next = orderedQueueItems(items, ['b', 'c', 'a']);
    expect(next[0]).toBe(items[1]);
    expect(next.map((r) => r.id)).toEqual(['b', 'c', 'a']);
  });
});

describe('queueInsertFromY', () => {
  const rows = [
    { id: 'a', top: 0, height: 20 },
    { id: 'b', top: 20, height: 20 },
    { id: 'c', top: 40, height: 20 },
  ];

  it('moves last to first when the pointer is above the first row', () => {
    const hit = queueInsertFromY(rows, 'c', 5);
    expect(hit?.ids).toEqual(['c', 'a', 'b']);
    expect(hit?.before).toBe(true);
    expect(hit?.unchanged).toBe(false);
  });

  it('moves first to last when the pointer is in the lower half of the last row', () => {
    const hit = queueInsertFromY(rows, 'a', 55);
    expect(hit?.ids).toEqual(['b', 'c', 'a']);
    expect(hit?.before).toBe(false);
    expect(hit?.unchanged).toBe(false);
  });

  it('reports unchanged when dropping a row onto its own slot', () => {
    expect(queueInsertFromY(rows, 'a', 5)?.unchanged).toBe(true);
    expect(queueInsertFromY(rows, 'b', 28)?.unchanged).toBe(true);
  });
});

describe('bindJobQueuePointerDrag', () => {
  function layout(list: HTMLElement) {
    [...list.querySelectorAll('li[data-q-id]')].forEach((el, i) => {
      el.getBoundingClientRect = () =>
        ({
          x: 0,
          y: i * 20,
          top: i * 20,
          left: 0,
          right: 120,
          bottom: (i + 1) * 20,
          width: 120,
          height: 20,
          toJSON() {
            return {};
          },
        }) as DOMRect;
    });
  }

  function mount() {
    const host = document.createElement('div');
    host.innerHTML =
      '<ol id="job-queue-list">' +
      '<li data-q-id="a"><span class="job-queue-label">1. Mesh 1</span><button data-q-remove="a">x</button></li>' +
      '<li data-q-id="b"><span class="job-queue-label">2. Run 1</span><button data-q-remove="b">x</button></li>' +
      '<li data-q-id="c"><span class="job-queue-label">3. Mesh 2</span><button data-q-remove="c">x</button></li>' +
      '</ol>';
    document.body.appendChild(host);
    const list = host.querySelector('ol') as HTMLElement;
    layout(list);
    return { host, list };
  }

  it('rewrites the real item array, not just the DOM, when a row is dragged', () => {
    const { host, list } = mount();
    let items = [
      { id: 'a', name: 'Mesh 1' },
      { id: 'b', name: 'Run 1' },
      { id: 'c', name: 'Mesh 2' },
    ];
    const applied: string[][] = [];
    bindJobQueuePointerDrag(host, {
      list,
      applyOrder(ids) {
        applied.push(ids);
        items = orderedQueueItems(items, ids);
      },
    });
    const last = list.querySelector('li[data-q-id="c"]') as HTMLElement;
    last.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, clientY: 45, pointerId: 1 }));
    last.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, button: 0, clientY: 4, pointerId: 1 }));
    last.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, button: 0, clientY: 4, pointerId: 1 }));
    expect(applied).toEqual([['c', 'a', 'b']]);
    expect(items.map((r) => r.id)).toEqual(['c', 'a', 'b']);
    host.remove();
  });

  it('rewrites the item array from mouse events too', () => {
    const { host, list } = mount();
    let items = [
      { id: 'a', name: 'Mesh 1' },
      { id: 'b', name: 'Run 1' },
      { id: 'c', name: 'Mesh 2' },
    ];
    bindJobQueuePointerDrag(host, {
      list,
      applyOrder(ids) {
        items = orderedQueueItems(items, ids);
      },
    });
    const last = list.querySelector('li[data-q-id="c"]') as HTMLElement;
    last.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0, clientY: 45 }));
    window.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, button: 0, clientY: 4 }));
    window.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, button: 0, clientY: 4 }));
    expect(items.map((r) => r.id)).toEqual(['c', 'a', 'b']);
    host.remove();
  });

  it('does not reorder on a click without a drag', () => {
    const { host, list } = mount();
    const applied: string[][] = [];
    bindJobQueuePointerDrag(host, {
      list,
      applyOrder(ids) {
        applied.push(ids);
      },
    });
    const first = list.querySelector('li[data-q-id="a"]') as HTMLElement;
    first.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, clientY: 5, pointerId: 1 }));
    first.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, button: 0, clientY: 6, pointerId: 1 }));
    expect(applied).toEqual([]);
    host.remove();
  });
});

describe('canQueueSolveJob', () => {
  const ready = { hasRun: true, running: false, done: false, meshReady: true, meshSoon: false };

  it('refuses a solve when no material is assigned', () => {
    expect(canQueueSolveJob({ ...ready, hasMaterial: false })).toBe(false);
  });

  it('allows a solve when Air is assigned and the mesh is ready or coming', () => {
    expect(canQueueSolveJob({ ...ready, hasMaterial: true })).toBe(true);
    expect(canQueueSolveJob({ ...ready, meshReady: false, meshSoon: true, hasMaterial: true })).toBe(true);
  });
});

describe('resolveRunMeshId', () => {
  it('uses the run assignment, then the live generate, then the only study mesh', () => {
    expect(resolveRunMeshId({ runMeshId: 'mesh_1', liveMeshId: 'mesh_2' })).toBe('mesh_1');
    expect(resolveRunMeshId({ selectedMeshId: 'mesh_2', liveMeshId: 'mesh_1' })).toBe('mesh_2');
    expect(resolveRunMeshId({ liveMeshId: 'mesh_1', studyMeshIds: ['mesh_2'] })).toBe('mesh_1');
    expect(resolveRunMeshId({ queuedMeshIds: ['mesh_1'], studyMeshIds: ['mesh_1', 'mesh_2'] })).toBe('mesh_1');
    expect(resolveRunMeshId({ studyMeshIds: ['mesh_1'] })).toBe('mesh_1');
    expect(resolveRunMeshId({ studyMeshIds: ['mesh_1', 'mesh_2'] })).toBe('');
  });
});

describe('meshIsQueuedOrGenerating', () => {
  it('treats a live or queued generate as soon enough to queue the matching run', () => {
    expect(meshIsQueuedOrGenerating({ meshId: 'mesh_1', liveMeshId: 'mesh_1' })).toBe(true);
    expect(meshIsQueuedOrGenerating({ meshId: 'mesh_1', queuedMeshIds: ['mesh_1'] })).toBe(true);
    expect(meshIsQueuedOrGenerating({ meshId: 'mesh_1', generatingIds: ['mesh_1'] })).toBe(true);
    expect(meshIsQueuedOrGenerating({ meshId: 'mesh_1', liveMeshId: 'mesh_2' })).toBe(false);
    expect(meshIsQueuedOrGenerating({ meshId: '', liveMeshId: 'mesh_1' })).toBe(false);
  });
});

describe('queueKickAfterStart', () => {
  it('holds the front job when start fails validation so the next mesh cannot skip it', () => {
    expect(queueKickAfterStart({ ok: false, error: 'Assign Air to a volume first' }, false)).toBe('hold');
  });

  it('retries later only when the machine is busy', () => {
    expect(queueKickAfterStart({ busy: true }, false)).toBe('retry');
  });

  it('dequeues only after a job actually starts', () => {
    expect(queueKickAfterStart({ ok: true }, true)).toBe('dequeue');
    expect(queueKickAfterStart({}, false)).toBe('hold');
  });

  it('skips a leftover job whose mesh or run was deleted', () => {
    expect(queueKickAfterStart({ ok: false, missing: true }, false)).toBe('skip');
    expect(queueKickAfterStart({ skip: true }, false)).toBe('skip');
  });
});

describe('dropMissingQueueJobs', () => {
  const queue = [
    { id: 'q-m1', kind: 'mesh', mesh_id: 'mesh_1' },
    { id: 'q-r1', kind: 'solve', run_id: 'run_1', mesh_id: 'mesh_1' },
    { id: 'q-gone', kind: 'mesh', mesh_id: 'mesh_deleted' },
    { id: 'q-oldrun', kind: 'solve', run_id: 'run_deleted', mesh_id: 'mesh_1' },
  ];

  it('drops queue rows whose mesh or run is gone after a clone cleanup', () => {
    expect(
      dropMissingQueueJobs(queue, { meshIds: ['mesh_1'], runIds: ['run_1'] }).map((r) => r.id)
    ).toEqual(['q-m1', 'q-r1']);
  });

  it('keeps every row when catalogs have not loaded yet', () => {
    expect(dropMissingQueueJobs(queue, { meshIds: [], runIds: [] }).map((r) => r.id)).toEqual([
      'q-m1',
      'q-r1',
      'q-gone',
      'q-oldrun',
    ]);
  });

  it('keeps another project’s jobs when the open catalogs do not contain them', () => {
    const mixed = [
      { id: 'q-ss-run', kind: 'solve', run_id: '09cec168', project_id: 'test-ss' },
      { id: 'q-tr-mesh', kind: 'mesh', mesh_id: 'mesh-tr', project_id: 'test-tr' },
      { id: 'q-gone', kind: 'mesh', mesh_id: 'deleted', project_id: 'test-tr' },
    ];
    expect(
      dropMissingQueueJobs(mixed, {
        meshIds: ['mesh-tr'],
        runIds: [],
        currentProjectId: 'test-tr',
      }).map((r) => r.id)
    ).toEqual(['q-ss-run', 'q-tr-mesh']);
  });

  it('merges a global shard with leftover per-project keys without dropping jobs', () => {
    expect(isJobQueueStorageKey(JOB_QUEUE_STORAGE_KEY)).toBe(true);
    expect(isJobQueueStorageKey('cfd-job-queue:test-ss')).toBe(true);
    expect(isJobQueueStorageKey('other')).toBe(false);
    const global = parseStoredQueueItems(
      JSON.stringify([{ id: 'q-ss', kind: 'solve', run_id: '09cec168', project_id: 'test-ss' }])
    );
    const stale = parseStoredQueueItems([
      { id: 'q-tr', kind: 'mesh', mesh_id: 'mesh-tr', project_id: 'test-tr' },
      { id: 'q-ss', kind: 'solve', run_id: '09cec168', project_id: 'test-ss' },
    ]);
    expect(mergeStoredQueueItems(global, stale).map((r) => r.id)).toEqual(['q-ss', 'q-tr']);
  });

  it('still drops a missing job that belongs to the open project', () => {
    const rows = [
      { id: 'q-keep', kind: 'solve', run_id: 'run_1', project_id: 'test-ss' },
      { id: 'q-gone', kind: 'solve', run_id: 'gone', project_id: 'test-ss' },
    ];
    expect(
      dropMissingQueueJobs(rows, {
        meshIds: ['mesh_1'],
        runIds: ['run_1'],
        currentProjectId: 'test-ss',
      }).map((r) => r.id)
    ).toEqual(['q-keep']);
  });
});

describe('queue mesh dependencies', () => {
  const mesh1 = { id: 'q-m1', kind: 'mesh', mesh_id: 'mesh_1' };
  const mesh2 = { id: 'q-m2', kind: 'mesh', mesh_id: 'mesh_2' };
  const run1 = { id: 'q-r1', kind: 'solve', mesh_id: 'mesh_1', run_id: 'run_1' };
  const run2 = { id: 'q-r2', kind: 'solve', mesh_id: 'mesh_2', run_id: 'run_2' };

  it('lets a run follow a queued or live mesh, then keeps that run after its mesh', () => {
    expect(insertSolveAfterMesh([mesh1, mesh2], run1).map((r) => r.id)).toEqual(['q-m1', 'q-r1', 'q-m2']);
    expect(insertSolveAfterMesh([mesh1, run1, mesh2], run2).map((r) => r.id)).toEqual([
      'q-m1',
      'q-r1',
      'q-m2',
      'q-r2',
    ]);
  });

  it('inserts a mesh generate before any queued solve that uses it', () => {
    expect(insertMeshBeforeDependentSolves([run2], mesh2).map((r) => r.id)).toEqual(['q-m2', 'q-r2']);
  });

  it('drops a deleted mesh and the solves that were waiting on it', () => {
    const queue = [mesh1, run1, mesh2, run2];
    expect(dropQueueJobsForMesh(queue, 'mesh_2').map((r) => r.id)).toEqual(['q-m1', 'q-r1']);
    expect(dropQueueJobsForMesh(queue, 'mesh_1').map((r) => r.id)).toEqual(['q-m2', 'q-r2']);
    expect(dropQueueJobsForMesh(queue, 'missing').map((r) => r.id)).toEqual(['q-m1', 'q-r1', 'q-m2', 'q-r2']);
  });

  it('treats a cancelled generate as finished so the queue can move on', () => {
    expect(isTerminalJobStatus('stopped')).toBe(true);
    expect(isTerminalJobStatus('running')).toBe(false);
    expect(snapMatchesLiveMeshJob({ snapMeshId: 'mesh_2', liveMeshId: 'mesh_3' })).toBe(false);
    expect(snapMatchesLiveMeshJob({ snapMeshId: 'mesh_2', liveMeshId: 'mesh_2' })).toBe(true);
    expect(snapMatchesLiveMeshJob({ snapMeshId: '', liveMeshId: 'mesh_2' })).toBe(false);
    expect(snapMatchesLiveMeshJob({ snapKickId: 'abc', liveKickId: 'abc', liveMeshId: 'mesh_2' })).toBe(true);
    expect(snapMatchesLiveMeshJob({ snapKickId: 'old', liveKickId: 'abc', liveMeshId: 'mesh_2' })).toBe(false);
  });

  it('keeps Generating on the live mesh when status or mesh_id briefly glitches', () => {
    expect(
      meshGenerateButtonKind({
        viewingMeshId: 'mesh_2',
        liveMeshId: 'mesh_2',
        generateLive: true,
        computeBusy: true,
      })
    ).toBe('generating');
    expect(
      meshGenerateButtonKind({
        viewingMeshId: 'mesh_2',
        liveMeshId: '',
        generateLive: true,
        computeBusy: true,
      })
    ).toBe('generating');
    expect(
      meshGenerateButtonKind({
        viewingMeshId: 'mesh_1',
        liveMeshId: 'mesh_2',
        generateLive: true,
        computeBusy: true,
      })
    ).toBe('queue');
    expect(meshGenerateButtonKind({ viewingMeshId: 'mesh_2', queued: true })).toBe('queued');
    expect(meshGenerateButtonKind({ viewingMeshId: 'mesh_2' })).toBe('generate');
  });

  it('rejects an order that puts a run above the mesh it needs', () => {
    const ok = [mesh1, run1, mesh2, run2];
    expect(queueHasMeshDepViolation(ok)).toBe(false);
    expect(queueHasMeshDepViolation([mesh1, run1, run2, mesh2])).toBe(true);
    expect(queueHasMeshDepViolation([run2, mesh1, run1, mesh2])).toBe(true);
  });
});

describe('results view while another job is live', () => {
  it('does not steal the server case while a mesh generate is live', () => {
    expect(resultsAttachStealsServerCase({ meshGenerateLive: true })).toBe(false);
    expect(resultsAttachStealsServerCase({ meshGenerateLive: false })).toBe(true);
  });

  it('keeps Run 1 results open when the queue starts Run 2', () => {
    expect(
      keepResultsWhileStartingRun({
        resultsOpen: true,
        resultsRunId: '28f2ce5a',
        startingRunId: '23b9fa58',
      })
    ).toBe(true);
    expect(
      keepResultsWhileStartingRun({
        resultsOpen: true,
        selectedRunId: '28f2ce5a',
        startingRunId: '23b9fa58',
      })
    ).toBe(true);
    expect(
      keepResultsWhileStartingRun({
        resultsOpen: true,
        resultsRunId: '28f2ce5a',
        startingRunId: '28f2ce5a',
      })
    ).toBe(false);
    expect(keepResultsWhileStartingRun({ resultsOpen: false, startingRunId: '23b9fa58' })).toBe(false);
  });

  it('ignores a mesh-case snap while Results is showing a run case', () => {
    const run = 'C:\\proj\\simulation_runs\\Run_1\\case';
    const mesh = 'C:\\proj\\meshes\\Mesh_2\\case';
    expect(ignoreForeignCaseSnap({ resultsOpen: true, viewedCaseDir: run, snapCaseDir: mesh })).toBe(true);
    expect(ignoreForeignCaseSnap({ resultsOpen: true, viewedCaseDir: run, snapCaseDir: run })).toBe(false);
    expect(ignoreForeignCaseSnap({ resultsOpen: false, viewedCaseDir: run, snapCaseDir: mesh })).toBe(false);
  });

  it('labels the chip Loading results ahead of Meshing or Solving', () => {
    expect(viewportChipPrefersResultsLoad({ resultsOpen: true, attaching: true })).toBe(true);
    expect(viewportChipPrefersResultsLoad({ resultsOpen: true, resultsBusy: true })).toBe(true);
    expect(viewportChipPrefersResultsLoad({ resultsOpen: true, attaching: false, resultsBusy: false })).toBe(false);
    expect(viewportChipPrefersResultsLoad({ resultsOpen: false, attaching: true })).toBe(false);
  });

  it('does not steal attach or wait the full prefetch queue while a solve is live', () => {
    expect(
      resultsPrefetchMayStealAttach({
        attachRequested: true,
        catalogSolving: true,
      })
    ).toBe(false);
    expect(
      resultsPrefetchMayStealAttach({
        attachRequested: true,
        catalogSolving: false,
        resultsViewOpen: false,
        meshInspectOpen: false,
        meshGenerateLive: false,
      })
    ).toBe(true);
    expect(resultsOpenWaitsFullPrefetchQueue()).toBe(false);
    expect(resultsAttachWaitMs({ sameCaseAlreadyAttaching: true })).toBe(RESULTS_ATTACH_WAIT_MS);
    expect(resultsAttachWaitMs({ sameCaseAlreadyAttaching: false })).toBe(0);
  });

  it('skips a half-written latest time and falls back to the previous frame', () => {
    expect(foamTimeDirIsComplete(['U'])).toBe(false);
    expect(foamTimeDirIsComplete(['p'])).toBe(false);
    expect(foamTimeDirIsComplete(['U', 'p'])).toBe(true);
    expect(foamTimeDirIsComplete(['U.gz', 'p.gz'])).toBe(true);
    expect(pickReadyResultTime(['0.03', '0.07', '0.10'])).toBe('0.10');
    expect(previousResultTime(['0.03', '0.07', '0.10'], '0.10')).toBe('0.07');
    expect(previousResultTime(['0.03', '0.07'], 'missing')).toBe('0.03');
  });

  it('does not reopen Results while the same run is already opening', () => {
    expect(
      liveFramesShouldOpenResults({
        resultsViewOpen: true,
        openingRunId: 'f8f525b1',
        selectedKey: 'runresults:f8f525b1',
        runId: 'f8f525b1',
      })
    ).toBe(false);
    expect(
      liveFramesShouldOpenResults({
        resultsViewOpen: false,
        openingRunId: 'f8f525b1',
        selectedKey: 'runresults:f8f525b1',
        runId: 'f8f525b1',
      })
    ).toBe(false);
    expect(
      liveFramesShouldOpenResults({
        resultsViewOpen: false,
        selectedKey: 'runresults:f8f525b1',
        runId: 'f8f525b1',
      })
    ).toBe(true);
  });
});

describe('meshProgressPhase', () => {
  it('shows ready when the mesh is on disk even if liveCompute is still mesh', () => {
    expect(
      meshProgressPhase({ jobStatus: 'done', computeLive: true, meshReady: true })
    ).toBe('ready');
    expect(
      meshProgressPhase({ jobStatus: 'running', computeLive: true, meshReady: true })
    ).toBe('ready');
  });

  it('does not stay on generating after the job is terminal', () => {
    expect(meshProgressPhase({ jobStatus: 'done', computeLive: true, meshReady: false })).toBe(
      'finishing'
    );
    expect(meshProgressPhase({ jobStatus: 'failed', failed: true, computeLive: true })).toBe(
      'failed'
    );
  });
});

describe('solveHandleStillLive', () => {
  it('treats a leftover solve handle as dead when the catalog row is done', () => {
    expect(
      solveHandleStillLive({
        liveKind: 'solve',
        liveRunId: 'd39c676f',
        catalogRows: [{ id: 'd39c676f', status: 'done' }],
      })
    ).toBe(false);
  });

  it('keeps a leftover handle live while the catalog row is running', () => {
    expect(
      solveHandleStillLive({
        liveKind: 'solve',
        liveRunId: 'd39c676f',
        catalogRows: [{ id: 'd39c676f', status: 'running' }],
      })
    ).toBe(true);
  });

  it('keeps a leftover handle live when the catalog is empty', () => {
    expect(
      solveHandleStillLive({
        liveKind: 'solve',
        liveRunId: 'd39c676f',
        catalogRows: [],
      })
    ).toBe(true);
  });

  it('is live while starting is true', () => {
    expect(solveHandleStillLive({ liveKind: 'mesh', starting: true })).toBe(true);
  });
});

describe('pickLiveSolveFromCatalog', () => {
  it('prefers the solving run that already wrote frames', () => {
    const picked = pickLiveSolveFromCatalog(
      [
        { id: 'tear', status: 'running', n_saved_times: 0, sim_time: 0.05 },
        { id: 'test', status: 'running', n_saved_times: 18, last_saved_iteration: 0.6, sim_time: 0.015 },
      ],
      'tear'
    );
    expect(picked && picked.id).toBe('test');
    expect(runDisplayedSimTime(picked)).toBe(0.6);
  });

  it('does not kick the queue when a catalog row is still solving', () => {
    expect(
      shouldKickQueueAfterLiveHandleLost({
        hadLiveId: 'test',
        nextLiveId: null,
        catalogRows: [{ id: 'test', status: 'running', n_saved_times: 12 }],
      })
    ).toBe(false);
    expect(
      shouldKickQueueAfterLiveHandleLost({
        hadLiveId: 'test',
        nextLiveId: null,
        catalogRows: [{ id: 'test', status: 'done' }],
      })
    ).toBe(true);
  });
});

describe('runHasVisibleResults', () => {
  it('opens stopped or live frames even when has_results is still false', () => {
    expect(
      runHasVisibleResults({
        status: 'stopped',
        has_results: false,
        n_saved_times: 9,
        last_saved_iteration: 0.28,
        case_dir: 'C:/case',
      })
    ).toBe(true);
    expect(
      runHasVisibleResults({
        status: 'running',
        has_results: false,
        n_saved_times: 1,
        last_saved_iteration: 0.03,
      })
    ).toBe(true);
    expect(runHasVisibleResults({ status: 'stopped', has_results: false })).toBe(false);
  });
});

describe('transientFrameCountLabel', () => {
  it('shows written frames against the planned write count', () => {
    expect(transientFrameCountLabel({ nSaved: 15, writeCount: 30 })).toBe('15 / 30 frames');
    expect(transientFrameCountLabel({ nSaved: 0, writeCount: 30 })).toBe('0 / 30 frames');
    expect(transientFrameCountLabel({ nSaved: 1 })).toBe('1 frame');
    expect(transientFrameCountLabel({ nSaved: 4 })).toBe('4 frames');
    expect(transientFrameCountLabel({ nSaved: 0 })).toBe('');
  });
});

describe('solveDisplayStage', () => {
  it('promotes starting to solve once saved times or sim_time exist', () => {
    expect(solveDisplayStage({ stage: 'starting' })).toBe('starting');
    expect(solveDisplayStage({ stage: 'starting', sim_time: 0.015 })).toBe('solve');
    expect(solveDisplayStage({ stage: 'starting', n_saved_times: 8, last_saved_iteration: 0.26 })).toBe('solve');
    expect(solveDisplayStage({ stage: 'reconstruct', n_saved_times: 8 })).toBe('reconstruct');
  });
});

describe('mergeRunCatalogRow', () => {
  it('keeps mesh_id and results when a settings save omits them', () => {
    const merged = mergeRunCatalogRow(
      {
        id: 'run-1',
        mesh_id: 'mesh-1',
        mesh_name: 'Mesh 1',
        has_results: true,
        n_saved_times: 9,
        case_dir: 'C:/case',
      },
      { id: 'run-1', status: 'stopped', mesh_id: null, has_results: false }
    );
    expect(merged && merged.mesh_id).toBe('mesh-1');
    expect(merged && merged.has_results).toBe(true);
    expect(merged && merged.n_saved_times).toBe(9);
  });

  it('promotes a stuck starting stage when saved times exist', () => {
    const merged = mergeRunCatalogRow(
      { id: 'run-1', stage: 'starting', n_saved_times: 8, last_saved_iteration: 0.26 },
      { id: 'run-1', stage: 'starting', status: 'running' }
    );
    expect(merged && merged.stage).toBe('solve');
    expect(merged && merged.n_saved_times).toBe(8);
  });
});

describe('startShouldEnqueue', () => {
  it('does not queue just because this start set its own starting flag', () => {
    expect(startShouldEnqueue({ otherJobRunning: false, waitForMesh: false })).toBe(false);
    expect(startShouldEnqueue({ otherJobRunning: true })).toBe(true);
    expect(startShouldEnqueue({ waitForMesh: true })).toBe(true);
    expect(startShouldEnqueue({ sameRunStillSolving: true })).toBe(true);
  });
});

describe('catalogReplacesStudyRuns', () => {
  it('keeps the open study when a live poll is for another study', () => {
    expect(catalogReplacesStudyRuns({ simulation_id: 'test' }, 'teardrop')).toBe(false);
    expect(catalogReplacesStudyRuns({ simulation_id: 'teardrop' }, 'teardrop')).toBe(true);
    expect(
      catalogReplacesStudyRuns({ runs: [{ simulation_id: 'test' }, { simulation_id: 'test' }] }, 'teardrop')
    ).toBe(false);
  });
});

describe('selectedRunAfterCatalog', () => {
  it('does not drop the open run when the payload is for another study', () => {
    expect(
      selectedRunAfterCatalog({
        selectedId: 'tear-run',
        incomingRuns: [{ id: 'test-run' }],
        replaceStudyRuns: false,
      })
    ).toBe('tear-run');
    expect(
      selectedRunAfterCatalog({
        selectedId: 'tear-run',
        incomingRuns: [{ id: 'test-run' }],
        replaceStudyRuns: true,
      })
    ).toBe(null);
  });
});

describe('runPanelDoc', () => {
  it('does not fall back to a different live solve', () => {
    expect(runPanelDoc({ id: 'tear-run', name: 'Run 1' }, { id: 'test-run', status: 'running' })).toEqual({
      id: 'tear-run',
      name: 'Run 1',
      run_id: 'tear-run',
    });
    expect(runPanelDoc(null, { id: 'test-run', status: 'running' })).toBe(null);
    expect(runPanelDoc({ id: 'test-run', name: 'Run 1' }, { id: 'test-run', status: 'running' })?.status).toBe(
      'running'
    );
  });
});

describe('runOwnerStudyIds', () => {
  it('prefers the run study over the currently open study', () => {
    expect(runOwnerStudyIds({ simulation_id: 'teardrop' }, { simulation_id: 'test' })).toEqual({
      simulation_id: 'teardrop',
    });
  });
});
