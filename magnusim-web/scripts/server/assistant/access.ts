/**
 * Who may use the Assistant: a browser or program on this PC talking to Magnusim
 * directly (isLocalOperator: a loopback Host and socket, no forwarding headers). Over a
 * reverse proxy or the public tunnel every Assistant route answers 403 with
 * `reason:'remote'`, before any body is read: remote visitors are anonymous, and the
 * Assistant spends the owner's keys and sends project data out.
 *
 * Every check goes through assistantAccess(req), so a later remote-access login has one
 * place to change: each route (local() and the prefix guard), and the page relay's channel,
 * for both the tab's stream and the subscribe (relay.ts open). The prefix guard runs in
 * index.ts right after the same-origin check,
 * on the path the router will match (canonicalPath), so `/api//assistant/key`,
 * `/api/./assistant/key`, `/api/x/../assistant/key` and `/api/%2e%2e/api/assistant/key`
 * are all caught.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { canonicalPath, isLocalOperator, parseUrl, sendJson } from '../http.ts';

export const REMOTE_MESSAGE =
  'The Assistant and its API keys can only be set up and used on the PC running Magnusim. Over remote access it is off.';

export const REMOTE_BODY = Object.freeze({ ok: false, available: false, reason: 'remote', error: REMOTE_MESSAGE });

/** Sent by the Assistant's own tool calls to the app's routes (host-call.ts); its own routes refuse it. */
export const TURN_HEADER = 'x-magnusim-assistant-turn';

/** The one access predicate for every Assistant route, channel and tool call. */
export function assistantAccess(req: IncomingMessage): boolean {
  return isLocalOperator(req);
}

const PREFIXES = ['/api/assistant', '/api/test/assistant'];

/** True for `/api/assistant…` and `/api/test/assistant…` as the router reads the URL. */
export function isAssistantPath(rawUrl: string | undefined): boolean {
  let path: string;
  try {
    path = canonicalPath(parseUrl(rawUrl).pathname).toLowerCase();
  } catch {
    // Unreadable: the router can't match it either; refuse it if it might be ours.
    return /assistant/i.test(String(rawUrl || ''));
  }
  return PREFIXES.some((p) => path.startsWith(p));
}

/** Answers 403 REMOTE_BODY (and returns true) for an Assistant path from anyone but this PC. */
export function assistantGuard(req: IncomingMessage, res: ServerResponse): boolean {
  if (!isAssistantPath(req.url)) return false;
  if (assistantAccess(req)) return false;
  sendJson(res, 403, REMOTE_BODY);
  return true;
}
