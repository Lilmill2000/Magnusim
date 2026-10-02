import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
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

const css = readKitCss('panels.css');
const appCss = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'style.css'), 'utf8');

describe('panels.css', () => {
  it('button.mgk-toast-close sets every property the frame base.css sets on a button', () => {
    expect(frameBaseProps('button').length).toBeGreaterThan(0);
    expect(missingFrameBaseProps(css, 'button.mgk-toast-close', 'button')).toEqual([]);
    expect(specificity('button.mgk-toast-close')).toEqual([0, 1, 1]);
    // Hover keeps the same look (above the frame's button:hover background).
    expect(missingFrameBaseProps(css, 'button.mgk-toast-close:hover', 'button')).toEqual([]);
    expect(specificity('button.mgk-toast-close:hover')).toEqual([0, 2, 1]);
  });

  it('the close button leaves to the browser what the core leaves to it, and zeroes margin and padding', () => {
    const close = ruleProps(css, 'button.mgk-toast-close');
    for (const p of ['font', 'border-radius', 'opacity', 'outline', 'outline-offset']) expect(close[p], p).toBe('revert');
    expect(close.margin).toBe('0');
    expect(close.padding).toBe('0');
    expect(close.border).toBe('0');
    expect(close.background).toBe('none');
    expect(close['font-size']).toBe('var(--mg-text-xl)');
    expect(ruleProps(css, 'button.mgk-toast-close:focus-visible')).toEqual({ outline: 'revert', 'outline-offset': 'revert' });
    expect(specificity('button.mgk-toast-close:focus-visible')).toEqual([0, 2, 1]);
  });

  it('selects kit classes only, with kit modifiers for states', () => {
    for (const rule of cssRules(css)) {
      for (const sel of rule.selectors) {
        for (const compound of sel.split(/\s*[\s>+~]\s*/).filter(Boolean)) {
          expect(compound, sel).toMatch(/\.mgk-/);
        }
        for (const cls of sel.match(/\.[\w-]+/g) || []) expect(cls, sel).toMatch(/^\.mgk-/);
        expect(sel, sel).not.toMatch(/\.is-/);
      }
    }
    expect(ruleProps(css, '.mgk-toast.mgk-toast--success')).toEqual({ 'border-left-color': 'var(--mg-success)' });
    expect(ruleProps(css, '.mgk-toast.mgk-toast--error')).toEqual({ 'border-left-color': 'var(--mg-danger)' });
  });

  it('in-panel roots use the panel body colour; the toast keeps the strong text colour', () => {
    expect(ruleProps(css, '.mgk-status').color).toBe('var(--mg-text-body)');
    expect(ruleProps(css, '.mgk-panel-body').color).toBe('var(--mg-text-body)');
    expect(ruleProps(css, '.mgk-toast').color).toBe('var(--mg-text-strong)');
    // The info accent is the info token (#1570ef), not the primary.
    expect(ruleProps(css, '.mgk-toast')['border-left']).toBe('3px solid var(--mg-info)');
    // PanelChrome's root takes its type and colour from .mgk-type.
    expect(ruleProps(css, '.mgk-panel')).toEqual({});
  });

  it('copies the core panel rules', () => {
    expect(ruleProps(css, '.mgk-panel-head')).toMatchObject({ 'margin-bottom': 'var(--mg-space-2)', 'padding-bottom': '6px' });
    expect(ruleProps(css, '.mgk-panel-foot')).toMatchObject({ 'margin-top': '14px', 'padding-top': '10px' });
    expect(ruleProps(css, 'button.mgk-panel-done')).toEqual({ 'min-width': '72px' });
    expect(ruleProps(css, '.mgk-panel--card')).toMatchObject({ padding: '10px 12px', 'box-shadow': 'var(--mg-shadow-md)' });
    // No cursor on the head: in a frame a pointer over a head that does nothing would mislead.
    expect(ruleProps(css, '.mgk-panel-head').cursor).toBeUndefined();
  });

  // PanelError has no core pair (a new look, the card every failed core panel now shows):
  // its rules are pinned here.
  it('the panel error card: a danger accent and title, a muted message', () => {
    expect(ruleProps(css, '.mgk-error')).toEqual({
      border: '1px solid var(--mg-border-subtle)',
      'border-left': '3px solid var(--mg-danger)',
      background: 'var(--mg-bg)',
      padding: 'var(--mg-space-3)',
      'border-radius': 'var(--mg-radius-md)',
    });
    expect(ruleProps(css, '.mgk-error-title')).toEqual({
      color: 'var(--mg-danger)',
      'font-size': 'var(--mg-text-md)',
      'font-weight': 'var(--mg-weight-semibold)',
    });
    expect(ruleProps(css, '.mgk-error-msg')).toEqual({
      'margin-top': 'var(--mg-space-1)',
      color: 'var(--mg-text-muted)',
      'overflow-wrap': 'anywhere',
    });
    expect(ruleProps(css, '.mgk-error .mgk-btn--fix')).toEqual({ 'margin-top': '6px' });
  });

  it('the status block: a large tabular elapsed time, the ETA and the meta line (.mesh-finished, .sim-eta)', () => {
    expect(ruleProps(css, '.mgk-status-elapsed')).toEqual({
      'font-variant-numeric': 'tabular-nums',
      'font-size': 'var(--mg-text-2xl)',
      'font-weight': 'var(--mg-weight-semibold)',
      color: 'var(--mg-text)',
      'margin-top': 'var(--mg-space-1)',
    });
    expect(ruleProps(css, '.mgk-status-eta')).toEqual({ 'font-size': 'var(--mg-text-sm)', color: 'var(--mg-text-secondary)', 'margin-top': '2px' });
    expect(ruleProps(css, '.mgk-status-meta')).toEqual({ 'font-size': 'var(--mg-text-xs)', color: 'var(--mg-text-muted)', 'margin-top': 'var(--mg-space-1)' });
  });

  it("in the app's flyout a kit panel head leaves room for the corner control, as a core head does", () => {
    const rule = cssRules(appCss).find((r) => r.selectors.includes('.tree-detail .mgk-panel-head'));
    expect(rule?.selectors).toEqual(['.tree-detail .sim-def-head', '.tree-detail .mat-panel-head', '.tree-detail .mgk-panel-head']);
    expect(rule?.props).toEqual({ 'padding-right': '28px' });
  });

  it('uses tokens for colours, sizes, weights, radii, shadows and layers, and no viewport units', () => {
    // The gen check's rules (§2.9 rules 4, 6 and 9) on this file alone.
    expect(checkCssColours(css)).toEqual([]);
    expect(checkCssDesignValues(css)).toEqual([]);
    expect(checkCssSelectors(css)).toEqual([]);
    expect(checkCssColours(`${css}\n.mgk-error-title { color: red; }`)).not.toEqual([]);
    expect(checkCssDesignValues(`${css}\n.mgk-error-title { font: 700 15px Georgia; }`)).not.toEqual([]);
    for (const rule of cssRules(css)) {
      for (const [prop, value] of Object.entries(rule.props)) {
        expect(value, `${prop}: ${value}`).not.toMatch(/\d(vw|vh|vmin|vmax)\b/);
        if (/^(font-size|font-weight|border-radius|box-shadow|z-index|opacity)$/.test(prop) && !['revert', 'none', '0'].includes(value)) {
          expect(value, `${prop}: ${value}`).toMatch(/^var\(--mg-[\w-]+\)$/);
        }
        if (/^(transition|animation)/.test(prop)) expect(value, `${prop}: ${value}`).not.toMatch(/\d+m?s\b/);
      }
    }
  });
});
