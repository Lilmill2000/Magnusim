// Types of page-styles.mjs for TypeScript e2e files (CAD's own Playwright).
// SPDX-License-Identifier: GPL-3.0-or-later
// `page` is a Playwright Page (typed `object`: CAD's @playwright/test is a copy of its own).
export interface StyleWatch {
  navigations: number;
  checked: number;
  failures: Map<string, string>;
  reload: ((options?: object) => Promise<unknown>) | null;
  guarded: boolean;
}
/** The page's stylesheet watch (its main frame's new documents, why a stylesheet request failed), made at the first call. */
export function watchStyles(page: object): StyleWatch;
/** Why a test stops on an unstyled page. */
export function unstyledMessage(what: string, opts?: { afterReload?: boolean }): string;
/**
 * The app page's own stylesheets applied (one evaluate per document); if not, reload once,
 * and throw when it is still unstyled. 'reloaded': wait for the app again.
 */
export function ensureStyled(page: object, opts?: { reload?: boolean; log?: (line: string) => void }): Promise<'styled' | 'reloaded' | 'unknown'>;
/** ensureStyled after each page.goto / page.reload of `page` that waits for the load. */
export function guardNavigations<P extends object>(page: P): P;
/** `base` (a Playwright `test`) with each page of the test's context guarded. */
export function withStyleGuard<T>(base: T): T;
