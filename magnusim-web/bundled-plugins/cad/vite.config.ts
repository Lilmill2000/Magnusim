// The workspace page build: src/index.html -> workspace/index.html + app.js + app.css.
// React, the bridge and the UI kit are NOT bundled: the host's import map
// provides them in the frame (react, react-dom/client, react/jsx-runtime,
// @magnusim/workspace, @magnusim/plugin-ui; host API 1.3).
// Worker modules are built separately by scripts/build.mjs. Run `npm run build`.
// SPDX-License-Identifier: GPL-3.0-or-later
import { defineConfig } from 'vite';

export const HOST_IMPORTS = ['react', 'react-dom/client', 'react/jsx-runtime', 'react/jsx-dev-runtime', '@magnusim/workspace', '@magnusim/plugin-ui'];

export default defineConfig({
  root: 'src',
  base: './',
  publicDir: false,
  logLevel: 'warn',
  esbuild: { jsx: 'automatic', legalComments: 'none' },
  build: {
    outDir: '../workspace',
    // workspace/ also holds the kernel and solver artifacts: scripts/build.mjs
    // removes only what this build writes.
    emptyOutDir: false,
    target: 'es2022',
    sourcemap: false,
    minify: 'esbuild',
    reportCompressedSize: false,
    modulePreload: { polyfill: false },
    chunkSizeWarningLimit: 2000,
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
