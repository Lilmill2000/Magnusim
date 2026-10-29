/**
 * Where the Assistant keeps its files (Foundation spec 3.1). Nothing is computed when
 * this module loads: each call reads the environment, and the stores keep the path they
 * got at their first call.
 *
 *   <home>/secrets     master.json, keys.json   (the encrypted provider keys)
 *   <home>/assistant   settings.json, spend.json
 *
 * <home> is MAGNUSIM_ASSISTANT_HOME when set; else, beside MAGNUSIM_LOCAL_JSON (every node
 * test and e2e server sets that, so no test reaches this PC's real folder); else the
 * user's own application-data folder, outside the install folder.
 */
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';

export interface HomeOptions {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  /** The user's home folder (os.homedir() when left out). */
  home?: string;
}

/** MAGNUSIM_<suffix>, else the legacy CFDDESK_<suffix> (scripts/env-compat.js envGet). */
function envOf(env: NodeJS.ProcessEnv, suffix: string): string | undefined {
  for (const prefix of ['MAGNUSIM_', 'CFDDESK_']) {
    const v = env[prefix + suffix];
    if (v != null && String(v).trim() !== '') return String(v);
  }
  return undefined;
}

/**
 * True when the home comes from MAGNUSIM_ASSISTANT_HOME or MAGNUSIM_LOCAL_JSON (a test or dev
 * folder); never in an installed app (MAGNUSIM_PACKAGED, set by desktop/config.mjs serverEnv).
 */
export function assistantHomeIsOverridden(o: HomeOptions = {}): boolean {
  const env = o.env ?? process.env;
  // An installed app's local.json home is the person's real folder, never a test one.
  if (String(env.MAGNUSIM_PACKAGED ?? '').trim() !== '') return false;
  return !!(envOf(env, 'ASSISTANT_HOME') || envOf(env, 'LOCAL_JSON'));
}

export function assistantHome(o: HomeOptions = {}): string {
  const env = o.env ?? process.env;
  const platform = o.platform ?? process.platform;
  const override = envOf(env, 'ASSISTANT_HOME');
  if (override) return resolve(override);
  const local = envOf(env, 'LOCAL_JSON');
  if (local) {
    const p = resolve(local);
    return join(dirname(p), basename(p).replace(/\.json$/i, '') + '.assistant');
  }
  const home = o.home ?? homedir();
  if (platform === 'win32') return join(env.APPDATA || join(home, 'AppData', 'Roaming'), 'Magnusim');
  if (platform === 'darwin') return join(home, 'Library', 'Application Support', 'Magnusim');
  return join(env.XDG_CONFIG_HOME || join(home, '.config'), 'magnusim');
}

/** master.json and keys.json. */
export function secretsDir(o: HomeOptions = {}): string {
  return join(assistantHome(o), 'secrets');
}

/** settings.json and spend.json. */
export function assistantDataDir(o: HomeOptions = {}): string {
  return join(assistantHome(o), 'assistant');
}
