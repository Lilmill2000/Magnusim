// The Materials panel reads the runtime's study state when it renders (which analysis, so
// one fluid or several materials) and listens for cfd:study from an effect. A state the
// runtime publishes between the two (a study switch's answer landing as the panel opens)
// must still show: a heat-transfer study kept the previous study's one-fluid editor, with
// no list of its fluid and solid, until something else changed.
import { createElement, Fragment, useLayoutEffect } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MaterialModelRow } from '../../materialModel';
import type { StudyState } from '../legacyBridge';
import { useProjectStore } from '../../store/project';
import { FIXTURE_MODEL, FIXTURE_REGISTRY } from '../../test/materialFixture';
import { MaterialsPanel } from './MaterialsPanel';

vi.mock('../../api/workerRpc', () => ({ workerRpc: async () => ({}) }));

const SOLID: MaterialModelRow = {
  key: 'fx_solid',
  label: 'Solid',
  role: 'solid',
  schema: { properties: { k: { title: '(k) Thermal conductivity', default: 167, minimum: 0 } } },
  library: [{ key: 'al', name: 'Aluminium 6061', values: { k: 167 }, library: 'AL', codes: ['AL', 'DEFAULT'] }],
  record_keys: { k: ['thermal_conductivity', 'k'] },
  custom_preset: 'custom',
};
const REGISTRY = {
  ...FIXTURE_REGISTRY,
  analysis: [...FIXTURE_REGISTRY.analysis, { key: 'heat_steady', label: 'Heat', material_models: ['newtonian_incompressible', 'fx_solid'] }],
  material: [FIXTURE_MODEL, SOLID],
};
const STORED = [
  { id: 'm-air', name: 'Air', material_model: 'newtonian_incompressible', assigned_volumes: ['Body1'] },
  { id: 'm-al', name: 'Aluminium 6061', material_model: 'fx_solid', thermal_conductivity: 167, assigned_volumes: ['Body2'] },
];

// The study shown before (one fluid) and the heat-transfer study the panel opens for.
const BEFORE = { has_study: true, id: 's0', analysis_type: 'incompressible_steady' } as StudyState;
const HEAT = { has_study: true, id: 's1', analysis_type: 'heat_steady' } as StudyState;

/** What runtime.js publishStudyState does: the global first, then the event. */
function publishStudyState(detail: StudyState) {
  window.__CFD_STUDY_STATE__ = detail;
  window.dispatchEvent(new CustomEvent('cfd:study', { detail }));
}

let fluidAtPublish = false;
/** The runtime's answer landing right after the panel rendered, before its passive effects ran. */
function Lands({ detail }: { detail: StudyState }) {
  useLayoutEffect(() => {
    // The one-fluid editor, loading its fluid; no list of materials.
    fluidAtPublish = !!document.querySelector('[data-material-loading="1"]') && !document.querySelector('[data-materials-list]');
    publishStudyState(detail);
  }, [detail]);
  return null;
}

const listed = () => [...document.querySelectorAll('[data-material-row]')].map((li) => li.textContent || '');
const settle = async (ok: () => boolean) => {
  for (let i = 0; i < 100 && !ok(); i += 1) await new Promise((r) => setTimeout(r, 10));
};

let root: Root | null = null;

beforeEach(() => {
  useProjectStore.setState({ registry: REGISTRY as never });
  window.__CFD_STUDY_STATE__ = BEFORE;
  window.__CFD_GEOMETRY_BODIES__ = () => ['Body1', 'Body2'];
  window.__CFD_MATERIAL_APPLY__ = vi.fn();
  window.__CFD_OPEN_MATERIAL__ = vi.fn();
  window.__CFD_ADD_MATERIAL__ = vi.fn();
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).includes('/api/materials')) return new Response(JSON.stringify({ materials: STORED, air: STORED[0] }), { status: 200 });
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }),
  );
  fluidAtPublish = false;
});

afterEach(() => {
  root?.unmount();
  root = null;
  useProjectStore.setState({ registry: null });
  delete window.__CFD_STUDY_STATE__;
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
});

describe('MaterialsPanel', () => {
  it('shows the study the runtime published between its first render and its subscription', async () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    root.render(
      createElement(
        Fragment,
        null,
        createElement(MaterialsPanel, { panelId: 'panel-materials-hub', projectId: 'p1', simId: 's1', scope: 'p:p1/s:s1' }),
        createElement(Lands, { detail: HEAT }),
      ),
    );
    await settle(() => listed().length === 2);
    // The timing was forced: the panel had rendered the previous study's one-fluid editor.
    expect(fluidAtPublish).toBe(true);
    // The heat-transfer study's materials: its fluid and its solid, not one Fluid editor.
    const oneFluid = !!document.querySelector('[aria-label="Fluid"]');
    expect(listed(), oneFluid ? 'the panel shows the one-fluid editor (a "Fluid" list) instead' : 'materials listed').toEqual([
      'AirFluid · 1 body',
      'Aluminium 6061Solid · 1 body',
    ]);
    expect(document.querySelector('[data-materials-list]')).not.toBeNull();
  });
});
