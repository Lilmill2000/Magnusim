// CAD's tokens (src/styles/tokens.css) in the host's two appearances: the light set is exactly
// what it was (every alias falls back to the host's light value), every literal colour has a dark
// value, the dark set changes only colours and shadows, blue text takes --mg-primary-ink, no CAD
// stylesheet paints a raw colour, and in dark the text and marks reach their contrast.
// SPDX-License-Identifier: GPL-3.0-or-later
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import { cadTokens, contrast, hostTokens, over, parseColor, PLUGIN, resolveVars, stripComments, themeValue } from './css-tokens';

/** Literal colours that are the same in both themes (a pick, a set face, a hover, the always-dark tooltip). */
const NEUTRAL = new Set(['--cad-pick', '--cad-set', '--cad-hover-pick', '--cad-tip-key-border', '--cad-tip-detail']);
/** Tokens that are not colours. */
const NOT_COLOURS = new Set(['--cad-tree-dim', '--cad-toolbar-scale']);
const COLOURISH = /#[0-9a-f]{3,8}\b|rgba?\(/i;

/**
 * The light block's values before the dark set (v050-live 22efe574: the tokens that mirror a core rule
 * are the host's --mg-* tokens there, so theirs are the host's light values): an alias now resolves
 * to exactly these on the host's light set.
 */
const LIGHT_BEFORE: Record<string, string> = {
  '--cad-tree-selected': '#d7e8ff',
  '--cad-tree-twisty': '#667085',
  '--cad-tree-head': '#344054',
  '--cad-tree-section': '#4a5160',
  '--cad-tree-empty': '#8a93a3',
  '--cad-tree-section-top': '#eef1f5',
  '--cad-tree-section-bottom': '#d5d8de',
  '--cad-toolbar-bg': '#f2f4f7',
  '--cad-toolbar-sep': '#d5d8de',
  '--cad-toolbar-label': '#667085',
  '--cad-toolbar-active-bg': '#d7e8ff',
  '--cad-toolbar-active-border': '#9bc2f0',
  '--cad-toolbar-active-icon': '#1a4fbf',
  '--cad-toolbar-scale': '1',
  // New: a toolbar button's hover and open background, the icon buttons' hover it had (--cad-icon-btn-hover-bg).
  '--cad-toolbar-hover-bg': '#eef0f4',
  '--cad-icon-btn': '#5b6575',
  '--cad-disabled-button-text': 'rgba(16, 16, 16, 0.3)',
  '--cad-icon-btn-hover-bg': '#eef0f4',
  '--cad-menu-hover': '#eef1f5',
  '--cad-menu-sep': '#e4e7ec',
  '--cad-menu-shadow': '0 8px 24px rgba(16, 24, 40, 0.14)',
  '--cad-viewport-bg': '#f0f2f7',
  '--cad-pick': '#2ec47e',
  '--cad-set': '#4884eb',
  '--cad-hover-pick': '#b2ccff',
  '--cad-axis-x': '#d42828',
  '--cad-axis-y': '#1f9a3a',
  '--cad-axis-z': '#2a5bd7',
  '--cad-view-btn-border': '#c9ced6',
  // Moved from .cad-viewport (viewport.css), and the two raw shadows and the labels' colours given tokens.
  '--cad-vp-btn-bg': 'rgba(255, 255, 255, 0.92)',
  '--cad-vp-btn-fg': '#2b3440',
  '--cad-vp-btn-hover-border': '#9fb0c5',
  '--cad-vp-btn-hover-fg': '#1d4ed8',
  '--cad-vp-btn-shadow': '0 1px 2px rgba(0, 0, 0, 0.08)',
  '--cad-vp-disabled': '#98a2b3',
  '--cad-vp-glow': '0 0 4px #fff, 0 1px 2px rgba(255, 255, 255, 0.85)',
  '--cad-vp-label': '#4a5160',
  '--cad-vp-label-hover': '#1a4fbf',
  '--cad-marker-shadow': '0 1px 3px rgba(16, 24, 40, 0.18)',
  // New: a failed marker's hover and focus background, the hover blue it had (--cad-hover-pick).
  '--cad-marker-failed-hover-bg': '#b2ccff',
  '--cad-sketch-over': '#b42318',
  // The keys to the sketch's line colours: the colours the state dot and a reference's dot painted
  // before (--cad-sketch-under, --cad-sketch-full, --cad-sketch-over, --cad-sketch-projected and
  // --cad-sketch-lost then).
  '--cad-sketch-key-under': '#1570ef',
  '--cad-sketch-key-full': '#101828',
  '--cad-sketch-key-over': '#b42318',
  '--cad-sketch-key-linked': '#7a3fd1',
  '--cad-sketch-key-lost': '#b54708',
  // New: the dots' face half in a dark view (E2); they had no shadow (none), and keep none in light.
  '--cad-sketch-key-under-on-face': 'none',
  '--cad-sketch-key-full-on-face': 'none',
  '--cad-sketch-key-over-on-face': 'none',
  '--cad-sketch-key-linked-on-face': 'none',
  '--cad-sketch-key-lost-on-face': 'none',
  '--cad-sketch-lost': '#b54708',
  '--cad-box-enclose': '#1570ef',
  '--cad-box-enclose-fill': 'rgba(21, 112, 239, 0.08)',
  '--cad-box-touch': '#12855a',
  '--cad-box-touch-fill': 'rgba(46, 196, 126, 0.1)',
  // New: the caption had no background (transparent) and no shadow (none), and keeps them in light.
  '--cad-box-caption-bg': 'transparent',
  '--cad-box-caption-ring': 'none',
  '--cad-panel-accent-feature': '#344054',
  '--cad-panel-accent-sketch': '#175cd3',
  '--cad-danger-hover-bg': '#fef3f2',
  '--cad-tree-dim': '0.55',
  '--cad-rollback': '#1570ef',
  '--cad-rollback-handle-bg': '#ffffff',
  '--cad-body-swatch-border': 'rgba(16, 24, 40, 0.25)',
  '--cad-disabled-text': '#8a93a3',
  '--cad-warning-border': '#fec84b',
  '--cad-spin-track': '#d0d5dd',
  '--cad-tip-key-border': 'rgba(255, 255, 255, 0.3)',
  '--cad-tip-detail': '#c9ced6',
  '--cad-modal-backdrop': 'rgba(20, 24, 32, 0.45)',
  '--cad-modal-shadow': '0 12px 40px rgba(0, 0, 0, 0.25)',
  '--cad-p2-progress-track': '#e4e7ec',
  '--cad-p2-measure': '#1a4fbf',
};

/** Every CSS file under src/ (plugin-relative path, text). */
function cssFiles(): { rel: string; css: string }[] {
  const out: { rel: string; css: string }[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (name.endsWith('.css')) out.push({ rel: relative(PLUGIN, p).replace(/\\/g, '/'), css: readFileSync(p, 'utf8') });
    }
  };
  walk(join(PLUGIN, 'src'));
  return out;
}

/** The core's stylesheet (magnusim-web/src/style.css), whose recipes CAD's copy. */
const CORE_CSS = join(PLUGIN, '../../src/style.css');

/** Every rule of a stylesheet, comments left out: its selector (whitespace collapsed) and its declarations. */
function rulesOf(css: string): { sel: string; body: string }[] {
  return [...stripComments(css).matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => ({ sel: m[1].replace(/\s+/g, ' ').trim(), body: m[2] }));
}

const same = (a: string | null, b: string) => (a ?? '').replace(/\s+/g, ' ').toLowerCase() === b.replace(/\s+/g, ' ').toLowerCase() || (a === '#fff' && b === '#ffffff');

describe('CAD tokens: the light set', () => {
  it('is :root and [data-theme="light"], so a light-pinned subtree gets the light aliases', () => {
    expect(cadTokens().lightSelector).toBe(':root, [data-theme="light"]');
  });

  it('has exactly the values it had before the dark set (an alias resolves to the host light value it replaced)', () => {
    const { light } = cadTokens();
    expect([...light.keys()].sort()).toEqual(Object.keys(LIGHT_BEFORE).sort());
    for (const [name, before] of Object.entries(LIGHT_BEFORE)) expect(same(themeValue(name, 'light'), before), `${name}: ${themeValue(name, 'light')} vs ${before}`).toBe(true);
  });

  it("aliases --mg-* tokens with the exact light value as the fallback (a host without the token stays as it was)", () => {
    const { light } = cadTokens();
    const host = hostTokens();
    for (const [name, v] of light) {
      const m = /^var\((--mg-[\w-]+)\s*,\s*([^()]+)\)$/.exec(v);
      if (!v.includes('var(')) continue;
      expect(m, `${name}: ${v} is var(--mg-x, <light value>)`).not.toBeNull();
      expect(same(host.light.get(m![1]) ?? null, m![2].trim()), `${name}: fallback ${m![2]} vs the host's ${host.light.get(m![1])}`).toBe(true);
    }
  });
});

describe('CAD tokens: the dark set', () => {
  it('gives every literal colour token a dark value (the theme-neutral ones excepted), and names no token the light set lacks', () => {
    const { light, dark } = cadTokens();
    expect(dark).not.toBeNull();
    const missing = [...light].filter(([name, v]) => !v.includes('var(') && COLOURISH.test(v) && !NEUTRAL.has(name) && !dark!.has(name)).map(([n]) => n);
    expect(missing).toEqual([]);
    expect([...dark!.keys()].filter((n) => !light.has(n))).toEqual([]);
    // An alias follows the host's dark set by itself: no dark entry overrides it.
    expect([...dark!.keys()].filter((n) => light.get(n)!.includes('var('))).toEqual([]);
  });

  it('changes only colours and shadows', () => {
    const { dark } = cadTokens();
    for (const [name, v] of dark!) {
      expect(NOT_COLOURS.has(name), name).toBe(false);
      expect(COLOURISH.test(v), `${name}: ${v}`).toBe(true);
      // A shadow's lengths, and `inset` (a key dot's face half, E2), besides colours.
      expect(v.replace(/#[0-9a-f]{3,8}\b|rgba?\([^)]*\)/gi, '').replace(/\binset\b/g, '').replace(/[\d.\spx,-]/g, ''), `${name}: only lengths besides colours`).toBe('');
    }
  });

  it("backs the box's caption in the view's background colour in dark only: it reads on a light face", () => {
    expect([themeValue('--cad-box-caption-bg', 'light'), themeValue('--cad-box-caption-ring', 'light')]).toEqual(['transparent', 'none']);
    const caption = /\n\.cad-box-caption \{([^}]*)\}/.exec(readFileSync(join(PLUGIN, 'src/viewport/viewport.css'), 'utf8'))?.[1];
    expect(caption).toMatch(/background: var\(--cad-box-caption-bg\);/);
    expect(caption).toMatch(/box-shadow: var\(--cad-box-caption-ring\);/);
    // The ring is the backing's own colour (one plate, 2 px larger each side).
    const backing = themeValue('--cad-box-caption-bg', 'dark')!;
    expect(themeValue('--cad-box-caption-ring', 'dark')).toBe(`0 0 0 2px ${backing}`);
    // Over the lightest face (a lit one is lighter than the body colour) and over the view's own background,
    // both captions read at least 4.5:1 on it (bare on a face: 1.2 to 1.4:1).
    const rgb = (c: number[]) => `rgb(${c.slice(0, 3).map(Math.round).join(', ')})`;
    for (const under of ['#ffffff', '#bdc9db', themeValue('--cad-viewport-bg', 'dark')!]) {
      const plate = rgb(over(parseColor(backing)!, parseColor(under)!));
      for (const text of ['--cad-box-enclose', '--cad-box-touch']) expect(contrast(themeValue(text, 'dark')!, plate), `${text} on the backing over ${under}`).toBeGreaterThanOrEqual(4.5);
    }
    expect(contrast(themeValue('--cad-box-enclose', 'dark')!, '#bdc9db')).toBeLessThan(1.6);
  });

  it("keeps a failed pattern marker's red number readable under the pointer and keyboard focus", () => {
    const css = readFileSync(join(PLUGIN, 'src/features/pattern/pattern.css'), 'utf8');
    expect(css).toMatch(/\.cad-pattern-marker\.is-failed:hover,\s*\.cad-pattern-markers \.cad-pattern-marker\.is-failed:focus-visible \{\s*background: var\(--cad-marker-failed-hover-bg\);\s*\}/);
    // Light: the hover blue every marker takes (4.06:1 for the red, as before); dark: on the hover blue it was 1.72:1.
    expect(themeValue('--cad-marker-failed-hover-bg', 'light')).toBe(themeValue('--cad-hover-pick', 'light'));
    expect(contrast(themeValue('--mg-danger', 'dark')!, themeValue('--cad-hover-pick', 'dark')!)).toBeLessThan(2);
    expect(contrast(themeValue('--mg-danger', 'dark')!, themeValue('--cad-marker-failed-hover-bg', 'dark')!)).toBeGreaterThanOrEqual(4.5);
  });

  it("shows a toolbar button's hover on the host's dark toolbar (its own token, not the panels' hover)", () => {
    const toolbar = rulesOf(readFileSync(join(PLUGIN, 'src/ui/ui.css'), 'utf8')).filter((r) => /\.tb-/.test(r.sel));
    // The button under the pointer, a split pair's either half, and an open flyout arrow, More or group menu.
    expect(toolbar.filter((r) => /background: var\(--cad-toolbar-hover-bg\);/.test(r.body)).map((r) => r.sel)).toEqual([
      '.tb-btn:hover',
      '.cad-toolbar.is-ribbon .tb-split:hover > .tb-btn:not(.is-disabled):not(.is-active)',
      '.cad-toolbar .tb-btn.tb-flyout-arrow.is-open',
      '.cad-toolbar .tb-btn.tb-more.is-open, .cad-toolbar .tb-btn.tb-group-menu.is-open',
    ]);
    expect(toolbar.filter((r) => r.body.includes('--cad-icon-btn-hover-bg')).map((r) => r.sel)).toEqual([]);
    // Light as it was; in dark it stands off the host's toolbar (the panels' hover was 1.06:1 there),
    // and the button's text and icon read on it.
    expect(themeValue('--cad-toolbar-hover-bg', 'light')).toBe(LIGHT_BEFORE['--cad-icon-btn-hover-bg']);
    expect(contrast(themeValue('--cad-toolbar-hover-bg', 'dark')!, themeValue('--cad-toolbar-bg', 'dark')!)).toBeGreaterThanOrEqual(1.15);
    expect(contrast(themeValue('--mg-text-strong', 'dark')!, themeValue('--cad-toolbar-hover-bg', 'dark')!)).toBeGreaterThanOrEqual(4.5);
  });

  it("paints a selected tree row and an active toolbar button in the core's colours, in both themes", () => {
    // CAD's copies of the core's recipes (style.css .tree-node.selected > .tree-row, .tb-btn.is-active).
    const core = rulesOf(readFileSync(CORE_CSS, 'utf8'));
    const host = hostTokens();
    const coreValue = (sel: string, prop: string, theme: 'light' | 'dark') => {
      const body = core.find((r) => r.sel === sel)?.body ?? '';
      const v = new RegExp(`(?:^|;)\\s*${prop}:\\s*([^;]+);`).exec(body)?.[1];
      expect(v, `the core's ${sel} { ${prop} }`).toBeTruthy();
      return resolveVars(v!, (n) => (theme === 'dark' ? host.dark : host.light).get(n));
    };
    for (const theme of ['light', 'dark'] as const)
      for (const [sel, prop, token] of [
        ['.tree-node.selected > .tree-row', 'background', '--cad-tree-selected'],
        ['.tb-btn.is-active', 'background', '--cad-toolbar-active-bg'],
        ['.tb-btn.is-active', 'border-color', '--cad-toolbar-active-border'],
      ] as const)
        expect(themeValue(token, theme), `${theme} ${token}`).toBe(coreValue(sel, prop, theme));
  });

  it('reads in dark: text at least 4.5:1 on its background, icons and marks at least 3:1', () => {
    const v = (name: string) => {
      const r = name.startsWith('#') ? name : themeValue(name, 'dark');
      if (!r) throw new Error(`${name} has no dark value`);
      return r;
    };
    // [foreground, background, minimum]
    const pairs: [string, string, number][] = [
      ['--cad-vp-label', '--cad-viewport-bg', 4.5],
      ['--cad-vp-label-hover', '--cad-viewport-bg', 4.5],
      ['--cad-box-enclose', '--cad-viewport-bg', 4.5],
      ['--cad-box-touch', '--cad-viewport-bg', 4.5],
      ['--cad-axis-x', '--cad-viewport-bg', 4.5],
      ['--cad-axis-y', '--cad-viewport-bg', 4.5],
      ['--cad-axis-z', '--cad-viewport-bg', 4.5],
      ['--cad-p2-measure', '--mg-bg', 4.5],
      ['--cad-set', '--mg-bg', 4.5],
      ['--cad-panel-accent-sketch', '--mg-bg', 4.5],
      ['--cad-sketch-over', '--mg-bg', 4.5],
      ['--cad-sketch-lost', '--mg-bg', 4.5],
      ['--mg-primary-ink', '--mg-selected-bg', 4.5],
      ['--mg-danger', '--cad-danger-hover-bg', 4.5],
      // A failed pattern marker's number under the pointer or keyboard focus.
      ['--mg-danger', '--cad-marker-failed-hover-bg', 4.5],
      ['--cad-tree-head', '--mg-bg', 4.5],
      ['--cad-tree-section', '--mg-bg', 4.5],
      ['--mg-text', '--cad-tree-selected', 4.5],
      ['--mg-text', '--cad-menu-hover', 4.5],
      ['--cad-toolbar-label', '--cad-toolbar-bg', 4.5],
      ['--mg-text', '--cad-toolbar-active-bg', 4.5],
      ['--cad-toolbar-active-icon', '--cad-toolbar-active-bg', 3],
      ['--cad-icon-btn', '--cad-toolbar-bg', 3],
      ['--cad-tree-twisty', '--mg-bg', 3],
      ['--cad-rollback', '--mg-bg', 3],
      ['--cad-warning-border', '--mg-bg', 3],
      ['--cad-panel-accent-feature', '--mg-bg', 3],
      // The keys to the line colours (dots, not text) at E2's default.
      ['--cad-sketch-key-under', '--mg-bg', 3],
      ['--cad-sketch-key-full', '--mg-bg', 3],
      ['--cad-sketch-key-over', '--mg-bg', 3],
      ['--cad-sketch-key-linked', '--mg-bg', 3],
      ['--cad-sketch-key-lost', '--mg-bg', 3],
    ];
    const low: string[] = [];
    for (const [fg, bg, min] of pairs) {
      const c = contrast(v(fg), v(bg));
      if (c < min) low.push(`${fg} ${v(fg)} on ${bg} ${v(bg)}: ${c.toFixed(2)} < ${min}`);
    }
    // The view's buttons: their glyphs on the translucent button over the view.
    const btn = contrast(v('--cad-vp-btn-fg'), v('--cad-vp-btn-bg').replace(/rgba\((\d+), (\d+), (\d+), [\d.]+\)/, (_, r, g, b) => `rgb(${r}, ${g}, ${b})`));
    if (btn < 4.5) low.push(`--cad-vp-btn-fg on --cad-vp-btn-bg: ${btn.toFixed(2)}`);
    expect(low).toEqual([]);
  });
});

describe('CAD stylesheets', () => {
  it('paint blue text with --mg-primary-ink (in dark the --mg-primary fill is too dark for text)', () => {
    const bad: string[] = [];
    for (const { rel, css } of cssFiles()) {
      stripComments(css)
        .split('\n')
        .forEach((line, i) => {
          if (/(^|[\s;{])color:\s*var\(--mg-primary\s*[,)]/.test(line)) bad.push(`${rel}:${i + 1} ${line.trim()}`);
        });
    }
    expect(bad).toEqual([]);
    // The text sites (and the token that carries the ink to text: the box caption).
    const sketch = readFileSync(join(PLUGIN, 'src/sketch/sketch.css'), 'utf8');
    for (const sel of ['.cad-sk-glyph.is-inference', '.cad-sk-dim.is-preview', '.cad-sketch-annotations > .cad-sk-handle']) {
      const rule = new RegExp(`\\n${sel.replace(/\./g, '\\.')} \\{([^}]*)\\}`).exec(sketch);
      expect(rule?.[1], sel).toMatch(/color: var\(--mg-primary-ink, #1570ef\)/);
    }
    const ui = readFileSync(join(PLUGIN, 'src/ui/ui.css'), 'utf8');
    for (const sel of ['.cad-panel-badge', '.cad-rail-owner']) {
      const rule = new RegExp(`\\n${sel.replace(/\./g, '\\.')} \\{([^}]*)\\}`).exec(ui);
      expect(rule?.[1], sel).toMatch(/color: var\(--mg-primary-ink, #1570ef\)/);
    }
    const { light } = cadTokens();
    expect(light.get('--cad-box-enclose')).toBe('var(--mg-primary-ink, #1570ef)');
  });

  it('paint no raw colour outside tokens.css (a var() fallback is the host value it stands in for)', () => {
    const bad: string[] = [];
    for (const { rel, css } of cssFiles()) {
      if (rel === 'src/styles/tokens.css') continue;
      const text = stripComments(css).replace(/var\(\s*--[\w-]+\s*,\s*(#[0-9a-f]{3,8}|rgba?\([^)]*\))\s*\)/gi, '');
      text.split('\n').forEach((line, i) => {
        // Declarations only (an id selector such as #cad-root is no colour).
        if (/[{,]\s*$/.test(line)) return;
        if (COLOURISH.test(line)) bad.push(`${rel}:${i + 1} ${line.trim()}`);
      });
    }
    expect(bad).toEqual([]);
  });

  it('resolve var() chains the way the tests assume', () => {
    const t = new Map([
      ['--a', 'var(--b, #111111)'],
      ['--c', '0 1px var(--a)'],
    ]);
    expect(resolveVars('var(--a)', (n) => t.get(n))).toBe('#111111');
    expect(resolveVars('var(--c)', (n) => t.get(n))).toBe('0 1px #111111');
    expect(resolveVars('var(--x)', (n) => t.get(n))).toBeNull();
  });
});
