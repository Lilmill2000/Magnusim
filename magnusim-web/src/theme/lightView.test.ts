import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { tokenValues } from '../test/kitCss';
import { hexRgb01, hexRgb255, LIGHT_VIEW, LIGHT_VIEW_TOKENS } from './lightView';

const light = tokenValues();
const here = dirname(fileURLToPath(import.meta.url));

describe('the 3D views’ light colours', () => {
  it('each is its token’s light value', () => {
    for (const [name, token] of Object.entries(LIGHT_VIEW_TOKENS)) {
      expect(LIGHT_VIEW[name as keyof typeof LIGHT_VIEW], token).toBe(light[token]);
    }
  });

  it('one background everywhere (Daniel, 2026-10-27): #f0f2f7, also the margins beside the view and the CAD and 2D tunnel views', () => {
    expect(LIGHT_VIEW.bg).toBe('#f0f2f7');
    const css = readFileSync(join(here, '..', 'style.css'), 'utf8');
    expect(css).toMatch(/\.viewport-wrap \{[^}]*background: #f0f2f7;/);
    const cad = readFileSync(join(here, '..', '..', 'bundled-plugins', 'cad', 'src', 'styles', 'tokens.css'), 'utf8');
    expect(cad).toContain('--cad-viewport-bg: #f0f2f7;');
    const tunnel = readFileSync(join(here, '..', '..', 'bundled-plugins', 'tunnel2d', 'src', 'styles', 'tokens.css'), 'utf8');
    expect(tunnel).toContain('--t2d-bg: #f0f2f7;');
  });

  it('runtime.js sets no 3D colour of its own where one of these belongs: no white or other background, no magenta, the axes, BC arrows and glyphs from here', () => {
    const src = readFileSync(join(here, '..', 'workbench', 'runtime.js'), 'utf8');
    for (const banned of [
      'background: [0.94, 0.95, 0.97]',
      'background: [1, 1, 1]',
      'renderer.setBackground(1, 1, 1); } catch (_) {}\n  syncMeshHullForPlanes',
      'v.renderer.setBackground(1, 1, 1)',
      'ren.setBackground(1, 1, 1)',
      'setColor(1, 0, 1)',
      'setColor(1.0, 0.0, 1.0)',
      "ctx.fillStyle = '#f0f2f7'",
      'color: [220, 40, 40]',
      'inlet: [0.18, 0.48, 0.92]',
      'makeGlyphActor([0.88, 0.2, 0.2])',
    ]) {
      expect(src.includes(banned), banned).toBe(false);
    }
  });

  it('converts to what vtk.js takes', () => {
    expect(hexRgb255('#f0f2f7')).toEqual([240, 242, 247]);
    expect(hexRgb01('#ff0000')).toEqual([1, 0, 0]);
    expect(hexRgb01(LIGHT_VIEW.bg).map((c) => Math.round(c * 255))).toEqual([240, 242, 247]);
  });
});
