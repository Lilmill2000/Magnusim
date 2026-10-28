import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { seriesLight, seriesVar } from '../theme/series';

// monitorChartSvg as runtime.js has it, with the helpers it calls; seriesVar and seriesLight are the theme module's.
const runtime = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'runtime.js'), 'utf8');
function runtimeSource(name: string): string {
  const m = runtime.match(new RegExp(`^function ${name}\\([\\s\\S]*?^}`, 'm'));
  if (!m) throw new Error(`runtime.js has no function ${name}`);
  return m[0];
}
type ChartOpts = { color?: string; screen?: boolean; title?: string; subtitle?: string; unit?: string; timeAxis?: boolean };
const monitorChartSvg = new Function(
  'seriesVar',
  'seriesLight',
  `${['escapeHtml', 'niceTicks', 'graphTick', 'seriesStyle', 'monitorChartSvg'].map(runtimeSource).join('\n')}\nreturn monitorChartSvg;`,
)(seriesVar, seriesLight) as (pts: Array<[number, number]>, opts: ChartOpts) => { svg: string };

const PTS: Array<[number, number]> = [
  [1, 0.52],
  [2, 0.81],
  [3, 0.34],
  [4, 1.18],
  [5, 0.97],
];
// The chart's own default, a palette colour, one whose light value is darker than its hex, and a hex with no token.
const COLOURS: Array<{ color?: string; css: string; paint?: string }> = [
  { css: 'var(--mg-series-default)' },
  { color: '#1570ef', css: 'var(--mg-series-1)' },
  { color: '#12b76a', css: 'var(--mg-series-3)', paint: '#099250' },
  { color: '#abcdef', css: 'color-mix(in srgb, #abcdef calc(100% - var(--mg-series-lift)), white)' },
];
const LAYOUTS: ChartOpts[] = [{}, { title: 'Drag', subtitle: 'run-1', unit: 'N', timeAxis: true }];

function parse(svg: string): SVGSVGElement {
  const doc = new DOMParser().parseFromString(svg, 'image/svg+xml');
  expect(doc.querySelector('parsererror')).toBeNull();
  return doc.documentElement as unknown as SVGSVGElement;
}
const all = (svg: Element, sel: string) => Array.from(svg.querySelectorAll(sel));

describe('monitorChartSvg for a saved image (no page CSS)', () => {
  for (const { color } of COLOURS) {
    for (const layout of LAYOUTS) {
      for (const screen of [undefined, false]) {
        it(`is light hex only: colour ${color ?? 'default'}, ${layout.title ? 'titled' : 'bare'}, screen ${screen}`, () => {
          const { svg } = monitorChartSvg(PTS, { ...layout, color, screen });
          expect(svg).not.toContain('var(');
          expect(svg).not.toMatch(/class="(gbg|gx|gax|gline|gtitle|gsub)"/);
          const el = parse(svg);
          const paints = all(el, '[stroke], [fill]').flatMap((n) => ['stroke', 'fill'].map((a) => n.getAttribute(a)).filter((v): v is string => v !== null));
          expect(paints.length).toBeGreaterThan(0);
          for (const v of paints) expect(v).toMatch(/^(#[0-9a-f]{6}|none|transparent|rgba\(255,255,255,0\.95\))$/i);
          // The one style left is the hover's display.
          expect(all(el, '[style]').map((n) => n.getAttribute('style'))).toEqual(['display:none']);
        });
      }
    }
  }
});

describe('monitorChartSvg on screen (opts.screen)', () => {
  for (const { color, css, paint } of COLOURS) {
    for (const layout of LAYOUTS) {
      it(`takes the theme: colour ${color ?? 'default'}, ${layout.title ? 'titled' : 'bare'}`, () => {
        const { svg } = monitorChartSvg(PTS, { ...layout, color, screen: true });
        const el = parse(svg);
        const bg = all(el, 'rect.gbg');
        expect(bg).toHaveLength(1);
        expect(el.querySelector('rect')).toBe(bg[0]);
        // Grid lines are gx; the x ticks and both axes are gax; the hover's cross line is neither.
        const lines = all(el, 'line').filter((n) => !n.closest('.ghover'));
        const grid = lines.filter((n) => n.getAttribute('stroke') === '#e6e9ef');
        const axes = lines.filter((n) => n.getAttribute('stroke') === '#98a2b3');
        expect(grid.length).toBeGreaterThan(1);
        expect(axes.length).toBeGreaterThan(2);
        expect(grid.length + axes.length).toBe(lines.length);
        for (const n of grid) expect(n.getAttribute('class')).toBe('gx');
        for (const n of axes) expect(n.getAttribute('class')).toBe('gax');
        expect(el.querySelector('.gcross')?.getAttribute('class')).toBe('gcross');
        // The series line and the hover dot: the light colour as the attribute, the theme's colour as a style.
        const path = el.querySelector('path');
        expect(path?.getAttribute('class')).toBe('gline');
        expect(path?.getAttribute('stroke')).toBe(paint ?? color ?? '#3884e6');
        expect(path?.getAttribute('style')).toBe(`stroke:${css}`);
        const dot = el.querySelector('.ghover circle');
        expect(dot?.getAttribute('fill')).toBe(paint ?? color ?? '#3884e6');
        expect(dot?.getAttribute('style')).toBe(`fill:${css}`);
        // The title and subtitle as the saved image has them (15px, the text colour), not as tick labels.
        expect(all(el, 'text.gtitle')).toHaveLength(layout.title ? 1 : 0);
        expect(all(el, 'text.gsub')).toHaveLength(layout.subtitle ? 1 : 0);
      });

      it(`is the saved image plus its classes and styles: colour ${color ?? 'default'}, ${layout.title ? 'titled' : 'bare'}`, () => {
        const screen = monitorChartSvg(PTS, { ...layout, color, screen: true }).svg;
        const saved = monitorChartSvg(PTS, { ...layout, color }).svg;
        const stripped = screen.replace(/ class="(gbg|gx|gax|gline|gtitle|gsub)"/g, '').replace(/ style="(stroke|fill):[^"]*"/g, '');
        expect(stripped).toBe(saved);
      });
    }
  }
});
