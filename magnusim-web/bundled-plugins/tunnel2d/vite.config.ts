// The workspace page build: src/index.html -> workspace/index.html + app.js + app.css.
// React, the bridge and the UI kit are NOT bundled: the host's import map provides
// them in the frame (src/importmap.json is that map). Run `npm run build`.
// The sketch solver (PlaneGCS: the worker, its glue and wasm) is copied from the CAD
// plugin's build into workspace/solver/: the frame may only load this plugin's files.
// SPDX-License-Identifier: GPL-3.0-or-later
import { copyFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { defineConfig, type Plugin } from 'vite';

const SOLVER_FILES = ['solver-worker.js', 'planegcs.mjs', 'planegcs.wasm'];

function copySolver(): Plugin {
  return {
    name: 'tunnel2d-copy-solver',
    closeBundle() {
      const from = new URL('../cad/workspace/solver/', import.meta.url);
      const to = new URL('./workspace/solver/', import.meta.url);
      mkdirSync(to, { recursive: true });
      for (const f of SOLVER_FILES) {
        const src = new URL(f, from);
        if (!existsSync(src)) throw new Error(`The CAD plugin's ${f} is missing (bundled-plugins/cad/workspace/solver/): the sketch solver cannot be copied.`);
        copyFileSync(src, new URL(f, to));
      }
    },
  };
}

const HOST_IMPORTS = Object.keys(JSON.parse(readFileSync(new URL('./src/importmap.json', import.meta.url), 'utf8')).imports);

export default defineConfig({
  plugins: [copySolver()],
  root: 'src',
  base: './',
  publicDir: false,
  logLevel: 'warn',
  esbuild: { jsx: 'automatic', legalComments: 'none' },
  build: {
    outDir: '../workspace',
    emptyOutDir: true,
    target: 'es2022',
    sourcemap: false,
    minify: 'esbuild',
    reportCompressedSize: false,
    modulePreload: { polyfill: false },
    rollupOptions: {
      external: HOST_IMPORTS,
      output: {
        entryFileNames: 'app.js',
        chunkFileNames: 'chunks/[name].js',
        assetFileNames: (info) => (info.names?.some((n) => n.endsWith('.css')) ? 'app.css' : 'assets/[name][extname]'),
      },
    },
  },
});
