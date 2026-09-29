/**
 * Plugin UI written in TypeScript/TSX, bundled when it is served.
 *
 * A plugin's UI entry may be `.tsx`/`.ts`/`.jsx`: the host bundles it (and the
 * plugin's own files it imports) into one ES module. `react` resolves to the
 * host's React (the page's single copy, set by the plugin loader), so a
 * plugin's components share the app's hooks and context. A plugin UI may
 * import only `react` and files inside its own `ui` folder; type-only imports
 * (the host API types) are erased.
 */
import { readdirSync, statSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';

export const BUNDLED_UI = /\.(tsx|ts|jsx)$/;

const HOST_REACT = `
const R = globalThis.__MAGNUSIM_HOST_REACT__;
if (!R) throw new Error('plugin UI loaded before the host provided React');
export default R;
export const {
  Children, Fragment, createContext, createElement, forwardRef, memo, useCallback, useContext,
  useEffect, useId, useLayoutEffect, useMemo, useReducer, useRef, useState, useSyncExternalStore,
} = R;
`;

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

const cache = new Map<string, { stamp: string; code: string }>();

function newestStamp(dir: string): string {
  let newest = 0;
  let count = 0;
  const walk = (d: string) => {
    for (const name of readdirSync(d)) {
      if (name === 'node_modules' || name.startsWith('.')) continue;
      const p = join(d, name);
      const st = statSync(p);
      if (st.isDirectory()) walk(p);
      else {
        count += 1;
        newest = Math.max(newest, st.mtimeMs);
      }
    }
  };
  walk(dir);
  return `${newest}:${count}`;
}

function inside(child: string, parent: string): boolean {
  const rel = relative(parent, child);
  return !!rel && !rel.startsWith('..') && !isAbsolute(rel);
}

/** One ES module for the entry, rebuilt when a file in the plugin's ui folder changes. */
export async function bundlePluginUi(entry: string, uiRoot: string): Promise<string> {
  const stamp = newestStamp(uiRoot);
  const hit = cache.get(entry);
  if (hit && hit.stamp === stamp) return hit.code;
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
          build.onLoad({ filter: /.*/, namespace: 'magnusim-host' }, (args) => ({
            contents: args.path === 'jsx' ? HOST_JSX : HOST_REACT,
            loader: 'js',
          }));
          build.onResolve({ filter: /.*/ }, (args) => {
            if (args.kind === 'entry-point') return undefined;
            if (!/^\.{1,2}\//.test(args.path)) {
              return { errors: [{ text: `plugin UI may import only react and its own files, not ${args.path}` }] };
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
  cache.set(entry, { stamp, code });
  return code;
}
