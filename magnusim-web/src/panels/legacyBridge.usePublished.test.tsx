// The panels' runtime states (useStudyState, useGeometryState, useBcState, useRunState) read
// what the runtime last published. Before its first publish a panel shows the state the
// runtime gave when the panel mounted (its __CFD_*_NOW__ function, which builds a new object
// on every call), then each published state as it comes. With no runtime, nothing.
import { createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useBcState, useStudyState, type BcState, type StudyState } from './legacyBridge';

function StudyName() {
  const study = useStudyState();
  return createElement('p', { 'data-probe': 'study' }, study ? String(study.name) : 'no study');
}

function BcCount() {
  const bcs = useBcState();
  return createElement('p', { 'data-probe': 'bcs' }, bcs ? `${bcs.bcs.length} BCs` : 'no BCs');
}

const shown = (probe: string) => document.querySelector(`[data-probe="${probe}"]`)?.textContent;
const settle = async (ok: () => boolean) => {
  for (let i = 0; i < 50 && !ok(); i += 1) await new Promise((r) => setTimeout(r, 10));
};

let root: Root | null = null;
let renders = 0;

function mount(...children: Array<() => ReturnType<typeof createElement>>) {
  const host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  root.render(
    createElement(() => {
      renders += 1;
      return createElement('div', null, ...children.map((c) => c()));
    }),
  );
}

beforeEach(() => {
  renders = 0;
  delete window.__CFD_STUDY_STATE__;
  delete window.__CFD_STUDY_STATE_NOW__;
  delete window.__CFD_BCS__;
  delete window.__CFD_BC_STATE__;
});

afterEach(() => {
  root?.unmount();
  root = null;
  delete window.__CFD_STUDY_STATE__;
  delete window.__CFD_STUDY_STATE_NOW__;
  delete window.__CFD_BCS__;
  delete window.__CFD_BC_STATE__;
  document.body.innerHTML = '';
});

describe('the runtime states panels read', () => {
  it('shows the state at mount before the first publish, then the first publish', async () => {
    // A new object on every call, as computeStudyState builds it.
    const now = vi.fn(() => ({ has_study: true, id: 's0', name: 'Pipe study' }) as StudyState);
    window.__CFD_STUDY_STATE_NOW__ = now;
    window.__CFD_BC_STATE__ = vi.fn(() => ({ bcs: [{ id: 'bc1' }] }) as unknown as BcState);
    mount(
      () => createElement(StudyName, { key: 's' }),
      () => createElement(BcCount, { key: 'b' }),
    );
    await settle(() => shown('study') === 'Pipe study' && shown('bcs') === '1 BCs');
    expect(shown('study'), 'the study as the runtime had it when the panel mounted').toBe('Pipe study');
    expect(shown('bcs')).toBe('1 BCs');
    await new Promise((r) => setTimeout(r, 50));
    // It read the runtime once, and did not render again and again (each call is a new object).
    expect(now).toHaveBeenCalledTimes(1);
    expect(renders).toBe(1);

    // The runtime's first publish: the global, then the event.
    const published = { has_study: true, id: 's0', name: 'Elbow study' } as StudyState;
    window.__CFD_STUDY_STATE__ = published;
    window.dispatchEvent(new CustomEvent('cfd:study', { detail: published }));
    const bcs = { bcs: [{ id: 'bc1' }, { id: 'bc2' }] } as unknown as BcState;
    window.__CFD_BCS__ = bcs;
    window.dispatchEvent(new CustomEvent('cfd:bcs', { detail: bcs }));
    await settle(() => shown('study') === 'Elbow study' && shown('bcs') === '2 BCs');
    expect(shown('study'), 'the published study').toBe('Elbow study');
    expect(shown('bcs'), 'the published BCs').toBe('2 BCs');
  });

  it('shows nothing with no runtime, and the first publish once it comes', async () => {
    mount(() => createElement(StudyName, { key: 's' }));
    await settle(() => !!shown('study'));
    expect(shown('study')).toBe('no study');
    const published = { has_study: true, id: 's1', name: 'Wing study' } as StudyState;
    window.__CFD_STUDY_STATE__ = published;
    window.dispatchEvent(new CustomEvent('cfd:study', { detail: published }));
    await settle(() => shown('study') === 'Wing study');
    expect(shown('study')).toBe('Wing study');
  });
});
