import { afterEach, describe, expect, it } from 'vitest';
import { useProjectStore } from './store/project';
import { analysisMissingText, defaultAnalysisKey, runAnalysisKey, siblingKey } from './analysis';

// The page names no simulation type: the default analysis is the required
// plugin's [default_analysis] (registry.describe), and siblings are found by family.
const fam = (key: string) => ({ key, label: key, title: key, description: '', tags: [], study_name: key });
const rows = [
  { key: 'flow_steady', label: 'Flow', time_dependency: 'steady', family: fam('flow') },
  { key: 'flow_transient', label: 'Flow', time_dependency: 'transient', family: fam('flow') },
  // A family whose keys do not follow the _steady/_transient naming.
  { key: 'heat', label: 'Heat', time_dependency: 'steady', family: fam('heat') },
  { key: 'heat_unsteady', label: 'Heat', time_dependency: 'transient', family: fam('heat') },
  { key: 'lonely_steady', label: 'Lonely', time_dependency: 'steady' },
];

function registry(extra: Record<string, unknown> = {}) {
  useProjectStore.setState({
    registry: {
      analysis: rows,
      default_analysis: { steady: 'flow_steady', transient: 'flow_transient', aliases: ['flow'] },
      ...extra,
    } as never,
  });
}

afterEach(() => useProjectStore.setState({ registry: null }));

describe('analysis keys from the registry', () => {
  it('takes the default analysis from the registry, not a built-in key', () => {
    registry();
    expect(defaultAnalysisKey()).toBe('flow_steady');
    expect(defaultAnalysisKey('Transient')).toBe('flow_transient');
    registry({ default_analysis: null });
    expect(defaultAnalysisKey()).toBe('');
  });

  it('finds siblings by family, and maps blank and old names to the default', () => {
    registry();
    expect(siblingKey('heat', 'Transient')).toBe('heat_unsteady');
    expect(siblingKey('heat_unsteady', 'Steady-state')).toBe('heat');
    expect(siblingKey('', 'Transient')).toBe('flow_transient');
    expect(siblingKey('FLOW', 'Steady-state')).toBe('flow_steady');
    expect(siblingKey('lonely_steady', 'Transient')).toBe('lonely_steady');
  });

  it('gives a clone that kept another analysis family no sibling of its own', () => {
    // A plugin's dataclasses.replace clone keeps the family of what it copied.
    registry({ analysis: [...rows, { key: 'mine', label: 'Mine', time_dependency: 'steady', family: fam('flow') }] });
    expect(siblingKey('mine', 'Transient')).toBe('mine');
    expect(siblingKey('flow_steady', 'Transient')).toBe('flow_transient');
  });

  it('never turns an analysis that is not installed into another one', () => {
    registry();
    expect(siblingKey('gone_steady', 'Transient')).toBe('gone_steady');
    expect(runAnalysisKey({}, 'gone_steady', true)).toBe('gone_steady');
    expect(analysisMissingText('gone_steady', 'run')).toBe(
      "This run's analysis is not available: its plugin is off or did not load.",
    );
    expect(analysisMissingText('heat', 'run')).toBe('');
  });

  it('names the required plugin that failed to load', () => {
    registry({ analysis: [], default_analysis: null, required_missing: [{ key: 'flow', name: 'Flow', error: 'x' }] });
    expect(analysisMissingText(siblingKey('', 'Steady-state'), 'run')).toBe("Flow failed to load, so this run can't start.");
  });

  it('says nothing is missing before the registry has loaded', () => {
    expect(analysisMissingText('flow_steady', 'run')).toBe('');
  });
});
