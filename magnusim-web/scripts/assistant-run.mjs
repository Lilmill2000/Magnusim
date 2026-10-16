#!/usr/bin/env node
/**
 * The Assistant from a terminal (Foundation spec 9.4): a developer tool that runs one
 * turn in the Magnusim app on this PC and prints what happens.
 *
 *   node scripts/assistant-run.mjs [--port N] [--tab auto|<id>] [--project <id>]
 *                                  [--conversation <id>] [--json] "prompt"
 *
 * It talks to the app's own routes over loopback (POST /api/assistant/turns, then the
 * long-poll GET /api/assistant/turns/:id). Questions are asked here (y/n): for a turn
 * with no tab they are asked only here; for a turn bound to an app tab the app shows
 * them too, and either answer counts. Ctrl+C stops the turn (twice: leave at once).
 *
 * Exit codes: 0 the turn finished (`done`), 1 anything else, 2 the tab isn't connected.
 */
import http from 'node:http';
import readline from 'node:readline';
import { pathToFileURL } from 'node:url';

export const HELP = `Usage: node scripts/assistant-run.mjs [--port N] [--tab auto|<id>] [--project <id>] [--conversation <id>] [--json] "prompt"

Runs one Assistant turn in the Magnusim app on this PC and prints what happens: the
answer, each tool call (→) and its result (✓ or ✗), notes and questions. Questions are
asked here (y/n). A turn bound to an app tab also shows them in the app; either answer
counts. Ctrl+C stops the turn.

  --port N             the app's port (default: the app's own setting, else 8082)
  --tab auto|<id>      bind the turn to an app tab's workspace (auto: the only connected one)
  --project <id>       the project the turn is about (without a tab)
  --conversation <id>  continue a conversation (its id is printed at the end)
  --json               print each event as one line of JSON

Keep the Magnusim window visible when you start a turn. It may then be covered for up to 10 minutes between turns.

Exit codes: 0 the turn finished, 1 it did not, 2 the app tab isn't connected.`;

const TAB_HIDDEN_EXIT = 2;
const POLL_WAIT_MS = 25_000;

export function parseArgs(argv) {
  const o = { port: null, tab: null, project: null, conversation: null, json: false, help: false, words: [], error: null };
  const value = (i, name) => {
    const v = argv[i + 1];
    if (v === undefined || v.startsWith('--')) {
      o.error = `${name} needs a value.`;
      return null;
    }
    return v;
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--help' || a === '-h') o.help = true;
    else if (a === '--json') o.json = true;
    else if (a === '--port' || a === '--tab' || a === '--project' || a === '--conversation') {
      const v = value(i, a);
      if (v === null) break;
      i += 1;
      if (a === '--port') {
        const n = Number(v);
        if (!Number.isInteger(n) || n < 1 || n > 65535) {
          o.error = '--port needs a port number.';
          break;
        }
        o.port = n;
      } else o[a.slice(2)] = v;
    } else if (a === '--') {
      o.words.push(...argv.slice(i + 1));
      break;
    } else if (a.startsWith('--')) {
      o.error = `Unknown option ${a}.`;
      break;
    } else o.words.push(a);
  }
  return o;
}

async function defaultPort() {
  const env = Number(process.env.MAGNUSIM_PORT || process.env.CFDDESK_PORT);
  if (Number.isInteger(env) && env > 0) return env;
  try {
    const { listenPort } = await import('./prefs.js');
    return listenPort();
  } catch {
    return 8082;
  }
}

function call(port, method, path, body) {
  const payload = body === undefined ? undefined : JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        method,
        path,
        agent: false,
        headers: {
          host: `127.0.0.1:${port}`,
          accept: 'application/json',
          ...(payload !== undefined ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } : {}),
        },
      },
      (res) => {
        let text = '';
        res.setEncoding('utf8');
        res.on('data', (d) => (text += d));
        res.on('end', () => {
          let json = null;
          try {
            json = text ? JSON.parse(text) : null;
          } catch {
            /* not JSON */
          }
          resolve({ status: res.statusCode || 0, json });
        });
        res.on('error', reject);
      },
    );
    req.on('error', reject);
    if (payload !== undefined) req.write(payload);
    req.end();
  });
}

/** Lines typed (or piped) into the terminal, kept until a question takes one. */
class Lines {
  constructor(input, interactive) {
    this.queue = [];
    this.waiting = null;
    this.closed = false;
    this.interactive = interactive;
    this.rl = readline.createInterface({ input, terminal: false });
    this.rl.on('line', (line) => {
      if (this.waiting) {
        const w = this.waiting;
        this.waiting = null;
        w(line);
      } else this.queue.push(line);
    });
    this.rl.on('close', () => {
      this.closed = true;
      if (this.waiting) {
        const w = this.waiting;
        this.waiting = null;
        w(null);
      }
    });
  }

  /** The next line (null when the input ended or `signal` aborted). Keys typed before a question don't answer it. */
  next(signal) {
    if (this.interactive) this.queue.length = 0;
    if (this.queue.length) return Promise.resolve(this.queue.shift());
    if (this.closed) return Promise.resolve(null);
    return new Promise((resolve) => {
      const onAbort = () => {
        if (this.waiting === done) this.waiting = null;
        resolve(null);
      };
      const done = (line) => {
        signal?.removeEventListener('abort', onAbort);
        resolve(line);
      };
      this.waiting = done;
      signal?.addEventListener('abort', onAbort, { once: true });
    });
  }

  close() {
    this.rl.close();
  }
}

export async function main(argv = process.argv.slice(2), io = { stdin: process.stdin, stdout: process.stdout, stderr: process.stderr }) {
  const o = parseArgs(argv);
  const out = (s) => io.stdout.write(s);
  const err = (s) => io.stderr.write(s);
  if (o.help) {
    out(`${HELP}\n`);
    return 0;
  }
  const prompt = o.words.join(' ').trim();
  if (o.error || !prompt) {
    err(`${o.error || 'Write what the Assistant should do.'}\n\n${HELP}\n`);
    return 1;
  }
  const port = o.port ?? (await defaultPort());
  const api = (method, path, body) => call(port, method, path, body);

  let tab = o.tab;
  try {
    if (tab === 'auto') {
      const r = await api('GET', '/api/assistant/tabs');
      if (r.status !== 200 || !r.json?.ok) {
        err(`${r.json?.error || `The app answered HTTP ${r.status}.`}\n`);
        return 1;
      }
      const connected = r.json.tabs.filter((t) => t.connected);
      if (connected.length === 1) tab = connected[0].tab;
      else if (connected.length > 1) {
        err(`More than one app tab offers tools: ${connected.map((t) => t.tab).join(', ')}. Pass --tab <id>.\n`);
        return 1;
      } else if (r.json.tabs.length) {
        err(
          "That tab isn't connected to the Assistant: its window is in the background or covered, or it was closed. Show the Magnusim window and try again.\n",
        );
        return TAB_HIDDEN_EXIT;
      } else {
        err('No app tab offers tools to the Assistant. Open a workspace in Magnusim, or leave out --tab.\n');
        return 1;
      }
    }
  } catch (e) {
    err(`Nothing answered on port ${port}. Is Magnusim running? (${e?.code || e?.message || e})\n`);
    return 1;
  }

  let started;
  try {
    started = await api('POST', '/api/assistant/turns', {
      text: prompt,
      ...(o.conversation ? { conversation: o.conversation } : {}),
      ...(tab ? { tab } : {}),
      ...(o.project ? { context: { project_id: o.project } } : {}),
    });
  } catch (e) {
    err(`Nothing answered on port ${port}. Is Magnusim running? (${e?.code || e?.message || e})\n`);
    return 1;
  }
  if (started.status !== 202 || !started.json?.ok) {
    const j = started.json || {};
    if (o.json) out(`${JSON.stringify({ type: 'refused', status: started.status, code: j.code ?? null, error: j.error ?? null })}\n`);
    err(`${j.error || `The app answered HTTP ${started.status}.`}\n`);
    return j.code === 'tab_hidden' ? TAB_HIDDEN_EXIT : 1;
  }
  const turn = started.json.turn;
  const conversation = started.json.conversation;
  if (o.json) out(`${JSON.stringify({ type: 'started', turn, conversation })}\n`);

  const lines = new Lines(io.stdin, !!io.stdin.isTTY);
  let atLineStart = true;
  const print = (s) => {
    if (!s) return;
    out(s);
    atLineStart = s.endsWith('\n');
  };
  const line = (s) => {
    if (!atLineStart) print('\n');
    print(`${s}\n`);
  };

  // Ctrl+C: stop the turn; a second one leaves at once.
  let stopping = false;
  const onInt = () => {
    if (stopping) {
      lines.close();
      process.exit(130);
    }
    stopping = true;
    if (!o.json) line('Stopping…');
    api('POST', `/api/assistant/turns/${encodeURIComponent(turn)}/stop`, {}).catch(() => {});
  };
  process.on('SIGINT', onInt);

  // One question at a time; the poll goes on meanwhile (an answer in the app closes it here).
  const asking = new Map();
  let questions = Promise.resolve();
  const ask = (gate) => {
    const ac = new AbortController();
    asking.set(gate.id, ac);
    questions = questions.then(async () => {
      if (ac.signal.aborted) return;
      const say = o.json ? err : (s) => line(s.replace(/\n$/, ''));
      say(`? ${gate.title}\n`);
      say(`  ${gate.copy}\n`);
      for (const d of gate.detail || []) say(`  ${d.label}: ${d.value}\n`);
      say(`  y = ${gate.yes}, n = ${gate.no}${tab ? ' (waiting for an answer in the app; you can also answer here)' : ''}\n`);
      if (o.json) err('(y/N) ');
      else print('(y/N) ');
      const answer = await lines.next(ac.signal);
      asking.delete(gate.id);
      if (ac.signal.aborted) return;
      if (!o.json && !atLineStart) print('\n');
      if (answer === null) {
        // The input ended: the question stays open for the app, or times out as a no.
        if (!o.json) line(tab ? '(waiting for an answer in the app)' : '(no answer given)');
        if (!tab) await api('POST', `/api/assistant/gates/${encodeURIComponent(gate.id)}`, { allow: false }).catch(() => {});
        return;
      }
      const allow = /^\s*y(es)?\s*$/i.test(answer);
      const r = await api('POST', `/api/assistant/gates/${encodeURIComponent(gate.id)}`, { allow }).catch(() => null);
      if (!o.json && r?.status === 409) line('(already answered)');
    });
  };

  let since = 0;
  let end = null;
  let usd = 0;
  const progressShown = new Map();
  try {
    for (;;) {
      const r = await api('GET', `/api/assistant/turns/${encodeURIComponent(turn)}?since=${since}&wait_ms=${POLL_WAIT_MS}`);
      if (r.status !== 200 || !r.json?.ok) {
        err(`${r.json?.error || `The app answered HTTP ${r.status}.`}\n`);
        return 1;
      }
      for (const e of r.json.events) {
        if (o.json) out(`${JSON.stringify(e)}\n`);
        switch (e.type) {
          case 'text':
            if (!o.json) print(e.text);
            break;
          case 'discard':
            if (!o.json) line('(the answer above was discarded)');
            break;
          case 'tool_call':
            if (!o.json) line(`→ ${e.tool} ${e.input_preview}`);
            break;
          case 'tool_progress': {
            const shown = `${e.label}|${e.fraction === null ? '' : Math.floor(e.fraction * 10)}`;
            if (!o.json && progressShown.get(e.call) !== shown) {
              progressShown.set(e.call, shown);
              line(`  … ${e.label}${e.fraction === null ? '' : ` (${Math.round(e.fraction * 100)}%)`}`);
            }
            break;
          }
          case 'tool_result':
            if (!o.json) line(e.ok ? `✓ ${e.summary}` : `✗ ${e.code || 'failed'}: ${e.summary}`);
            break;
          case 'note':
            if (!o.json) line(`note: ${e.text}`);
            break;
          case 'fallback':
            if (!o.json) line(`note: answered by ${e.to} instead of ${e.from}`);
            break;
          case 'gate':
            ask(e.gate);
            break;
          case 'gate_closed': {
            const ac = asking.get(e.gate);
            if (ac) {
              asking.delete(e.gate);
              ac.abort();
              if (!o.json) line(e.by === 'timeout' ? '(no answer in time: not allowed)' : `(answered: ${e.answer === 'allow' ? 'allowed' : 'not allowed'})`);
            }
            break;
          }
          case 'usage':
            usd = e.turn_usd;
            break;
          case 'end':
            end = e;
            break;
          default:
            break;
        }
      }
      since = r.json.next;
      if (r.json.ended) break;
    }
  } catch (e) {
    err(`Lost the app on port ${port} (${e?.code || e?.message || e}).\n`);
    return 1;
  } finally {
    process.off('SIGINT', onInt);
    for (const ac of asking.values()) ac.abort();
    lines.close();
  }
  if (!o.json) {
    if (end?.message) line(end.state === 'done' ? end.message : `[${end.state}] ${end.message}`);
    else if (end && end.state !== 'done') line(`[${end.state}] ${end.reason}`);
    else if (!atLineStart) print('\n');
    err(`(conversation ${conversation}${usd > 0 ? `, $${usd.toFixed(4)} this turn` : ''}; continue it with --conversation ${conversation})\n`);
  }
  return end?.state === 'done' ? 0 : 1;
}

const isMain = (() => {
  try {
    return !!process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
  } catch {
    return false;
  }
})();

/** Leaves once the output is written (process.exit could cut a piped stdout short). */
function leave(code) {
  process.exitCode = code;
  process.stdin.destroy();
  setTimeout(() => process.exit(code), 2_000).unref();
}

if (isMain) {
  main().then(leave, (e) => {
    process.stderr.write(`${e?.stack || e}\n`);
    leave(1);
  });
}
