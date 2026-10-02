import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { colormapGradient } from '../colormaps';
import { formatSci } from '../format/sci';
import { ColorLegend, legendTicks } from './ColorLegend';

const ticksOf = (c: HTMLElement) => [...c.querySelectorAll('.mgk-legend-ticks > span')].map((s) => s.textContent);

describe('ColorLegend', () => {
  it('draws a title, the bar and the ticks with kit classes', () => {
    const { container } = render(<ColorLegend map="viridis" min={0} max={2} title="Speed" unit="m/s" />);
    const root = container.firstElementChild as HTMLElement;
    expect(root.className).toBe('mgk-type mgk-legend');
    expect([...root.children].map((c) => c.className)).toEqual(['mgk-legend-title', 'mgk-legend-bar', 'mgk-legend-ticks']);
    expect(root.querySelector('.mgk-legend-title')?.textContent).toBe('Speed (m/s)');
  });

  it("paints the bar with the map's own table (colormapGradient)", () => {
    for (const map of ['rainbow', 'viridis', 'balance', 'curl'] as const) {
      const { container, unmount } = render(<ColorLegend map={map} min={0} max={1} />);
      const bar = container.querySelector('.mgk-legend-bar') as HTMLElement;
      // jsdom keeps the gradient as written; compare the stops, colours in hex or rgb.
      const style = bar.getAttribute('style') || '';
      const want = colormapGradient(map);
      const stops = (s: string) =>
        [...s.matchAll(/#([0-9a-f]{6})|rgb\((\d+), (\d+), (\d+)\)/g)].map((m) =>
          m[1] ? m[1] : [m[2], m[3], m[4]].map((v) => Number(v).toString(16).padStart(2, '0')).join(''),
        );
      expect(stops(style), map).toEqual(stops(want));
      expect(stops(want)).toHaveLength(33);
      unmount();
    }
  });

  it('shows 5 ticks by default, ends included, through formatSci', () => {
    const { container } = render(<ColorLegend map="rainbow" min={0} max={101325} />);
    expect(ticksOf(container)).toEqual([0, 25331.25, 50662.5, 75993.75, 101325].map((v) => formatSci(v)));
    expect(ticksOf(container)).toEqual(['0', '25331.3', '50662.5', '75993.8', '101325']);
  });

  it('takes a tick count and a format', () => {
    const { container } = render(<ColorLegend map="viridis" min={1} max={3} ticks={3} format={(v) => `${v.toFixed(1)} K`} />);
    expect(ticksOf(container)).toEqual(['1.0 K', '2.0 K', '3.0 K']);
  });

  it('centres the range on 0 for a diverging map', () => {
    const { container } = render(<ColorLegend map="balance" min={-2} max={8} centred />);
    expect(ticksOf(container)).toEqual(['-8', '-4', '0', '4', '8']);
    expect(legendTicks(-5, 1, 3, true)).toEqual([-5, 0, 5]);
    expect(legendTicks(-5, 1, 3, false)).toEqual([-5, -2, 1]);
  });

  it('shows the title or the unit alone, and no title row without either', () => {
    expect(render(<ColorLegend map="curl" min={0} max={1} title="Vorticity" />).container.querySelector('.mgk-legend-title')?.textContent).toBe('Vorticity');
    expect(render(<ColorLegend map="curl" min={0} max={1} unit="1/s" />).container.querySelector('.mgk-legend-title')?.textContent).toBe('1/s');
    expect(render(<ColorLegend map="curl" min={0} max={1} />).container.querySelector('.mgk-legend-title')).toBeNull();
  });

  it('keeps at least the two ends', () => {
    expect(legendTicks(0, 1, 1, false)).toEqual([0, 1]);
    expect(legendTicks(0, 1, 0, false)).toEqual([0, 1]);
  });
});
