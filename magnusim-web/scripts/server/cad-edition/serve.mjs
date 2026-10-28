/**
 * Magnusim CAD's server: the app's API (createApiPlugin, unchanged) on plain node:http,
 * with no Vite config, no Python and no WSL.
 *
 *   node scripts/server/cad-edition/serve.mjs [--port N] [--dev | --static DIR]
 *
 * It sets MAGNUSIM_EDITION=cad and installs the spawn guard (./spawn-guard.js) before
 * it loads the server, so the API's worker is the JavaScript one (node-worker.ts) and
 * nothing it loads can start Python or WSL. --static serves a built page (the desktop
 * app's), --dev the page from source (Vite, cad.html); with neither only the API answers. The desktop shell and the tests call
 * startCadServer() instead.
 */
import { createServer } from 'node:http';
import { createReadStream, existsSync, readFileSync, statSync } from 'node:fs';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

process.env.MAGNUSIM_EDITION = 'cad';
// w21-mesh-generate.js calls wslDistro() when it is imported, and wsl-env.js then runs
// `wsl printenv HOME` unless a case root is set. Magnusim CAD has no cases, so this root is
// never used; it only keeps that probe from running (wsl-env.js is left as it is).
// cad-edition-server.test.js fails if starting the server spawns WSL or Python.
process.env.MAGNUSIM_WSL_CASE_ROOT ||= '/home/cfddesk/cases';
const { installSpawnGuard } = await import('./spawn-guard.js');
installSpawnGuard();
const { createApiPlugin } = await import('../index.ts');
const { stampAppearance } = await import('../../prefs.js');

const WEB_ROOT = resolve(fileURLToPath(new URL('../../..', import.meta.url)));

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.wasm': 'application/wasm',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

/** The connect-style stack a Vite plugin's configureServer expects (middlewares.use). */
function middlewareStack() {
  const stack = [];
  return {
    use(fn) {
      stack.push(fn);
    },
    handle(req, res, done) {
      let i = 0;
      const next = (err) => {
        if (err) return done(err);
        const fn = stack[i++];
        if (!fn) return done();
        try {
          const out = fn(req, res, next);
          if (out && typeof out.catch === 'function') out.catch(next);
        } catch (e) {
          next(e);
        }
      };
      next();
    },
  };
}

function serveStatic(root, req, res) {
  const url = new URL(req.url || '/', 'http://localhost');
  let rel = decodeURIComponent(url.pathname);
  if (rel.endsWith('/')) rel += 'index.html';
  const file = normalize(join(root, rel));
  if (file !== root && !file.startsWith(root + sep)) return false;
  const hit = existsSync(file) && statSync(file).isFile() ? file : join(root, 'index.html');
  if (!existsSync(hit)) return false;
  res.statusCode = 200;
  res.setHeader('Content-Type', TYPES[extname(hit).toLowerCase()] || 'application/octet-stream');
  // The page carries the person's look for its first paint (prefs.js stampAppearance).
  if (extname(hit).toLowerCase() === '.html') res.end(stampAppearance(readFileSync(hit, 'utf8')));
  else createReadStream(hit).pipe(res);
  return true;
}

/**
 * The page from source, as `npm run dev` serves Magnusim's: Vite in middleware mode, with
 * cad.html (the CAD edition's entry) at `/`. No hot reload: restart to see an edit. Vite's
 * client socket shares this server's port (it would open one of its own on 24678).
 */
async function devPage(webRoot, httpServer) {
  const [{ createServer: createVite }, { default: react }] = await Promise.all([import('vite'), import('@vitejs/plugin-react')]);
  const vite = await createVite({
    configFile: false,
    root: webRoot,
    appType: 'custom',
    plugins: [react()],
    server: { middlewareMode: true, hmr: { server: httpServer }, watch: null },
    optimizeDeps: { entries: ['cad.html', 'src/app/main-cad.tsx'] },
    logLevel: 'warn',
  });
  return {
    middlewares: vite.middlewares,
    async html(url) {
      const raw = readFileSync(join(webRoot, 'cad.html'), 'utf8');
      return stampAppearance(await vite.transformIndexHtml(url, raw));
    },
    close: () => vite.close(),
  };
}

/**
 * Start the server; resolves with its port and a close().
 * `dev` serves the page from source (Vite); `staticDir` a built page; neither: the API only.
 * @param {{ port?: number, host?: string, staticDir?: string, dev?: boolean }} [opts]
 */
export async function startCadServer(opts = {}) {
  const host = opts.host || '127.0.0.1';
  const staticDir = opts.staticDir ? resolve(opts.staticDir) : '';
  const middlewares = middlewareStack();
  const httpServer = createServer((req, res) => {
    middlewares.handle(req, res, (err) => {
      if (err) {
        res.statusCode = 500;
        res.end(String(err && err.message ? err.message : err));
        return;
      }
      if (staticDir && (req.method === 'GET' || req.method === 'HEAD') && serveStatic(staticDir, req, res)) return;
      res.statusCode = 404;
      res.end('not found');
    });
  });
  const page = opts.dev ? await devPage(WEB_ROOT, httpServer) : null;
  if (page) {
    middlewares.use(async (req, res, next) => {
      const path = new URL(req.url || '/', 'http://localhost').pathname;
      if (req.method !== 'GET' || (path !== '/' && path !== '/index.html' && path !== '/cad.html')) return next();
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.end(await page.html(req.url || '/'));
    });
  }
  await new Promise((ok, fail) => {
    httpServer.once('error', fail);
    httpServer.listen(opts.port || 0, host, () => ok(undefined));
  });
  const port = /** @type {import('node:net').AddressInfo} */ (httpServer.address()).port;
  process.env.MAGNUSIM_BOUND_PORT = String(port);
  const api = createApiPlugin();
  if (page) {
    api.configureServer({ middlewares, httpServer });
    // After the API: Vite answers the page's modules and assets.
    middlewares.use(page.middlewares);
  } else {
    api.configurePreviewServer({ middlewares, httpServer });
  }
  return {
    port,
    close: async () => {
      await page?.close();
      await new Promise((ok) => httpServer.close(() => ok(undefined)));
    },
  };
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const arg = (name) => {
    const i = process.argv.indexOf(name);
    return i > 0 ? process.argv[i + 1] : undefined;
  };
  const { port } = await startCadServer({
    port: Number(arg('--port') || 0),
    staticDir: arg('--static'),
    dev: process.argv.includes('--dev'),
  });
  console.log(`Magnusim CAD server on http://127.0.0.1:${port}/`);
}
