// The broken-manifest e2e check (cad-p1-document.spec.js) breaks this plugin's
// manifest.toml in place for one test. A copy of the real file is kept in
// .cache/ first, and every e2e run restores it before anything starts, so a run
// that was stopped mid-test never leaves a broken manifest behind.
// SPDX-License-Identifier: GPL-3.0-or-later
import { copyFileSync, existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const PLUGIN_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const MANIFEST = join(PLUGIN_DIR, 'manifest.toml');
const BACKUP = join(PLUGIN_DIR, '.cache', 'e2e-manifest-backup.toml');

/** Put the real manifest back if a run stopped while it was broken. Returns true when it did. */
export function restoreManifestIfLeft() {
  if (!existsSync(BACKUP)) return false;
  copyFileSync(BACKUP, MANIFEST);
  unlinkSync(BACKUP);
  return true;
}

/** Break manifest.toml (a line that is not TOML). Returns restore(), which puts the real file back. */
export function breakManifest() {
  restoreManifestIfLeft();
  const good = readFileSync(MANIFEST);
  mkdirSync(dirname(BACKUP), { recursive: true });
  writeFileSync(BACKUP, good);
  writeFileSync(MANIFEST, `${good.toString('utf8')}\nthis line is not TOML [\n`);
  return () => {
    writeFileSync(MANIFEST, good);
    if (existsSync(BACKUP)) unlinkSync(BACKUP);
    return readFileSync(MANIFEST).equals(good);
  };
}
