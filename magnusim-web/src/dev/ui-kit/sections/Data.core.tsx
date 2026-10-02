/**
 * Page only (page.tsx): the core residual plot beside a kit LinePlot with the
 * same rows and series. The core plot takes no data attributes, so the parts
 * the parity gate compares are named here, by selector, on both sides; the
 * tip only while it shows (the gate hovers both at 30 % of the width).
 */
import { useLayoutEffect, useRef, type ReactNode } from 'react';
import { ResidualPlot, type ResidualSeries } from '../../../panels/run/ResidualPlot';
import { LinePlot } from '../../../plugin-ui';
import { RESIDUAL_ROWS, RESIDUAL_SERIES } from './Data';
import { Group } from './Foundation';
import { CorePair } from './Foundation.core';

// The values of --mg-series-1..3: the colours a kit LinePlot gives its first three series.
const CORE_SERIES: ResidualSeries[] = [
  { key: 'u', label: 'U', color: '#1570ef', always: true },
  { key: 'p', label: 'p', color: '#6941c6', always: true },
  { key: 'k', label: 'k', color: '#12b76a', always: true },
];

type Parts = Readonly<Record<string, string>>;

const CORE_PARTS: Parts = {
  wrap: '.sim-residual-wrap',
  svg: 'svg.sim-residual-plot',
  legend: '.sim-residual-legend',
  swatch: '.sim-swatch',
  line: 'polyline',
  tip: '.sim-plot-tip',
};

const KIT_PARTS: Parts = {
  wrap: '.mgk-plot',
  svg: 'svg.mgk-plot-svg',
  legend: '.mgk-plot-legend',
  swatch: '.mgk-plot-swatch',
  line: 'polyline.mgk-plot-line',
  tip: '.mgk-plot-tip:not([hidden])',
};

/** div.mat-panel-body that marks the first match of each selector with data-kit-part, and keeps the marks current. */
function PartsBody({ parts, children }: { parts: Parts; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const mark = () => {
      for (const [name, selector] of Object.entries(parts)) {
        const want = el.querySelector(selector);
        for (const old of el.querySelectorAll(`[data-kit-part="${name}"]`)) if (old !== want) old.removeAttribute('data-kit-part');
        if (want && want.getAttribute('data-kit-part') !== name) want.setAttribute('data-kit-part', name);
      }
    };
    mark();
    // The tip comes and goes with the hover: added and removed (core), shown and hidden (kit).
    const observer = new MutationObserver(mark);
    observer.observe(el, { childList: true, subtree: true, attributes: true, attributeFilter: ['hidden'] });
    return () => observer.disconnect();
  }, [parts]);
  return (
    <div ref={ref} className="mat-panel-body">
      {children}
    </div>
  );
}

export function DataCore() {
  return (
    <Group title="LinePlot (core, then kit)">
      <CorePair
        pair="LinePlot/log-iterations"
        core={
          <PartsBody parts={CORE_PARTS}>
            <ResidualPlot rows={RESIDUAL_ROWS} endTime={0} seconds={false} series={CORE_SERIES} />
          </PartsBody>
        }
        kit={
          <PartsBody parts={KIT_PARTS}>
            <LinePlot rows={RESIDUAL_ROWS} series={RESIDUAL_SERIES} label="Residuals" x={{ kind: 'iterations' }} y={{ scale: 'log' }} />
          </PartsBody>
        }
      />
    </Group>
  );
}
