/**
 * The Node.js a coding agent runs on (scripts/server/assistant/agents/node.ts): Magnusim's own
 * (process.execPath, exactly as before) unless the server runs inside Electron (the desktop app,
 * whose executable is the app itself), then node.exe from PATH, never the app, and only one new
 * enough (MIN_AGENT_NODE); none there and every agent says it needs Node.js (naming the version
 * found when the only one is too old), and starting one is refused with those words.
 */
import { after, afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, linkSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ROOT = mkdtempSync(join(tmpdir(), 'magnusim-agent-node-'));
process.env.MAGNUSIM_ASSISTANT_HOME = join(ROOT, 'home');
after(() => rmSync(ROOT, { recursive: true, force: true }));

const { agentNode, MIN_AGENT_NODE, NEEDS_NODE_CODE, NEEDS_NODE_TEXT, needsNodeText } = await import('../assistant/agents/node.ts');
const { resolveCustom, agentStartRefusal } = await import('../assistant/agents/discover.ts');

const WIN = process.platform === 'win32';
const NODE_NAME = WIN ? 'node.exe' : 'node';
const OLD_TEXT = 'Coding agents need Node.js 22 or newer on this PC (found 18.19.0). Install it from nodejs.org, then start Magnusim CAD again.';

/** A folder on PATH holding a real Node.js: this one, hard-linked (copied where it can't be). */
function folderWithNode(name) {
  const dir = join(ROOT, name);
  mkdirSync(dir, { recursive: true });
  try {
    linkSync(process.execPath, join(dir, NODE_NAME));
  } catch {
    copyFileSync(process.execPath, join(dir, NODE_NAME));
  }
  return dir;
}

/** Runs fn as if inside Electron (process.versions.electron set), then puts it back. */
async function asElectron(fn) {
  Object.defineProperty(process.versions, 'electron', { value: '44.9.3', configurable: true, enumerable: true });
  try {
    return await fn();
  } finally {
    delete process.versions.electron;
  }
}

afterEach(() => {
  delete process.versions.electron;
});

describe('agentNode', () => {
  it("is Magnusim's own Node, exactly process.execPath, outside Electron", () => {
    assert.equal(process.versions.electron, undefined);
    assert.equal(agentNode(), process.execPath);
    assert.equal(agentNode({ electron: undefined, execPath: 'C:\\x\\node.exe', env: { PATH: '' } }), 'C:\\x\\node.exe');
    assert.equal(needsNodeText(), NEEDS_NODE_TEXT);
  });

  it('inside Electron: the first node on PATH (absolute folders only), never the app itself', { skip: !WIN }, () => {
    const a = folderWithNode('a');
    const b = folderWithNode('b');
    const env = { Path: ['relative\\dir', `"${a}"`, b].join(';') };
    assert.equal(agentNode({ electron: '44.9.3', execPath: 'C:\\Apps\\Magnusim CAD.exe', env, platform: 'win32' }), join(a, 'node.exe'));
    // A folder whose node.exe is the app's own executable is skipped.
    assert.equal(agentNode({ electron: '44.9.3', execPath: join(a, 'node.exe'), env, platform: 'win32' }), join(b, 'node.exe'));
    assert.equal(agentNode({ electron: '44.9.3', execPath: 'C:\\Apps\\Magnusim CAD.exe', env: { Path: join(ROOT, 'none') }, platform: 'win32' }), null);
  });

  it('asks each node its version: one that does not run is not a Node.js', () => {
    // This Node is new enough (the floor is the agents' and Magnusim runs on Node 22.12+).
    assert.ok(Number(process.versions.node.split('.')[0]) >= MIN_AGENT_NODE[0]);
    const real = folderWithNode('real');
    const fake = join(ROOT, 'fake');
    mkdirSync(fake, { recursive: true });
    writeFileSync(join(fake, NODE_NAME), '', { mode: 0o755 });
    const asked = [];
    const env = { PATH: [fake, real].join(WIN ? ';' : ':') };
    const o = { electron: '44.9.3', execPath: join(ROOT, 'Magnusim CAD'), env, platform: process.platform };
    assert.equal(agentNode(o), join(real, NODE_NAME));
    // The real `node --version` ran: a stub on the same PATH sees the same two candidates.
    agentNode({ ...o, env: { PATH: [fake, real, join(ROOT, 'x')].join(WIN ? ';' : ':') }, versionOf: (p) => (asked.push(p), p.startsWith(fake) ? null : 'v24.1.0') });
    assert.deepEqual(asked, [join(fake, NODE_NAME), join(real, NODE_NAME)]);
  });

  it('passes over a node older than MIN_AGENT_NODE for a newer one later on PATH', () => {
    const old = folderWithNode('old-first');
    const fresh = folderWithNode('fresh-second');
    const versions = { [join(old, NODE_NAME)]: 'v18.19.0', [join(fresh, NODE_NAME)]: 'v22.0.0' };
    const o = { electron: '44.9.3', execPath: join(ROOT, 'Magnusim CAD'), env: { PATH: [old, fresh].join(WIN ? ';' : ':') }, platform: process.platform, versionOf: (p) => versions[p] };
    assert.equal(agentNode(o), join(fresh, NODE_NAME));
    assert.equal(needsNodeText(o), NEEDS_NODE_TEXT);
  });

  it('only an old node: none, and the words name the version found and the minimum', () => {
    const old = folderWithNode('old-only');
    const o = { electron: '44.9.3', execPath: join(ROOT, 'Magnusim CAD'), env: { PATH: old }, platform: process.platform, versionOf: () => 'v18.19.0' };
    assert.equal(agentNode(o), null);
    assert.equal(needsNodeText(o), OLD_TEXT);
    // Just under the floor is too old; exactly the floor is enough.
    const at = (v) => agentNode({ ...o, env: { PATH: `${old}${WIN ? ';' : ':'}` + v }, versionOf: () => v });
    assert.equal(at('v21.99.99'), null);
    assert.equal(at('v22.0.0'), join(old, NODE_NAME));
  });
});

describe('discovery and start inside Electron', () => {
  const script = join(ROOT, 'agent', 'index.js');
  mkdirSync(join(ROOT, 'agent'), { recursive: true });
  writeFileSync(script, '#!/usr/bin/env node\n');
  const custom = { id: 'c-1', name: 'Stand-in agent', argv: [script, '--acp'], keep_env: [] };
  const ctx = { env: {}, platform: process.platform, home: ROOT, folders: [] };

  it("Magnusim: a node-script agent starts on process.execPath, as before", async () => {
    const e = await resolveCustom(custom, ctx);
    assert.equal(e.error, null);
    assert.deepEqual(e.argv, [process.execPath, script, '--acp']);
  });

  it('Electron with Node.js on PATH: it starts on that node', async () => {
    const dir = folderWithNode('onpath');
    const before = process.env.PATH;
    process.env.PATH = dir;
    try {
      const e = await asElectron(() => resolveCustom(custom, ctx));
      assert.equal(e.error, null);
      assert.deepEqual(e.argv, [join(dir, NODE_NAME), script, '--acp']);
    } finally {
      process.env.PATH = before;
    }
  });

  it('Electron with no Node.js: the agent says it needs it, and a start is refused with those words', async () => {
    const before = process.env.PATH;
    process.env.PATH = join(ROOT, 'empty');
    try {
      const e = await asElectron(() => resolveCustom(custom, ctx));
      assert.deepEqual(e.error, { code: NEEDS_NODE_CODE, message: NEEDS_NODE_TEXT });
      const refusal = agentStartRefusal({ reason: NEEDS_NODE_CODE, error: e.error.message, name: 'Stand-in agent', found: true, kind: 'custom' }, 'turn');
      assert.deepEqual(refusal, { code: NEEDS_NODE_CODE, error: NEEDS_NODE_TEXT });
    } finally {
      process.env.PATH = before;
    }
  });

  it('Electron with only an old Node.js: the agent and a start name the version found and the minimum', async () => {
    const dir = folderWithNode('old-on-path');
    const before = process.env.PATH;
    process.env.PATH = dir;
    try {
      // The stub old node: its version is asked once and kept with this PATH, as the app keeps it.
      await asElectron(() => agentNode({ versionOf: () => 'v18.19.0' }));
      const e = await asElectron(() => resolveCustom(custom, ctx));
      assert.deepEqual(e.error, { code: NEEDS_NODE_CODE, message: OLD_TEXT });
      const refusal = agentStartRefusal({ reason: NEEDS_NODE_CODE, error: e.error.message, name: 'Stand-in agent', found: true, kind: 'custom' }, 'turn');
      assert.deepEqual(refusal, { code: NEEDS_NODE_CODE, error: OLD_TEXT });
    } finally {
      process.env.PATH = before;
    }
  });
});
