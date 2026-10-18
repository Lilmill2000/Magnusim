// The controller of the scripted coding agent (fake-acp-agent.mjs), run in the test process
// (phase 3 spec 7.2). Plain ESM, no dependencies, names no real agent. Used by node tests and
// browser specs:
//
//   const fake = await startFakeAcp({ style: 'tool_name_meta' });
//   fake.argv                     // [process.execPath, <fake-acp-agent.mjs>, '--control', <url>]
//   fake.script({ say: 'hi' }, { call: { tool: 'app_status' } }, { stop: 'end_turn' });
//   ... the app starts fake.argv as a coding agent and sends it a prompt ...
//   fake.received()               // every message the fake got, in order
//
// API:
//   argv, url, agentPath, marker
//   argvWith({helpersAtStart})    the argv with --helpers-at-start n
//   writeLauncher(file, {version?, helpersAtStart?})
//                                 writes a small script at `file` (folders made) that runs the
//                                 fake with this controller, and returns `file`. For a start
//                                 that passes no --control: agent discovery starts a package's
//                                 bin as [node, <script>, ...args] with no MAGNUSIM_ variable,
//                                 so a test puts the launcher where the bin points (for example
//                                 <prefix>/node_modules/<package>/dist/index.js). It works as
//                                 CommonJS or ESM; `--version` prints `version` (default 1.0.0).
//   configure(patch)              settings the next started fake reads (the header of
//                                 fake-acp-agent.mjs lists them)
//   script(...steps)              queues one prompt's steps (one call = one prompt, in order)
//   release(name)                 lets a `hold` step go (before or after it is reached)
//   records()                     everything the fakes recorded: {seq, pid, instance, dir:'in'|'out',
//                                 msg} or {seq, pid, instance, event, ...}, in each fake's order
//                                 (instance: the fake process's own random id)
//   received(pid?) / sent(pid?)   the messages a fake got / sent (all fakes when pid is left out);
//                                 a pid means the last fake that reported it (the OS reuses pids)
//   events(name?, pid?)           the fakes' own events (mcp_tools, mcp_result, permission_outcome,
//                                 holding, fs_answer, env, exit, ...), of that fake when pid is given
//   of(pid)                       a record predicate: the last fake that reported that pid
//   pids(role?)                   [{pid, role: 'agent'|'helper'|'mcp', agent, instance}] the fakes reported
//   waitFor(pred, ms?)            resolves with the first record pred accepts (earlier ones
//                                 included); rejects after ms (default 10 s)
//   signIn() / signOut()          the sign-in marker file that requireSignIn checks
//   stop()                        closes the control server and lets every hold go
import http from 'node:http';
import { mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const FAKE_ACP_AGENT = fileURLToPath(new URL('./fake-acp-agent.mjs', import.meta.url));

const DEFAULTS = Object.freeze({ style: 'none', protocolVersion: 1, requireSignIn: false, authMethods: [] });

export async function startFakeAcp(options = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'magnusim-fake-acp-'));
  const marker = join(dir, 'signed_in');
  let config = { ...DEFAULTS, ...options, marker };
  const prompts = [];
  const all = [];
  const pidList = [];
  const holds = new Map();
  const listeners = new Set();

  const hold = (name) => {
    let h = holds.get(name);
    if (!h) {
      h = { released: false, waiters: [] };
      holds.set(name, h);
    }
    return h;
  };

  const add = (rec) => {
    all.push(rec);
    for (const l of [...listeners]) l(rec);
  };

  const readBody = (req) =>
    new Promise((resolve) => {
      let text = '';
      req.setEncoding('utf8');
      req.on('data', (d) => (text += d));
      req.on('end', () => {
        try {
          resolve(JSON.parse(text || '{}'));
        } catch {
          resolve({});
        }
      });
    });

  const json = (res, status, body) => {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  };

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    if (req.method === 'GET' && url.pathname === '/config') return json(res, 200, config);
    if (req.method === 'GET' && url.pathname === '/hold') {
      const h = hold(url.searchParams.get('name') || '');
      if (!h.released) await new Promise((r) => h.waiters.push(r));
      return json(res, 200, { ok: true });
    }
    if (req.method !== 'POST') return json(res, 404, { ok: false });
    const body = await readBody(req);
    if (url.pathname === '/record') {
      add(body);
      return json(res, 200, { ok: true });
    }
    if (url.pathname === '/pids') {
      for (const pid of body.pids || []) pidList.push({ pid, role: body.role, agent: body.pid, instance: body.instance ?? null, atStart: !!body.atStart });
      add({ seq: null, pid: body.pid, instance: body.instance ?? null, event: 'pids', role: body.role, pids: body.pids || [] });
      return json(res, 200, { ok: true });
    }
    if (url.pathname === '/prompt') {
      const steps = prompts.shift() || [];
      add({ seq: null, pid: body.pid, instance: body.instance ?? null, event: 'prompt', sessionId: body.sessionId, prompt: body.prompt, steps });
      return json(res, 200, { steps });
    }
    return json(res, 404, { ok: false });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  const argv = [process.execPath, FAKE_ACP_AGENT, '--control', url];

  /** The instance of the last fake that reported `pid` as its own (null: none reported it). */
  const instanceOf = (pid) => {
    for (let i = pidList.length - 1; i >= 0; i -= 1) if (pidList[i].role === 'agent' && pidList[i].pid === pid) return pidList[i].instance;
    return null;
  };
  /** That fake's records only: the pid, and the instance of the last fake that had it. */
  const byPid = (pid) => {
    if (pid == null) return () => true;
    const instance = instanceOf(pid);
    return (r) => r.pid === pid && (instance == null || r.instance === instance);
  };

  return {
    url,
    agentPath: FAKE_ACP_AGENT,
    marker,
    argv,
    argvWith({ helpersAtStart = 0 } = {}) {
      return helpersAtStart > 0 ? [...argv, '--helpers-at-start', String(helpersAtStart)] : [...argv];
    },
    writeLauncher(file, { version = '1.0.0', helpersAtStart = 0 } = {}) {
      const args = ['--control', url, '--fake-version', String(version), ...(helpersAtStart > 0 ? ['--helpers-at-start', String(helpersAtStart)] : [])];
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(
        file,
        [
          '#!/usr/bin/env node',
          '// Runs the scripted coding agent with its test controller (written by fake-acp.mjs).',
          `process.argv.splice(2, 0, ${args.map((a) => JSON.stringify(a)).join(', ')});`,
          `import(${JSON.stringify(pathToFileURL(FAKE_ACP_AGENT).href)}).catch((err) => {`,
          "  process.stderr.write(String((err && err.stack) || err) + '\\n');",
          '  process.exit(70);',
          '});',
          '',
        ].join('\n'),
      );
      return file;
    },
    configure(patch) {
      config = { ...config, ...patch, marker };
    },
    script(...steps) {
      prompts.push(steps);
    },
    release(name) {
      const h = hold(name);
      h.released = true;
      for (const w of h.waiters.splice(0)) w();
    },
    records: () => [...all],
    received: (pid) => all.filter(byPid(pid)).filter((r) => r.dir === 'in').map((r) => r.msg),
    sent: (pid) => all.filter(byPid(pid)).filter((r) => r.dir === 'out').map((r) => r.msg),
    events: (name, pid) => all.filter(byPid(pid)).filter((r) => r.event && (!name || r.event === name)),
    of: (pid) => byPid(pid),
    pids: (role) => pidList.filter((p) => !role || p.role === role),
    waitFor(pred, ms = 10_000) {
      const found = all.find(pred);
      if (found) return Promise.resolve(found);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          listeners.delete(listen);
          reject(new Error(`fake-acp: no matching record in ${ms} ms`));
        }, ms);
        const listen = (rec) => {
          if (!pred(rec)) return;
          clearTimeout(timer);
          listeners.delete(listen);
          resolve(rec);
        };
        listeners.add(listen);
      });
    },
    signIn() {
      writeFileSync(marker, 'signed in');
    },
    signOut() {
      try {
        unlinkSync(marker);
      } catch {
        /* not signed in */
      }
    },
    async stop() {
      for (const h of holds.values()) {
        h.released = true;
        for (const w of h.waiters.splice(0)) w();
      }
      server.closeAllConnections?.();
      await new Promise((resolve) => server.close(() => resolve()));
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        /* the OS temp cleaner takes it */
      }
    },
  };
}
