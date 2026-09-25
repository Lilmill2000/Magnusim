import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { createApiPlugin } from './scripts/server/index.ts';
import { listenPort } from './scripts/prefs.js';
import { verifyWslToolchain } from './scripts/wsl-env.js';
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

// Chokidar on Windows will sit on a core if it walks projects/, python/, or
// caches. A function ignore is reliable with backslashes; globs alone are not.
function isViteWatchIgnored(filePath) {
  const p = String(filePath || '').replace(/\\/g, '/').toLowerCase();
  if (
    p.includes('/node_modules/') ||
    p.endsWith('/node_modules') ||
    p.includes('/.git/') ||
    p.includes('/projects/') ||
    // Playwright's projects root; a watched run folder blocks the live-sync rename from WSL.
    p.includes('/.tmp-projects/') ||
    p.includes('/.cache/') ||
    p.includes('/python/') ||
    p.includes('/dist/') ||
    p.includes('hexcore-process-backup')
  ) {
    return true;
  }
  return /\.(vtp|vtu|vtk|vtm|foam|bin|stl|step|stp|png|jpe?g|webp|mp4|webm)$/i.test(p);
}

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
    watch: {
      usePolling: false,
      ignored: isViteWatchIgnored,
    },
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
