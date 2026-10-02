import { describe, expect, it } from 'vitest';
import {
  checkCssColours,
  checkCssDesignValues,
  checkCssSelectors,
  cssRules,
  frameBaseProps,
  missingFrameBaseProps,
  readKitCss,
  ruleProps,
  specificity,
} from '../../test/kitCss';

const css = readKitCss('button.css');

describe('kit.css', () => {
  it('imports base.css first, then each part, and nothing else', () => {
    const kitCss = readKitCss('../kit.css').replace(/\/\*[\s\S]*?\*\//g, '');
    expect(kitCss.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)).toEqual([
      "@import './styles/base.css';",
      "@import './styles/button.css';",
      "@import './styles/controls.css';",
      "@import './styles/panels.css';",
      "@import './styles/data.css';",
    ]);
  });
});

describe('button.css', () => {
  it('button.mgk-btn sets every property the frame base.css sets on a button', () => {
    // font, colour, border, radius, padding, background, cursor, hover background,
    // disabled opacity and cursor, the focus ring.
    expect(frameBaseProps('button')).toEqual(
      ['background', 'border', 'border-radius', 'color', 'cursor', 'font', 'opacity', 'outline', 'outline-offset', 'padding'],
    );
    expect(missingFrameBaseProps(css, 'button.mgk-btn', 'button')).toEqual([]);
    expect(specificity('button.mgk-btn')).toEqual([0, 1, 1]);
  });

  it('leaves to the browser what the core leaves to it, and zeroes margin and padding', () => {
    const base = ruleProps(css, 'button.mgk-btn');
    for (const p of ['font', 'color', 'background', 'border', 'border-radius', 'outline', 'outline-offset']) {
      expect(base[p], p).toBe('revert');
    }
    expect(base.margin).toBe('0');
    expect(base.padding).toBe('0');
    expect(ruleProps(css, 'button.mgk-btn:focus-visible')).toEqual({ outline: 'revert', 'outline-offset': 'revert' });
  });

  it('states are element.class:state, above the frame base.css states', () => {
    for (const rule of cssRules(css)) {
      for (const sel of rule.selectors) {
        expect(sel.startsWith('button.mgk-btn'), sel).toBe(true);
        if (/:(hover|disabled|focus-visible)/.test(sel)) expect(specificity(sel)[1], sel).toBeGreaterThanOrEqual(2);
      }
    }
    expect(specificity('button.mgk-btn:disabled')).toEqual([0, 2, 1]);
  });

  it('primary and secondary have no hover change, as in the core', () => {
    const rules = cssRules(css);
    const primary = rules.find((r) => r.selectors.includes('button.mgk-btn--primary'));
    const secondary = rules.find((r) => r.selectors.includes('button.mgk-btn--secondary'));
    expect(primary?.selectors).toContain('button.mgk-btn--primary:hover');
    expect(secondary?.selectors).toContain('button.mgk-btn--secondary:hover');
    expect(rules.filter((r) => r.selectors.some((s) => /--(primary|secondary):hover/.test(s)))).toHaveLength(2);
  });

  it('copies the core hover looks: neutral darkens, link underlines, fix darkens (.js-btn, .mat-clear-link, .sim-fix-go)', () => {
    expect(ruleProps(css, 'button.mgk-btn--neutral:hover')).toEqual({ background: 'var(--mg-btn-neutral-hover)' });
    expect(ruleProps(css, 'button.mgk-btn--neutral')).toMatchObject({
      border: '1px solid var(--mg-btn-neutral-border)',
      background: 'var(--mg-btn-neutral-bg)',
      'border-radius': 'var(--mg-radius-xs)',
      padding: '4px 10px',
      'font-size': 'var(--mg-text-xs)',
    });
    // Link and fix share their resting look with :hover, then add the hover change.
    expect(ruleProps(css, 'button.mgk-btn--link:hover')).toEqual({
      background: 'none',
      border: 'none',
      color: 'var(--mg-link)',
      'font-size': 'var(--mg-text-xs)',
      'text-decoration': 'underline',
    });
    expect(ruleProps(css, 'button.mgk-btn--link')['text-decoration']).toBeUndefined();
    expect(ruleProps(css, 'button.mgk-btn--fix')).toMatchObject({ color: 'var(--mg-link-strong)', 'text-decoration': 'underline' });
    expect(ruleProps(css, 'button.mgk-btn--fix:hover').color).toBe('var(--mg-link-strong-hover)');
  });

  it('danger is the solid danger colour, darker on hover and focus', () => {
    expect(ruleProps(css, 'button.mgk-btn--danger')).toEqual({
      border: '1px solid var(--mg-danger-solid)',
      background: 'var(--mg-danger-solid)',
      color: 'var(--mg-primary-text)',
      'border-radius': 'var(--mg-radius-sm)',
      padding: '4px 8px',
      'font-weight': 'var(--mg-weight-semibold)',
    });
    for (const sel of ['button.mgk-btn--danger:hover', 'button.mgk-btn--danger:focus-visible']) {
      expect(ruleProps(css, sel), sel).toEqual({ 'border-color': 'var(--mg-danger-solid-hover)', background: 'var(--mg-danger-solid-hover)' });
    }
  });

  it('disabled buttons fade and keep their resting colours, as the core ones do', () => {
    expect(ruleProps(css, 'button.mgk-btn:disabled')).toEqual({ opacity: 'var(--mg-disabled-opacity)', cursor: 'not-allowed' });
    expect(ruleProps(css, 'button.mgk-btn--primary:disabled')).toEqual({
      'border-color': 'var(--mg-btn-disabled-bg)',
      background: 'var(--mg-btn-disabled-bg)',
    });
    expect(ruleProps(css, 'button.mgk-btn--secondary:disabled')).toEqual({ background: 'var(--mg-bg)' });
    expect(ruleProps(css, 'button.mgk-btn--neutral:disabled')).toEqual({ background: 'var(--mg-btn-neutral-bg)' });
    expect(ruleProps(css, 'button.mgk-btn--danger:disabled')).toEqual({
      'border-color': 'var(--mg-danger-solid)',
      background: 'var(--mg-danger-solid)',
    });
  });

  it('uses tokens for colours, sizes, weights and radii', () => {
    // The gen check's rules (§2.9 rules 4, 6 and 9) on this file alone.
    expect(checkCssColours(css)).toEqual([]);
    expect(checkCssDesignValues(css)).toEqual([]);
    expect(checkCssSelectors(css)).toEqual([]);
    for (const rule of cssRules(css)) {
      for (const [prop, value] of Object.entries(rule.props)) {
        if (/^(font-size|font-weight|border-radius|box-shadow|z-index|opacity)$/.test(prop) && value !== 'revert') {
          expect(value, `${prop}: ${value}`).toMatch(/^var\(--mg-[\w-]+\)$/);
        }
      }
    }
  });

  it('the shared checks catch a colour word or a literal font in this file', () => {
    expect(checkCssColours(`${css}\nbutton.mgk-btn--link:hover { border-bottom: 1px solid black; }`)).not.toEqual([]);
    expect(checkCssColours(`${css}\nbutton.mgk-btn--fix:hover { color: red; }`)).not.toEqual([]);
    expect(checkCssDesignValues(`${css}\nbutton.mgk-btn--fix { font: 700 15px Georgia; }`)).not.toEqual([]);
  });
});
