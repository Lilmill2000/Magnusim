/**
 * The dev sheet's Data section: LinePlot, ColorLegend and the colour maps,
 * drawn through the kit it is given (the page's copy or the frame's). Every
 * value is fixed: page and frame render at different moments.
 */
import type { CSSProperties } from 'react';
import type { LineSeries } from '../../../plugin-ui';
import { Group, Specimen, type SectionProps } from './Foundation';

type Row = Record<string, number | undefined>;

/** A steady run's residuals: 60 iterations of U, p and k (the LinePlot/log-iterations pair uses them too). */
export const RESIDUAL_ROWS: Row[] = Array.from({ length: 60 }, (_, i) => ({
  t: i + 1,
  u: 0.6 * Math.exp(-i / 9) * (1 + 0.25 * Math.sin(i / 2)),
  p: 0.9 * Math.exp(-i / 14) * (1 + 0.2 * Math.cos(i / 3)),
  k: 0.3 * Math.exp(-i / 7) * (1 + 0.3 * Math.sin(i / 4 + 1)),
}));

/** U, p and k, always listed: the core plot's three solid series. */
export const RESIDUAL_SERIES: LineSeries[] = [
  { key: 'u', label: 'U', legend: 'always' },
  { key: 'p', label: 'p', legend: 'always' },
  { key: 'k', label: 'k', legend: 'always' },
];

/** A transient run: 40 steps of 5 ms toward a 0.25 s end, with its mean Courant number. */
const TRANSIENT_ROWS: Row[] = Array.from({ length: 40 }, (_, i) => ({
  t: Number(((i + 1) * 0.005).toFixed(3)),
  u: 2e-3 * Math.exp(-i / 30) * (1 + 0.4 * Math.sin(i * 0.9)),
  p: 8e-3 * Math.exp(-i / 25) * (1 + 0.3 * Math.cos(i * 0.7)),
  co: 0.35 + 0.15 * (1 - Math.exp(-i / 8)),
}));

const TRANSIENT_SERIES: LineSeries[] = [
  { key: 'u', label: 'U', legend: 'always' },
  { key: 'p', label: 'p', legend: 'always' },
  { key: 'co', label: 'Co mean', dashed: true, format: (v) => v.toFixed(2) },
];

/** A monitor: the pressure drop settling over 50 iterations. */
const MONITOR_ROWS: Row[] = Array.from({ length: 50 }, (_, i) => ({ t: i + 1, dp: 120 + 40 * Math.exp(-i / 8) * Math.cos(i / 3) }));

const MONITOR_SERIES: LineSeries[] = [{ key: 'dp', label: 'Pressure drop', legend: 'always', format: (v) => v.toFixed(1) }];

const BAR: CSSProperties = { display: 'block', height: 12, margin: '2px 0 6px' };

const hex = (t: Uint8Array, i: number) => '#' + [t[i * 3], t[i * 3 + 1], t[i * 3 + 2]].map((b) => b.toString(16).padStart(2, '0')).join('');

export function DataSection({ kit }: SectionProps) {
  const { LinePlot, ColorLegend } = kit;
  return (
    <>
      <Group title="LinePlot">
        <Specimen name="LinePlot/log-iterations" covers="LinePlot" hover>
          <div data-kit-target="1">
            <LinePlot rows={RESIDUAL_ROWS} series={RESIDUAL_SERIES} label="Residuals" x={{ kind: 'iterations' }} y={{ scale: 'log' }} />
          </div>
        </Specimen>
        <Specimen
          name="LinePlot/log-seconds"
          covers="LinePlot"
          hover
          note="No core pair of its own: the same plot as log-iterations, in simulated seconds, with a dashed metric."
        >
          <div data-kit-target="1">
            <LinePlot rows={TRANSIENT_ROWS} series={TRANSIENT_SERIES} label="Residuals" x={{ kind: 'seconds', max: 0.25 }} y={{ scale: 'log' }} />
          </div>
        </Specimen>
        <Specimen
          name="LinePlot/linear"
          covers="LinePlot"
          hover
          note="No core pair: the core's linear graphs (the monitors) are a different, larger chart."
        >
          <div data-kit-target="1">
            <LinePlot rows={MONITOR_ROWS} series={MONITOR_SERIES} label="Pressure drop" x={{ kind: 'iterations' }} y={{ scale: 'linear', unit: 'Pa' }} />
          </div>
        </Specimen>
      </Group>
      <Group title="ColorLegend">
        <Specimen
          name="ColorLegend/rainbow"
          covers="ColorLegend"
          note="No core pair: a new look. The core legend's gradient is hand-picked, not the colours the render draws (ROADMAP)."
        >
          <ColorLegend map="rainbow" min={0} max={12.5} title="Velocity magnitude" unit="m/s" />
        </Specimen>
        <Specimen name="ColorLegend/viridis" covers="ColorLegend">
          <ColorLegend map="viridis" min={293.15} max={353.15} title="Temperature" unit="K" />
        </Specimen>
        <Specimen name="ColorLegend/balance-centred" covers="ColorLegend">
          <ColorLegend map="balance" min={-35} max={120} centred title="Pressure" unit="Pa" />
        </Specimen>
        <Specimen name="ColorLegend/curl" covers="ColorLegend">
          <ColorLegend map="curl" min={-2.5} max={2.5} ticks={3} title="Vorticity z" unit="1/s" />
        </Specimen>
      </Group>
      <Group title="Colour maps">
        <Specimen name="Colormaps/colormapGradient" covers="colormapGradient">
          {kit.COLORMAPS.map((name) => (
            <div key={name}>
              colormapGradient({JSON.stringify(name)})
              <div style={{ ...BAR, background: kit.colormapGradient(name) }} />
            </div>
          ))}
        </Specimen>
        <Specimen name="Colormaps/colormapRgb" covers="colormapRgb">
          {kit.COLORMAPS.map((name) => {
            const t = kit.colormapRgb(name);
            return (
              <div key={name}>
                colormapRgb({JSON.stringify(name)}) → {t.length} bytes, {hex(t, 0)} … {hex(t, 255)}
              </div>
            );
          })}
        </Specimen>
        <Specimen name="Constants/COLORMAPS" covers="COLORMAPS">
          COLORMAPS = {JSON.stringify(kit.COLORMAPS)}
        </Specimen>
        <Specimen name="Constants/RAINBOW_HUE" covers="RAINBOW_HUE">
          RAINBOW_HUE = {kit.RAINBOW_HUE}
        </Specimen>
      </Group>
    </>
  );
}
