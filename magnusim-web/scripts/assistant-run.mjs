#!/usr/bin/env node
/**
 * The Assistant from a terminal (Foundation spec 9.4): a developer tool that runs one
 * turn in the Magnusim app on this PC and prints what happens.
 *
 *   node scripts/assistant-run.mjs [--port N] [--provider <id> | --agent <id>] [--tab auto|<id>]
 *                                  [--project <id>] [--conversation <id>] [--image <file>]... [--json] "prompt"
 *
 * It talks to the app's own routes over loopback (POST /api/assistant/turns, then the
 * long-poll GET /api/assistant/turns/:id). `--provider` goes to the app as it is: the app
 * checks it, and its refusal names the providers (this file keeps no list of them).
 * `--agent <id>` is `--provider agent:<id>`: a coding agent the person already uses. A turn on
 * a coding agent needs this account's proof: the app's per-launch token, read from its
 * owner-only connection file (mcp.json, found as the MCP bridge finds it) and sent in the
 * x-magnusim-launch header, never printed. It is sent only to an app that first proved it
 * holds that token (POST /api/assistant/launch/check: an HMAC of a fresh nonce and the port it
 * was reached on), never to whatever else answers on the port. When the app refuses a turn for
 * want of it (a default or a conversation that is a coding agent, or a file read before the app
 * restarted), the file is read again and, once the app proved it, the start sent once more.
 * Such a turn prints the agent's plan,
 * its own tools, its permission requests, its mode and model, and at the end that its own
 * account pays.
 * Questions are asked here (y/n): for a turn with no tab they are asked only here; for a
 * turn bound to an app tab the app shows them too, and either answer counts. Only a line
 * typed after a question shows answers it.
 * An answer carries the turn's answer key (from the start's 202): only the program that
 * started a turn, or the app tab that shows its question, may answer it. A question for the
 * Magnusim window only (link_only) is shown here but answered there.
 * `--image <file>` (up to 4) sends a PNG, JPEG or WebP reference picture with the prompt; the app
 * checks it (at most 1.5 MB and 2000 px a side) and its privacy rules hold for it as for the prompt.
 * A coding agent gets it only if the agent says it takes pictures; otherwise the turn ends with
 * the app's words and nothing is sent to the agent.
 * A review round the workspace asked for prints as `review: round i of n`.
 * `--tab auto` is resolved by the app (the only connected tab). Ctrl+C stops the turn
 * (twice: leave at once).
 *
 * Exit codes: 0 the turn finished (`done`), 1 anything else, 2 the tab isn't connected.
 */
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import http from 'node:http';
import { readFileSync, realpathSync } from 'node:fs';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';

export const HELP = `Usage: node scripts/assistant-run.mjs [--port N] [--provider <id> | --agent <id>] [--tab auto|<id>] [--project <id>] [--conversation <id>] [--image <file>]... [--json] "prompt"

Runs one Assistant turn in the Magnusim app on this PC and prints what happens: the
answer, each tool call (→) and its result (✓ or ✗, with the tool's hint under a failed
one), notes and questions. Questions are asked here (y/n): only a line typed after a
question shows answers it. A turn bound to an app tab also shows them in the app; either
answer counts. A question for the Magnusim window only is shown here and answered there.
Ctrl+C stops the turn.

  --port N             the app's port (default: the app's own setting, else 8082)
  --provider <id>      a provider as Settings → Assistant names it, or agent:<id>; without
                       it the conversation's own, else the default from Settings → Assistant
  --agent <id>         a coding agent Settings → Assistant lists (= --provider agent:<id>)
  --tab auto|<id>      bind the turn to an app tab's workspace (auto: the only connected one)
  --project <id>       the project the turn is about (without a tab)
  --conversation <id>  continue a conversation (its id is printed at the end)
  --image <file>       a reference picture (PNG, JPEG or WebP, at most 1.5 MB and 2000 px
                       a side) sent with the prompt; up to 4
  --json               print each event as one line of JSON

Keep the Magnusim window visible when you start a turn. It may then be covered for up to 10 minutes between turns.

Exit codes: 0 the turn finished, 1 it did not, 2 the app tab isn't connected.`;

const TAB_HIDDEN_EXIT = 2;
const POLL_WAIT_MS = 25_000;
export const SIGN_IN_LINE = 'Sign in, then run the same command again.';

/**
 * This launch's token from the app's connection file (mcp.json, found by the MCP bridge's own
 * rules: the same home as the app's), or null. Read fresh each time: the app writes a new one at
 * each start. Never printed.
 */
export async function launchToken(o = {}) {
  try {
    const { bridgeInfoPath } = await import('./assistant-mcp.mjs');
    const raw = readFileSync(bridgeInfoPath(o.info ?? null, o), 'utf8');
    const doc = JSON.parse(raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw);
    return doc && typeof doc.token === 'string' && doc.token ? doc.token : null;
  } catch {
    return null;
  }
}

/**
 * Whether the app answering on `port` holds `token`, before the token is sent to it: it must
 * answer POST /api/assistant/launch/check {nonce} with HMAC-SHA256(token, "l<port>:<nonce>")
 * for a fresh nonce. Anything else on that port (a wrong --port, a port saved in Settings that
 * the app hasn't restarted on yet) can't, and one that passes the check on to the app's real
 * port gets an answer bound to that other port. Never throws.
 */
export async function appHoldsToken(port, token) {
  if (typeof token !== 'string' || !token) return false;
  const nonce = randomBytes(16).toString('hex');
  try {
    const r = await call(port, 'POST', '/api/assistant/launch/check', { nonce });
    const proof = r.json?.proof;
    if (r.status !== 200 || typeof proof !== 'string' || !/^[0-9a-f]{64}$/.test(proof)) return false;
    return timingSafeEqual(Buffer.from(proof, 'hex'), createHmac('sha256', token).update(`l${port}:${nonce}`).digest());
  } catch {
    return false;
  }
}

/** This launch's token once the app on `port` proved it holds it: {token}, or {token: null, unproven} when a token was found but the app didn't prove it. */
async function provenToken(port) {
  const token = await launchToken();
  if (!token) return { token: null, unproven: false };
  return (await appHoldsToken(port, token)) ? { token, unproven: false } : { token: null, unproven: true };
}

export function parseArgs(argv) {
  const o = { port: null, provider: null, tab: null, project: null, conversation: null, images: [], json: false, help: false, words: [], error: null };
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
    else if (a === '--image') {
      const v = value(i, a);
      if (v === null) break;
      i += 1;
      o.images.push(v);
    } else if (a === '--port' || a === '--provider' || a === '--agent' || a === '--tab' || a === '--project' || a === '--conversation') {
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
      } else if (a === '--agent') o.provider = `agent:${v}`;
      else o[a.slice(2)] = v;
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

/** The most pictures a turn carries (the app checks each one). */
export const IMAGES_MAX = 4;
const IMAGE_TYPES = Object.freeze({ '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp' });

/** `--image` files as the start's `images` ({media_type, data}), or {error} in words. The app checks what they hold. */
export function readImages(files) {
  if (files.length > IMAGES_MAX) return { error: `At most ${IMAGES_MAX} --image files go with a request.` };
  const images = [];
  for (const f of files) {
    const ext = (/\.[^./\\]+$/.exec(f)?.[0] ?? '').toLowerCase();
    const type = IMAGE_TYPES[ext];
    if (!type) return { error: `${f}: --image takes a .png, .jpg, .jpeg or .webp file.` };
    let bytes;
    try {
      bytes = readFileSync(f);
    } catch (e) {
      return { error: `${f} could not be read (${e?.code || e?.message || e}).` };
    }
    images.push({ media_type: type, data: bytes.toString('base64') });
  }
  return { images };
}

/** The app's port, picked as the app picks it (prefs.js listenPort: the saved port, then MAGNUSIM_PORT, then 8082). */
async function defaultPort() {
  try {
    const { listenPort } = await import('./prefs.js');
    return listenPort();
  } catch {
    return 8082;
  }
}

/** Controls, line and paragraph separators and bidi controls; \n and \t are kept. */
const CONTROLS = /[\p{Cc}\p{Bidi_Control}\p{Zl}\p{Zp}]/gu;

/** Model text for the terminal: nothing it could act on (escape sequences, carriage returns, bidi). */
export function plainText(text) {
  return String(text ?? '').replace(CONTROLS, (c) => (c === '\n' || c === '\t' ? c : ''));
}

function call(port, method, path, body, extraHeaders = {}) {
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
          ...extraHeaders,
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

/**
 * Lines typed into the terminal, each for the question open when it came. A line typed while
 * no question is open answers nothing, whether stdin is a terminal or a pipe (Git Bash's
 * mintty, an IDE panel): the model's text can look like a question, and a "y" typed at it
 * must not answer the real one that opens next.
 */
class Lines {
  constructor(input) {
    this.waiting = null;
    this.closed = false;
    this.rl = readline.createInterface({ input, terminal: false });
    this.rl.on('line', (line) => {
      if (!this.waiting) return;
      const w = this.waiting;
      this.waiting = null;
      w(line);
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

  /** The next line typed from now on (null when the input ended or `signal` aborted). */
  next(signal) {
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

/** One agent event as a line (null: nothing to print). Titles and labels are the app's cleaned text. */
export function agentLine(e) {
  switch (e.type) {
    case 'agent':
      return `${plainText(e.name)}${e.version ? ` ${plainText(e.version)}` : ''} is working (its own tools are ${e.own_tools === 'off' ? 'off' : 'on'}).`;
    case 'plan': {
      const mark = { pending: '[ ]', in_progress: '[~]', completed: '[x]' };
      return ['plan:', ...(e.entries || []).map((x) => `  ${mark[x.status] ?? '[ ]'} ${plainText(x.content)}`)].join('\n');
    }
    case 'agent_tool':
      return `agent: ${plainText(e.title) || plainText(e.kind)} (${e.status})`;
    case 'agent_permission':
      if (e.outcome === 'auto_allowed') return `auto-allowed: ${plainText(e.title)}`;
      return `agent asked: ${plainText(e.title)} (${e.outcome === 'allowed' ? 'allowed' : e.outcome === 'declined' ? `not allowed${e.by === 'timeout' ? ', no answer in time' : ''}` : 'cancelled'})`;
    case 'agent_mode':
      return `mode: ${plainText(e.label || e.mode)}`;
    case 'agent_model':
      return `model: ${plainText(e.label || e.model)}`;
    default:
      return null;
  }
}

/** The end's billing line for a turn its coding agent's own account pays. */
export function billingLine(summary) {
  if (summary?.billing !== 'agent_account') return null;
  const name = plainText(summary.agent?.name || 'coding agent');
  return `Billed to your ${name} account (Magnusim can't see the cost).`;
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
  const pictures = readImages(o.images);
  if (pictures.error) {
    err(`${pictures.error}\n`);
    return 1;
  }
  const port = o.port ?? (await defaultPort());
  const api = (method, path, body) => call(port, method, path, body);

  // 'auto' goes as it is: the app picks the only connected tab, or says why it can't (resolveTab).
  const tab = o.tab;
  const startBody = {
    text: prompt,
    ...(o.conversation ? { conversation: o.conversation } : {}),
    ...(o.provider ? { provider: o.provider } : {}),
    ...(tab ? { tab } : {}),
    ...(o.project ? { context: { project_id: o.project } } : {}),
    ...(pictures.images.length ? { images: pictures.images } : {}),
  };
  // A coding agent's turn carries this account's proof (the app's per-launch token), only to an
  // app that proved it holds that token (never to whatever else answers on the port).
  const withToken = (token) => (token ? { 'x-magnusim-launch': token } : {});
  const isAgent = typeof o.provider === 'string' && o.provider.startsWith('agent:');
  let started;
  /** A token was found but the app did not prove it holds it (so none was sent). */
  let unproven;
  try {
    const first = isAgent ? await provenToken(port) : { token: null, unproven: false };
    unproven = first.unproven;
    started = await call(port, 'POST', '/api/assistant/turns', startBody, withToken(first.token));
    // No token sent, or one of an earlier launch: the file once more (the app has just written
    // it), sent only once the app proved it holds that one.
    if (started.status === 403 && started.json?.code === 'launch_proof') {
      const again = await provenToken(port);
      unproven = again.unproven;
      if (again.token) started = await call(port, 'POST', '/api/assistant/turns', startBody, withToken(again.token));
    }
  } catch (e) {
    err(`Nothing answered on port ${port}. Is Magnusim running? (${e?.code || e?.message || e})\n`);
    return 1;
  }
  if (started.status !== 202 || !started.json?.ok) {
    const j = started.json || {};
    if (o.json) out(`${JSON.stringify({ type: 'refused', status: started.status, code: j.code ?? null, error: j.error ?? null })}\n`);
    err(`${j.error || `The app answered HTTP ${started.status}.`}\n`);
    if (j.code === 'launch_proof' && unproven) err(`What answers on port ${port} didn't prove it is the Magnusim that wrote the connection file, so the launch token was not sent. Check --port.\n`);
    return j.code === 'tab_hidden' ? TAB_HIDDEN_EXIT : 1;
  }
  const turn = started.json.turn;
  const conversation = started.json.conversation;
  // Answers this turn's questions; never printed (not with --json either).
  const answerKey = typeof started.json.answer_key === 'string' ? started.json.answer_key : '';
  const answerGate = (id, allow) => api('POST', `/api/assistant/gates/${encodeURIComponent(id)}`, { allow, answer_key: answerKey });
  if (o.json) out(`${JSON.stringify({ type: 'started', turn, conversation })}\n`);

  const lines = new Lines(io.stdin);
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
      if (gate.link_only === true) {
        // Only the Magnusim window that shows it can answer it (its gate_closed still prints here).
        say('  Answer it in the Magnusim window.\n');
        return;
      }
      say(`  y = ${gate.yes}, n = ${gate.no}${tab ? ' (waiting for an answer in the app; you can also answer here)' : ''}\n`);
      // Listening before the prompt shows, so no line typed at it can be missed.
      const answering = lines.next(ac.signal);
      if (o.json) err('(y/N) ');
      else print('(y/N) ');
      const answer = await answering;
      asking.delete(gate.id);
      if (ac.signal.aborted) return;
      if (!o.json && !atLineStart) print('\n');
      if (answer === null) {
        // The input ended: the question stays open for the app, or times out as a no.
        if (!o.json) line(tab ? '(waiting for an answer in the app)' : '(no answer given)');
        if (!tab) await answerGate(gate.id, false).catch(() => {});
        return;
      }
      const allow = /^\s*y(es)?\s*$/i.test(answer);
      const r = await answerGate(gate.id, allow).catch(() => null);
      if (!o.json && r?.status === 409) line('(already answered)');
    });
  };

  let since = 0;
  let end = null;
  let usd = 0;
  let summary = null;
  const progressShown = new Map();
  try {
    for (;;) {
      const r = await api('GET', `/api/assistant/turns/${encodeURIComponent(turn)}?since=${since}&wait_ms=${POLL_WAIT_MS}`);
      if (r.status !== 200 || !r.json?.ok) {
        err(`${r.json?.error || `The app answered HTTP ${r.status}.`}\n`);
        return 1;
      }
      summary = r.json.turn ?? summary;
      for (const e of r.json.events) {
        if (o.json) out(`${JSON.stringify(e)}\n`);
        switch (e.type) {
          case 'text':
            if (!o.json) print(plainText(e.text));
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
            if (!o.json) {
              line(e.ok ? `✓ ${e.summary}` : `✗ ${e.code || 'failed'}: ${e.summary}`);
              // How the tool says to fix it (the model has it too).
              if (!e.ok && e.hint) line(`  hint: ${plainText(e.hint)}`);
            }
            break;
          case 'note':
            if (!o.json) line(`note: ${e.text}`);
            break;
          case 'review':
            if (!o.json) line(`review: round ${e.round} of ${e.of}`);
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
          case 'agent':
          case 'plan':
          case 'agent_tool':
          case 'agent_permission':
          case 'agent_mode':
          case 'agent_model': {
            const shown = o.json ? null : agentLine(e);
            if (shown) line(shown);
            break;
          }
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
    if (end?.reason === 'agent_signin') line(SIGN_IN_LINE);
    const billed = billingLine(summary);
    if (billed) line(billed);
    err(`(conversation ${conversation}${usd > 0 ? `, $${usd.toFixed(4)} this turn` : ''}; continue it with --conversation ${conversation})\n`);
  }
  return end?.state === 'done' ? 0 : 1;
}

// By real paths: through a junction or a directory link argv[1] names the link while
// import.meta.url names the real file (the test imports this module, so a guard stays).
const isMain = (() => {
  try {
    return !!process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
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
