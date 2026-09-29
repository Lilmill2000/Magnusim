/**
 * Incompressible Flow's panels: the study settings (turbulence model, time
 * dependency, algorithm, steady SIMPLE numerics) and the run settings
 * (iterations, or simulation time, result frames and the PIMPLE time step).
 * The core draws the chrome around them: title, Start, progress, Done/Delete.
 */
import type { PluginHost } from '../../../src/plugins/loader';
import { setHost } from './host';
import { RunSettings } from './RunSettings';
import { StudySettings } from './StudySettings';

/** The names the analysis contract's `ui` publishes (incompressible_flow.contract.UI). */
export const STUDY_SETTINGS = 'incompressible_flow.study';
export const RUN_SETTINGS = 'incompressible_flow.run';

export function register(host: PluginHost): void {
  setHost(host);
  host.pluginUi.registerStudySettings(STUDY_SETTINGS, StudySettings);
  host.pluginUi.registerRunSettings(RUN_SETTINGS, RunSettings);
}
