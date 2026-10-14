// Home sets the page's on-home / on-workbench classes from the route in the address. It
// reads the address when it renders and listens for hashchange from an effect: an address
// change that lands between the two (a project link opened as the page boots) must still
// count. And an address with a broken %-escape (a truncated or hand-edited link) must not
// take the page down: the route is parsed as the shell draws, and a throw there unmounted
// the whole React shell (tree, toolbar, Home, FILTERS).
import { createElement, Fragment, useLayoutEffect } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Home } from './Home';

// The typed controller wires the #home shell, which this test has not got.
vi.mock('./controller', async (importOriginal) => ({ ...(await importOriginal<typeof import('./controller')>()), initHome: vi.fn() }));

const onHome = () => document.body.classList.contains('on-home');
const onWorkbench = () => document.body.classList.contains('on-workbench');
const marker = () => document.querySelector('[data-shell-marker="1"]');
const settle = async (ok: () => boolean) => {
  for (let i = 0; i < 50 && !ok(); i += 1) await new Promise((r) => setTimeout(r, 10));
};

function goTo(hash: string) {
  const oldURL = location.href;
  history.replaceState(null, '', hash);
  window.dispatchEvent(new HashChangeEvent('hashchange', { oldURL, newURL: location.href }));
}

let changedBeforeEffects: boolean | null = null;
/** A project link landing right after Home rendered, before its passive effects ran. */
function Lands() {
  useLayoutEffect(() => {
    changedBeforeEffects = onHome() === false && onWorkbench() === false;
    goTo('#/p/proj');
  }, []);
  return null;
}

/** The rest of the shell, in the same React root as Home. */
function Marker() {
  return createElement('div', { 'data-shell-marker': '1' }, 'tree');
}

let root: Root | null = null;

beforeEach(() => {
  history.replaceState(null, '', '#/');
  document.body.className = '';
  changedBeforeEffects = null;
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ ok: true, plugins: [] }), { status: 200 })));
});

afterEach(() => {
  root?.unmount();
  root = null;
  vi.unstubAllGlobals();
  history.replaceState(null, '', '#/');
  document.body.className = '';
  document.body.innerHTML = '';
});

describe('Home', () => {
  it('follows an address change that lands between its first render and its subscription', async () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    root.render(createElement(Fragment, null, createElement(Home), createElement(Lands)));
    await settle(() => onWorkbench());
    // The timing was forced: Home had not set a class yet when the address changed.
    expect(changedBeforeEffects).toBe(true);
    expect({ onHome: onHome(), onWorkbench: onWorkbench() }, 'the page is on the project, not Home').toEqual({
      onHome: false,
      onWorkbench: true,
    });
  });

  it('keeps the shell up when the address gets a broken %-escape', async () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    root.render(createElement(Fragment, null, createElement(Home), createElement(Marker)));
    await settle(() => onHome());
    expect(onHome()).toBe(true);
    goTo('#/p/%E0%A4%A');
    await settle(() => onWorkbench());
    await new Promise((r) => setTimeout(r, 50));
    expect(marker(), 'the rest of the shell is still on the page').not.toBeNull();
    expect(onWorkbench(), 'the address names a project').toBe(true);
  });
});
