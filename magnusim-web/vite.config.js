import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { createApiPlugin } from './scripts/server/index.ts';
import { listenPort } from './scripts/prefs.js';
import { verifyWslToolchain } from './scripts/wsl-env.js';
// Projects, Python, caches, results, local OCCT builds and logs (tested in scripts/__tests__).
import { isViteWatchIgnored } from './scripts/vite-watch-ignore.js';
verifyWslToolchain();

const PORT = listenPort();
// Public tunnel host so box bots can open https://simulation.lilmill2000.com/
// MAGNUSIM_ALLOWED_HOSTS still appends extra comma-separated hosts.
const defaultAllowedHosts = ['simulation.lilmill2000.com', '.lilmill2000.com'];
const envHosts = (process.env.MAGNUSIM_ALLOWED_HOSTS || '').split(',').map((s) => s.trim()).filter(Boolean);
const allowedHosts = [...new Set([...defaultAllowedHosts, ...envHosts])];
process.env.MAGNUSIM_BOUND_PORT = String(PORT);
process.env.CFDDESK_BOUND_PORT = String(PORT); // legacy alias

// Same-origin /api/* served by the Vite middleware plugin (projects, geometry,
// mesh generate, post-processing exports via python/.venv + python/tools).
// Server modules under scripts/ are not hot-reloaded: restart the dev server after editing them.

// Steady mode (run.bat sets MAGNUSIM_STEADY=1; `run.bat --live` does not): no file watcher
// and no hot reload, and every app module is compiled once at start (warmup), so a page
// reload serves that same code. Edits made in this checkout while the app runs (other
// work in progress) reach it at its next start, never in the middle of a session.
const STEADY = process.env.MAGNUSIM_STEADY === '1';

export default defineConfig({
  plugins: [react(), createApiPlugin()],
  server: {
    host: '127.0.0.1',
    port: PORT,
    strictPort: true,
    allowedHosts,
    fs: {
      deny: ['.env', '.env.*', '*.{crt,pem,key}', '**/.git/**', '**/projects/**', '**/.cache/**', '**/runs/**', '**/python/**', '**/.*-local.json'],
    },
    hmr: STEADY ? false : undefined,
    watch: STEADY
      ? null
      : {
          usePolling: false,
          // Chokidar passes the file's stats second; only the path is meant here.
          ignored: (filePath) => isViteWatchIgnored(filePath),
        },
    // The app's entry and its two lazy imports; each one's static imports come with it.
    ...(STEADY ? { warmup: { clientFiles: ['./src/app/main.tsx', './src/workbench/runtime.js', './src/workspace/startActions.ts'] } } : {}),
  },
  preview: {
    host: '127.0.0.1',
    port: PORT,
    strictPort: true,
    allowedHosts,
  },
  optimizeDeps: {
    entries: ['index.html', 'src/app/main.tsx'],
    exclude: [],
  },
});
