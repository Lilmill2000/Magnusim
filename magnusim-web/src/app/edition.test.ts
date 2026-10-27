import { afterEach, describe, expect, it } from 'vitest';
import { edition, isCad } from './edition';

afterEach(() => {
  document.head.innerHTML = '';
  delete window.__MAGNUSIM_EDITION__;
  history.replaceState(null, '', '/');
});

describe('edition', () => {
  it('is Magnusim unless the page says CAD', () => {
    expect(edition()).toBe('magnusim');
    expect(isCad()).toBe(false);
    document.head.innerHTML = '<meta name="magnusim-edition" content="cad">';
    expect(edition()).toBe('cad');
    document.head.innerHTML = '<meta name="magnusim-edition" content="magnusim">';
    expect(edition()).toBe('magnusim');
  });

  it('takes a host global over the page', () => {
    window.__MAGNUSIM_EDITION__ = ' CAD ';
    expect(isCad()).toBe(true);
  });

  it('never comes from the address', () => {
    history.replaceState(null, '', '/?edition=cad#/edition/cad');
    expect(edition()).toBe('magnusim');
  });
});
