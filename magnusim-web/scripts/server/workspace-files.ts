/**
 * A plugin's workspace files as its sandboxed frame gets them (API 1.1).
 *
 * The frame has an opaque origin: it can load scripts, styles, fonts, images,
 * WASM and data only from the SDK (/plugin-sdk/) and its own plugin's
 * workspace folder (/plugins/<key>/workspace/), fetch only from the latter,
 * start workers only from blobs, and run no inline script but the host's
 * import map and its pre-paint (each allowed by its hash). /api/** stays out
 * of reach: the CSP refuses it before the server's same-origin check would.
 *
 * The pre-paint gives the page the app's look before its first paint (1.9,
 * unreleased), as index.html's does for the app's page: the server puts the
 * person's look in the head (meta magnusim-look: theme, text_scale,
 * icon_scale), and the pre-paint sets html's data-theme (a "system" choice
 * decided by the frame's own prefers-color-scheme), data-theme-pref and the
 * scales. The SDK sets them again from the host's look once the page connects.
 */
import { createHash } from 'node:crypto';
import { SDK_IMPORTS } from './plugin-sdk.ts';

const IMPORT_MAP = JSON.stringify({ imports: SDK_IMPORTS });
const IMPORT_MAP_HASH = createHash('sha256').update(IMPORT_MAP).digest('base64');

/** The look the server puts in a workspace page's head (scripts/prefs.js appearancePrefs). */
export interface PageLook {
  theme: string;
  text_scale: number;
  icon_scale: number;
}

/** The workspace page's pre-paint: the look in its head (meta magnusim-look) on html. Fixed text: its hash is in the CSP. */
export const LOOK_SCRIPT =
  '(function(){try{' +
  'var m=document.querySelector(\'meta[name="magnusim-look"]\');' +
  "var a=m&&JSON.parse(m.getAttribute('content')||'null');" +
  "if(!a||['light','dark','system'].indexOf(a.theme)<0)return;" +
  'var h=document.documentElement;' +
  "var d=a.theme==='dark'||(a.theme==='system'&&!!window.matchMedia&&window.matchMedia('(prefers-color-scheme: dark)').matches);" +
  "h.setAttribute('data-theme',d?'dark':'light');" +
  "h.setAttribute('data-theme-pref',a.theme);" +
  "if(typeof a.text_scale==='number'&&a.text_scale>=0.5&&a.text_scale<=3)h.style.setProperty('--mg-text-scale',String(a.text_scale));" +
  "if(typeof a.icon_scale==='number'&&a.icon_scale>=0.5&&a.icon_scale<=3)h.style.setProperty('--mg-icon-scale',String(a.icon_scale));" +
  '}catch(e){}})();';
const LOOK_SCRIPT_HASH = createHash('sha256').update(LOOK_SCRIPT).digest('base64');

/**
 * Whether a request for a workspace page is the page's load (its frame, or a navigation): only then
 * does the page get the person's look. Workspace files are anyone's to read (Access-Control-Allow-
 * Origin: *), so a fetch() of one never gets it. A fetch() always sends Origin, which a GET to load
 * a frame or a page never does; and a browser with Fetch Metadata says "empty" in Sec-Fetch-Dest
 * (a page can set neither header). No Sec-Fetch-Dest and no Origin (an older browser's load, or a
 * client that is no browser): a load.
 */
export function isPageLoad(dest: string | string[] | undefined, origin: string | string[] | undefined): boolean {
  if (origin !== undefined) return false;
  const d = Array.isArray(dest) ? dest[0] : dest;
  return !d || d === 'iframe' || d === 'frame' || d === 'document';
}

/** Text safe inside a double-quoted attribute. */
function attr(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

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
  // ui-kit-sheet.html: the dev sheet's frame page (dev server with VITE_MAGNUSIM_DEV_SHEETS=1 only).
  html: 'text/html; charset=utf-8',
  js: 'text/javascript; charset=utf-8',
  css: 'text/css; charset=utf-8',
  // workspace.d.ts: the bridge's types, for a plugin's editor (never run).
  ts: 'text/plain; charset=utf-8',
};

/**
 * The workspace page with the host's pre-paint and the person's look (`look`; without it the page
 * paints light), import map, theme and UI kit styles first in its head.
 */
export function injectWorkspaceHead(html: string, look?: PageLook | null): string {
  const tags =
    (look ? `<meta name="magnusim-look" content="${attr(JSON.stringify({ theme: look.theme, text_scale: look.text_scale, icon_scale: look.icon_scale }))}">` : '') +
    `<script>${LOOK_SCRIPT}</script>` +
    `<script type="importmap">${IMPORT_MAP}</script>` +
    '<link rel="stylesheet" href="/plugin-sdk/theme.css">' +
    '<link rel="stylesheet" href="/plugin-sdk/plugin-ui.css">';
  const head = html.match(/<head(\s[^>]*)?>/i);
  // A function, so a "$" in the tags is text, never a replacement pattern.
  if (head) return html.replace(head[0], () => head[0] + tags);
  // No head tag: first, but after a doctype (before it the page would be in quirks mode).
  const doctype = html.match(/^\s*<!doctype[^>]*>/i);
  if (doctype) return doctype[0] + tags + html.slice(doctype[0].length);
  return tags + html;
}

/** The workspace page's Content-Security-Policy, for this host and plugin. */
export function workspaceCsp(host: string, key: string): string {
  return frameCsp(host, `/plugins/${key}/workspace/`);
}

/** A sandboxed frame page's Content-Security-Policy: the SDK plus its own folder (`ownPath`). */
export function frameCsp(host: string, ownPath: string): string {
  const origin = `http://${host}`;
  const own = `${origin}${ownPath}`;
  const sdk = `${origin}/plugin-sdk/`;
  return [
    "default-src 'none'",
    `script-src ${sdk} ${own} blob: 'wasm-unsafe-eval' 'sha256-${IMPORT_MAP_HASH}' 'sha256-${LOOK_SCRIPT_HASH}'`,
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
