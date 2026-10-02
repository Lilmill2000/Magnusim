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

const css = readKitCss('controls.css');

// Each control's base rule and the element the frame's base.css styles under it.
const BASE_RULES: Array<[selector: string, element: string]> = [
  ['input.mgk-input', 'input'],
  ['select.mgk-select', 'select'],
  ['input.mgk-switch-input', 'input'],
  ['button.mgk-pill', 'button'],
];

describe('controls.css', () => {
  it('each control base rule sets every property the frame base.css sets on its element', () => {
    expect(frameBaseProps('input')).toEqual(
      ['background', 'border', 'border-radius', 'color', 'font', 'outline', 'outline-offset', 'padding'],
    );
    expect(frameBaseProps('select')).toEqual(frameBaseProps('input'));
    for (const [selector, element] of BASE_RULES) {
      expect(missingFrameBaseProps(css, selector, element), selector).toEqual([]);
      expect(specificity(selector), selector).toEqual([0, 1, 1]);
    }
  });

  it('leaves to the browser what the core leaves to it, and zeroes margin', () => {
    for (const [selector] of BASE_RULES) {
      const props = ruleProps(css, selector);
      for (const p of ['font', 'outline', 'outline-offset']) expect(props[p], `${selector} ${p}`).toBe('revert');
      expect(props.margin, selector).toBe('0');
    }
    // The core's .bc-select sets its text colour and background; the input and buttons do not.
    for (const selector of ['input.mgk-input', 'input.mgk-switch-input', 'button.mgk-pill']) {
      expect(ruleProps(css, selector).color, selector).toBe('revert');
    }
    expect(ruleProps(css, 'select.mgk-select')).toMatchObject({ color: 'var(--mg-text)', background: 'var(--mg-bg)' });
    // The core's input, switch and pill keep the browser's field or button face.
    expect(ruleProps(css, 'input.mgk-input').background).toBe('revert');
    expect(ruleProps(css, 'input.mgk-switch-input').background).toBe('revert');
    expect(ruleProps(css, 'button.mgk-pill').background).toBe('revert');
    expect(ruleProps(css, 'input.mgk-switch-input').padding).toBe('0');
    expect(ruleProps(css, 'input.mgk-switch-input').border).toBe('0');
    // The font size comes after `font: revert`, so it wins.
    for (const selector of ['input.mgk-input', 'select.mgk-select', 'button.mgk-pill']) {
      const keys = Object.keys(ruleProps(css, selector));
      expect(keys.indexOf('font-size'), selector).toBeGreaterThan(keys.indexOf('font'));
    }
  });

  it('every focusable control keeps the browser focus ring, in page and frame', () => {
    for (const selector of [
      'input.mgk-input:focus-visible',
      'select.mgk-select:focus-visible',
      'input.mgk-switch-input:focus-visible',
      'button.mgk-pill:focus-visible',
    ]) {
      expect(ruleProps(css, selector), selector).toEqual({ outline: 'revert', 'outline-offset': 'revert' });
      expect(specificity(selector), selector).toEqual([0, 2, 1]);
    }
    // The help "?" is a span: above the frame's bare :focus-visible (0,1,0).
    expect(ruleProps(css, '.mgk-field-help:focus-visible')).toEqual({ outline: 'revert', 'outline-offset': 'revert' });
    expect(specificity('.mgk-field-help:focus-visible')).toEqual([0, 2, 0]);
  });

  it('states of an element.class sit above the frame base.css states', () => {
    for (const rule of cssRules(css)) {
      for (const sel of rule.selectors) {
        if (/^(input|select|button)\.mgk-[\w-]+:(hover|disabled|focus-visible)$/.test(sel)) {
          expect(specificity(sel)[1], sel).toBeGreaterThanOrEqual(2);
        }
      }
    }
    expect(ruleProps(css, 'button.mgk-pill:hover').background).toBe('revert');
    expect(ruleProps(css, 'button.mgk-pill:disabled')).toEqual({ opacity: 'var(--mg-disabled-opacity)', cursor: 'not-allowed' });
  });

  it('the ON pill is a kit modifier as specific as the core .mesh-toggle.is-on, never is-on', () => {
    expect(specificity('button.mgk-pill.mgk-pill--on')).toEqual([0, 2, 1]);
    expect(specificity('button.mgk-pill.mgk-pill--on:hover')).toEqual([0, 3, 1]);
    expect(ruleProps(css, 'button.mgk-pill.mgk-pill--on')).toEqual({
      background: 'var(--mg-text)',
      color: 'var(--mg-primary-text)',
      'border-color': 'var(--mg-text)',
    });
    expect(css).not.toMatch(/\.is-[a-z]/);
  });

  it('copies the core switch and pill', () => {
    expect(ruleProps(css, 'label.mgk-switch')).toMatchObject({ width: '34px', height: '18px', display: 'inline-block' });
    expect(ruleProps(css, '.mgk-switch-track::before')).toMatchObject({
      width: '14px',
      height: '14px',
      left: '2px',
      top: '2px',
      'border-radius': 'var(--mg-radius-round)',
      transition: 'transform var(--mg-duration-switch)',
    });
    expect(ruleProps(css, 'input.mgk-switch-input:checked + .mgk-switch-track::before')).toEqual({ transform: 'translateX(16px)' });
    expect(ruleProps(css, 'button.mgk-pill')).toMatchObject({ 'min-width': '48px', height: '24px', padding: '0 8px' });
  });

  it('the switch track: grey off, dark on, faded when disabled (.switch .slider)', () => {
    expect(ruleProps(css, '.mgk-switch-track')).toEqual({
      position: 'absolute',
      inset: '0',
      background: 'var(--mg-switch-off)',
      'border-radius': 'var(--mg-radius-pill)',
    });
    expect(ruleProps(css, 'input.mgk-switch-input:checked + .mgk-switch-track')).toEqual({ background: 'var(--mg-text-strong)' });
    expect(ruleProps(css, 'input.mgk-switch-input:disabled + .mgk-switch-track')).toEqual({
      opacity: 'var(--mg-disabled-opacity)',
      cursor: 'not-allowed',
    });
    expect(ruleProps(css, '.mgk-switch-track::before').background).toBe('var(--mg-bg)');
  });

  it('the help tip shows on hovering the label and on focusing its "?" (.mat-k-tip)', () => {
    const shows = cssRules(css).filter((r) => r.props.display === 'block' && r.selectors.some((s) => s.includes('mgk-field-tip')));
    expect(shows.map((r) => r.selectors)).toEqual([
      ['.mgk-field-k[data-help]:hover .mgk-field-tip', '.mgk-field-help:focus-visible + .mgk-field-tip'],
    ]);
    expect(ruleProps(css, '.mgk-field-tip')).toEqual({
      display: 'none',
      position: 'absolute',
      left: '0',
      top: 'calc(100% + 4px)',
      'z-index': 'var(--mg-z-tooltip)',
      width: '260px',
      padding: '7px 9px',
      'border-radius': 'var(--mg-radius-tip)',
      background: 'var(--mg-tooltip-bg)',
      color: 'var(--mg-tooltip-text)',
      'font-size': 'var(--mg-text-sm)',
      'font-weight': 'var(--mg-weight-regular)',
      'line-height': 'var(--mg-line)',
      'text-align': 'left',
      'white-space': 'normal',
      'box-shadow': 'var(--mg-shadow-tooltip)',
      'pointer-events': 'none',
    });
    expect(ruleProps(css, '.mgk-field-k[data-help]')).toEqual({ position: 'relative', cursor: 'help' });
  });

  it('hints: muted, warning and danger colours', () => {
    expect(ruleProps(css, '.mgk-hint')).toEqual({ 'font-size': 'var(--mg-text-xs)', color: 'var(--mg-text-muted)', margin: '0 0 6px' });
    expect(ruleProps(css, '.mgk-hint--warning')).toEqual({ color: 'var(--mg-warning)' });
    expect(ruleProps(css, '.mgk-hint--danger')).toEqual({ color: 'var(--mg-danger)' });
    expect(ruleProps(css, '.mgk-reason')).toEqual({ color: 'var(--mg-danger)' });
  });

  it('sets list-style only on the li form of EmptyState', () => {
    const withListStyle = cssRules(css).filter((r) => Object.keys(r.props).some((p) => p.startsWith('list-style')));
    expect(withListStyle.map((r) => r.selectors)).toEqual([['li.mgk-empty']]);
  });

  it('gives the in-panel roots the panel body colour', () => {
    for (const selector of ['.mgk-value-row', 'label.mgk-switch', '.mgk-field']) {
      expect(ruleProps(css, selector).color, selector).toBe('var(--mg-text-body)');
    }
  });

  it('the help tip has no viewport cap', () => {
    expect(ruleProps(css, '.mgk-field-tip').width).toBe('260px');
    expect(ruleProps(css, '.mgk-field-tip')['max-width']).toBeUndefined();
    for (const rule of cssRules(css)) {
      for (const [prop, value] of Object.entries(rule.props)) expect(value, `${prop}: ${value}`).not.toMatch(/\d(vw|vh|vmin|vmax)\b/);
    }
  });

  it('uses tokens for colours, sizes, weights, radii, shadows, layers and durations', () => {
    // The gen check's rules (§2.9 rules 4, 6 and 9) on this file alone.
    expect(checkCssColours(css)).toEqual([]);
    expect(checkCssDesignValues(css)).toEqual([]);
    expect(checkCssSelectors(css)).toEqual([]);
    expect(checkCssColours(`${css}\n.mgk-hint--warning { border-left: 3px solid black; }`)).not.toEqual([]);
    for (const rule of cssRules(css)) {
      for (const sel of rule.selectors) {
        for (const cls of sel.match(/\.[\w-]+/g) || []) expect(cls, sel).toMatch(/^\.mgk-/);
      }
      for (const [prop, value] of Object.entries(rule.props)) {
        if (/^(font-size|font-weight|border-radius|box-shadow|z-index|opacity)$/.test(prop) && !['revert', '0'].includes(value)) {
          expect(value, `${prop}: ${value}`).toMatch(/^var\(--mg-[\w-]+\)$/);
        }
        if (/^(transition|animation)/.test(prop)) expect(value, `${prop}: ${value}`).not.toMatch(/\d+m?s\b/);
      }
    }
  });
});
