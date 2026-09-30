/**
 * The workspace SDK served to plugin frames at /plugin-sdk/ (API 1.1).
 *
 * A workspace frame is its own realm: it gets React as ES modules, one copy
 * shared by `react`, `react-dom/client` and the JSX runtimes (react-all.js,
 * with small facades that re-export its named bindings, since React ships
 * CommonJS only), the bridge (`workspace.js`, from src/plugin-sdk/workspace.ts)
 * and the design tokens (`theme.css`: src/theme/tokens.css plus base styles).
 * The host injects the import map that names them into every workspace page.
 *
 * Built with esbuild on first request and kept in memory, in a development
 * and a production variant (the dev server serves dev, preview serves prod).
 * `npm run gen:plugin-sdk` builds both as a check and writes what plugin
 * authors build against: docs/plugins/workspace-sdk.d.ts (also served here as
 * workspace.d.ts) and docs/plugins/plugin-sdk.json.
 */
import { build } from 'esbuild';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';

export type SdkVariant = 'dev' | 'prod';

/** The bare names a workspace may import, and where the host serves them. */
export const SDK_IMPORTS: Record<string, string> = {
  react: '/plugin-sdk/react.js',
  'react-dom/client': '/plugin-sdk/react-dom-client.js',
  'react/jsx-runtime': '/plugin-sdk/jsx-runtime.js',
  'react/jsx-dev-runtime': '/plugin-sdk/jsx-dev-runtime.js',
  '@magnusim/workspace': '/plugin-sdk/workspace.js',
};

export const SDK_FILES = [
  'react-all.js',
  'react.js',
  'react-dom-client.js',
  'jsx-runtime.js',
  'jsx-dev-runtime.js',
  'workspace.js',
  'workspace.d.ts',
  'theme.css',
] as const;

/** The published types of '@magnusim/workspace' (generated; see scripts/gen-plugin-sdk.mjs). */
export function workspaceDtsPath(webRoot: string): string {
  return join(webRoot, 'docs', 'plugins', 'workspace-sdk.d.ts');
}

/** What a workspace builds against: the bridge version, the React it gets, the import map. */
export function pluginSdkInfo(webRoot: string): { sdk_version: string; react_version: string; imports: Record<string, string> } {
  const src = readFileSync(join(webRoot, 'src', 'plugin-sdk', 'workspace.ts'), 'utf8');
  const m = src.match(/export const SDK_VERSION = '([^']+)'/);
  if (!m) throw new Error('src/plugin-sdk/workspace.ts has no SDK_VERSION');
  const req = createRequire(join(webRoot, 'package.json'));
  const react = (req('react/package.json') as { version: string }).version;
  return { sdk_version: m[1], react_version: react, imports: { ...SDK_IMPORTS } };
}

const IDENT = /^[A-Za-z_$][\w$]*$/;

function exportNames(webRoot: string, mod: string): string[] {
  const req = createRequire(join(webRoot, 'package.json'));
  // Development build: it exports what production does, plus the dev-only helpers.
  const prev = process.env.NODE_ENV;
  process.env.NODE_ENV = 'development';
  try {
    return Object.keys(req(mod) as object)
      .filter((k) => k !== 'default' && IDENT.test(k))
      .sort();
  } finally {
    if (prev == null) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = prev;
  }
}

function facade(binding: string, names: string[], withDefault: boolean): string {
  const lines = [`import { ${binding} as M } from './react-all.js';`];
  if (withDefault) lines.push('export default M;');
  if (names.length) lines.push(`export const { ${names.join(', ')} } = M;`);
  return lines.join('\n') + '\n';
}

async function bundle(webRoot: string, contents: string, variant: SdkVariant, loader: 'js' | 'ts'): Promise<string> {
  const out = await build({
    stdin: { contents, resolveDir: webRoot, loader, sourcefile: 'plugin-sdk-entry' },
    bundle: true,
    format: 'esm',
    platform: 'browser',
    target: 'es2020',
    write: false,
    minify: variant === 'prod',
    legalComments: 'none',
    define: { 'process.env.NODE_ENV': JSON.stringify(variant === 'prod' ? 'production' : 'development') },
    logLevel: 'silent',
  });
  return out.outputFiles[0].text;
}

/** Every SDK file for one variant, by file name. */
export async function buildPluginSdk(webRoot: string, variant: SdkVariant): Promise<Map<string, string>> {
  const files = new Map<string, string>();
  files.set(
    'react-all.js',
    await bundle(
      webRoot,
      [
        "import * as ReactNS from 'react';",
        "import * as ReactDOMClientNS from 'react-dom/client';",
        "import * as JSXNS from 'react/jsx-runtime';",
        "import * as JSXDevNS from 'react/jsx-dev-runtime';",
        'export const React = ReactNS.default || ReactNS;',
        'export const ReactDOMClient = ReactDOMClientNS.default || ReactDOMClientNS;',
        'export const JSXRuntime = JSXNS.default || JSXNS;',
        'export const JSXDevRuntime = JSXDevNS.default || JSXDevNS;',
      ].join('\n'),
      variant,
      'js',
    ),
  );
  files.set('react.js', facade('React', exportNames(webRoot, 'react'), true));
  files.set('react-dom-client.js', facade('ReactDOMClient', exportNames(webRoot, 'react-dom/client'), true));
  files.set('jsx-runtime.js', facade('JSXRuntime', exportNames(webRoot, 'react/jsx-runtime'), false));
  files.set('jsx-dev-runtime.js', facade('JSXDevRuntime', exportNames(webRoot, 'react/jsx-dev-runtime'), false));
  files.set(
    'workspace.js',
    await bundle(webRoot, readFileSync(join(webRoot, 'src', 'plugin-sdk', 'workspace.ts'), 'utf8'), variant, 'ts'),
  );
  files.set(
    'theme.css',
    readFileSync(join(webRoot, 'src', 'theme', 'tokens.css'), 'utf8') +
      '\n' +
      readFileSync(join(webRoot, 'src', 'plugin-sdk', 'base.css'), 'utf8'),
  );
  const dts = workspaceDtsPath(webRoot);
  if (existsSync(dts)) files.set('workspace.d.ts', readFileSync(dts, 'utf8'));
  return files;
}

const built = new Map<SdkVariant, Promise<Map<string, string>>>();

/** One SDK file (built once per variant, then from memory); null when there is no such file. */
export async function pluginSdkFile(webRoot: string, variant: SdkVariant, name: string): Promise<string | null> {
  if (!(SDK_FILES as readonly string[]).includes(name)) return null;
  let files = built.get(variant);
  if (!files) {
    files = buildPluginSdk(webRoot, variant);
    built.set(variant, files);
    files.catch(() => built.delete(variant));
  }
  return (await files).get(name) ?? null;
}
