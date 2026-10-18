// Another app's MCP client, for the browser tests of Other apps (MCP): the MCP SDK's own
// Client (@modelcontextprotocol/client, a devDependency) with a StdioClientTransport that
// starts Magnusim's real bridge, scripts/assistant-mcp.mjs, as a desktop app would from the
// config Settings shows. `info` is the mcp.json the server under test writes (its
// GET /api/assistant/mcp names it in bridge.args); nothing here reads this PC's own.
// SPDX-License-Identifier: GPL-3.0-or-later
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { join } from 'node:path';
import { WEB_ROOT } from './host-server.mjs';

export const BRIDGE = join(WEB_ROOT, 'scripts', 'assistant-mcp.mjs');
export const MODERN = '2026-07-28';

/** The --info path from a GET /api/assistant/mcp answer. */
export function infoPathOf(mcp) {
  const args = mcp?.bridge?.args ?? [];
  const at = args.indexOf('--info');
  if (at < 0 || typeof args[at + 1] !== 'string') throw new Error(`no --info in ${JSON.stringify(args)}`);
  return args[at + 1];
}

/**
 * Starts the bridge and connects the SDK's client through it: {client, changes (list_changed
 * notifications heard, counted), stderr(), close()}. Rejects when the bridge ends before the
 * client is connected (Magnusim not running, or a refusal): the error carries the bridge's
 * stderr as `stderr`.
 */
export async function startMcpClient({ info, name = 'E2E Desk App', era = 'legacy' } = {}) {
  const transport = new StdioClientTransport({ command: process.execPath, args: [BRIDGE, '--info', info], stderr: 'pipe', env: {} });
  let stderr = '';
  transport.stderr?.on('data', (d) => (stderr += d));
  const changes = { n: 0 };
  const client = new Client(
    { name, version: '1.0.0' },
    {
      ...(era === 'modern' ? { versionNegotiation: { mode: { pin: MODERN } } } : {}),
      listChanged: { tools: { autoRefresh: false, debounceMs: 0, onChanged: () => (changes.n += 1) } },
    },
  );
  const close = async () => {
    await client.close().catch(() => {});
    await transport.close().catch(() => {});
  };
  try {
    await client.connect(transport);
  } catch (err) {
    // The bridge's own words come on stderr as it ends: read to its end (bounded), then close.
    const s = transport.stderr;
    if (s && !s.readableEnded && !s.destroyed) {
      await new Promise((resolve) => {
        const timer = setTimeout(resolve, 5000);
        const done = () => {
          clearTimeout(timer);
          resolve();
        };
        s.once('end', done);
        s.once('close', done);
      });
    }
    await close();
    throw Object.assign(err instanceof Error ? err : new Error(String(err)), { stderr });
  }
  return { client, changes, stderr: () => stderr, close };
}

/** A tool result's JSON text, parsed. */
export function resultJson(result) {
  return JSON.parse(result.content[0].text);
}
