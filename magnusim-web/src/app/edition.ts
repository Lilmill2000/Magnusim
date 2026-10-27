/**
 * Which app this page is: Magnusim, or Magnusim CAD (the project screen, CAD and the
 * Assistant, with no simulation).
 *
 * The page's own HTML says so: Magnusim CAD's entry (cad.html) carries
 * `<meta name="magnusim-edition" content="cad">`, and a host may set
 * `window.__MAGNUSIM_EDITION__`. Never the URL: a link cannot turn Magnusim into CAD.
 */
export type Edition = 'magnusim' | 'cad';

declare global {
  interface Window {
    __MAGNUSIM_EDITION__?: string;
  }
}

export function edition(): Edition {
  if (typeof document === 'undefined') return 'magnusim';
  const meta = document.querySelector('meta[name="magnusim-edition"]')?.getAttribute('content');
  const value = String(window.__MAGNUSIM_EDITION__ || meta || '')
    .trim()
    .toLowerCase();
  return value === 'cad' ? 'cad' : 'magnusim';
}

export function isCad(): boolean {
  return edition() === 'cad';
}
