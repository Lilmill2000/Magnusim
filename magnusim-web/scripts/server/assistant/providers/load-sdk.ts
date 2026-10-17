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
 *
 * The MCP server package (other apps and coding agents reach Magnusim's tools through
 * it) loads here too, by loadMcpSdk(), with its own state: a missing or broken MCP
 * package never changes depsStatus() for the API-key providers, and a missing provider
 * package never stops the MCP server.
 */
import { readFile } from 'node:fs/promises';
import { dirname, join, parse } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ProviderError } from '../types.ts';

export type SdkName = '@anthropic-ai/sdk' | 'openai';
export const SDK_NAMES: readonly SdkName[] = Object.freeze(['@anthropic-ai/sdk', 'openai']);

/** The MCP server package (its `.` and `./stdio` entries). */
export type McpSdkName = '@modelcontextprotocol/server';
export const MCP_SDK_NAME: McpSdkName = '@modelcontextprotocol/server';

export const DEPS_MISSING_TEXT = "The Assistant's packages aren't installed. Run Setup.bat again.";
export const MCP_DEPS_MISSING_TEXT = "Magnusim's tool-connection package isn't installed. Run Setup.bat again.";

/** Tests only: load a package by another name (one that doesn't exist, to stand in for a missing one). */
const specifiers = new Map<SdkName | McpSdkName, string>();

export function setSdkSpecifierForTests(name: SdkName | McpSdkName, spec: string | null): void {
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

/** The MCP server package's two entries, as loaded (mcp/server.ts reads its classes from them). */
export interface McpSdkModules {
  /** `@modelcontextprotocol/server`: the low-level `Server`. */
  server: Record<string, unknown>;
  /** `@modelcontextprotocol/server/stdio`: `serveStdio` and `StdioServerTransport`. */
  stdio: Record<string, unknown>;
}

/**
 * The MCP server package, by a variable specifier on first use (Node caches it). Missing,
 * broken, or without the classes Magnusim uses: ProviderError('deps_missing') with
 * MCP_DEPS_MISSING_TEXT, and only the MCP server is off.
 */
export async function loadMcpSdk(): Promise<McpSdkModules> {
  const spec: string = specifiers.get(MCP_SDK_NAME) ?? MCP_SDK_NAME;
  const stdioSpec = `${spec}/stdio`;
  let server: Record<string, unknown>;
  let stdio: Record<string, unknown>;
  try {
    server = (await import(spec)) as Record<string, unknown>;
    stdio = (await import(stdioSpec)) as Record<string, unknown>;
  } catch {
    throw new ProviderError('deps_missing', MCP_DEPS_MISSING_TEXT);
  }
  if (typeof server.Server !== 'function' || typeof stdio.serveStdio !== 'function' || typeof stdio.StdioServerTransport !== 'function') {
    throw new ProviderError('deps_missing', MCP_DEPS_MISSING_TEXT);
  }
  return { server, stdio };
}

/** The installed MCP server package's version (null when it is not there), apart from depsStatus(). */
export async function mcpSdkInstalled(): Promise<string | null> {
  return specifiers.has(MCP_SDK_NAME) ? null : sdkInstalled(MCP_SDK_NAME);
}
