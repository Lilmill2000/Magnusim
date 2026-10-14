// Types of cad-preview.mjs for TypeScript e2e files (CAD's own Playwright).
// SPDX-License-Identifier: GPL-3.0-or-later
import type { APIRequestContext, APIResponse } from '@playwright/test';

/** GET `url` until the answer is not 202 "being prepared" (at most `timeout` ms): that response. */
export function cadPreviewReady(request: APIRequestContext, url: string, timeout?: number): Promise<APIResponse>;
