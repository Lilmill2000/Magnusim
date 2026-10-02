import { describe, expect, it } from 'vitest';
import {
  isPluginResultsKey,
  PLUGIN_RESULTS_KEY_RE,
  pluginResultsAutosaveAllowed,
  pluginResultsDisplayScale,
  pluginResultsMatch,
  pluginResultsRecord,
  pluginResultsShowsCad,
  pluginResultsShowsCompare,
  pluginResultsShowsViews,
  type PluginResultsInfo,
} from './pluginResultsRules';

const info: PluginResultsInfo = {
  key: 'pf-0123456789ab',
  projectId: 'geometry-remove-e2e',
  caseDir: 'C:/projects/geometry-remove-e2e/plugins/foam-demo/studies/st-1/cases/c2',
  plugin: 'foam-demo',
  pluginName: 'Foam demo',
  studyId: 'st-1',
  studyTitle: 'Cavity case 1',
  caseRel: 'cases/c2',
  app: 'pimpleFoam',
  timeDependency: 'transient',
  times: ['0.1', '0.2', '0.3', '0.4', '0.5'],
};

describe('plugin results keys', () => {
  it("are 'pf-' and 12 hex, never a core run's id", () => {
    expect(isPluginResultsKey('pf-0123456789ab')).toBe(true);
    expect(PLUGIN_RESULTS_KEY_RE.test('pf-0123456789ab')).toBe(true);
    expect(isPluginResultsKey('pf-0123456789AB')).toBe(false);
    expect(isPluginResultsKey('pf-0123')).toBe(false);
    expect(isPluginResultsKey('run-1')).toBe(false);
    expect(isPluginResultsKey('09cec168')).toBe(false);
    expect(isPluginResultsKey('')).toBe(false);
    expect(isPluginResultsKey(null)).toBe(false);
    expect(isPluginResultsKey(42)).toBe(false);
  });
});

describe('pluginResultsRecord', () => {
  it('is a finished run with results, no core study, and the plugin case it came from', () => {
    expect(pluginResultsRecord(info, { projectId: 'geometry-remove-e2e' })).toEqual({
      id: 'pf-0123456789ab',
      run_id: 'pf-0123456789ab',
      project_id: 'geometry-remove-e2e',
      simulation_id: null,
      name: 'Foam demo \u{203A} Cavity case 1',
      status: 'done',
      has_results: true,
      n_saved_times: 5,
      last_saved_iteration: 0.5,
      case_dir: info.caseDir,
      path_kind: 'pimpleFoam',
      time_dependency: 'transient',
      plugin_case: { plugin: 'foam-demo', study_id: 'st-1', case_rel: 'cases/c2' },
    });
  });

  it('reads anything but transient as steady, and names by key and id when titles are missing', () => {
    const rec = pluginResultsRecord({ ...info, pluginName: '', studyTitle: null, timeDependency: 'Steady-state', times: [] });
    expect(rec).toMatchObject({
      name: 'foam-demo \u{203A} st-1',
      time_dependency: 'steady',
      n_saved_times: 0,
      last_saved_iteration: 0,
    });
    expect(pluginResultsRecord({ ...info, timeDependency: undefined })?.time_dependency).toBe('steady');
    expect(pluginResultsRecord({ ...info, timeDependency: 'Transient' })?.time_dependency).toBe('transient');
  });

  it('refuses another project, a bad key or missing fields', () => {
    expect(pluginResultsRecord(info, { projectId: 'no-geometry-e2e' })).toBeNull();
    expect(pluginResultsRecord({ ...info, key: 'run-1' })).toBeNull();
    expect(pluginResultsRecord({ ...info, caseDir: '' })).toBeNull();
    expect(pluginResultsRecord({ ...info, projectId: '' })).toBeNull();
    expect(pluginResultsRecord({ ...info, plugin: '' })).toBeNull();
    expect(pluginResultsRecord({ ...info, studyId: ' ' })).toBeNull();
    expect(pluginResultsRecord(null)).toBeNull();
  });

  it('answers only its own key', () => {
    const rec = pluginResultsRecord(info);
    expect(pluginResultsMatch(rec, 'pf-0123456789ab')).toBe(true);
    expect(pluginResultsMatch(rec, 'pf-ba9876543210')).toBe(false);
    expect(pluginResultsMatch(rec, 'run-1')).toBe(false);
    expect(pluginResultsMatch(null, 'pf-0123456789ab')).toBe(false);
  });
});

describe('while plugin results show', () => {
  it('nothing autosaves into a run doc: there is none', () => {
    expect(pluginResultsAutosaveAllowed('pf-0123456789ab')).toBe(false);
    expect(pluginResultsAutosaveAllowed('run-1')).toBe(true);
    expect(pluginResultsAutosaveAllowed(null)).toBe(true);
  });

  it('saved Views are hidden', () => {
    expect(pluginResultsShowsViews('pf-0123456789ab')).toBe(false);
    expect(pluginResultsShowsViews('run-1')).toBe(true);
    expect(pluginResultsShowsViews('')).toBe(true);
  });

  it('Compare and the CAD are hidden, and come back when they end', () => {
    const rec = pluginResultsRecord(info);
    expect(pluginResultsShowsCompare(rec)).toBe(false);
    expect(pluginResultsShowsCad(rec)).toBe(false);
    expect(pluginResultsShowsCompare(null)).toBe(true);
    expect(pluginResultsShowsCad(null)).toBe(true);
  });

  it('the case is drawn at scale 1, not scaled to the CAD', () => {
    expect(pluginResultsDisplayScale(pluginResultsRecord(info))).toBe(1);
    expect(pluginResultsDisplayScale(null)).toBeNull();
  });
});
