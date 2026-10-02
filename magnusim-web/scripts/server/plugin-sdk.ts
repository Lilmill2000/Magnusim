/**
 * The workspace SDK served to plugin frames at /plugin-sdk/ (API 1.1).
 *
 * A workspace frame is its own realm: it gets React as ES modules, one copy
 * shared by `react`, `react-dom/client` and the JSX runtimes (react-all.js,
 * with small facades that re-export its named bindings, since React ships
 * CommonJS only), the bridge (`workspace.js`, from src/plugin-sdk/workspace.ts),
 * the design tokens (`theme.css`: src/theme/tokens.css plus base styles) and
 * the plugin UI kit (`plugin-ui.js` and `plugin-ui.css`, from src/plugin-ui/).
 * The host injects the import map that names them into every workspace page.
 *
 * Built with esbuild on first request and kept in memory, in a development
 * and a production variant (the dev server serves dev, preview serves prod).
 * The dev variant is rebuilt when its sources change; the kit is built apart
 * from React and the bridge, so a kit error does not take those down.
 * `npm run gen:plugin-sdk` builds both as a check and writes what plugin
 * authors build against: docs/plugins/workspace-sdk.d.ts and plugin-ui.d.ts
 * (also served here as workspace.d.ts and plugin-ui.d.ts) and
 * docs/plugins/plugin-sdk.json.
 */
import type { Metafile } from 'esbuild';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { buildKit, bundle, exportNames, newestStamp, type SdkVariant } from './sdk-build.ts';

export type { SdkVariant } from './sdk-build.ts';

/** The bare names a workspace may import, and where the host serves them. */
export const SDK_IMPORTS: Record<string, string> = {
  react: '/plugin-sdk/react.js',
  'react-dom/client': '/plugin-sdk/react-dom-client.js',
  'react/jsx-runtime': '/plugin-sdk/jsx-runtime.js',
  'react/jsx-dev-runtime': '/plugin-sdk/jsx-dev-runtime.js',
  '@magnusim/workspace': '/plugin-sdk/workspace.js',
  '@magnusim/plugin-ui': '/plugin-sdk/plugin-ui.js',
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
  'plugin-ui.js',
  'plugin-ui.css',
  'plugin-ui.d.ts',
] as const;

/** The kit's files: built (and cached) apart from the rest. */
const KIT_FILES: readonly string[] = ['plugin-ui.js', 'plugin-ui.css', 'plugin-ui.d.ts'];

/** The published types of '@magnusim/workspace' (generated; see scripts/gen-plugin-sdk.mjs). */
export function workspaceDtsPath(webRoot: string): string {
  return join(webRoot, 'docs', 'plugins', 'workspace-sdk.d.ts');
}

/** The published types of '@magnusim/plugin-ui' (generated; see scripts/gen-plugin-sdk.mjs). */
export function pluginUiDtsPath(webRoot: string): string {
  return join(webRoot, 'docs', 'plugins', 'plugin-ui.d.ts');
}

/** What a workspace builds against: the bridge and kit versions, the React it gets, the import map. */
export function pluginSdkInfo(webRoot: string): {
  sdk_version: string;
  plugin_ui_version: string;
  react_version: string;
  imports: Record<string, string>;
} {
  const src = readFileSync(join(webRoot, 'src', 'plugin-sdk', 'workspace.ts'), 'utf8');
  const m = src.match(/export const SDK_VERSION = '([^']+)'/);
  if (!m) throw new Error('src/plugin-sdk/workspace.ts has no SDK_VERSION');
  const kitSrc = readFileSync(join(webRoot, 'src', 'plugin-ui', 'version.ts'), 'utf8');
  const k = kitSrc.match(/export const PLUGIN_UI_API_VERSION = '([^']+)'/);
  if (!k) throw new Error('src/plugin-ui/version.ts has no PLUGIN_UI_API_VERSION');
  const req = createRequire(join(webRoot, 'package.json'));
  const react = (req('react/package.json') as { version: string }).version;
  return { sdk_version: m[1], plugin_ui_version: k[1], react_version: react, imports: { ...SDK_IMPORTS } };
}

function facade(binding: string, names: string[], withDefault: boolean): string {
  const lines = [`import { ${binding} as M } from './react-all.js';`];
  if (withDefault) lines.push('export default M;');
  if (names.length) lines.push(`export const { ${names.join(', ')} } = M;`);
  return lines.join('\n') + '\n';
}

/** React and its facades, the bridge, the theme and the bridge's types. */
async function buildCoreSdk(webRoot: string, variant: SdkVariant): Promise<Map<string, string>> {
  const files = new Map<string, string>();
  const reactAll = await bundle(
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
  );
  files.set('react-all.js', reactAll.text);
  files.set('react.js', facade('React', exportNames(webRoot, 'react'), true));
  files.set('react-dom-client.js', facade('ReactDOMClient', exportNames(webRoot, 'react-dom/client'), true));
  files.set('jsx-runtime.js', facade('JSXRuntime', exportNames(webRoot, 'react/jsx-runtime'), false));
  files.set('jsx-dev-runtime.js', facade('JSXDevRuntime', exportNames(webRoot, 'react/jsx-dev-runtime'), false));
  const bridge = await bundle(webRoot, readFileSync(join(webRoot, 'src', 'plugin-sdk', 'workspace.ts'), 'utf8'), variant, 'ts');
  files.set('workspace.js', bridge.text);
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

/** The UI kit: plugin-ui.js and plugin-ui.css (built), plugin-ui.d.ts (from docs). */
async function buildKitSdk(webRoot: string, variant: SdkVariant): Promise<Map<string, string>> {
  const kit = await buildKit(webRoot, variant);
  const files = new Map<string, string>([
    ['plugin-ui.js', kit.js],
    ['plugin-ui.css', kit.css],
  ]);
  const dts = pluginUiDtsPath(webRoot);
  if (existsSync(dts)) files.set('plugin-ui.d.ts', readFileSync(dts, 'utf8'));
  return files;
}

/** Every SDK file for one variant, by file name. */
export async function buildPluginSdk(webRoot: string, variant: SdkVariant): Promise<Map<string, string>> {
  const [core, kit] = await Promise.all([buildCoreSdk(webRoot, variant), buildKitSdk(webRoot, variant)]);
  return new Map([...core, ...kit]);
}

/** What the dev variant is built from: a change in any of these rebuilds it. */
export function devSdkStamp(webRoot: string): string {
  return newestStamp(
    join(webRoot, 'src', 'plugin-ui'),
    join(webRoot, 'src', 'theme'),
    join(webRoot, 'src', 'plugin-sdk'),
    join(webRoot, 'src', 'dev', 'ui-kit'),
    join(webRoot, 'docs', 'plugins'),
  );
}

interface Built {
  stamp: string;
  core?: Promise<Map<string, string>>;
  kit?: Promise<Map<string, string>>;
}

const built = new Map<string, Built>();

/**
 * One SDK file, or null when there is no such file. Prod is built once; dev is
 * rebuilt when devSdkStamp changes (`stamp` replaces it in tests). The kit has
 * its own build, so a kit error fails plugin-ui.* only.
 */
export async function pluginSdkFile(
  webRoot: string,
  variant: SdkVariant,
  name: string,
  stamp?: () => string,
): Promise<string | null> {
  if (!(SDK_FILES as readonly string[]).includes(name)) return null;
  const key = `${variant}|${webRoot}`;
  const now = variant === 'dev' ? (stamp ?? (() => devSdkStamp(webRoot)))() : '';
  let entry = built.get(key);
  if (!entry || entry.stamp !== now) {
    entry = { stamp: now };
    built.set(key, entry);
  }
  const part = KIT_FILES.includes(name) ? 'kit' : 'core';
  let files = entry[part];
  if (!files) {
    const made = part === 'kit' ? buildKitSdk(webRoot, variant) : buildCoreSdk(webRoot, variant);
    const owner = entry;
    owner[part] = made;
    made.catch(() => {
      if (owner[part] === made) owner[part] = undefined;
    });
    files = made;
  }
  return (await files).get(name) ?? null;
}

/** The UI kit dev sheet's frame files: served only by a dev server with VITE_MAGNUSIM_DEV_SHEETS=1. */
export const DEV_SHEET_FILES: readonly string[] = ['ui-kit-sheet.html', 'ui-kit-sheet.js'];

export function devSheetsOn(variant: SdkVariant): boolean {
  return variant === 'dev' && process.env.VITE_MAGNUSIM_DEV_SHEETS === '1';
}

/** The sheet's frame script: src/dev/ui-kit/frame.tsx, every import-map name left to the map. */
export function buildUiKitSheetJs(webRoot: string): Promise<{ text: string; metafile: Metafile }> {
  return bundle(webRoot, "import './src/dev/ui-kit/frame.tsx';", 'dev', 'ts', { external: Object.keys(SDK_IMPORTS) });
}

let sheetJs: { key: string; text: Promise<string> } | null = null;

/** A dev sheet file's text (the HTML before the host's head is injected), or null. */
export async function devSheetFile(webRoot: string, name: string, stamp?: () => string): Promise<string | null> {
  if (name === 'ui-kit-sheet.html') return readFileSync(join(webRoot, 'src', 'dev', 'ui-kit', 'sheet.html'), 'utf8');
  if (name !== 'ui-kit-sheet.js') return null;
  const key = `${webRoot}|${(stamp ?? (() => devSdkStamp(webRoot)))()}`;
  let current = sheetJs;
  if (!current || current.key !== key) {
    const mine = { key, text: buildUiKitSheetJs(webRoot).then((r) => r.text) };
    sheetJs = current = mine;
    mine.text.catch(() => {
      if (sheetJs === mine) sheetJs = null;
    });
  }
  return current.text;
}
