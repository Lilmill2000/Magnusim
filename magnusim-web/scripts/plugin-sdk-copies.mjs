/**
 * The copies of '@magnusim/workspace''s generated types that plugins in this
 * repo build against. scripts/gen-plugin-sdk.mjs writes each one with the same
 * text as docs/plugins/workspace-sdk.d.ts, and its --check fails when one is
 * missing or differs, so a copy can't drift from the SDK the host serves.
 * Pure, so scripts/__tests__/plugin-sdk-copies.test.mjs can show a stale copy
 * fail.
 */
// SPDX-License-Identifier: GPL-3.0-or-later
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Paths from the web root, '/'-separated. Tunnel2d's types/workspace-sdk.d.ts
 * is still copied by hand.
 */
export const WORKSPACE_DTS_COPIES = ['bundled-plugins/cad/src/types/workspace-sdk.d.ts'];

/** Where the copy `rel` is under `webRoot`. */
export function copyPath(webRoot, rel) {
  return join(webRoot, ...rel.split('/'));
}

/** The copies that are missing or whose text is not `text` (a CRLF checkout of the same text is current). */
export function staleCopies(webRoot, copies, text) {
  return copies.filter((rel) => {
    const path = copyPath(webRoot, rel);
    return !existsSync(path) || readFileSync(path, 'utf8').replace(/\r\n/g, '\n') !== text;
  });
}
