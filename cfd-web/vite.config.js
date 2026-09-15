import { defineConfig } from 'vite';
import { caseFieldsApiPlugin } from './scripts/vite-plugin-case-fields.js';
import { listenPort } from './scripts/prefs.js';

const PORT = listenPort();
process.env.CFDDESK_BOUND_PORT = String(PORT);

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
  plugins: [caseFieldsApiPlugin()],
  server: {
    host: '127.0.0.1',
    port: PORT,
    strictPort: true,
    allowedHosts: ['simulation.lilmill2000.com', '.lilmill2000.com'],
    watch: {
      usePolling: false,
      ignored: isViteWatchIgnored,
    },
  },
  preview: {
    host: '127.0.0.1',
    port: PORT,
    strictPort: true,
    allowedHosts: ['simulation.lilmill2000.com', '.lilmill2000.com'],
  },
  optimizeDeps: {
    exclude: [],
  },
});
