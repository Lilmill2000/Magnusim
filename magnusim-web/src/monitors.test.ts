import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { MonitorQuantity, RegistryRow, RunMonitor } from './api/registry.gen';
import {
  LEGACY_MONITOR_QUANTITIES,
  balanceSummary,
  defaultQuantity,
  detailRows,
  directionSuffix,
  formatMonitorValue,
  monitorCsv,
  monitorQuantities,
  monitorTypes,
  monitorsCsv,
  plotQuantities,
  resolveMonitorType,
  summaryOf,
  summaryText,
  tipLines,
} from './monitors';

const qs = LEGACY_MONITOR_QUANTITIES;
const q = (key: string) => qs.find((x) => x.key === key) as MonitorQuantity;

const inlet: RunMonitor = {
  key: 'mon_inlet',
  patch: 'inlet',
  name: 'Inlet',
  bc_type: 'Velocity inlet',
  default_quantity: 'Umag',
  series: [
    { t: 1, U: [2, 0, 0], Umag: 2, p_Pa: 0.6, Q_m3s: -0.01, Un_m_s: -1, mdot_kgs: -0.012 },
    { t: 2, U: [3, 4, 0], Umag: 5, p_Pa: 0.3, Q_m3s: -0.02, Un_m_s: -2, mdot_kgs: -0.024 },
  ],
};
const probe: RunMonitor = {
  key: 'rc_outlet_probe',
  name: 'Outlet probe',
  default_quantity: 'p',
  series: [{ t: 2, U: [1, 2, 2], Umag: 3, p_Pa: 135.7, Q_m3s: null, Un_m_s: null, mdot_kgs: null }],
};

describe('the API 1.1 quantity table', () => {
  it('is the table Incompressible Flow declares (docs/plugins/registry.json)', () => {
    const reg = JSON.parse(readFileSync('docs/plugins/registry.json', 'utf8')) as { analysis: RegistryRow[] };
    for (const row of reg.analysis.filter((r) => r.plugin === 'incompressible_flow')) {
      expect(row.monitor_quantities).toEqual(qs);
    }
  });

  it('is used when neither the answer nor the analysis names quantities', () => {
    const own = [{ ...q('p'), key: 'T', label: 'Temperature' }];
    expect(monitorQuantities({ quantities: own }, [q('Umag')])).toBe(own);
    expect(monitorQuantities({ quantities: [] }, own)).toBe(own);
    expect(monitorQuantities({}, null)).toBe(qs);
    expect(monitorQuantities(null)).toBe(qs);
  });
});

describe('values as the monitor cards show them', () => {
  it('switches flows to L/s and g/s below 0.01', () => {
    expect(formatMonitorValue(q('Q'), 0.004)).toBe('4.00 L/s');
    expect(formatMonitorValue(q('Q'), -0.0004)).toBe('0.400 L/s');
    expect(formatMonitorValue(q('Q'), 0.25)).toBe('0.2500 m³/s');
    expect(formatMonitorValue(q('mdot'), 0.0048)).toBe('4.800 g/s');
    expect(formatMonitorValue(q('mdot'), -1.5)).toBe('1.5000 kg/s');
  });

  it('shows pressure whole from 100 Pa, else one decimal; velocities with three digits', () => {
    expect(formatMonitorValue(q('p'), 135.7)).toBe('136 Pa');
    expect(formatMonitorValue(q('p'), -12.34)).toBe('-12.3 Pa');
    expect(formatMonitorValue(q('Umag'), 5)).toBe('5.00 m/s');
    expect(formatMonitorValue(q('Ux'), -0.25)).toBe('-0.250 m/s');
    expect(formatMonitorValue(q('Umag'), null)).toBe('—');
  });

  it('names the direction from the sign of the flow', () => {
    expect(directionSuffix(q('Q'), { Q_m3s: -0.02 })).toBe(' in');
    expect(directionSuffix(q('Un'), { Q_m3s: 0.02 })).toBe(' out');
    expect(directionSuffix(q('Un'), { Q_m3s: null })).toBe('');
    expect(directionSuffix(q('p'), { Q_m3s: -1 })).toBe('');
  });

  it('opens a plot on the row default, offering only plotted quantities', () => {
    expect(plotQuantities(qs).map((x) => x.label)).toEqual(['Pressure', 'Mean velocity', 'Velocity X', 'Velocity Y', 'Velocity Z']);
    expect(defaultQuantity(inlet, qs)).toBe('Umag');
    expect(defaultQuantity(probe, qs)).toBe('p');
    expect(defaultQuantity({ default_quantity: 'Q' }, qs)).toBe('p');
  });

  it('lists the details of the latest point that has them', () => {
    expect(detailRows(inlet, qs)).toEqual([
      ['Pressure', '0.3 Pa'],
      ['Mean velocity', '5.00 m/s'],
      ['Velocity X', '3.00 m/s'],
      ['Velocity Y', '4.00 m/s'],
      ['Velocity Z', '0 m/s'],
      ['Normal velocity', '2.00 m/s in'],
      ['Flow rate', '0.0200 m³/s in'],
      ['Mass flow', '0.0240 kg/s'],
    ]);
    expect(detailRows(probe, qs).map((r) => r[0])).toEqual(['Pressure', 'Mean velocity', 'Velocity X', 'Velocity Y', 'Velocity Z']);
  });

  it('reads the plotted quantity, then the other headline quantities, on hover', () => {
    const lines = tipLines(qs, 'Umag', inlet.series![1]);
    expect(lines).toEqual([
      { label: 'Mean velocity', value: '5.00 m/s', chosen: true },
      { label: 'Pressure', value: '0.3 Pa', chosen: false },
      { label: 'Flow rate', value: '0.0200 m³/s in', chosen: false },
    ]);
  });
});

describe('the summary line', () => {
  it('reads "Flow in … · out … · imbalance …" from an API 1.1 balance', () => {
    const { items, warn } = balanceSummary({ in_m3s: 0.03, out_m3s: 0.033, imbalance: 0.1 });
    expect(warn).toBe(true);
    expect(summaryText(items, qs)).toBe('Flow in 0.0300 m³/s · out 0.0330 m³/s · imbalance 10.00 %');
    expect(summaryText(balanceSummary({ in_m3s: 2, out_m3s: 2, imbalance: 0.00001 }).items, qs)).toBe(
      'Flow in 2.0000 m³/s · out 2.0000 m³/s · imbalance < 0.01 %',
    );
    expect(balanceSummary({ in_m3s: 0, out_m3s: 0, imbalance: null })).toEqual({ items: [], warn: false });
    expect(balanceSummary(null)).toEqual({ items: [], warn: false });
  });

  it("prefers the answer's own summary", () => {
    const answer = {
      summary: [{ label: 'Heat in', value: 12.5, quantity: '', unit: 'W' }],
      summary_warn: false,
      balance: { in_m3s: 1, out_m3s: 1, imbalance: 0 },
    };
    const { items, warn } = summaryOf(answer);
    expect(warn).toBe(false);
    expect(summaryText(items, qs)).toBe('Heat in 12.5 W');
    expect(summaryText(summaryOf({ balance: { in_m3s: 1, out_m3s: 1.5, imbalance: 0.5 } }).items, qs)).toMatch(
      /^Flow in .+ · out .+ · imbalance .+/,
    );
  });
});

describe('CSV exports', () => {
  it("one monitor: every exported quantity's column, signed, with no density in the core", () => {
    const csv = monitorCsv(inlet, qs, false).split('\n');
    expect(csv[0]).toBe('iteration,pressure_Pa,mean_velocity_m_s,Ux_m_s,Uy_m_s,Uz_m_s,Un_m_s,flow_m3_s,mass_kg_s');
    expect(csv[2]).toBe('2,0.3,5,3,4,0,-2,-0.02,-0.024');
    expect(monitorCsv(probe, qs, true).split('\n')[1]).toBe('2,135.7,3,1,2,2,,,');
  });

  it('every monitor: number quantities as shown, per monitor', () => {
    const csv = monitorsCsv([inlet, probe], qs, false).split('\n');
    expect(csv[0]).toBe(
      [
        'iteration',
        ...['Inlet', 'Outlet probe'].flatMap((n) =>
          ['Pressure [Pa]', 'Mean velocity [m/s]', 'Normal velocity [m/s]', 'Flow rate [m³/s]', 'Mass flow [kg/s]'].map((c) => n + ' ' + c),
        ),
      ]
        .map((h) => '"' + h + '"')
        .join(','),
    );
    expect(csv).toHaveLength(3);
    expect(csv[2]).toBe('2,0.3,5,2,0.02,0.024,135.7,3,,,');
  });
});

describe('monitor types', () => {
  const types: RegistryRow[] = [
    { key: 'area_average', label: 'Area average', aliases: ['Area average', 'Surface data'], user_creatable: true },
    { key: 'flow_rate', label: 'Flow rate', aliases: [], user_creatable: false },
  ];

  it('offers the types a user may add', () => {
    expect(monitorTypes(types).map((t) => t.key)).toEqual(['area_average']);
    expect(monitorTypes(types, { key: 'a', label: 'A', monitors: ['flow_rate'] } as RegistryRow & { monitors: string[] })).toEqual([]);
    expect(monitorTypes(null)).toEqual([]);
  });

  it('reads the type of a saved record, older ones by their names', () => {
    const creatable = monitorTypes(types);
    expect(resolveMonitorType({ monitor_type: 'area_average', name: 'Outlet probe' }, creatable)?.key).toBe('area_average');
    // Saved before monitor types: kind is dropped on disk, category survives.
    expect(resolveMonitorType({ category: 'Surface data', name: 'Outlet probe' }, creatable)?.key).toBe('area_average');
    expect(resolveMonitorType({ kind: 'Area average', name: 'Probe' }, creatable)?.key).toBe('area_average');
    expect(resolveMonitorType({ name: 'area AVERAGE 2' }, creatable)?.key).toBe('area_average');
    expect(resolveMonitorType({ name: 'Cut plane 1', category: 'Volume' }, creatable)).toBeNull();
    expect(resolveMonitorType({ monitor_type: 'missing_type', category: 'Surface data' }, creatable)).toBeNull();
    expect(resolveMonitorType(null, creatable)).toBeNull();
  });
});
