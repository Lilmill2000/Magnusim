/**
 * Plugin UI written in TypeScript/TSX, bundled when it is served.
 *
 * A plugin's UI entry may be `.tsx`/`.ts`/`.jsx`: the host bundles it (and the
 * plugin's own files it imports) into one ES module. `react` resolves to the
 * host's React (the page's single copy, set by the plugin loader), so a
 * plugin's components share the app's hooks and context; `@magnusim/plugin-ui`
 * resolves to the page's UI kit the same way. A plugin UI may import only
 * `react`, `@magnusim/plugin-ui` and files inside its own `ui` folder;
 * type-only imports (the host API types) are erased.
 */
import { createHash } from 'node:crypto';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { exportNames, kitExportNames, newestStamp } from './sdk-build.ts';

export const BUNDLED_UI = /\.(tsx|ts|jsx)$/;

/** This checkout's web root (magnusim-web/). */
const WEB_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

// Every name React exports, read from the React the host bundles.
function hostReact(names: string[]): string {
  return [
    'const R = globalThis.__MAGNUSIM_HOST_REACT__;',
    "if (!R) throw new Error('plugin UI loaded before the host provided React');",
    'export default R;',
    names.length ? `export const { ${names.join(', ')} } = R;` : '',
    '',
  ].join('\n');
}

// The page's UI kit (set by the plugin loader); the names are the kit's runtime exports.
function hostKit(names: string[]): string {
  return [
    'const K = globalThis.__MAGNUSIM_HOST_KIT__;',
    "if (!K) throw new Error('plugin UI loaded before the host provided the UI kit');",
    names.length ? `export const { ${names.join(', ')} } = K;` : '',
    '',
  ].join('\n');
}

// The automatic JSX runtime on the host's React (createElement takes children in props).
const HOST_JSX = `
const R = globalThis.__MAGNUSIM_HOST_REACT__;
if (!R) throw new Error('plugin UI loaded before the host provided React');
export const Fragment = R.Fragment;
export function jsx(type, props, key) {
  return R.createElement(type, key === undefined ? props : { ...props, key });
}
export const jsxs = jsx;
export const jsxDEV = jsx;
`;

/** kitKey: null when the bundle did not import the kit, else a hash of the kit names it used. */
const cache = new Map<string, { stamp: string; kitKey: string | null; code: string }>();

function namesKey(names: string[]): string {
  return createHash('sha256').update(names.join('\n')).digest('hex');
}

function inside(child: string, parent: string): boolean {
  const rel = relative(parent, child);
  return !!rel && !rel.startsWith('..') && !isAbsolute(rel);
}

export interface BundlePluginUiOptions {
  /** The web root whose React and kit the shims name (default: this checkout's). */
  webRoot?: string;
  /** The kit's runtime export names (default: kitExportNames(webRoot)); asked only when the UI imports the kit. */
  kitNames?: () => Promise<string[]>;
}

/**
 * One ES module for the entry, rebuilt when a file in the plugin's ui folder
 * changes, or, for a UI that imports the kit, when the kit's export names do.
 */
export async function bundlePluginUi(entry: string, uiRoot: string, opts: BundlePluginUiOptions = {}): Promise<string> {
  const webRoot = opts.webRoot ?? WEB_ROOT;
  const kitNames = opts.kitNames ?? (() => kitExportNames(webRoot));
  const stamp = newestStamp(uiRoot);
  const hit = cache.get(entry);
  if (hit && hit.stamp === stamp && (hit.kitKey === null || hit.kitKey === namesKey(await kitNames()))) return hit.code;
  let kitKey: string | null = null;
  const esbuild = await import('esbuild');
  const result = await esbuild.build({
    entryPoints: [entry],
    bundle: true,
    write: false,
    format: 'esm',
    platform: 'browser',
    target: 'es2022',
    jsx: 'automatic',
    sourcemap: 'inline',
    logLevel: 'silent',
    plugins: [
      {
        name: 'magnusim-plugin-ui',
        setup(build) {
          build.onResolve({ filter: /^react$/ }, () => ({ path: 'react', namespace: 'magnusim-host' }));
          build.onResolve({ filter: /^react\/jsx(-dev)?-runtime$/ }, () => ({ path: 'jsx', namespace: 'magnusim-host' }));
          build.onResolve({ filter: /^@magnusim\/plugin-ui$/ }, () => ({ path: 'kit', namespace: 'magnusim-host' }));
          build.onLoad({ filter: /.*/, namespace: 'magnusim-host' }, async (args) => {
            if (args.path === 'jsx') return { contents: HOST_JSX, loader: 'js' };
            if (args.path === 'kit') {
              // Only a UI that imports the kit waits for (and depends on) the kit's names.
              const names = await kitNames();
              kitKey = namesKey(names);
              return { contents: hostKit(names), loader: 'js' };
            }
            return { contents: hostReact(exportNames(webRoot, 'react')), loader: 'js' };
          });
          build.onResolve({ filter: /.*/ }, (args) => {
            if (args.kind === 'entry-point') return undefined;
            if (!/^\.{1,2}\//.test(args.path)) {
              return {
                errors: [{ text: `plugin UI may import only react, @magnusim/plugin-ui and its own files, not ${args.path}` }],
              };
            }
            const target = resolve(args.resolveDir, args.path);
            if (!inside(target, uiRoot)) {
              return { errors: [{ text: `plugin UI import leaves its ui folder: ${args.path}` }] };
            }
            return undefined;
          });
        },
      },
    ],
  });
  const code = new TextDecoder().decode(result.outputFiles[0].contents);
  cache.set(entry, { stamp, kitKey, code });
  return code;
}
