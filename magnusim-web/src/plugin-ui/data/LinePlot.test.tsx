import { fireEvent, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ResidualPlot, type ResidualSeries } from '../../panels/run/ResidualPlot';
import { LinePlot, type LineSeries } from './LinePlot';

type Row = Record<string, number | undefined>;

const ROWS: Row[] = Array.from({ length: 10 }, (_, i) => ({
  t: i + 1,
  u: 0.4 * Math.exp(-i / 3),
  p: 0.8 * Math.exp(-i / 5),
  k: 0.1 * Math.exp(-i / 2),
}));
const SECONDS: Row[] = ROWS.map((r, i) => ({ ...r, t: (i + 1) * 0.005 }));

const CORE_SERIES: ResidualSeries[] = [
  { key: 'u', label: 'U', color: '#1570ef', always: true },
  { key: 'p', label: 'p', color: '#6941c6', always: true },
  { key: 'k', label: 'k', color: '#12b76a', always: true },
];
const KIT_SERIES: LineSeries[] = CORE_SERIES.map((s) => ({ key: s.key, label: s.label, legend: 'always' }));

const SVG_WIDTH = 300;
const TIP_WIDTH = 120;

beforeEach(() => {
  // jsdom lays nothing out: the plot is 300 px wide and the tip 120 px.
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
    const width = this.tagName.toLowerCase() === 'svg' ? SVG_WIDTH : this.classList.contains('mgk-plot-tip') ? TIP_WIDTH : 0;
    return { x: 0, y: 0, left: 0, top: 0, right: width, bottom: 132, width, height: 132, toJSON: () => ({}) } as DOMRect;
  });
});
afterEach(() => vi.restoreAllMocks());

function hover(el: Element | null, clientX: number) {
  if (!el) throw new Error('no plot');
  fireEvent.pointerMove(el, { clientX, clientY: 60 });
}

describe('LinePlot', () => {
  it('draws the core plot markup with kit classes', () => {
    const { container } = render(<LinePlot rows={ROWS} series={KIT_SERIES} label="Residuals" x={{ kind: 'iterations' }} y={{ scale: 'log' }} />);
    const root = container.firstElementChild as HTMLElement;
    expect(root.className).toBe('mgk-type mgk-linechart');
    const svg = container.querySelector('.mgk-plot > svg.mgk-plot-svg') as SVGSVGElement;
    expect(svg.getAttribute('role')).toBe('img');
    expect(svg.getAttribute('aria-label')).toBe('Residuals');
    expect(svg.getAttribute('preserveAspectRatio')).toBe('none');
    expect(container.querySelectorAll('polyline.mgk-plot-line')).toHaveLength(3);
    expect(container.querySelector('line.mgk-plot-grid')).not.toBeNull();
    const labels = [...container.querySelectorAll('text.mgk-plot-label')];
    expect(labels.every((t) => t.getAttribute('font-size') === '8' && !t.hasAttribute('fill'))).toBe(true);
    expect(labels.slice(-2).map((t) => t.textContent)).toEqual(['1', '10']);
    expect(container.querySelector('.mgk-plot-cursor')?.hasAttribute('hidden')).toBe(true);
    expect(container.querySelector('.mgk-plot-tip')?.hasAttribute('hidden')).toBe(true);
  });

  it('is 132 px tall with a 280 × 132 viewBox by default, and takes a height', () => {
    const { container, rerender } = render(<LinePlot rows={ROWS} series={KIT_SERIES} label="R" x={{ kind: 'iterations' }} y={{ scale: 'log' }} />);
    let svg = container.querySelector('svg') as SVGSVGElement;
    expect(svg.style.height).toBe('132px');
    expect(svg.getAttribute('viewBox')).toBe('0 0 280 132');
    rerender(<LinePlot rows={ROWS} series={KIT_SERIES} label="R" x={{ kind: 'iterations' }} y={{ scale: 'log' }} height={200} />);
    svg = container.querySelector('svg') as SVGSVGElement;
    expect(svg.style.height).toBe('200px');
    expect(svg.getAttribute('viewBox')).toBe('0 0 280 200');
    // The end labels sit 4 units above the bottom, at the plot's own height.
    expect([...svg.querySelectorAll('text')].slice(-1)[0].getAttribute('y')).toBe('196');
  });

  it('colours lines from the series palette through inline style, and dashes dashed series', () => {
    const rows = ROWS.map((r) => ({ ...r, co: 0.3 }));
    const series: LineSeries[] = [...KIT_SERIES, { key: 'co', label: 'Co', dashed: true, color: 'var(--mg-danger)' }];
    const { container } = render(<LinePlot rows={rows} series={series} label="R" x={{ kind: 'iterations' }} y={{ scale: 'log' }} />);
    const lines = [...container.querySelectorAll('polyline')] as SVGPolylineElement[];
    expect(lines.map((l) => l.style.stroke)).toEqual(['var(--mg-series-1)', 'var(--mg-series-2)', 'var(--mg-series-3)', 'var(--mg-danger)']);
    expect(lines.every((l) => !l.hasAttribute('stroke'))).toBe(true);
    expect(lines.map((l) => l.classList.contains('mgk-plot-line--dashed'))).toEqual([false, false, false, true]);
  });

  it('draws the legend with an <i> swatch per series, a dashed swatch for dashed series', () => {
    const rows = ROWS.map((r) => ({ ...r, co: 0.3 }));
    const series: LineSeries[] = [...KIT_SERIES, { key: 'co', label: 'Co', dashed: true }];
    const { container } = render(<LinePlot rows={rows} series={series} label="R" x={{ kind: 'iterations' }} y={{ scale: 'log' }} />);
    const keys = [...container.querySelectorAll('.mgk-plot-legend > span.mgk-plot-key')];
    expect(keys.map((k) => k.textContent)).toEqual(['U', 'p', 'k', 'Co']);
    const swatches = keys.map((k) => k.firstElementChild as HTMLElement);
    expect(swatches.map((s) => s.tagName)).toEqual(['I', 'I', 'I', 'I']);
    expect(swatches.every((s) => s.className === 'mgk-plot-swatch')).toBe(true);
    expect(swatches[0].getAttribute('style')).toContain('var(--mg-series-1)');
    expect(swatches[3].getAttribute('style')).toContain('repeating-linear-gradient(90deg, var(--mg-series-4) 0 4px, transparent 4px 6px)');
  });

  it('follows the legend rules, and leaves the legend out on request', () => {
    const series: LineSeries[] = [
      { key: 'u', label: 'U', legend: 'always' },
      { key: 'p', label: 'p' },
      { key: 'zz', label: 'Z', legend: 'always' },
      { key: 'k', label: 'k', legend: 'never' },
      { key: 'none', label: 'None' },
      { key: 'co', label: 'Co', dashed: true },
    ];
    const { container, rerender } = render(<LinePlot rows={ROWS} series={series} label="R" x={{ kind: 'iterations' }} y={{ scale: 'log' }} />);
    expect([...container.querySelectorAll('.mgk-plot-key')].map((k) => k.textContent)).toEqual(['U', 'p', 'Z']);
    rerender(<LinePlot rows={ROWS} series={series} label="R" x={{ kind: 'iterations' }} y={{ scale: 'log' }} legend={false} />);
    expect(container.querySelector('.mgk-plot-legend')).toBeNull();
  });

  it('labels x in seconds from 0 s to the planned end', () => {
    const { container } = render(<LinePlot rows={SECONDS} series={KIT_SERIES} label="R" x={{ kind: 'seconds', max: 0.1 }} y={{ scale: 'log' }} />);
    const texts = [...container.querySelectorAll('text')].map((t) => t.textContent);
    expect(texts.slice(-2)).toEqual(['0 s', '0.1 s']);
  });

  it('shows the y unit under the y labels on a linear plot', () => {
    const rows = [
      { t: 1, dp: 12 },
      { t: 2, dp: 18 },
    ];
    const { container } = render(<LinePlot rows={rows} series={[{ key: 'dp', label: 'Δp' }]} label="Pressure drop" x={{ kind: 'iterations' }} y={{ scale: 'linear', unit: 'Pa' }} />);
    const unit = [...container.querySelectorAll('text')].find((t) => t.textContent === 'Pa');
    expect(unit?.getAttribute('text-anchor')).toBe('end');
    expect(unit?.getAttribute('y')).toBe('128');
    expect([...container.querySelectorAll('text')].map((t) => t.textContent)).toContain('12.00');
  });

  it('draws nothing before a value can be drawn, as the core plot', () => {
    const { container } = render(<LinePlot rows={[{ t: 1, u: 0 }]} series={KIT_SERIES} label="R" x={{ kind: 'iterations' }} y={{ scale: 'log' }} />);
    expect(container.innerHTML).toBe('');
  });

  for (const [name, rows, seconds] of [
    ['iterations', ROWS, false],
    ['seconds', SECONDS, true],
  ] as const) {
    it(`reads out the hovered row as the core tip does (${name})`, () => {
      const core = render(<div className="core"><ResidualPlot rows={rows} endTime={0} seconds={seconds} series={CORE_SERIES} /></div>);
      const kit = render(
        <LinePlot rows={rows} series={KIT_SERIES} label="R" x={{ kind: seconds ? 'seconds' : 'iterations' }} y={{ scale: 'log' }} />,
      );
      // Away from the right edge, where the kit tip flips and the core tip does not.
      for (const clientX of [40, 100, 150]) {
        hover(core.container.querySelector('.sim-residual-wrap'), clientX);
        hover(kit.container.querySelector('.mgk-plot'), clientX);
        const coreTip = core.container.querySelector('.sim-plot-tip') as HTMLElement;
        const kitTip = kit.container.querySelector('.mgk-plot-tip') as HTMLElement;
        expect(kitTip.hasAttribute('hidden')).toBe(false);
        expect(kitTip.textContent).toBe(coreTip.textContent);
        expect(kitTip.querySelector('b.mgk-plot-tip-head')?.textContent).toBe(coreTip.querySelector('b')?.textContent);
        // The same cursor place, and the same tip place away from the right edge.
        const cursor = kit.container.querySelector('.mgk-plot-cursor') as HTMLElement;
        expect(cursor.style.left).toBe((core.container.querySelector('.sim-plot-cursor') as HTMLElement).style.left);
        expect(kitTip.style.left).toBe(coreTip.style.left);
      }
      const head = (kit.container.querySelector('b.mgk-plot-tip-head') as HTMLElement).textContent;
      expect(head).toMatch(seconds ? /^t = [\d.]+ s$/ : /^Iteration \d+$/);
    });
  }

  it('flips the tip left of the cursor at the right edge', () => {
    const { container } = render(<LinePlot rows={ROWS} series={KIT_SERIES} label="R" x={{ kind: 'iterations' }} y={{ scale: 'log' }} />);
    const plot = container.querySelector('.mgk-plot');
    const tip = () => container.querySelector('.mgk-plot-tip') as HTMLElement;
    const cursorX = () => parseFloat((container.querySelector('.mgk-plot-cursor') as HTMLElement).style.left);
    hover(plot, 60);
    expect(parseFloat(tip().style.left)).toBeCloseTo(cursorX() + 8, 1);
    hover(plot, 290);
    // Row 10 sits at 272 of 280 units: 291.4 px of 300, so a 120 px tip would pass the edge.
    expect(cursorX()).toBeCloseTo(291.4, 1);
    expect(parseFloat(tip().style.left)).toBeCloseTo(cursorX() - 8 - TIP_WIDTH, 1);
  });

  it('hides the cursor and tip when the pointer leaves', () => {
    const { container } = render(<LinePlot rows={ROWS} series={KIT_SERIES} label="R" x={{ kind: 'iterations' }} y={{ scale: 'log' }} />);
    const plot = container.querySelector('.mgk-plot') as HTMLElement;
    hover(plot, 100);
    expect(container.querySelector('.mgk-plot-cursor')?.hasAttribute('hidden')).toBe(false);
    fireEvent.pointerLeave(plot);
    expect(container.querySelector('.mgk-plot-cursor')?.hasAttribute('hidden')).toBe(true);
    expect(container.querySelector('.mgk-plot-tip')?.hasAttribute('hidden')).toBe(true);
    expect(container.querySelector('.mgk-plot-tip')?.textContent).toBe('');
  });

  it('reads dashed series on their own lines, through their format', () => {
    const rows = ROWS.map((r, i) => ({ ...r, co: i / 10 }));
    const series: LineSeries[] = [...KIT_SERIES, { key: 'co', label: 'Co', dashed: true, format: (v) => v.toFixed(2) }];
    const { container } = render(<LinePlot rows={rows} series={series} label="R" x={{ kind: 'iterations' }} y={{ scale: 'log' }} />);
    hover(container.querySelector('.mgk-plot'), 150);
    const tip = container.querySelector('.mgk-plot-tip') as HTMLElement;
    expect(tip.querySelectorAll('br')).toHaveLength(2);
    expect(tip.textContent).toMatch(/^Iteration \d+Co 0\.\d\dU \d\.\de-\d · p /);
  });

  it('takes its own tip', () => {
    const { container } = render(
      <LinePlot rows={ROWS} series={KIT_SERIES} label="R" x={{ kind: 'iterations' }} y={{ scale: 'log' }} tip={(row) => <span>row {row.t}</span>} />,
    );
    hover(container.querySelector('.mgk-plot'), 150);
    expect(container.querySelector('.mgk-plot-tip')?.textContent).toMatch(/^row \d+$/);
  });

  it('reads x from xKey', () => {
    const rows = ROWS.map(({ t, ...rest }) => ({ step: t, ...rest }));
    const { container } = render(<LinePlot rows={rows} series={KIT_SERIES} label="R" xKey="step" x={{ kind: 'iterations' }} y={{ scale: 'log' }} />);
    hover(container.querySelector('.mgk-plot'), 290);
    expect(container.querySelector('.mgk-plot-tip-head')?.textContent).toBe('Iteration 10');
  });

  it('draws a linear x axis with its ticks and grid, below zero too, and hovers by that x', () => {
    const rows = [-4, -2, 0, 2, 4, 6, 8, 10].map((a) => ({ alpha: a, cl: 0.11 * (a + 2) }));
    const { container } = render(
      <LinePlot
        rows={rows}
        series={[{ key: 'cl', label: 'Cl', format: (v) => v.toFixed(3) }]}
        label="Cl against α"
        xKey="alpha"
        x={{ kind: 'linear', label: 'α', format: (v) => `${v}°` }}
        y={{ scale: 'linear' }}
      />,
    );
    const texts = [...container.querySelectorAll('text')].map((t) => t.textContent);
    expect(texts).toEqual(expect.arrayContaining(['-5°', '0°', '5°', '10°']));
    expect(texts).not.toContain('1');
    const xLabels = [...container.querySelectorAll('text')].filter((t) => (t.textContent || '').endsWith('°'));
    expect(xLabels[0].getAttribute('text-anchor')).toBe('start');
    expect(xLabels[xLabels.length - 1].getAttribute('text-anchor')).toBe('end');
    // A vertical grid line per x tick, beside the horizontal ones.
    const vertical = [...container.querySelectorAll('line.mgk-plot-grid')].filter((l) => l.getAttribute('x1') === l.getAttribute('x2'));
    expect(vertical).toHaveLength(4);
    // The left edge is α = −5°, not 0: the nearest row there is −4°.
    hover(container.querySelector('.mgk-plot'), 40);
    expect(container.querySelector('.mgk-plot-tip-head')?.textContent).toBe('α = -4°');
    expect(container.querySelector('.mgk-plot-tip')?.textContent).toContain('Cl -0.220');
    hover(container.querySelector('.mgk-plot'), 299);
    expect(container.querySelector('.mgk-plot-tip-head')?.textContent).toBe('α = 10°');
  });
});
