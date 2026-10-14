// The FILTERS panel reads the plugin panels placed there when it renders and listens for
// cfd:panels from an effect. A panel a plugin registers between the two (its UI loading as
// the FILTERS panel mounts) must still show: the panel left it out until something else
// registered.
import { createElement, Fragment, useLayoutEffect } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { registerPanel, unregisterPlugin } from '../plugin-api';
import { useProjectStore } from '../store/project';
import { FiltersPanel } from './FiltersPanel';

const section = () => document.querySelector('[data-filter-section="late-probe"]');

let shownAtRegister: boolean | null = null;
/** A plugin UI registering its FILTERS section right after the panel rendered, before its passive effects ran. */
function Lands() {
  useLayoutEffect(() => {
    shownAtRegister = !!section();
    registerPanel({
      key: 'late-probe',
      title: 'Probe line',
      place: 'filters',
      Component: function ProbeLine() {
        return createElement('p', null, 'Probe line from the plugin');
      },
    });
  }, []);
  return null;
}

const settle = async (ok: () => boolean) => {
  for (let i = 0; i < 50 && !ok(); i += 1) await new Promise((r) => setTimeout(r, 10));
};

let root: Root | null = null;

beforeEach(() => {
  useProjectStore.setState({ projectId: 'proj', registry: { filter: [] } } as never);
  shownAtRegister = null;
});

afterEach(() => {
  root?.unmount();
  root = null;
  unregisterPlugin('');
  useProjectStore.setState({ projectId: null, registry: null } as never);
  document.body.innerHTML = '';
});

describe('FiltersPanel', () => {
  it('shows a plugin section registered between its first render and its subscription', async () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    root.render(createElement(Fragment, null, createElement(FiltersPanel), createElement(Lands)));
    await settle(() => !!section());
    // The timing was forced: the panel was on screen without the section when it was registered.
    expect(document.querySelector('[data-filters-panel="1"]')).not.toBeNull();
    expect(shownAtRegister).toBe(false);
    expect(section()?.textContent, 'the FILTERS panel shows the plugin section').toBe('Probe line from the plugin');
  });
});
