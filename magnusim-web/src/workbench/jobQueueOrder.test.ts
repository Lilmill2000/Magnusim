import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
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
  computeBusyLabel,
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
  catalogRowsForOpenProject,
  pickHydrateLiveRunForProject,
  pickLiveSolveFromCatalog,
  shouldKickQueueAfterLiveHandleLost,
  solveHandleStillLive,
  runDisplayedSimTime,
  solveDisplayStage,
  transientFrameCountLabel,
  startShouldEnqueue,
  queueHasMeshDepViolation,
  queueInsertFromY,
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
  serverBusyIsPluginOrCheck,
  serverSolvePhase,
  serverBusyBlocksRun,
  startRefusalKind,
  stopActionFor,
  stopShownFor,
  cancelStartOutcome,
  START_ID_RE,
  newStartId,
  liveSolveToFollow,
  queueFailureMessage,
  queueFailureLinksRun,
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

  it("refuses a solve while the run's analysis reports a setup issue (or has not answered)", () => {
    expect(canQueueSolveJob({ ...ready, setupOk: false })).toBe(false);
    expect(canQueueSolveJob({ ...ready })).toBe(false);
  });

  it('allows a solve when the setup is ready and the mesh is ready or coming', () => {
    expect(canQueueSolveJob({ ...ready, setupOk: true })).toBe(true);
    expect(canQueueSolveJob({ ...ready, meshReady: false, meshSoon: true, setupOk: true })).toBe(true);
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

  it("keeps the open project's plugin cases: they are in no core catalog", () => {
    const rows = [
      { id: 'q-case', kind: 'foam', job_id: 'fc-abc123-0a1b2c', run_id: null, mesh_id: null, project_id: 'test-ss' },
      { id: 'q-gone', kind: 'solve', run_id: 'gone', project_id: 'test-ss' },
    ];
    expect(
      dropMissingQueueJobs(rows, { meshIds: ['mesh_1'], runIds: ['run_1'], currentProjectId: 'test-ss' }).map((r) => r.id)
    ).toEqual(['q-case']);
    // The browser's own queue copies still never hold one.
    expect(parseStoredQueueItems([rows[0]])).toEqual([]);
    expect(mergeStoredQueueItems([rows[0] as never])).toEqual([]);
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

  it('keeps Run 1 results open when Run 2 starts', () => {
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

describe('meshProgressPhase queued', () => {
  it('reads queued, not generating, while the mesh waits behind another job', () => {
    expect(meshProgressPhase({ jobStatus: 'idle', queued: true })).toBe('queued');
    // A ready mesh queued to regenerate still reads queued.
    expect(meshProgressPhase({ jobStatus: 'done', meshReady: true, queued: true })).toBe('queued');
  });

  it('a running job wins over a stale queue row', () => {
    expect(meshProgressPhase({ jobStatus: 'running', queued: true })).toBe('generating');
    expect(meshProgressPhase({ jobStatus: 'idle', computeLive: true, queued: true })).toBe('generating');
  });
});

describe('computeBusyLabel', () => {
  const names = (kind: string, id: string) => (kind === 'mesh' && id === 'mesh_1' ? 'Coarse mesh' : null);

  it('names a job in another project with that project', () => {
    expect(
      computeBusyLabel(
        { kind: 'mesh', mesh_id: 'mesh_1', project_id: 'pA', project_title: 'Project A', mesh_name: 'Mesh 1' },
        { currentProjectId: 'pB', lookupName: names },
      ),
    ).toBe('Mesh 1 in Project A');
  });

  it("does not borrow this project's mesh name for another project's mesh_1", () => {
    expect(
      computeBusyLabel({ kind: 'mesh', mesh_id: 'mesh_1', project_id: 'pA' }, { currentProjectId: 'pB', lookupName: names }),
    ).toBe('a mesh in another project');
  });

  it("uses this project's own names for its own job", () => {
    expect(
      computeBusyLabel({ kind: 'mesh', mesh_id: 'mesh_1', project_id: 'pB' }, { currentProjectId: 'pB', lookupName: names }),
    ).toBe('Coarse mesh');
    expect(
      computeBusyLabel(
        { kind: 'solve', run_id: 'r1', project_id: 'pA' },
        { currentProjectId: 'pB', projectTitle: () => 'Project A' },
      ),
    ).toBe('a run in Project A');
  });

  it('is empty when nothing runs', () => {
    expect(computeBusyLabel(null)).toBe('');
    expect(computeBusyLabel({ kind: 'other', project_id: 'pA' })).toBe('');
  });

  it('names a plugin case by the name the server gives it', () => {
    const own = { kind: 'foam', phase: 'running', name: 'Cavity case 1 · c1 · Foam demo', project_id: 'pB' };
    expect(computeBusyLabel(own, { currentProjectId: 'pB' })).toBe('Cavity case 1 · c1 · Foam demo');
    expect(computeBusyLabel({ ...own, project_id: 'pA', project_title: 'Project A' }, { currentProjectId: 'pB' })).toBe(
      'Cavity case 1 · c1 · Foam demo in Project A',
    );
    expect(computeBusyLabel({ kind: 'foam', project_id: 'pB' }, { currentProjectId: 'pB' })).toBe('a plugin case');
  });

  it('says the app is checking for jobs left running, in any project', () => {
    const check = { kind: 'check', phase: 'checking', name: 'Checking for jobs left running', project_id: null };
    expect(computeBusyLabel(check, { currentProjectId: 'pB' })).toBe('Checking for jobs left running');
    expect(computeBusyLabel({ kind: 'check', project_id: 'pA', project_title: 'Project A' }, { currentProjectId: 'pB' })).toBe(
      'Checking for jobs left running',
    );
  });

  it('says (stopping) for a job asked to stop and (finishing) for a drain with no stop', () => {
    const run = { kind: 'solve', run_id: 'r1', project_id: 'pA', project_title: 'Project A' };
    const opts = { currentProjectId: 'pB' };
    expect(computeBusyLabel({ ...run, phase: 'draining', stopping: true }, opts)).toBe('a run in Project A (stopping)');
    expect(computeBusyLabel({ ...run, phase: 'draining', stopping: false }, opts)).toBe('a run in Project A (finishing)');
    expect(computeBusyLabel({ ...run, phase: 'running', stopping: true }, opts)).toBe('a run in Project A (stopping)');
    expect(computeBusyLabel({ ...run, phase: 'running', stopping: false }, opts)).toBe('a run in Project A');
    expect(computeBusyLabel({ ...run, phase: 'starting' }, opts)).toBe('a run in Project A');
    const names = (kind: string, id: string) => (kind === 'solve' && id === 'r1' ? 'Run 1' : null);
    expect(computeBusyLabel({ ...run, project_id: 'pB', phase: 'draining' }, { currentProjectId: 'pB', lookupName: names })).toBe(
      'Run 1 (finishing)',
    );
    expect(
      computeBusyLabel({ kind: 'foam', name: 'Case', project_id: 'pB', phase: 'draining', stopping: true }, { currentProjectId: 'pB' }),
    ).toBe('Case (stopping)');
  });
});

describe('the server busy job and the Run panel', () => {
  const at = { runId: 'r1', projectId: 'pA' };
  const solve = (phase: string, extra: Record<string, unknown> = {}) => ({ kind: 'solve', run_id: 'r1', project_id: 'pA', phase, ...extra });

  it('a plugin case or the boot check blocks every start', () => {
    expect(serverBusyIsPluginOrCheck({ kind: 'foam', project_id: 'pZ' })).toBe(true);
    expect(serverBusyIsPluginOrCheck({ kind: 'check', phase: 'checking' })).toBe(true);
    expect(serverBusyIsPluginOrCheck({ kind: 'mesh' })).toBe(false);
    expect(serverBusyIsPluginOrCheck({ kind: 'solve' })).toBe(false);
    expect(serverBusyIsPluginOrCheck(null)).toBe(false);
  });

  it('reads the phase only of this very run in this project', () => {
    expect(serverSolvePhase(solve('draining'), at)).toBe('draining');
    expect(serverSolvePhase(solve('starting'), at)).toBe('starting');
    expect(serverSolvePhase({ kind: 'solve', run_id: 'r1', project_id: 'pA' }, at)).toBe('running');
    expect(serverSolvePhase(solve('running'), { runId: 'r2', projectId: 'pA' })).toBe('');
    expect(serverSolvePhase(solve('running'), { runId: 'r1', projectId: 'pB' })).toBe('');
    expect(serverSolvePhase({ kind: 'mesh', mesh_id: 'r1', project_id: 'pA' }, at)).toBe('');
    expect(serverSolvePhase(solve('running'), { projectId: 'pA' })).toBe('');
  });

  it('Start queues behind another job of any kind and project, and behind this run\'s own drain', () => {
    expect(serverBusyBlocksRun(null, at)).toBe(false);
    expect(serverBusyBlocksRun({ kind: null }, at)).toBe(false);
    expect(serverBusyBlocksRun({ kind: 'mesh', mesh_id: 'm1', project_id: 'pA', phase: 'running' }, at)).toBe(true);
    expect(serverBusyBlocksRun({ kind: 'mesh', mesh_id: 'm1', project_id: 'pZ', phase: 'running' }, at)).toBe(true);
    expect(serverBusyBlocksRun({ kind: 'foam', project_id: 'pA', phase: 'running' }, at)).toBe(true);
    expect(serverBusyBlocksRun({ kind: 'check', phase: 'checking', project_id: null }, at)).toBe(true);
    // Another run of this project, or this run id in another project.
    expect(serverBusyBlocksRun({ ...solve('running'), run_id: 'r2' }, at)).toBe(true);
    expect(serverBusyBlocksRun({ ...solve('running'), project_id: 'pZ' }, at)).toBe(true);
    // This run's own solve is not another job, until it drains.
    expect(serverBusyBlocksRun(solve('starting'), at)).toBe(false);
    expect(serverBusyBlocksRun(solve('running'), at)).toBe(false);
    expect(serverBusyBlocksRun(solve('draining'), at)).toBe(true);
    expect(serverBusyBlocksRun(solve('draining', { stopping: true }), at)).toBe(true);
    // No run selected: anything busy blocks.
    expect(serverBusyBlocksRun(solve('running'), {})).toBe(true);
  });

  it("tells a refused start's kind: busy queues; stopped and same_run are no failure", () => {
    expect(startRefusalKind(409, { error: 'Another job is already running', code: 'busy', busy: { kind: 'mesh' } })).toBe('busy');
    expect(startRefusalKind(409, { error: 'A run is already in progress', run_id: 'r9' })).toBe('busy');
    // By its text too, as the Start's own busy test reads it.
    expect(startRefusalKind(409, { error: 'Another job is already running' })).toBe('busy');
    expect(startRefusalKind(409, { error: 'Stopped before it started', code: 'stopped', stopped: true, run_id: 'r1' })).toBe('stopped');
    expect(startRefusalKind(409, { stopped: true })).toBe('stopped');
    expect(startRefusalKind(409, { error: 'This run is already solving. Click Stop if you want to end it.', code: 'same_run' })).toBe(
      'same_run',
    );
    // Without its code the same-run text is a plain failure (an older server).
    expect(startRefusalKind(409, { error: 'This run is already solving. Click Stop if you want to end it.' })).toBe('fail');
    expect(startRefusalKind(409, { error: 'This run already finished. Create a new run to solve again.' })).toBe('fail');
    expect(startRefusalKind(500, { error: 'Another job is already running', code: 'busy' })).toBe('fail');
    expect(startRefusalKind(400, { error: 'project_id required' })).toBe('fail');
    expect(startRefusalKind(409, null)).toBe('fail');
  });

  it("Stop cancels this tab's own start, cancels a start the server makes, else stops", () => {
    const own = { id: 's-abc-123456', run_id: 'r1', posted: false };
    expect(stopActionFor({ ownStart: own, busy: null, ...at })).toBe('cancel_own');
    // Its own start wins over what the server shows (its own POST may be in flight).
    expect(stopActionFor({ ownStart: { ...own, posted: true }, busy: solve('starting'), ...at })).toBe('cancel_own');
    expect(stopActionFor({ ownStart: { ...own, run_id: 'r2' }, busy: null, ...at })).toBe('stop');
    // The queue (or another tab) is starting this run.
    expect(stopActionFor({ ownStart: null, busy: solve('starting'), ...at })).toBe('cancel_server');
    expect(stopActionFor({ ownStart: null, busy: solve('starting'), runId: 'r1', projectId: 'pB' })).toBe('stop');
    expect(stopActionFor({ ownStart: null, busy: { ...solve('starting'), run_id: 'r2' }, ...at })).toBe('stop');
    expect(stopActionFor({ ownStart: null, busy: solve('running'), ...at })).toBe('stop');
    expect(stopActionFor({ ownStart: null, busy: solve('draining'), ...at })).toBe('stop');
    expect(stopActionFor({ ownStart: null, busy: null, ...at })).toBe('stop');
    expect(stopActionFor({ ownStart: own, busy: null, projectId: 'pA' })).toBe('stop');
    // A start already asked to stop is not cancelled again.
    expect(stopActionFor({ ownStart: null, busy: solve('starting', { stopping: true }), ...at })).toBe('stop');
  });

  it('a "Cancel this start" answer: cancelled, or a run that had already started and now stops', () => {
    // The start ended before its run started.
    expect(cancelStartOutcome(true, { ok: true, stopping: true, cancelled: true, run_id: 'r1' })).toBe('cancelled');
    // The claim was already running: today's Stop ran (a started run, never "Stopped before it started").
    expect(cancelStartOutcome(true, { ok: true, stopping: true, run_id: 'r1' })).toBe('stopping');
    // Nothing of this run was starting or running.
    expect(cancelStartOutcome(true, { ok: true, stopping: false, pending: false, run_id: 'r1' })).toBe('none');
    expect(cancelStartOutcome(true, { ok: true, stopping: true, pending: true, run_id: 'r1' })).toBe('none');
    expect(cancelStartOutcome(false, { ok: false, error: 'No run is in progress' })).toBe('none');
    expect(cancelStartOutcome(true, null)).toBe('none');
  });

  it('Stop shows while the run starts (here or by the queue) and while it drains with no stop asked', () => {
    const own = { id: 's-abc-123456', run_id: 'r1', posted: false };
    expect(stopShownFor({ ownStart: own, busy: null, ...at })).toBe('cancel_start');
    expect(stopShownFor({ ownStart: null, busy: solve('starting'), ...at })).toBe('cancel_start');
    expect(stopShownFor({ ownStart: null, busy: solve('starting', { stopping: true }), ...at })).toBe(null);
    expect(stopShownFor({ ownStart: null, busy: solve('draining'), ...at })).toBe('drain');
    expect(stopShownFor({ ownStart: null, busy: solve('draining', { stopping: true }), ...at })).toBe(null);
    expect(stopShownFor({ ownStart: null, busy: solve('running'), ...at })).toBe(null);
    expect(stopShownFor({ ownStart: null, busy: { ...solve('draining'), run_id: 'r2' }, ...at })).toBe(null);
    expect(stopShownFor({ ownStart: null, busy: { kind: 'foam', project_id: 'pA', phase: 'draining' }, ...at })).toBe(null);
    expect(stopShownFor({ ownStart: null, busy: null, ...at })).toBe(null);
  });

  it('gives every Start click its own id, in the form the server accepts', () => {
    const a = newStartId(Date.UTC(2026, 9, 1), '0a1b2c');
    expect(a).toBe('s-' + Date.UTC(2026, 9, 1).toString(36) + '-0a1b2c');
    expect(START_ID_RE.test(a)).toBe(true);
    const ids = new Set(Array.from({ length: 50 }, () => newStartId()));
    expect(ids.size).toBe(50);
    for (const id of ids) {
      expect(id).toMatch(/^s-[a-z0-9]+-[0-9a-f]{6}$/);
      expect(START_ID_RE.test(id)).toBe(true);
    }
  });

  it('follows the live job only for a mesh, or a solve in phase running', () => {
    expect(liveSolveToFollow({ kind: 'mesh', mesh_id: 'm1', phase: 'running' })).toBe(true);
    expect(liveSolveToFollow({ kind: 'mesh', mesh_id: 'm1' })).toBe(true);
    expect(liveSolveToFollow({ kind: 'solve', run_id: 'r1', phase: 'running' })).toBe(true);
    expect(liveSolveToFollow({ kind: 'solve', run_id: 'r1', phase: 'starting' })).toBe(false);
    expect(liveSolveToFollow({ kind: 'solve', run_id: 'r1', phase: 'draining' })).toBe(false);
    expect(liveSolveToFollow({ kind: 'foam', phase: 'running' })).toBe(false);
    expect(liveSolveToFollow({ kind: 'check', phase: 'checking' })).toBe(false);
    expect(liveSolveToFollow(null)).toBe(false);
  });
});

describe('queue leave notices', () => {
  it('words the toast by why the job left the queue', () => {
    expect(queueFailureMessage({ kind: 'solve', name: 'Run 6', error: 'Start failed on the server. See the server log' })).toBe(
      'Run 6 could not start from the queue: Start failed on the server. See the server log.',
    );
    expect(queueFailureMessage({ kind: 'solve', name: 'Run 6', error: 'No mesh', reason: 'failed' })).toBe(
      'Run 6 could not start from the queue: No mesh.',
    );
    expect(
      queueFailureMessage({ kind: 'foam', name: 'Cavity case 1 · c1 · Foam demo', error: 'The study was deleted', reason: 'dropped' }),
    ).toBe('Cavity case 1 · c1 · Foam demo was taken off the queue: The study was deleted.');
    expect(
      queueFailureMessage({ kind: 'foam', name: 'Cavity case 1 · c3 · Foam demo', error: 'Foam demo was turned off', reason: 'stopped' }),
    ).toBe('Cavity case 1 · c3 · Foam demo was stopped: Foam demo was turned off.');
  });

  it('falls back on a name and a reason, and never ends in two full stops', () => {
    expect(queueFailureMessage({ kind: 'mesh' })).toBe('Mesh could not start from the queue: unknown reason.');
    expect(queueFailureMessage({ kind: 'solve', error: 'Run not found.' })).toBe('Run could not start from the queue: Run not found.');
    expect(queueFailureMessage({ kind: 'foam', error: 'x', reason: 'stopped' })).toBe('A plugin case was stopped: x.');
    expect(queueFailureMessage(null)).toBe('Run could not start from the queue: unknown reason.');
  });

  it('shows the reason on the Run panel only for a core run that could not start', () => {
    expect(queueFailureLinksRun({ kind: 'solve', run_id: 'r1', error: 'x' })).toBe(true);
    expect(queueFailureLinksRun({ kind: 'solve', run_id: 'r1', error: 'x', reason: 'failed' })).toBe(true);
    expect(queueFailureLinksRun({ kind: 'solve', run_id: 'r1', error: 'The project was deleted', reason: 'dropped' })).toBe(false);
    expect(queueFailureLinksRun({ kind: 'solve', error: 'x' })).toBe(false);
    expect(queueFailureLinksRun({ kind: 'foam', run_id: null, error: 'x', reason: 'stopped' })).toBe(false);
    expect(queueFailureLinksRun({ kind: 'mesh', error: 'x' })).toBe(false);
  });
});

describe('runtime.js uses these rules where the Run panel, Stop and the queue decide', () => {
  const runtime = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'runtime.js'), 'utf8').replace(/\r\n/g, '\n');
  /** A top-level function of runtime.js, from its header to its closing brace. */
  const fn = (header: string) => {
    const at = runtime.indexOf(header);
    expect(at, header).toBeGreaterThanOrEqual(0);
    return runtime.slice(at, runtime.indexOf('\n}\n', at) + 2);
  };
  const count = (text: string, part: string) => text.split(part).length - 1;

  it('Start and the busy checks read the server slot', () => {
    expect(fn('function anyComputeJobRunning(')).toContain('serverBusyIsPluginOrCheck(jobQueue.busy)');
    expect(fn('function computeJobBlocksStart(')).toContain('serverBusyBlocksRun(jobQueue.busy, { runId: exceptRunId, projectId: pid })');
    const state = fn('function computeRunState(');
    expect(state).toContain('|| serverBusyBlocksRun(jobQueue.busy, runProject)');
    expect(state).toContain('stopShownFor({ ownStart: runCatalog.start, busy: jobQueue.busy, ...runProject })');
    expect(state).toContain("'Cancel this start'");
    expect(state).toContain("'The solver still runs in WSL. Stop ends it.'");
    expect(state).toContain('visible: running || !!stopMore');
  });

  it('the tab follows only a running solve or a mesh, and words leave notices by reason', () => {
    expect(fn('function applyServerQueue(')).toContain('liveSolveToFollow(j.live)');
    const notices = fn('function noticeQueueFailures(');
    expect(notices).toContain('const msg = queueFailureMessage(f);');
    expect(notices).toContain('if (queueFailureLinksRun(f)) {');
  });

  it("a Start carries its click's start_id, posted only after its last cancel check, with no await between", () => {
    const start = fn('async function startSolveClient(');
    expect(start).toContain("const start = { id: newStartId(), run_id: runCatalog.selected_run_id, posted: false };");
    expect(start).toContain('start_id: start.id,');
    // After persistSimControl, after refreshRunCatalog, before each enqueue and before the POST.
    expect(count(start, "if (cancelled()) return endWithoutStart('Stopped before it started.', true);")).toBe(5);
    const posted = start.indexOf('start.posted = true;');
    const lastCheck = start.lastIndexOf("if (cancelled()) return endWithoutStart('Stopped before it started.', true);", posted);
    const post = start.indexOf('await postRunStart({', posted);
    expect(lastCheck).toBeGreaterThan(0);
    expect(start.slice(lastCheck, posted)).not.toContain('await');
    expect(start.slice(posted, post)).not.toContain('await');
    // Wherever this start ends, its record goes with it.
    const ends = count(start, 'runCatalog.starting = false;');
    expect(ends).toBe(5);
    expect(count(start, 'runCatalog.starting = false;\n    dropStart();')).toBe(4);
    expect(count(start, 'runCatalog.starting = false;\n        dropStart();')).toBe(1);
    // A stopped or same-run refusal is no failure; the busy test above it is unchanged.
    const refusal = start.indexOf('const refusal = startRefusalKind(r.status, j);');
    expect(refusal).toBeGreaterThan(start.indexOf('const busy = r.status === 409 && /already in progress|already running/i.test(err);'));
    expect(refusal).toBeLessThan(start.lastIndexOf("return failStart((j && j.error) || 'Start failed', j);"));
  });

  it("Stop cancels a start without stop_requested: its own only once posted, with that click's start_id", () => {
    const stop = fn('async function stopSolveClient(');
    const force = stop.indexOf('const force = !!(rec && rec.stop_requested);');
    expect(stop.indexOf('stopActionFor({')).toBeLessThan(force);
    const own = stop.slice(stop.indexOf("if (action === 'cancel_own') {"), stop.indexOf("if (action === 'cancel_server') {"));
    expect(own).toContain('runCatalog.cancel_start = stopRunId;');
    expect(own).toContain('if (own && own.posted) {');
    expect(own).toContain('starting: true,\n          start_id: own.id,');
    const server = stop.slice(stop.indexOf("if (action === 'cancel_server') {"), force);
    expect(server).toContain('starting: true,');
    expect(server).not.toContain('start_id');
    // "Stopped before it started." only for a cancelled start, never for a run that had started.
    expect(server).toContain('const outcome = cancelStartOutcome(posted.response.ok, posted.json);');
    expect(server).toContain("if (outcome === 'cancelled') {\n        runCatalog.start_error = 'Stopped before it started.';");
    expect(server.split('Stopped before it started.').length).toBe(2);
    expect(stop.slice(0, force)).not.toContain('stop_requested');
  });

  it('plugin results: one record, no core run request, no autosave, no Views, scale 1', () => {
    expect(fn('function findRunRecord(').split('\n')[1]).toBe(
      '  if (isPluginResultsKey(runId) && pluginResultsMatch(pluginResultsRec, runId)) return pluginResultsRec;',
    );
    expect(fn('function refreshRunReady(')).toContain('if (!rec || isPluginResultsKey(rec.id)) return;');
    expect(fn('function filterAutosaveAllowed(')).toContain('if (!pluginResultsAutosaveAllowed(resultsRunId)) return false;');
    expect(fn('function renderViewsBlock(')).toContain('if (!pluginResultsShowsViews(resultsRunId)) { block.hidden = true; return; }');
    expect(fn('function meshDisplayScaleFromBounds(').split('\n')[1]).toBe(
      '  if (pluginResultsRec) return pluginResultsDisplayScale(pluginResultsRec);',
    );
    expect(fn('function resultDisplayScale(')).toContain('window.__CFD_RESULTS_SCALE__ = scale;');
    const hide = fn('function hideRunResultsView(');
    expect(hide.indexOf('pluginResultsRec = null;\n    syncPluginResultsChrome();')).toBeGreaterThan(0);
    expect(hide.indexOf('pluginResultsRec = null;')).toBeLessThan(hide.indexOf('if (!resultsViewOpen) return;'));
    const attach = fn('async function attachCaseDirClient(');
    expect(attach).toContain('{ plugin: plugin.plugin, plugin_study_id: plugin.study_id }');
    expect(attach).toContain('const claimedElsewhere = !plugin &&');
  });

  it('opening plugin results takes a switch token, clears the study, and every await of the open checks it', () => {
    const open = runtime.slice(runtime.indexOf('window.__CFD_OPEN_PLUGIN_RESULTS__ = async function'), runtime.indexOf('async function openRunResults('));
    expect(open.indexOf('const token = ++studySwitchGen;')).toBeGreaterThan(0);
    expect(open).toContain('if (typeof currentStudyId === \'function\' && currentStudyId()) clearStudyScope();');
    expect(open.indexOf('const token = ++studySwitchGen;')).toBeLessThan(open.indexOf('await openRunResults(rec.id, { token });'));
    const body = fn('async function openRunResults(');
    // Each await is followed by the stale check (the attach chain by one after its try).
    expect(count(body, 'if (stale()) return { stale: true };')).toBe(7);
    expect(body).toContain('attachSolveCase(casePath, { simulation_id: rec && rec.simulation_id, ...scope })');
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

  it('does not paint another project live solve onto this run even when ids match', () => {
    expect(
      runPanelDoc(
        { id: 'r1', name: 'Run 1', project_id: 'transient', status: 'draft' },
        { id: 'r1', status: 'running', pid: 32200, project_id: 'testss' },
        'transient'
      )
    ).toEqual({
      id: 'r1',
      name: 'Run 1',
      project_id: 'transient',
      status: 'draft',
      run_id: 'r1',
    });
    expect(
      runPanelDoc(
        { id: 'old', name: 'Run 1', project_id: 'testss', status: 'running' },
        { id: 'old', status: 'running', project_id: 'testss' },
        'transient'
      )
    ).toBe(null);
  });
});

describe('catalogRowsForOpenProject', () => {
  it('drops leftover rows from another project', () => {
    expect(
      catalogRowsForOpenProject(
        [
          { id: 'old', project_id: 'testss', status: 'running' },
          { id: 'next', project_id: 'transient', status: 'draft' },
        ],
        'transient'
      ).map((r) => r.id)
    ).toEqual(['next']);
  });

  it('keeps untagged rows so a same-project poll still works', () => {
    expect(catalogRowsForOpenProject([{ id: 'a' }], 'transient').map((r) => r.id)).toEqual(['a']);
  });
});

describe('pickHydrateLiveRunForProject', () => {
  it('does not open another project live solve', () => {
    expect(
      pickHydrateLiveRunForProject(
        [
          { id: 'old', project_id: 'testss', status: 'running' },
          { id: 'next', project_id: 'transient', status: 'draft' },
        ],
        'old',
        'transient'
      )
    ).toBe(null);
  });

  it('still opens this project live solve', () => {
    expect(
      pickHydrateLiveRunForProject(
        [
          { id: 'old', project_id: 'testss', status: 'running' },
          { id: 'mine', project_id: 'transient', status: 'running' },
        ],
        null,
        'transient'
      )?.id
    ).toBe('mine');
  });
});

describe('runOwnerStudyIds', () => {
  it('prefers the run study over the currently open study', () => {
    expect(runOwnerStudyIds({ simulation_id: 'teardrop' }, { simulation_id: 'test' })).toEqual({
      simulation_id: 'teardrop',
    });
  });
});
