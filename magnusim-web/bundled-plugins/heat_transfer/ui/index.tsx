/**
 * Heat Transfer's panels: the study settings (gravity, density, operating
 * pressure, temperatures, turbulence, time dependency, numerics, and which
 * solver runs) and the run settings (iterations, or simulation time and result
 * frames; "Stop when a monitor settles"). The BC editor draws the Thermal
 * fields from the analyses' bc_fields with the core's form; the core draws the
 * chrome around both panels.
 */
import type { PluginHost } from '../../../src/plugins/loader';
import { setHost } from './host';
import { RunSettings } from './RunSettings';
import { StudySettings } from './StudySettings';

/** The names the analysis contract's `ui` publishes (heat_transfer.contract.UI). */
export const STUDY_SETTINGS = 'heat_transfer.study';
export const RUN_SETTINGS = 'heat_transfer.run';

export function register(host: PluginHost): void {
  setHost(host);
  host.pluginUi.registerStudySettings(STUDY_SETTINGS, StudySettings);
  host.pluginUi.registerRunSettings(RUN_SETTINGS, RunSettings);
}
