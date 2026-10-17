// The MCP library spike (phase 3 spec 3.2, M1): the MCP server package loads only through
// load-sdk.ts (loadMcpSdk, by a variable specifier, with its own missing-package state),
// and its low-level Server, served per connection by serveStdio over a socket (the
// listener's shape), answers tools/list and tools/call to the SDK's own client in both
// protocol eras: 2025-11-25 (the client's default, `initialize`) and 2026-07-28 pinned
// (`server/discover`). Raw JSON Schemas go through unchanged; text and images come back.
import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ROOT = mkdtempSync(join(tmpdir(), 'magnusim-assistant-mcp-sdk-'));
process.env.MAGNUSIM_PROJECTS_ROOT = join(ROOT, 'projects');
process.env.MAGNUSIM_LOCAL_JSON = join(ROOT, 'local.json');
process.env.MAGNUSIM_ASSISTANT_HOME = join(ROOT, 'home');
after(() => rmSync(ROOT, { recursive: true, force: true }));

const sdk = await import('../assistant/providers/load-sdk.ts');
// The test client (a devDependency): only load-sdk.ts loads the server package.
const { Client, ReadBuffer, serializeMessage } = await import('@modelcontextprotocol/client');

const MODERN = '2026-07-28';
/** A 1×1 PNG. */
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

const TOOL = {
  name: 'ai-demo__add',
  title: 'Add to the counter',
  description: 'Adds n to the counter.',
  inputSchema: {
    type: 'object',
    properties: { n: { type: 'integer', minimum: 1, maximum: 9, description: 'How much to add.' }, mode: { type: 'string', enum: ['fast', 'slow'] } },
    required: ['n'],
    additionalProperties: false,
  },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
};

/** A client transport over one end of a socket pair: MCP's stdio framing (newline JSON). */
class SocketClientTransport {
  constructor(sock) {
    this.sock = sock;
    this.buf = new ReadBuffer();
  }
  async start() {
    this.sock.on('data', (chunk) => {
      this.buf.append(chunk);
      for (let m = this.buf.readMessage(); m !== null; m = this.buf.readMessage()) this.onmessage?.(m);
    });
    this.sock.on('error', (err) => this.onerror?.(err));
    this.sock.on('close', () => this.onclose?.());
  }
  async send(message) {
    this.sock.write(serializeMessage(message));
  }
  async close() {
    this.sock.destroy();
  }
}

/**
 * A loopback socket pair; the accepted end is served by serveStdio with a fresh low-level
 * Server per connection (the factory gets the era).
 */
async function serve(seen) {
  const { server: serverMod, stdio } = await sdk.loadMcpSdk();
  const { Server } = serverMod;
  const { serveStdio, StdioServerTransport } = stdio;
  const handles = [];
  const listener = net.createServer((sock) => {
    const transport = new StdioServerTransport(sock, sock, { maxBufferSize: 8 * 1024 * 1024 });
    handles.push(
      serveStdio(
        ({ era }) => {
          seen.eras.push(era);
          const s = new Server({ name: 'magnusim-spike', version: '0.0.1' }, { capabilities: { tools: {} }, instructions: 'Spike instructions.' });
          s.setRequestHandler('tools/list', async () => ({ tools: [TOOL] }));
          s.setRequestHandler('tools/call', async (request, ctx) => {
            seen.calls.push({
              name: request.params.name,
              args: request.params.arguments,
              legacyClient: s.getClientVersion()?.name ?? null,
              modernClient: ctx.mcpReq.envelope?.['io.modelcontextprotocol/clientInfo']?.name ?? null,
            });
            return {
              content: [
                { type: 'text', text: JSON.stringify({ tool: request.params.name, ok: true, data: { counter: 2 } }) },
                { type: 'image', data: PNG, mimeType: 'image/png' },
              ],
            };
          });
          return s;
        },
        { transport, onerror: (err) => seen.errors.push(String(err?.message ?? err)) },
      ),
    );
    sock.on('error', () => {});
  });
  await new Promise((r) => listener.listen(0, '127.0.0.1', r));
  return {
    port: listener.address().port,
    async close() {
      await Promise.all(handles.map((h) => h.close().catch(() => {})));
      await new Promise((r) => listener.close(r));
    },
  };
}

async function connect(port, era) {
  const sock = net.connect(port, '127.0.0.1');
  await new Promise((resolve, reject) => sock.once('connect', resolve).once('error', reject));
  const client = new Client({ name: 'spike-client', version: '1.2.3' }, era === 'modern' ? { versionNegotiation: { mode: { pin: MODERN } } } : {});
  await client.connect(new SocketClientTransport(sock));
  return client;
}

describe('the MCP server package loads through load-sdk.ts', () => {
  it('loadMcpSdk gives the low-level Server, serveStdio and StdioServerTransport; its version is read without loading it', async () => {
    const mods = await sdk.loadMcpSdk();
    assert.equal(typeof mods.server.Server, 'function');
    assert.equal(typeof mods.stdio.serveStdio, 'function');
    assert.equal(typeof mods.stdio.StdioServerTransport, 'function');
    assert.equal(await sdk.mcpSdkInstalled(), '2.3.0');
  });

  it('a missing MCP package is deps_missing for MCP only: the API-key providers keep their state, and back again', async () => {
    const before = await sdk.depsStatus();
    sdk.setSdkSpecifierForTests(sdk.MCP_SDK_NAME, '@magnusim-test/no-such-mcp-package');
    try {
      await assert.rejects(sdk.loadMcpSdk(), (err) => err.code === 'deps_missing' && err.message === sdk.MCP_DEPS_MISSING_TEXT);
      assert.equal(await sdk.mcpSdkInstalled(), null);
      assert.deepEqual(await sdk.depsStatus(), before, 'depsStatus() for the providers is unchanged');
    } finally {
      sdk.setSdkSpecifierForTests(sdk.MCP_SDK_NAME, null);
    }
    assert.equal(typeof (await sdk.loadMcpSdk()).server.Server, 'function');
  });

  it('a missing provider package leaves the MCP package loadable', async () => {
    sdk.setSdkSpecifierForTests('openai', '@magnusim-test/no-such-provider-package');
    try {
      assert.equal((await sdk.depsStatus()).state, 'missing');
      assert.equal(typeof (await sdk.loadMcpSdk()).stdio.serveStdio, 'function');
    } finally {
      sdk.setSdkSpecifierForTests('openai', null);
    }
  });
});

describe('serveStdio with a low-level Server over a socket pair, both eras', () => {
  for (const era of ['legacy', 'modern']) {
    it(`${era}: tools/list returns the raw JSON Schema tool, tools/call returns text and an image`, async () => {
      const seen = { eras: [], calls: [], errors: [] };
      const srv = await serve(seen);
      let client;
      try {
        client = await connect(srv.port, era);
        assert.equal(client.getProtocolEra(), era);
        assert.equal(client.getNegotiatedProtocolVersion(), era === 'modern' ? MODERN : '2025-11-25');
        assert.equal(client.getInstructions(), 'Spike instructions.');
        assert.deepEqual(seen.eras, [era], 'one instance, pinned to the era the opening chose');

        const listed = await client.listTools();
        assert.equal(listed.tools.length, 1);
        const tool = listed.tools[0];
        assert.equal(tool.name, TOOL.name);
        assert.equal(tool.title, TOOL.title);
        assert.deepEqual(tool.inputSchema, TOOL.inputSchema, 'the schema passes through as sent');
        assert.deepEqual(tool.annotations, TOOL.annotations);

        const result = await client.callTool({ name: TOOL.name, arguments: { n: 2 } });
        assert.ok(!result.isError);
        assert.deepEqual(JSON.parse(result.content[0].text), { tool: TOOL.name, ok: true, data: { counter: 2 } });
        assert.deepEqual(result.content[1], { type: 'image', data: PNG, mimeType: 'image/png' });
        assert.equal(seen.calls.length, 1);
        assert.deepEqual(seen.calls[0].args, { n: 2 });
        // The client's own name: from initialize (legacy), or each request's envelope (modern).
        if (era === 'legacy') assert.equal(seen.calls[0].legacyClient, 'spike-client');
        else assert.equal(seen.calls[0].modernClient, 'spike-client');
      } finally {
        await client?.close().catch(() => {});
        await srv.close();
      }
    });
  }
});
