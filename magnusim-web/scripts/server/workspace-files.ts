/**
 * A plugin's workspace files as its sandboxed frame gets them (API 1.1).
 *
 * The frame has an opaque origin: it can load scripts, styles, fonts, images,
 * WASM and data only from the SDK (/plugin-sdk/) and its own plugin's
 * workspace folder (/plugins/<key>/workspace/), fetch only from the latter,
 * start workers only from blobs, and run no inline script but the host's
 * import map (allowed by its hash). /api/** stays out of reach: the CSP
 * refuses it before the server's same-origin check would.
 */
import { createHash } from 'node:crypto';
import { SDK_IMPORTS } from './plugin-sdk.ts';

const IMPORT_MAP = JSON.stringify({ imports: SDK_IMPORTS });
const IMPORT_MAP_HASH = createHash('sha256').update(IMPORT_MAP).digest('base64');

export const WORKSPACE_TYPES: Record<string, string> = {
  html: 'text/html; charset=utf-8',
  js: 'text/javascript; charset=utf-8',
  mjs: 'text/javascript; charset=utf-8',
  css: 'text/css; charset=utf-8',
  json: 'application/json; charset=utf-8',
  map: 'application/json; charset=utf-8',
  svg: 'image/svg+xml',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  wasm: 'application/wasm',
  woff2: 'font/woff2',
  woff: 'font/woff',
  ttf: 'font/ttf',
  txt: 'text/plain; charset=utf-8',
  csv: 'text/csv; charset=utf-8',
  dat: 'text/plain; charset=utf-8',
};

export const SDK_TYPES: Record<string, string> = {
  js: 'text/javascript; charset=utf-8',
  css: 'text/css; charset=utf-8',
  // workspace.d.ts: the bridge's types, for a plugin's editor (never run).
  ts: 'text/plain; charset=utf-8',
};

/** The workspace page with the host's import map and theme first in its head. */
export function injectWorkspaceHead(html: string): string {
  const tags = `<script type="importmap">${IMPORT_MAP}</script><link rel="stylesheet" href="/plugin-sdk/theme.css">`;
  const head = html.match(/<head(\s[^>]*)?>/i);
  if (head) return html.replace(head[0], head[0] + tags);
  return tags + html;
}

/** The workspace page's Content-Security-Policy, for this host and plugin. */
export function workspaceCsp(host: string, key: string): string {
  const origin = `http://${host}`;
  const own = `${origin}/plugins/${key}/workspace/`;
  const sdk = `${origin}/plugin-sdk/`;
  return [
    "default-src 'none'",
    `script-src ${sdk} ${own} blob: 'wasm-unsafe-eval' 'sha256-${IMPORT_MAP_HASH}'`,
    'worker-src blob:',
    `style-src ${sdk} ${own} 'unsafe-inline'`,
    `img-src ${own} data: blob:`,
    `font-src ${sdk} ${own}`,
    `media-src ${own} blob:`,
    `connect-src ${own}`,
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'self'",
  ].join('; ');
}

/** Headers every file a frame loads gets (it asks with Origin: null). */
export const FRAME_ASSET_HEADERS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'X-Content-Type-Options': 'nosniff',
};

/** GET/HEAD of these paths is served to the opaque-origin frames: no same-origin check. */
export function isFrameAssetRequest(method: string | undefined, url: string): boolean {
  if (method !== 'GET' && method !== 'HEAD') return false;
  // The path the router matches (`..` and `%2e%2e` resolved), not the raw text:
  // /plugins/k/workspace/../../api/... is an API request.
  let path: string;
  try {
    path = new URL(url, 'http://127.0.0.1').pathname;
  } catch {
    return false;
  }
  return path.startsWith('/plugin-sdk/') || /^\/plugins\/[^/]+\/workspace\//.test(path);
}
