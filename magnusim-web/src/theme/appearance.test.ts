import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import indexHtml from '../../index.html?raw';
import cadHtml from '../../cad.html?raw';
import {
  APPEARANCE_CHANNEL,
  APPEARANCE_KEY,
  applyAppearance,
  currentAppearance,
  currentTheme,
  DEFAULT_APPEARANCE,
  readAppearance,
  resetAppearanceForTests,
  resolveTheme,
  saveAppearance,
  startAppearanceSync,
} from './appearance';

const html = document.documentElement;

/** A system that says light or dark, and can change its mind. */
function system(dark: boolean) {
  const listeners = new Set<() => void>();
  const mql = {
    get matches() {
      return dark;
    },
    addEventListener: (_: string, fn: () => void) => listeners.add(fn),
    removeEventListener: (_: string, fn: () => void) => listeners.delete(fn),
  };
  vi.stubGlobal('matchMedia', () => mql);
  return {
    set(next: boolean) {
      dark = next;
      for (const fn of listeners) fn();
    },
  };
}

beforeEach(() => resetAppearanceForTests());
afterEach(() => {
  resetAppearanceForTests();
  vi.unstubAllGlobals();
  html.removeAttribute('data-theme');
  html.removeAttribute('data-theme-pref');
  html.removeAttribute('style');
  localStorage.clear();
});

describe('the look', () => {
  it('reads only what Settings offers; anything else is its default', () => {
    expect(readAppearance({ theme: 'dark', text_scale: 1.15, icon_scale: 1.5 })).toEqual({ theme: 'dark', text_scale: 1.15, icon_scale: 1.5 });
    expect(readAppearance({ theme: 'neon', text_scale: 7, icon_scale: '1.5' })).toEqual(DEFAULT_APPEARANCE);
    expect(readAppearance(null)).toEqual(DEFAULT_APPEARANCE);
  });

  it('"system" is the system\'s light or dark', () => {
    expect([resolveTheme('light', true), resolveTheme('dark', false), resolveTheme('system', true), resolveTheme('system', false)]).toEqual(['light', 'dark', 'dark', 'light']);
  });

  it('puts the resolved theme, the choice and the scales on html, keeps them for the first paint, and says so', () => {
    system(false);
    const heard: unknown[] = [];
    const on = (e: Event) => heard.push((e as CustomEvent).detail);
    window.addEventListener('cfd:appearance', on);
    applyAppearance({ theme: 'dark', text_scale: 1.3, icon_scale: 0.85 });
    window.removeEventListener('cfd:appearance', on);
    // color-scheme is tokens.css's, by data-theme: never inline (a light swap on html takes it too).
    expect([html.dataset.theme, html.dataset.themePref, html.style.colorScheme]).toEqual(['dark', 'dark', '']);
    expect([html.style.getPropertyValue('--mg-text-scale'), html.style.getPropertyValue('--mg-icon-scale')]).toEqual(['1.3', '0.85']);
    expect(JSON.parse(localStorage.getItem(APPEARANCE_KEY)!)).toEqual({ theme: 'dark', text_scale: 1.3, icon_scale: 0.85 });
    expect(heard).toEqual([{ theme: 'dark', text_scale: 1.3, icon_scale: 0.85 }]);
    expect([currentAppearance().theme, currentTheme()]).toEqual(['dark', 'dark']);
  });

  it('"system" follows the system as it changes, and the event carries the theme it resolved to', () => {
    const sys = system(false);
    const themes: string[] = [];
    const on = (e: Event) => themes.push((e as CustomEvent).detail.theme);
    window.addEventListener('cfd:appearance', on);
    applyAppearance({ theme: 'system', text_scale: 1, icon_scale: 1 });
    expect([html.dataset.theme, html.dataset.themePref]).toEqual(['light', 'system']);
    sys.set(true);
    expect(html.dataset.theme).toBe('dark');
    // Not followed once the person picks a theme of their own.
    applyAppearance({ theme: 'light', text_scale: 1, icon_scale: 1 });
    sys.set(false);
    sys.set(true);
    window.removeEventListener('cfd:appearance', on);
    expect(html.dataset.theme).toBe('light');
    expect(themes).toEqual(['light', 'dark', 'light']);
  });

  it("a change made here reaches this app's other tabs, and a page does not take back what it said", async () => {
    system(false);
    // Another tab, as a channel of its own.
    const other = new BroadcastChannel(APPEARANCE_CHANNEL);
    const got: unknown[] = [];
    other.onmessage = (e) => got.push(e.data);
    const stop = startAppearanceSync();
    const heard: unknown[] = [];
    const on = (e: Event) => heard.push((e as CustomEvent).detail.theme);
    window.addEventListener('cfd:appearance', on);
    applyAppearance({ theme: 'dark', text_scale: 1, icon_scale: 1 }, { announce: true });
    await vi.waitFor(() => expect(got).toHaveLength(1));
    expect(got[0]).toMatchObject({ theme: 'dark', text_scale: 1, icon_scale: 1 });
    await new Promise((r) => setTimeout(r, 20));
    expect(heard).toEqual(['dark']);
    // What another tab says is shown here.
    other.postMessage({ theme: 'light', text_scale: 1.15, icon_scale: 1, from: 'elsewhere' });
    await vi.waitFor(() => expect(html.dataset.theme).toBe('light'));
    expect(html.style.getPropertyValue('--mg-text-scale')).toBe('1.15');
    window.removeEventListener('cfd:appearance', on);
    stop();
    other.close();
  });

  it('saves a change in the app prefs and shows the look as saved, or says why not', async () => {
    system(false);
    const posted: unknown[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init: RequestInit) => {
        const body = JSON.parse(String(init.body));
        posted.push(body);
        if (body.theme === 'neon') return new Response(JSON.stringify({ ok: false, error: 'theme is one of light, dark, system' }), { status: 400 });
        return new Response(JSON.stringify({ ok: true, prefs: { ok: true, theme: 'dark', text_scale: 1, icon_scale: 1.25 } }), { status: 200 });
      }),
    );
    expect(await saveAppearance({ theme: 'dark' })).toEqual({ ok: true, appearance: { theme: 'dark', text_scale: 1, icon_scale: 1.25 } });
    expect([html.dataset.theme, html.style.getPropertyValue('--mg-icon-scale')]).toEqual(['dark', '1.25']);
    expect((window as unknown as { __CFD_PREFS__: { theme: string } }).__CFD_PREFS__.theme).toBe('dark');
    expect(await saveAppearance({ theme: 'neon' as never })).toEqual({ ok: false, error: 'theme is one of light, dark, system' });
    expect(html.dataset.theme).toBe('dark');
    expect(posted).toEqual([{ theme: 'dark' }, { theme: 'neon' }]);
  });
});

describe('the first paint (index.html, cad.html)', () => {
  /** The pre-paint script of a page, as its own source. */
  const prePaint = (page: string) => {
    const m = /<script>([\s\S]*?)<\/script>/.exec(page);
    if (!m) throw new Error('no pre-paint script');
    return m[1];
  };

  it('both pages have the same one, before the stylesheet', () => {
    expect(prePaint(cadHtml)).toBe(prePaint(indexHtml));
    for (const page of [indexHtml, cadHtml]) expect(page.indexOf('<script>')).toBeLessThan(page.indexOf('/src/style.css'));
  });

  it('shows the kept look before any app script runs: dark, the system\'s, the scales; junk changes nothing', () => {
    const run = () => new Function(prePaint(indexHtml))();
    system(false);
    localStorage.setItem(APPEARANCE_KEY, JSON.stringify({ theme: 'dark', text_scale: 1.3, icon_scale: 1.5 }));
    run();
    // color-scheme is tokens.css's, by data-theme: never inline (a light swap on html takes it too).
    expect([html.dataset.theme, html.dataset.themePref, html.style.colorScheme]).toEqual(['dark', 'dark', '']);
    expect([html.style.getPropertyValue('--mg-text-scale'), html.style.getPropertyValue('--mg-icon-scale')]).toEqual(['1.3', '1.5']);
    html.removeAttribute('style');
    system(true);
    localStorage.setItem(APPEARANCE_KEY, JSON.stringify({ theme: 'system', text_scale: 1, icon_scale: 1 }));
    run();
    expect([html.dataset.theme, html.dataset.themePref]).toEqual(['dark', 'system']);
    html.removeAttribute('data-theme');
    html.removeAttribute('style');
    for (const junk of ['not json', JSON.stringify({ theme: 'neon' }), JSON.stringify({ theme: 'dark', text_scale: 40, icon_scale: 'x' })]) {
      localStorage.setItem(APPEARANCE_KEY, junk);
      expect(() => run()).not.toThrow();
    }
    // A theme it knows still goes on; scales it does not are left out.
    expect(html.dataset.theme).toBe('dark');
    expect(html.style.getPropertyValue('--mg-text-scale')).toBe('');
  });

  it("takes the look the server put on the page first: a new origin's storage is empty (Magnusim CAD's port changes every start)", () => {
    const run = () => new Function(prePaint(indexHtml))();
    system(false);
    localStorage.clear();
    // As the server stamps it (scripts/prefs.js stampAppearance; prefs-appearance.test.js): data-look, JSON.
    html.setAttribute('data-look', JSON.stringify({ theme: 'dark', text_scale: 1.15, icon_scale: 1 }));
    run();
    expect([html.dataset.theme, html.dataset.themePref, html.style.getPropertyValue('--mg-text-scale')]).toEqual(['dark', 'dark', '1.15']);
    // It wins over this origin's copy, which can be older (the look changed on another origin).
    html.removeAttribute('data-theme');
    html.removeAttribute('style');
    localStorage.setItem(APPEARANCE_KEY, JSON.stringify({ theme: 'light', text_scale: 1, icon_scale: 1 }));
    run();
    expect(html.dataset.theme).toBe('dark');
    html.removeAttribute('data-look');
  });
});
