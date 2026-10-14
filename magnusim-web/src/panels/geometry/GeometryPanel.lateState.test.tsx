// The Geometry panel reads the runtime's geometry state when it renders and listens for
// cfd:geometry from an effect. A state the runtime publishes between the two (a geometry
// switch's answer landing as the panel opens) must still show: the panel kept the previous
// geometry's Name and Volume rows until something else changed.
import { createElement, Fragment, useLayoutEffect } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { GeometryState } from '../legacyBridge';
import { useProjectStore } from '../../store/project';
import { GeometryPanel } from './GeometryPanel';

const PIPE: GeometryState = {
  has_geometry: true,
  id: 'g-pipe',
  title: 'Pipe',
  name: 'pipe.step',
  representation: 'CAD (STEP)',
  volume: 'Body1',
  can_delete: true,
};
const ELBOW: GeometryState = {
  has_geometry: true,
  id: 'g-elbow',
  title: 'Elbow',
  name: 'elbow.step',
  representation: 'CAD (STEP)',
  volume: 'Body1, Body2',
  can_delete: true,
};

/** What runtime.js publishGeometryState does: the global first, then the event. */
function publishGeometryState(detail: GeometryState) {
  window.__CFD_GEOMETRY_STATE__ = detail;
  window.dispatchEvent(new CustomEvent('cfd:geometry', { detail }));
}

let seenAtPublish = '';
/** The runtime's answer landing right after the panel rendered, before its passive effects ran. */
function Lands({ detail }: { detail: GeometryState }) {
  useLayoutEffect(() => {
    seenAtPublish = document.querySelector('[data-geometry-name="1"]')?.textContent || '';
    publishGeometryState(detail);
  }, [detail]);
  return null;
}

const text = (sel: string) => document.querySelector(sel)?.textContent || '';
const settle = async (want: string) => {
  for (let i = 0; i < 50 && text('[data-geometry-name="1"]') !== want; i += 1) await new Promise((r) => setTimeout(r, 10));
};

let root: Root | null = null;

beforeEach(() => {
  // No project: the panel reads no link or actions over the network.
  useProjectStore.setState({ projectId: null } as never);
  window.__CFD_GEOMETRY_STATE__ = PIPE;
  seenAtPublish = '';
});

afterEach(() => {
  root?.unmount();
  root = null;
  delete window.__CFD_GEOMETRY_STATE__;
  document.body.innerHTML = '';
});

describe('GeometryPanel', () => {
  it('shows the geometry the runtime published between its first render and its subscription', async () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    root.render(createElement(Fragment, null, createElement(GeometryPanel, { panelId: 'panel-geometry' }), createElement(Lands, { detail: ELBOW })));
    await settle('elbow.step');
    // The timing was forced: the panel had rendered the previous geometry when the state landed.
    expect(seenAtPublish).toBe('pipe.step');
    expect(text('[data-geometry-name="1"]')).toBe('elbow.step');
    expect(text('[data-geometry-volume="1"]')).toBe('Body1, Body2');
    // A later publish redraws it too.
    publishGeometryState({ ...ELBOW, volume: 'Body2' });
    for (let i = 0; i < 50 && text('[data-geometry-volume="1"]') !== 'Body2'; i += 1) await new Promise((r) => setTimeout(r, 10));
    expect(text('[data-geometry-volume="1"]')).toBe('Body2');
  });
});
