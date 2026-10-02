/**
 * Build code shared by the workspace SDK (plugin-sdk.ts) and the plugin UI
 * bundler (plugin-ui-bundle.ts). It imports only esbuild and node: modules;
 * both of those import it and neither imports the other.
 *
 * The plugin UI kit (src/plugin-ui/) is built here for frames: plugin-ui.js
 * with React left to the import map, and plugin-ui.css from kit.css.
 */
import { build, type Metafile } from 'esbuild';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';

export type SdkVariant = 'dev' | 'prod';

/** The stdin entry's name in a metafile; the kit checks skip it by this exact name. */
export const SDK_ENTRY_NAME = 'plugin-sdk-entry';

/** What the kit leaves to its host: React (a frame's import map, or the page's shims). */
export const KIT_EXTERNAL = ['react', 'react/jsx-runtime', 'react/jsx-dev-runtime', 'react-dom', 'react-dom/client'];

const KIT_ENTRY = "export * from './src/plugin-ui/index.ts';";

const IDENT = /^[A-Za-z_$][\w$]*$/;

/** The named exports of a package as Node loads it (development build: a superset of production). */
export function exportNames(webRoot: string, mod: string): string[] {
  const req = createRequire(join(webRoot, 'package.json'));
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

function stampOne(dir: string): string {
  let newest = 0;
  let count = 0;
  let bytes = 0;
  const walk = (d: string) => {
    for (const name of readdirSync(d)) {
      if (name === 'node_modules' || name.startsWith('.')) continue;
      const p = join(d, name);
      const st = statSync(p);
      if (st.isDirectory()) walk(p);
      else {
        count += 1;
        bytes += st.size;
        newest = Math.max(newest, st.mtimeMs);
      }
    }
  };
  if (existsSync(dir)) walk(dir);
  return `${newest}:${count}:${bytes}`;
}

/** Changes when a file in any of these folders changes (a missing folder counts as empty). */
export function newestStamp(...dirs: string[]): string {
  return dirs.map(stampOne).join('|');
}

export interface BundleOptions {
  /** Bare names left as imports (resolved by the import map at run time). */
  external?: string[];
}

/** One ES module from `contents` (resolved from the web root), with its metafile. */
export async function bundle(
  webRoot: string,
  contents: string,
  variant: SdkVariant,
  loader: 'js' | 'ts',
  opts: BundleOptions = {},
): Promise<{ text: string; metafile: Metafile }> {
  const out = await build({
    stdin: { contents, resolveDir: webRoot, loader, sourcefile: SDK_ENTRY_NAME },
    // Metafile paths are relative to this, whatever folder the process runs in.
    absWorkingDir: webRoot,
    bundle: true,
    format: 'esm',
    platform: 'browser',
    target: 'es2020',
    jsx: 'automatic',
    external: opts.external ?? [],
    metafile: true,
    write: false,
    minify: variant === 'prod',
    // Keep licence notices (React's @license, the colour maps' sources) at the end of the file.
    legalComments: 'eof',
    define: { 'process.env.NODE_ENV': JSON.stringify(variant === 'prod' ? 'production' : 'development') },
    logLevel: 'silent',
  });
  return { text: out.outputFiles[0].text, metafile: out.metafile };
}

/** src/plugin-ui/kit.css with its @import list resolved. */
async function buildKitCss(webRoot: string, variant: SdkVariant): Promise<string> {
  const out = await build({
    entryPoints: [join(webRoot, 'src', 'plugin-ui', 'kit.css')],
    absWorkingDir: webRoot,
    bundle: true,
    write: false,
    minify: variant === 'prod',
    logLevel: 'silent',
  });
  return out.outputFiles[0].text;
}

/** The kit for frames: plugin-ui.js (React external) and plugin-ui.css. */
export async function buildKit(
  webRoot: string,
  variant: SdkVariant,
): Promise<{ js: string; css: string; metafile: Metafile }> {
  const [js, css] = await Promise.all([
    bundle(webRoot, KIT_ENTRY, variant, 'ts', { external: KIT_EXTERNAL }),
    buildKitCss(webRoot, variant),
  ]);
  return { js: js.text, css, metafile: js.metafile };
}

/** The export names of the one output in a metafile, sorted. */
export function metafileExports(metafile: Metafile): string[] {
  const output = Object.values(metafile.outputs)[0];
  return [...(output?.exports ?? [])].sort();
}

const kitNames = new Map<string, { stamp: string; names: Promise<string[]> }>();

/**
 * The kit's runtime export names, from a build of the kit alone (they do not
 * depend on the variant). Kept until a file in src/plugin-ui changes; a failed
 * build rejects and is not kept.
 */
export function kitExportNames(webRoot: string): Promise<string[]> {
  const stamp = newestStamp(join(webRoot, 'src', 'plugin-ui'));
  const hit = kitNames.get(webRoot);
  if (hit && hit.stamp === stamp) return hit.names;
  const names = bundle(webRoot, KIT_ENTRY, 'dev', 'ts', { external: KIT_EXTERNAL }).then((r) => metafileExports(r.metafile));
  kitNames.set(webRoot, { stamp, names });
  names.catch(() => {
    if (kitNames.get(webRoot)?.names === names) kitNames.delete(webRoot);
  });
  return names;
}
