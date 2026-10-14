// The Simulation panel reads the runtime's study state when it renders and listens for
// cfd:study from an effect. A state the runtime publishes between the two (a study
// switch's or a save's answer landing as the panel opens) must still show: the panel kept
// the previous study's name and analysis until something else changed.
import { createElement, Fragment, useLayoutEffect } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { StudyState } from '../legacyBridge';
import { useProjectStore } from '../../store/project';
import { SimulationDefaults } from './SimulationPanel';

const fam = (key: string) => ({ key, label: key, title: key, description: '', tags: [] });
const ROWS = [
  { key: 'toy_steady', label: 'Toy', time_dependency: 'steady', family: fam('toy'), schema: { type: 'object', properties: {} } },
  { key: 'toy_transient', label: 'Toy', time_dependency: 'transient', family: fam('toy'), schema: { type: 'object', properties: {} } },
];

const PIPE: StudyState = {
  has_study: true,
  id: 'sim_pipe',
  project_id: 'proj',
  name: 'Pipe study',
  analysis: 'Toy (steady)',
  analysis_type: 'toy_steady',
  time_dependency: 'Steady-state',
  algorithm: '',
  record: { id: 'sim_pipe' },
};
const ELBOW: StudyState = {
  ...PIPE,
  id: 'sim_elbow',
  name: 'Elbow study',
  analysis: 'Toy (transient)',
  analysis_type: 'toy_transient',
  time_dependency: 'Transient',
  record: { id: 'sim_elbow' },
};

/** What runtime.js publishStudyState does: the global first, then the event. */
function publishStudyState(detail: StudyState) {
  window.__CFD_STUDY_STATE__ = detail;
  window.dispatchEvent(new CustomEvent('cfd:study', { detail }));
}

let seenAtPublish = '';
/** The runtime's answer landing right after the panel rendered, before its passive effects ran. */
function Lands({ detail }: { detail: StudyState }) {
  useLayoutEffect(() => {
    seenAtPublish = document.querySelector('[data-panel-title="1"]')?.textContent || '';
    publishStudyState(detail);
  }, [detail]);
  return null;
}

const text = (sel: string) => document.querySelector(sel)?.textContent || '';
const settle = async (sel: string, want: string) => {
  for (let i = 0; i < 50 && text(sel) !== want; i += 1) await new Promise((r) => setTimeout(r, 10));
};

let root: Root | null = null;

beforeEach(() => {
  useProjectStore.setState({ projectId: 'proj', registry: { analysis: ROWS } as never });
  window.__CFD_STUDY_STATE__ = PIPE;
  window.__CFD_STUDY_UPDATE__ = vi.fn(async () => ({}));
  window.__CFD_STUDY_TIME__ = vi.fn(async () => ({}));
  window.__CFD_STUDY_DELETE__ = vi.fn(async () => ({}));
  window.__CFD_PLUGINS_READY__ = true;
  seenAtPublish = '';
});

afterEach(() => {
  root?.unmount();
  root = null;
  useProjectStore.setState({ projectId: null, registry: null } as never);
  delete window.__CFD_STUDY_STATE__;
  delete window.__CFD_PLUGINS_READY__;
  document.body.innerHTML = '';
});

describe('SimulationDefaults', () => {
  it('shows the study the runtime published between its first render and its subscription', async () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    root.render(
      createElement(
        Fragment,
        null,
        createElement(SimulationDefaults, { panelId: 'panel-study-settings', scope: 'p:proj/s:sim_elbow' }),
        createElement(Lands, { detail: ELBOW }),
      ),
    );
    await settle('[data-panel-title="1"]', 'Elbow study');
    // The timing was forced: the panel had rendered the previous study when the state landed.
    expect(seenAtPublish).toBe('Pipe study');
    expect(text('[data-panel-title="1"]')).toBe('Elbow study');
    expect(text('[data-study-analysis="1"]')).toBe('Toy (transient)');
    // A later publish (a rename) redraws it too.
    publishStudyState({ ...ELBOW, name: 'Elbow study 2' });
    await settle('[data-panel-title="1"]', 'Elbow study 2');
    expect(text('[data-panel-title="1"]')).toBe('Elbow study 2');
  });
});
