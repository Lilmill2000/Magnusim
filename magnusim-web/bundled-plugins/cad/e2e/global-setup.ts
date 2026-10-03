// Starts (or reuses) the host server once for the run; tests read CAD_E2E_BASE_URL.
// First puts back manifest.toml if an earlier run stopped while its broken-manifest
// check had it broken (e2e/manifest-guard.mjs).
// SPDX-License-Identifier: GPL-3.0-or-later
import { readLiveLock, startHostServer } from './host-server.mjs';
import { restoreManifestIfLeft } from './manifest-guard.mjs';

export default async function globalSetup(): Promise<() => Promise<void>> {
  if (restoreManifestIfLeft()) console.log('[cad-e2e] restored manifest.toml left broken by a stopped run');
  if (process.env.CAD_E2E_BASE_URL) {
    console.log(`[cad-e2e] using ${process.env.CAD_E2E_BASE_URL}`);
    // A server named by the lock as well: its prefs file too (the off-by-default and contention tests need it).
    if (!process.env.CAD_E2E_PREFS && process.env.CAD_E2E_LOCK) {
      const live = await readLiveLock(process.env.CAD_E2E_LOCK);
      if (live?.prefs && live.base.replace(/\/$/, '') === process.env.CAD_E2E_BASE_URL.replace(/\/$/, '')) process.env.CAD_E2E_PREFS = live.prefs;
    }
    return async () => {};
  }
  const server = await startHostServer({ log: (m: string) => console.log(`[cad-e2e] ${m}`) });
  process.env.CAD_E2E_BASE_URL = server.base;
  // The off-by-default test puts CAD back to a fresh install's state (no choice remembered).
  if (server.prefs) process.env.CAD_E2E_PREFS = server.prefs;
  return async () => {
    server.stop();
  };
}
