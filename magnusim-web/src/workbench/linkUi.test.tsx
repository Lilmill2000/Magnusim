// What the user sees of a linked geometry (host API 1.5, LINK proposal 5.14, 5.18, D15):
// its row in the tree ("from <study>", Edit, its link state, its lost faces), body and face
// labels ("Fluid (Body1)", "Box +x (face 10)"), a BC's lost faces with Forget, the geometry
// panel's last update and Forget all, and the report after an update.
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SetupTreeView, linkStatusText } from '../chrome/LeftTree';
import { readSetupTree, type GeomLink, type ProjectTreeDoc } from '../chrome/treeModel';
import { setTreeActionHandler } from '../chrome/treeSession';
import { lostFacesOf, lostReason, bcCardSub } from '../panels/bcs/BcPanel';
import { lastUpdateLine } from '../panels/geometry/GeometryPanel';
import { linkNeedsAction, linkQuietText, linkReportText, linkTouchesSetup } from '../workspace/linkReport';
import type { LinkResult } from '../plugin-sdk/workspace';
import { bodyDisplay, faceDisplay, lostDisplay, resetFaceNamesForTests, setShownFaceTable } from './faceNames';

beforeEach(() => resetFaceNamesForTests());
afterEach(() => vi.unstubAllGlobals());

const DOC: ProjectTreeDoc = {
  project_id: 'p1',
  geometries: [
    {
      id: 'g1',
      name: 'Demo 1',
      key: 'p:p1/g:g1',
      bodies: ['Body1', 'Body2'],
      source: { plugin: 'link-demo', study_id: 'st-1', workspace: 'demo', study_title: 'Demo 1' },
      rev: 3,
      names8: 'abcd1234',
      updating: false,
      unlinked: false,
      body_labels: [
        { ref: 'Body1', name: 'Fluid', label: null },
        { ref: 'Body2', name: 'Body 2', label: 'Solid' },
      ],
      lost_faces: 2,
      source_state: 'ok',
      behind: false,
      studies: [
        {
          id: 's1',
          name: 'Study 1',
          geometry_id: 'g1',
          key: 'p:p1/g:g1/s:s1',
          bcs: [{ id: 'bc1', name: 'Top', faces: ['face 10@Body1'], key: 'p:p1/g:g1/s:s1/i:bc1', lost: 1 }],
        },
      ],
    },
    // An earlier version the link moved away from: a plain row.
    { id: 'g0', name: 'Demo 0', key: 'p:p1/g:g0', bodies: ['Body1'], source: { plugin: 'link-demo', study_id: 'st-1' }, rev: 7, unlinked: true, studies: [] },
  ],
  plugin_studies: [
    {
      id: 'st-1',
      plugin: 'link-demo',
      plugin_name: 'Link demo',
      kind: 'demo',
      kind_title: 'Demo',
      icon: '',
      workspace: 'demo',
      workspace_title: 'Demo workspace',
      title: 'Demo 1',
      rev: 1,
      available: true,
      read_only: false,
      reason: '',
      scope_key: 'p:p1/x:link-demo/st:st-1',
    },
  ],
};

describe('the tree', () => {
  it('reads a linked geometry\'s row: its study, Edit target, state and lost faces; an earlier version is plain', () => {
    const model = readSetupTree(DOC);
    const link = model.geoms[0].link as GeomLink;
    expect(link).toMatchObject({ plugin: 'link-demo', studyId: 'st-1', studyTitle: 'Demo 1', studyScopeKey: 'p:p1/x:link-demo/st:st-1', sourceState: 'ok', lostFaces: 2, rev: 3 });
    expect(model.geoms[1].link).toBeNull();
    expect(model.geoms[0].bodyLabels).toEqual({ Body1: { name: 'Fluid', label: null }, Body2: { name: 'Body 2', label: 'Solid' } });
    expect(model.geoms[0].studies[0].bcs[0].lost).toBe(1);
  });

  it('shows "from <study>", Edit, the lost count, body labels; "(plugin not installed)" with no Edit; Edit greyed while the plugin is off', () => {
    const { container, rerender } = render(
      <ul>
        <SetupTreeView model={readSetupTree(DOC)} />
      </ul>,
    );
    const row = container.querySelector('[data-geom-link="g1"]') as HTMLElement;
    expect(row.querySelector('[data-geom-from]')?.textContent).toBe('from Demo 1');
    expect(row.querySelector('[data-geom-edit]')?.textContent).toBe('Edit');
    expect(row.querySelector('[data-geom-edit]')?.getAttribute('title')).toBe('Edit in Demo workspace');
    expect(row.querySelector('[data-geom-link-reason]')).toBeNull();
    expect(row.querySelector('[data-geom-lost]')?.textContent).toBe('2 lost faces');
    expect(container.querySelector('[data-geom-link="g0"]')).toBeNull();
    expect(screen.getByText('Fluid (Body1)')).toBeInTheDocument();
    expect(screen.getByText('Solid (Body2)')).toBeInTheDocument();
    expect(container.querySelector('[data-bc-lost-count]')?.textContent).toBe('1 lost face');
    const off: ProjectTreeDoc = {
      ...DOC,
      plugin_studies: [{ ...DOC.plugin_studies![0], available: false, reason: 'Requires the Link demo plugin' }],
      geometries: [{ ...DOC.geometries![0], source_state: 'plugin_off', source_reason: 'Link demo is off' }],
    };
    rerender(
      <ul>
        <SetupTreeView model={readSetupTree(off)} />
      </ul>,
    );
    const edit = container.querySelector('[data-geom-edit]') as HTMLButtonElement;
    expect([edit.disabled, edit.getAttribute('title')]).toEqual([true, 'Link demo is off']);
    // The reason and a way to fix it, as the plugin study's own row has (5.18).
    const reason = container.querySelector('[data-geom-link-reason]') as HTMLElement;
    expect(reason.textContent).toBe('Link demo is off. Open Settings → Plugins');
    const calls: string[][] = [];
    setTreeActionHandler((key, action) => calls.push([key, action]));
    try {
      fireEvent.click(reason.querySelector('[data-geom-link-settings]') as HTMLButtonElement);
    } finally {
      setTreeActionHandler(null);
    }
    expect(calls).toEqual([['p:p1/x:link-demo/st:st-1', 'open-plugin-settings']]);
    // Needs setup (or failed to load) is not "off": its own words.
    const setup: ProjectTreeDoc = { ...off, geometries: [{ ...off.geometries![0], source_reason: 'Link demo needs setup: install its dependencies' }] };
    rerender(
      <ul>
        <SetupTreeView model={readSetupTree(setup)} />
      </ul>,
    );
    expect(container.querySelector('[data-geom-link-reason]')?.textContent).toBe('Link demo needs setup: install its dependencies. Open Settings → Plugins');
    const gone: ProjectTreeDoc = { ...DOC, plugin_studies: [], geometries: [{ ...DOC.geometries![0], source_state: 'plugin_missing' }] };
    rerender(
      <ul>
        <SetupTreeView model={readSetupTree(gone)} />
      </ul>,
    );
    expect(container.querySelector('[data-geom-from]')?.textContent).toBe('from Demo 1 (plugin not installed)');
    expect(container.querySelector('[data-geom-edit]')).toBeNull();
    expect(container.querySelector('[data-geom-link-reason]')).toBeNull();
  });

  it('with its study deleted the geometry is a plain one: no "from", no Edit, no status, its lost faces still counted', () => {
    // The worker marks it (source_state study_deleted, unlinked); with no row at all the client reads it the same.
    const deleted: ProjectTreeDoc = {
      ...DOC,
      plugin_studies: [],
      geometries: [{ ...DOC.geometries![0], source_state: 'study_deleted', unlinked: true, behind: false }],
    };
    for (const doc of [deleted, { ...DOC, plugin_studies: [], geometries: [{ ...DOC.geometries![0], source_state: undefined }] }]) {
      const model = readSetupTree(doc);
      expect(model.geoms[0].link).toBeNull();
    }
    const { container } = render(
      <ul>
        <SetupTreeView model={readSetupTree(deleted)} />
      </ul>,
    );
    expect(container.querySelector('[data-geom-link]')).toBeNull();
    expect(container.querySelector('[data-geom-from]')).toBeNull();
    expect(container.querySelector('[data-geom-edit]')).toBeNull();
    expect(container.querySelector('[data-geom-link-status]')).toBeNull();
    expect(container.textContent).toContain('2 lost faces');
  });

  it("says what the link is doing: Queued, Updating…, Couldn't finish updating, Not up to date", () => {
    const link = readSetupTree(DOC).geoms[0].link as GeomLink;
    expect(linkStatusText('Demo 1', link, null)).toBe('');
    expect(linkStatusText('Demo 1', link, { status: 'queued', stage: null, label: null })).toBe('Queued');
    expect(linkStatusText('Demo 1', link, { status: 'running', stage: 'matching', label: null })).toBe('Updating… (matching)');
    expect(linkStatusText('Demo 1', { ...link, updating: true }, null)).toBe("Couldn't finish updating Demo 1");
    expect(linkStatusText('Demo 1', { ...link, behind: true }, null)).toBe('Not up to date with Demo 1.');
  });

  it('the geometry row has its ✓ only while the part is up to date with its study', () => {
    const geomCheck = (c: HTMLElement) => c.querySelector('[data-w16-geom="g1"] > .tree-row > .tree-check');
    const doc = (over: Record<string, unknown>): ProjectTreeDoc => ({ ...DOC, geometries: [{ ...DOC.geometries![0], ...over }, DOC.geometries![1]] });
    const { container, rerender } = render(
      <ul>
        <SetupTreeView model={readSetupTree(doc({}))} />
      </ul>,
    );
    expect(geomCheck(container)).toBeTruthy();
    // The study's saved design is newer (a refused link, "Leave anyway"): no ✓ beside "Not up to date".
    rerender(
      <ul>
        <SetupTreeView model={readSetupTree(doc({ behind: true }))} />
      </ul>,
    );
    expect(container.querySelector('[data-w16-geom="g1"] [data-geom-link-status]')?.textContent).toBe('Not up to date with Demo 1.');
    expect(geomCheck(container)).toBeNull();
    // An update that did not finish: no ✓ either.
    rerender(
      <ul>
        <SetupTreeView model={readSetupTree(doc({ updating: true }))} />
      </ul>,
    );
    expect(geomCheck(container)).toBeNull();
    // A plain geometry (an earlier version, unlinked) keeps its ✓.
    expect(container.querySelector('[data-w16-geom="g0"] > .tree-row > .tree-check')).toBeTruthy();
  });
});

describe('face and body labels (D15)', () => {
  it('shows "Label (face N)", else "Name (face N)", else the host label; bodies likewise', () => {
    expect(faceDisplay('face 10@Body1')).toBe('face 10@Body1');
    setShownFaceTable(
      {
        faces: [
          { id: 10, name: 'F:box:+x', label: 'Box +x' },
          { id: 11, name: 'F:b2:-x' },
          { id: 12 },
        ],
        body_info: [{ ref: 'Body1', name: 'Fluid' }, { ref: 'Body2', label: 'Solid', name: 'Body 2' }, { ref: 'Body3' }],
      },
      'g1',
    );
    expect(faceDisplay('face 10@Body1')).toBe('Box +x (face 10)');
    expect(faceDisplay('face 11@Body2')).toBe('F:b2:-x (face 11)');
    expect(faceDisplay('face 12@Body1')).toBe('face 12@Body1');
    expect(bodyDisplay('Body1')).toBe('Fluid (Body1)');
    expect(bodyDisplay('Body2')).toBe('Solid (Body2)');
    expect(bodyDisplay('Body3')).toBe('Body3');
    expect(lostDisplay({ label: 'Boss end', name: 'F:boss:end', old: 'face 15@Body1' })).toBe('Boss end');
    expect(bcCardSub({ id: 'b', name: 'Inlet', bc_type: 'Pressure', faces: ['face 10@Body1'] })).toBe('Pressure · Box +x (face 10)');
  });
});

describe("a BC's lost faces", () => {
  it('lists them with why, and Forget sends the entry', async () => {
    const bc = {
      id: 'bc1',
      name: 'Top',
      bc_type: 'Wall',
      faces: [],
      lost_faces: [
        { field: 'faces', old: 'face 15@Body1', name: 'F:boss:end', label: 'Boss end', reason: 'gone' },
        { field: 'faces', old: 'face 6@Body1', name: 'F:box:+x', label: 'Box +x', reason: 'claimed_twice', targets: ['face 10@Body1'] },
      ],
    };
    expect(lostFacesOf(bc).map((e) => e.reason)).toEqual(['gone', 'claimed_twice']);
    expect(lostReason(lostFacesOf(bc)[0])).toBe('Gone from the geometry. It comes back here if the face does.');
    expect(lostReason(lostFacesOf(bc)[1])).toBe('It merged with a face of another boundary condition: pick it on one of them.');
    const forget = vi.fn(async () => ({ ok: true }));
    window.__CFD_FORGET_LOST__ = forget;
    window.__CFD_BCS__ = {
      simulation_id: 's1',
      bcs: [bc],
      active_id: 'bc1',
      draft_faces: [],
      focus_face: null,
      defaults: { wall_type: 'No-slip' },
      defaults_summary: '',
      pending_faces: [],
      imperial: false,
    };
    const { BcEditor } = await import('../panels/bcs/BcPanel');
    render(<BcEditor />);
    const list = screen.getByRole('list', { name: 'Lost faces' });
    expect(list.textContent).toContain('Boss end');
    fireEvent.click(screen.getAllByRole('button', { name: 'Forget' })[0]);
    await waitFor(() => expect(forget).toHaveBeenCalledWith({ study_id: 's1', kind: 'bc', id: 'bc1', entry: { field: 'faces', old: 'face 15@Body1' } }));
    delete window.__CFD_FORGET_LOST__;
    delete window.__CFD_BCS__;
  });
});

describe('the geometry panel and the report', () => {
  it("says the last update's rev and what it lost or brought back", () => {
    expect(lastUpdateLine({ rev: 3, from_rev: 2, lost: 1, returned: 2 })).toBe('Rev 3 (from rev 2): 1 face lost, 2 came back.');
    expect(lastUpdateLine({ rev: 2, from_rev: 1 })).toBe('Rev 2 (from rev 1).');
    expect(lastUpdateLine(null)).toBe('');
  });

  it('reports lost, returned, split and claimed faces by their labels, and the meshes to generate again', () => {
    const r = {
      geometryId: 'g1',
      name: 'Demo 1',
      rev: 2,
      fromRev: 1,
      created: false,
      change: 'shape',
      bodies: 2,
      faces: 17,
      named: 17,
      match: { byName: 14, byShape: 0, split: 3, merged: 2, movedFar: 0 },
      lost: [{ studyId: 's1', studyTitle: 'Study 1', kind: 'bc', registryKey: null, item: 'Top', field: 'faces', old: 'face 15@Body1', name: 'F:boss:end', label: 'Boss end', reason: 'gone' }],
      returned: [],
      stillLost: 3,
      claimedTwice: [{ studyId: 's1', studyTitle: 'Study 1', target: 'face 10@Body1', name: 'F:box:+x', label: 'Box +x', items: ['Inlet', 'Outlet'] }],
      outOfDate: { meshes: [{ studyId: 's1', studyTitle: 'Study 1', meshId: 'm1', meshName: 'Mesh 1' }], runs: 0 },
      seconds: 2,
    } as LinkResult;
    const at = { studyId: 's1', studyTitle: 'Study 1', kind: 'bc', field: 'faces', name: 'F:box:+y' };
    const setup = {
      movedFar: [],
      split: [{ ...at, item: 'Side', old: 'face 12@Body1', label: 'Box +y', faces: 2 }],
      merged: [],
      stale: [],
    };
    const t = linkReportText(r, setup);
    expect(t.title).toBe('Demo 1 updated');
    expect(t.copy.split('\n')).toEqual([
      'Boundary conditions, refinements and monitors kept their faces by name.',
      'These faces are gone. Each one stays listed on its record and comes back if the face does:',
      "Study 1 › Top: 'Boss end'",
      "Split: Study 1 › Side now covers 2 faces in place of 'Box +y'.",
      "Pick one: 'Box +x' was in Inlet and Outlet.",
      'Out of date: Mesh 1. Generate it again before you run.',
    ]);
  });

  // The CAD review of 2026-10-04: "Kept by name but moved far: 1 face" after edits with no
  // simulation, and faces no record held. Only what touches a record is reported, by name.
  it('reports only faces a record refers to: none touched is no dialog (a mesh out of date is a quiet line), moved far names record and face', () => {
    const base = {
      geometryId: 'g1',
      name: 'Part 1',
      rev: 2,
      fromRev: 1,
      created: false,
      change: 'shape',
      bodies: 1,
      faces: 10,
      named: 10,
      // Statistics of the whole part: six faces moved far, three split, but no record holds them.
      match: { byName: 10, byShape: 0, split: 3, merged: 1, movedFar: 6 },
      lost: [],
      returned: [],
      stillLost: 0,
      claimedTwice: [],
      outOfDate: { meshes: [], runs: 0 },
      seconds: 2,
    } as LinkResult;
    const none = { movedFar: [], split: [], merged: [], stale: [] };
    expect([linkTouchesSetup(base, none), linkNeedsAction(base, none), linkQuietText(base, none)]).toEqual([false, false, '']);
    const meshes = { ...base, outOfDate: { meshes: [{ studyId: 's1', studyTitle: 'Study 1', meshId: 'm1', meshName: 'Mesh 1' }], runs: 0 } } as LinkResult;
    expect(linkTouchesSetup(meshes, none)).toBe(false);
    expect(linkQuietText(meshes, none)).toBe('Part 1 updated. Out of date: Mesh 1. Generate it again before you run.');
    const wall = { studyId: 's1', studyTitle: 'Study 1', kind: 'bc', item: 'Wall', field: 'faces', old: 'face 6@Body1', name: 'F:x:side2', label: 'Extrude 1 · Side 2' };
    const moved = { ...none, movedFar: [wall] };
    expect([linkTouchesSetup(base, moved), linkNeedsAction(base, moved)]).toEqual([true, true]);
    expect(linkReportText(base, moved).copy.split('\n')).toEqual([
      'Boundary conditions, refinements and monitors kept their faces by name.',
      "Kept by name but moved far: Study 1 › Wall ('Extrude 1 · Side 2'). Check it.",
    ]);
    // A merge on a record is reported, and needs nothing of the user (after "Continue in background", a toast).
    const merged = { ...none, merged: [{ ...wall, faces: 2, target: 'face 3@Body1', targetLabel: 'Extrude 1 · Side 1' }] };
    expect([linkTouchesSetup(base, merged), linkNeedsAction(base, merged)]).toEqual([true, false]);
    expect(linkReportText(base, merged).copy.split('\n')[1]).toBe("Merged: Study 1 › Wall: 'Extrude 1 · Side 2' is now one face with 1 other face ('Extrude 1 · Side 1').");
    expect(linkQuietText(base, merged)).toBe('Part 1 updated. 1 face of your setup changed and stayed on its record.');
    // A record saved for an older version must be picked again.
    const stale = { ...none, stale: [{ studyId: 's1', studyTitle: 'Study 1', item: 'Inlet', kind: 'bc' }] };
    expect(linkNeedsAction(base, stale)).toBe(true);
    expect(linkReportText(base, stale).copy.split('\n')[1]).toBe('Saved for an older version: Study 1 › Inlet. Pick its faces again.');
  });
});
