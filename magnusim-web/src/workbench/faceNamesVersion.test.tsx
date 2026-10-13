// A face table set while a list mounts (after its first render, before its subscription)
// still redraws the list (the BC editor kept "face 15@Body1" after a reload on CI).
import { createElement, Fragment, useLayoutEffect } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';
import { faceDisplay, resetFaceNamesForTests, setShownFaceTable, useFaceNamesVersion } from './faceNames';

function Picks() {
  useFaceNamesVersion();
  return createElement('span', { 'data-pick': '1' }, faceDisplay('face 15@Body1'));
}

/** The preview's answer landing right after the list rendered, before its passive effects ran. */
function Lands({ label }: { label: string }) {
  useLayoutEffect(() => {
    setShownFaceTable({ faces: [{ id: 15, name: 'F:boss:end', label }] }, 'g1');
  }, [label]);
  return null;
}

const settle = async (host: HTMLElement, want: string) => {
  for (let i = 0; i < 50 && host.textContent !== want; i += 1) await new Promise((r) => setTimeout(r, 10));
};

afterEach(() => {
  resetFaceNamesForTests();
  document.body.innerHTML = '';
});

describe('useFaceNamesVersion', () => {
  it('a table set between the first render and the subscription is not missed', async () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    root.render(createElement(Fragment, null, createElement(Picks), createElement(Lands, { label: 'Renamed Boss end' })));
    await settle(host, 'Renamed Boss end (face 15)');
    expect(host.textContent).toBe('Renamed Boss end (face 15)');
    // A later table redraws it too.
    setShownFaceTable({ faces: [{ id: 15, name: 'F:boss:end', label: 'Boss end' }] }, 'g1');
    await settle(host, 'Boss end (face 15)');
    expect(host.textContent).toBe('Boss end (face 15)');
    root.unmount();
  });
});
