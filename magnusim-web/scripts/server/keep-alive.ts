// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * How long the app server keeps an idle keep-alive connection open.
 *
 * Node closes an idle connection keepAliveTimeout (5 s) plus keepAliveTimeoutBuffer (1 s)
 * after its last response. A client that keeps idle connections for reuse with no limit of
 * its own (Node's http.Agent with keepAlive, as in Playwright's request context, which the
 * e2e tests use) sends its next request on one whenever it likes. When that request arrives
 * while the server's event loop is busy (a sync step in another request, a big worker reply)
 * and the 6 s pass meanwhile, the server's next loop turn runs the idle timer before it reads
 * the request: it closes the connection with the request unread, and the client gets
 * "read ECONNRESET" (CAD e2e: cad-p1-review3 view-kept on GitHub, 2026-10-13). A browser sends
 * such a request again on a new connection; Node's client does not.
 *
 * Kept far above the gaps of any client (and above the 60 s idle limit of common proxies),
 * idle connections end when their client closes them. headersTimeout stays above it, as Node
 * advises, and requestTimeout above that.
 */
export const KEEP_ALIVE_TIMEOUT_MS = 120_000;
export const HEADERS_TIMEOUT_MS = KEEP_ALIVE_TIMEOUT_MS + 5_000;

type HttpServerTimeouts = { keepAliveTimeout?: number; headersTimeout?: number; requestTimeout?: number };

/** Apply the timeouts above to an http.Server (no-op for none, as in Vite's middleware mode). */
export function keepIdleConnectionsOpen(server: unknown): void {
  if (!server || typeof server !== 'object' || typeof (server as HttpServerTimeouts).keepAliveTimeout !== 'number') return;
  const s = server as HttpServerTimeouts;
  s.keepAliveTimeout = KEEP_ALIVE_TIMEOUT_MS;
  s.headersTimeout = HEADERS_TIMEOUT_MS;
  // 0 turns requestTimeout off; otherwise it must stay above headersTimeout.
  if (typeof s.requestTimeout === 'number' && s.requestTimeout > 0 && s.requestTimeout <= HEADERS_TIMEOUT_MS) {
    s.requestTimeout = HEADERS_TIMEOUT_MS + 5_000;
  }
}
