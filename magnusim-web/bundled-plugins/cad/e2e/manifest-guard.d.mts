// Types of manifest-guard.mjs for the TypeScript e2e files.
// SPDX-License-Identifier: GPL-3.0-or-later
export const MANIFEST: string;
export function restoreManifestIfLeft(): boolean;
export function breakManifest(): () => boolean;
