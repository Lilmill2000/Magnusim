/**
 * The one place the provider SDKs are loaded (scripts/__tests__/assistant-boundaries.test.mjs).
 *
 * By a variable specifier, on first use: Vite's config bundler resolves a literal bare
 * specifier when it bundles the server, so a copy without the packages would not start
 * at all. A missing or broken package becomes ProviderError('deps_missing'), and the rest
 * of the app runs on.
 *
 * sdkInstalled() reads node_modules/<name>/package.json directly, walking up from this
 * file (never through require.resolve: a package's exports map may not list its
 * package.json), so the status route can say whether the packages are there without
 * loading them.
 */
import { readFile } from 'node:fs/promises';
import { dirname, join, parse } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ProviderError } from '../types.ts';

export type SdkName = '@anthropic-ai/sdk' | 'openai';
export const SDK_NAMES: readonly SdkName[] = Object.freeze(['@anthropic-ai/sdk', 'openai']);

export const DEPS_MISSING_TEXT = "The Assistant's packages aren't installed. Run Setup.bat again.";

/** Tests only: load a package by another name (one that doesn't exist, to stand in for a missing one). */
const specifiers = new Map<SdkName, string>();

export function setSdkSpecifierForTests(name: SdkName, spec: string | null): void {
  if (spec === null) specifiers.delete(name);
  else specifiers.set(name, spec);
}

/** The SDK's module namespace. Node caches it, so only the first call loads anything. */
export async function loadSdk(name: SdkName): Promise<Record<string, unknown>> {
  const spec: string = specifiers.get(name) ?? name;
  try {
    return (await import(spec)) as Record<string, unknown>;
  } catch {
    throw new ProviderError('deps_missing', DEPS_MISSING_TEXT);
  }
}

/** The SDK's class: the module's default export (or its named one). */
export async function loadSdkClass<T>(name: SdkName, named: string): Promise<T> {
  const mod = await loadSdk(name);
  const cls = (mod.default ?? mod[named]) as T | undefined;
  if (typeof cls !== 'function') throw new ProviderError('deps_missing', DEPS_MISSING_TEXT);
  return cls;
}

const HERE = dirname(fileURLToPath(import.meta.url));

/** The installed version of `name`, found by folder from this file upward; null when it is not there. */
export async function sdkInstalled(name: string, from: string = HERE): Promise<string | null> {
  let dir = from;
  const root = parse(dir).root;
  for (;;) {
    try {
      const doc = JSON.parse(await readFile(join(dir, 'node_modules', ...name.split('/'), 'package.json'), 'utf8')) as { version?: unknown };
      if (typeof doc.version === 'string' && doc.version) return doc.version;
    } catch {
      /* not here: look one folder up */
    }
    if (dir === root) return null;
    const up = dirname(dir);
    if (up === dir) return null;
    dir = up;
  }
}

/** Whether both SDKs are installed (status `deps`), with the versions found. */
export async function depsStatus(): Promise<{ state: 'ok' | 'missing'; versions: Record<string, string | null> }> {
  const versions: Record<string, string | null> = {};
  for (const name of SDK_NAMES) versions[name] = specifiers.has(name) ? null : await sdkInstalled(name);
  return { state: Object.values(versions).every(Boolean) ? 'ok' : 'missing', versions };
}
