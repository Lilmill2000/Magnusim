/**
 * Magnusim CAD's server: the app's API (createApiPlugin, unchanged) on plain node:http,
 * with no Vite config, no Python and no WSL.
 *
 *   node scripts/server/cad-edition/serve.mjs [--port N] [--static DIR]
 *
 * It sets MAGNUSIM_EDITION=cad and installs the spawn guard (./spawn-guard.js) before
 * it loads the server, so the API's worker is the JavaScript one (node-worker.ts) and
 * nothing it loads can start Python or WSL. --static serves a built page (the desktop
 * app's); without it only the API answers. The desktop shell and the tests call
 * startCadServer() instead.
 */
import { createServer } from 'node:http';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

process.env.MAGNUSIM_EDITION = 'cad';
// The simulation modules the API loads ask WSL for its home at import (wsl-env.js) unless
// a case root is set; Magnusim CAD has no cases, so this one is never used.
process.env.MAGNUSIM_WSL_CASE_ROOT ||= '/home/cfddesk/cases';
const { installSpawnGuard } = await import('./spawn-guard.js');
installSpawnGuard();
const { createApiPlugin } = await import('../index.ts');

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
  createReadStream(hit).pipe(res);
  return true;
}

/**
 * Start the server; resolves with its port and a close().
 * @param {{ port?: number, host?: string, staticDir?: string }} [opts]
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
  await new Promise((ok, fail) => {
    httpServer.once('error', fail);
    httpServer.listen(opts.port || 0, host, () => ok(undefined));
  });
  const port = /** @type {import('node:net').AddressInfo} */ (httpServer.address()).port;
  process.env.MAGNUSIM_BOUND_PORT = String(port);
  createApiPlugin().configurePreviewServer({ middlewares, httpServer });
  return {
    port,
    close: () => new Promise((ok) => httpServer.close(() => ok(undefined))),
  };
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const arg = (name) => {
    const i = process.argv.indexOf(name);
    return i > 0 ? process.argv[i + 1] : undefined;
  };
  const { port } = await startCadServer({ port: Number(arg('--port') || 0), staticDir: arg('--static') });
  console.log(`Magnusim CAD server on http://127.0.0.1:${port}/`);
}
