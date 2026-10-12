// The workspace page build: src/index.html -> workspace/index.html + app.js + app.css.
// React, the bridge and the UI kit are NOT bundled: the host's import map provides
// them in the frame (src/importmap.json is that map). Run `npm run build`.
// SPDX-License-Identifier: GPL-3.0-or-later
import { readFileSync } from 'node:fs';
import { defineConfig } from 'vite';

const HOST_IMPORTS = Object.keys(JSON.parse(readFileSync(new URL('./src/importmap.json', import.meta.url), 'utf8')).imports);

export default defineConfig({
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
