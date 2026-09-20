// @ts-check
/**
 * Branding rename compat: prefer MAGNUSIM_* env / .magnusim-local.json,
 * fall back to CFDDESK_* / .cfddesk-local.json so mid-flight Vite/Tester keep working.
 */
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

/** Read MAGNUSIM_<suffix> first, then CFDDESK_<suffix>. */
export function envGet(suffix) {
  for (const prefix of ['MAGNUSIM_', 'CFDDESK_']) {
    const v = process.env[prefix + suffix];
    if (v != null && String(v).trim() !== '') return String(v);
  }
  return undefined;
}

/** Prefer .magnusim-local.json; still read .cfddesk-local.json if that is what exists. */
export function resolveLocalJsonPath(webRoot) {
  const override = envGet('LOCAL_JSON');
  if (override) return resolve(override);
  const neu = join(webRoot, '.magnusim-local.json');
  const old = join(webRoot, '.cfddesk-local.json');
  if (existsSync(neu)) return neu;
  if (existsSync(old)) return old;
  return neu;
}

/** Prefer .magnusim-ready; still accept .cfddesk-ready. */
export function resolveReadyStampPath(webRoot) {
  const neu = join(webRoot, '.magnusim-ready');
  const old = join(webRoot, '.cfddesk-ready');
  if (existsSync(neu)) return neu;
  if (existsSync(old)) return old;
  return neu;
}
