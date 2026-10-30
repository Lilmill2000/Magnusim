/**
 * The Assistant's chat history (Daniel: "save 31 days"): a conversation lives in memory only
 * (conversations.ts), so each request's end also appends one JSON line to
 *
 *   <assistant home>/assistant/chats/<project>/<conversation id>.jsonl
 *
 * where <project> is the project's id, `_home` for a chat on Home, and `x-<32 hex>` (its
 * SHA-256) for an id that is no plain file name.
 *
 * - A line (HistoryLine) holds the person's prompt, the model's text, one line per tool step (its
 *   tool, title, ok or its code, and the result's one-line summary: never its data), how the
 *   request ended (state, reason, message; why the conversation was full), where its words went
 *   (`destination`: chat_history asks before they go anywhere else), its usage and times.
 *   Pictures only by their count, files by their names. Every string is redacted (redact.ts: the
 *   keys this server knows, anything shaped like one) and loses each run of base64. A line is at
 *   most HISTORY_LIMITS.lineBytes: past it the answer, the steps and the prompt are cut until it
 *   fits, and `cut` names what was.
 * - Lines go through one queue per file, in order. One that can't be written is logged and lost;
 *   the request itself never fails for it.
 * - Kept 31 days, as the spend ledger keeps its days (ledger.ts KEEP_DAYS, by the server's local
 *   date): the sweep, at boot and every 6 h, removes a file whose last line ended longer ago (an
 *   unreadable one by its modified time) and an emptied project folder. Deleting a project
 *   removes its folder (forgetProject: assistant-routes.ts hears w16-project-geometry.js
 *   deleteProject through project-deleted.ts), and no later line of that project is written.
 * - list(): a project's saved chats, newest first; read(): one chat's lines, a page at a time;
 *   clear(): every chat of a project. The dock's History and Clear history (assistant-routes.ts)
 *   and the AI's chat_history tool (host/chat-history.ts) use these three; find() is Continue in
 *   a new chat's (turns.ts carry_from) for a chat whose conversation is gone.
 *
 * The store is one per folder per process, on globalThis (a Vite re-import of this module shares
 * it). Nothing runs when the module loads, and nothing makes the folder before a line comes.
 */
import { createHash } from 'node:crypto';
import { appendFile, open, readdir, readFile, rmdir, stat, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { removeTree } from '../../remove-tree.js';
import { ensurePrivateDir } from './files.ts';
import { assistantDataDir } from './home.ts';
import { dayNumber, KEEP_DAYS, todayKey } from './ledger.ts';
import { alog } from './log.ts';
import { redact } from './redact.ts';

export const HISTORY_LIMITS = Object.freeze({
  keepDays: KEEP_DAYS,
  /** One line, in UTF-8 bytes. */
  lineBytes: 64 * 1024,
  promptBytes: 16 * 1024,
  /** The model's text (its end is kept). */
  answerBytes: 32 * 1024,
  /** Tool steps a line keeps (the rest only counted). */
  steps: 100,
  /** A step's result line, in characters. */
  stepLine: 300,
  /** Chats list() gives at most. */
  list: 200,
  /** Lines one read() gives at most, and their bytes. */
  page: 50,
  pageBytes: 1024 * 1024,
  /** The sweep's period. */
  sweepEveryMs: 6 * 60 * 60 * 1000,
});

/** A conversation id as conversations.ts makes them (newConversationId): the only file names written or read. */
export const CONVERSATION_ID_RE = /^c-[0-9a-z]{1,16}-[0-9a-f]{8}$/;
/** A Home chat's folder. */
export const HOME_KEY = '_home';
const PLAIN_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
/** Names Windows keeps for devices: never a folder's. */
const DEVICE_NAME = /^(con|prn|aux|nul|com\d|lpt\d)(\.|$)/i;
const BASE64_RUN = /(?:data:[\w.+-]{1,40}\/[\w.+-]{1,40};base64,)?[A-Za-z0-9+/]{200,}={0,2}/g;
export const DATA_LEFT_OUT = '[data left out]';

/** The folder name of a project's chats (null: Home). */
export function historyKey(projectId: string | null): string {
  if (projectId === null || projectId === '') return HOME_KEY;
  if (PLAIN_ID.test(projectId) && !/\.$/.test(projectId) && !DEVICE_NAME.test(projectId)) return projectId;
  return `x-${createHash('sha256').update(projectId).digest('hex').slice(0, 32)}`;
}

/** One tool step as a line keeps it. */
export interface HistoryStep {
  /** The model's step (one answer) it was called in. */
  step: number;
  tool: string;
  title: string;
  /** null: it never answered (the request ended first). */
  ok: boolean | null;
  code: string | null;
  /** The result's one-line summary. */
  line: string;
}

/** One request of a saved chat. */
export interface HistoryLine {
  v: 1;
  turn: string;
  conversation: string;
  project_id: string | null;
  provider: string;
  /**
   * Where its words went (providers/index.ts destinationOf: `anthropic`, `openai`, `host:<name>`,
   * `agent:<id>`); absent on a line written before it was kept (lineDestination).
   */
  destination?: string;
  /** How the person reads its provider: the provider's label, or the coding agent's name. */
  label: string;
  model: string;
  /** The conversation's title (its first request's). */
  title: string;
  prompt: string;
  /** The person's pictures sent with it (only their number). */
  pictures: number;
  /** The files attached to it, by name. */
  files: string[];
  /** Everything the model said in it, step after step (its end kept when cut). */
  answer: string;
  steps: HistoryStep[];
  /** Tool steps not kept (past HISTORY_LIMITS.steps, or cut to fit). */
  steps_left_out: number;
  end: { state: string; reason: string; message: string | null };
  /** Why its conversation was full after it, in the person's words (null while it was not). */
  full: string | null;
  usage: { usd: number; estimated: boolean; tokens: number; steps: number; billing: string };
  started_by: string;
  started_at: string;
  ended_at: string;
  /** The conversation it continued (Continue in a new chat), or null. */
  carried_from: string | null;
  /** The fields cut to fit the line. */
  cut?: string[];
}

/** What a request's end gives the history (turns.ts Turn.historyInput): plain values, not yet cleaned. */
export type HistoryInput = Omit<HistoryLine, 'v' | 'cut'>;

/** A saved chat as list() names it. */
export interface HistoryChat {
  id: string;
  title: string;
  provider: string;
  label: string;
  model: string;
  /** Where its words went (its first and its last saved request's: lineDestination), each once. */
  destinations: string[];
  /** Its first saved request's start, and its last one's end. */
  started_at: string;
  ended_at: string;
  /** Its first saved prompt (at most 300 characters). */
  first_prompt: string;
  /** How its last saved request ended. */
  end_state: string;
  /** Its conversation was full after its last request. */
  full: boolean;
}

/** A page of one chat (read()). */
export interface HistoryPage {
  chat: HistoryChat;
  /** Its requests saved, in all. */
  total: number;
  from: number;
  lines: HistoryLine[];
  /** Where the next page starts (null: none). */
  next: number | null;
}

const utf8 = (s: string) => Buffer.byteLength(s, 'utf8');

/** `s` cut to at most `max` UTF-8 bytes, never inside a character: its start, or (`fromEnd`) its end. */
function cutTo(s: string, max: number, fromEnd = false): string {
  if (utf8(s) <= max) return s;
  const chars = [...s];
  if (fromEnd) chars.reverse();
  const out: string[] = [];
  let n = 0;
  for (const c of chars) {
    n += utf8(c);
    if (n > max) break;
    out.push(c);
  }
  if (fromEnd) out.reverse();
  return out.join('');
}

const firstChars = (s: string, max: number) => {
  const chars = [...s];
  return chars.length > max ? chars.slice(0, max).join('') : s;
};

/** A string as a line keeps it: redacted, no base64. */
export function scrub(v: unknown): string {
  return redact(typeof v === 'string' ? v : v == null ? '' : String(v)).replace(BASE64_RUN, DATA_LEFT_OUT);
}

/**
 * Where a line's words went: its `destination`, else (a line written before that was kept) its
 * provider for a cloud provider or a coding agent, and '' (not known) for a local server's.
 */
export function lineDestination(l: Pick<HistoryLine, 'provider' | 'destination'>): string {
  if (typeof l.destination === 'string' && l.destination) return l.destination;
  return l.provider === 'openai_compatible' ? '' : String(l.provider ?? '');
}

/** The line for `input`, as its JSON text (no newline), at most HISTORY_LIMITS.lineBytes. */
export function historyLine(input: HistoryInput): string {
  const L = HISTORY_LIMITS;
  const cut = new Set<string>();
  const capped = (field: string, s: string, max: number, fromEnd = false) => {
    const out = cutTo(s, max, fromEnd);
    if (out !== s) cut.add(field);
    return out;
  };
  const steps = input.steps.slice(0, L.steps).map((s) => ({
    step: Math.max(0, Math.floor(Number(s.step) || 0)),
    tool: firstChars(scrub(s.tool), 120),
    title: firstChars(scrub(s.title), 120),
    ok: s.ok === null ? null : !!s.ok,
    code: s.code === null ? null : firstChars(scrub(s.code), 60),
    line: firstChars(scrub(s.line), L.stepLine),
  }));
  const line: HistoryLine = {
    v: 1,
    turn: firstChars(scrub(input.turn), 64),
    conversation: firstChars(scrub(input.conversation), 64),
    project_id: input.project_id === null ? null : firstChars(scrub(input.project_id), 200),
    provider: firstChars(scrub(input.provider), 80),
    ...(input.destination ? { destination: firstChars(scrub(input.destination), 300) } : {}),
    label: firstChars(scrub(input.label), 80),
    model: firstChars(scrub(input.model), 120),
    title: firstChars(scrub(input.title), 200),
    prompt: capped('prompt', scrub(input.prompt), L.promptBytes),
    pictures: Math.max(0, Math.floor(Number(input.pictures) || 0)),
    files: input.files.slice(0, 4).map((f) => firstChars(scrub(f), 255)),
    answer: capped('answer', scrub(input.answer), L.answerBytes, true),
    steps,
    steps_left_out: Math.max(0, Math.floor(Number(input.steps_left_out) || 0)) + Math.max(0, input.steps.length - steps.length),
    end: { state: firstChars(scrub(input.end.state), 20), reason: firstChars(scrub(input.end.reason), 80), message: input.end.message === null ? null : firstChars(scrub(input.end.message), 2000) },
    full: input.full === null ? null : firstChars(scrub(input.full), 1000),
    usage: {
      usd: Number.isFinite(input.usage.usd) ? Math.round(input.usage.usd * 1e6) / 1e6 : 0,
      estimated: !!input.usage.estimated,
      tokens: Math.max(0, Math.floor(Number(input.usage.tokens) || 0)),
      steps: Math.max(0, Math.floor(Number(input.usage.steps) || 0)),
      billing: firstChars(scrub(input.usage.billing), 20),
    },
    started_by: firstChars(scrub(input.started_by), 20),
    started_at: firstChars(scrub(input.started_at), 40),
    ended_at: firstChars(scrub(input.ended_at), 40),
    carried_from: input.carried_from === null ? null : firstChars(scrub(input.carried_from), 64),
  };
  // Too long: the answer first (its end stays), then the steps (the first ones stay), then the prompt.
  const shrink: Array<() => void> = [
    () => (line.answer = capped('answer', line.answer, 8 * 1024, true)),
    () => keepSteps(30),
    () => (line.prompt = capped('prompt', line.prompt, 8 * 1024)),
    () => (line.answer = capped('answer', line.answer, 2 * 1024, true)),
    () => keepSteps(5),
    () => (line.prompt = capped('prompt', line.prompt, 2 * 1024)),
  ];
  function keepSteps(n: number): void {
    if (line.steps.length <= n) return;
    line.steps_left_out += line.steps.length - n;
    line.steps = line.steps.slice(0, n);
    cut.add('steps');
  }
  const text = () => JSON.stringify(cut.size ? { ...line, cut: [...cut].sort() } : line);
  for (const step of shrink) {
    if (utf8(text()) <= L.lineBytes) break;
    step();
  }
  return text();
}

/** A line read back (null: not one: a line cut short by a crash, or someone's edit). */
export function parseLine(raw: string): HistoryLine | null {
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!v || typeof v !== 'object') return null;
  const l = v as Partial<HistoryLine>;
  if (l.v !== 1 || typeof l.conversation !== 'string' || typeof l.prompt !== 'string' || typeof l.answer !== 'string' || !Array.isArray(l.steps) || !l.end || typeof l.end !== 'object') return null;
  if (typeof l.ended_at !== 'string' || typeof l.started_at !== 'string') return null;
  return l as HistoryLine;
}

function chatOf(id: string, first: HistoryLine, last: HistoryLine): HistoryChat {
  return {
    id,
    title: last.title || first.title || firstChars(first.prompt.split(/\r\n?|\n/)[0] ?? '', 60),
    provider: last.provider,
    label: last.label,
    model: last.model,
    destinations: [...new Set([lineDestination(first), lineDestination(last)])],
    started_at: first.started_at,
    ended_at: last.ended_at,
    first_prompt: firstChars(first.prompt, 300),
    end_state: String(last.end?.state ?? ''),
    full: typeof last.full === 'string' && last.full.length > 0,
  };
}

const codeOf = (err: unknown) => String((err as { code?: unknown } | null)?.code || '');

export class ChatHistory {
  readonly dir: string;
  private readonly now: () => number;
  /** Each file's write queue (the last write asked for; never rejects). */
  private readonly queues = new Map<string, Promise<void>>();
  /** Projects deleted in this process: no line of theirs is written again. */
  private readonly gone = new Set<string>();
  private sweepTimer: ReturnType<typeof setInterval> | null = null;
  private sweepUsers = 0;
  private sweeping: Promise<number> | null = null;

  constructor(o: { dir: string; now?: () => number }) {
    this.dir = o.dir;
    this.now = o.now ?? Date.now;
  }

  folderOf(projectId: string | null): string {
    return join(this.dir, historyKey(projectId));
  }

  private fileOf(projectId: string | null, conversation: string): string | null {
    return CONVERSATION_ID_RE.test(conversation) ? join(this.folderOf(projectId), `${conversation}.jsonl`) : null;
  }

  /** Appends a request's line to its chat (after the lines asked for before it). Resolves once written (or given up). */
  append(input: HistoryInput): Promise<void> {
    const key = historyKey(input.project_id);
    const file = this.fileOf(input.project_id, input.conversation);
    if (!file || this.gone.has(key)) return Promise.resolve();
    let text: string;
    try {
      text = historyLine(input);
    } catch (err) {
      alog('warn', 'a chat history line could not be made', { error: redact(err instanceof Error ? err.message : String(err)).slice(0, 200) });
      return Promise.resolve();
    }
    const before = this.queues.get(file) ?? Promise.resolve();
    const next = before.then(async () => {
      if (this.gone.has(key)) return;
      try {
        await ensurePrivateDir(join(this.dir, key));
        await appendFile(file, `${text}\n`, { encoding: 'utf8', mode: 0o600 });
      } catch (err) {
        alog('warn', 'a chat history line could not be written', { error: redact(err instanceof Error ? err.message : String(err)).slice(0, 200) });
      }
    });
    this.queues.set(file, next);
    void next.then(() => {
      if (this.queues.get(file) === next) this.queues.delete(file);
    });
    return next;
  }

  /** Every write asked for so far, done. */
  async flush(): Promise<void> {
    await Promise.all([...this.queues.values()]);
  }

  /** A file's lines that read back, in order. */
  private async linesOf(file: string): Promise<HistoryLine[]> {
    let raw: string;
    try {
      raw = await readFile(file, 'utf8');
    } catch (err) {
      if (codeOf(err) === 'ENOENT') return [];
      throw err;
    }
    const out: HistoryLine[] = [];
    for (const l of raw.split('\n')) {
      if (!l.trim()) continue;
      const parsed = parseLine(l);
      if (parsed) out.push(parsed);
    }
    return out;
  }

  /** A file's first and last lines that read back (null when none does), reading only its ends. */
  private async edgesOf(file: string): Promise<{ first: HistoryLine; last: HistoryLine } | null> {
    const span = HISTORY_LIMITS.lineBytes * 2 + 4;
    let fh;
    try {
      fh = await open(file, 'r');
    } catch (err) {
      if (codeOf(err) === 'ENOENT') return null;
      throw err;
    }
    try {
      const size = (await fh.stat()).size;
      if (size <= span) {
        const all = (await fh.readFile('utf8')).split('\n').map((l) => (l.trim() ? parseLine(l) : null)).filter((l): l is HistoryLine => !!l);
        return all.length ? { first: all[0], last: all[all.length - 1] } : null;
      }
      const head = Buffer.alloc(span);
      await fh.read(head, 0, span, 0);
      const tail = Buffer.alloc(span);
      await fh.read(tail, 0, span, size - span);
      // The head's last piece and the tail's first may be cut: only whole lines parse.
      const first = head.toString('utf8').split('\n').map((l) => (l.trim() ? parseLine(l) : null)).find((l): l is HistoryLine => !!l);
      const lastLines = tail.toString('utf8').split('\n').map((l) => (l.trim() ? parseLine(l) : null)).filter((l): l is HistoryLine => !!l);
      const last = lastLines[lastLines.length - 1];
      return first && last ? { first, last } : null;
    } finally {
      await fh.close().catch(() => undefined);
    }
  }

  /** A project's saved chats (null: Home's), newest end first, at most HISTORY_LIMITS.list; `total` counts them all. */
  async list(projectId: string | null): Promise<{ chats: HistoryChat[]; total: number }> {
    const folder = this.folderOf(projectId);
    let names: string[];
    try {
      names = await readdir(folder);
    } catch (err) {
      if (codeOf(err) === 'ENOENT') return { chats: [], total: 0 };
      throw err;
    }
    const chats: HistoryChat[] = [];
    for (const name of names) {
      const id = name.endsWith('.jsonl') ? name.slice(0, -'.jsonl'.length) : '';
      if (!CONVERSATION_ID_RE.test(id)) continue;
      const edges = await this.edgesOf(join(folder, name)).catch(() => null);
      if (edges) chats.push(chatOf(id, edges.first, edges.last));
    }
    chats.sort((a, b) => (Date.parse(b.ended_at) || 0) - (Date.parse(a.ended_at) || 0) || (a.id < b.id ? 1 : -1));
    return { chats: chats.slice(0, HISTORY_LIMITS.list), total: chats.length };
  }

  /**
   * One saved chat of a project, its lines from `from` (0: its first), at most `limit` and
   * HISTORY_LIMITS.pageBytes (at least one); null when it has none.
   */
  async read(projectId: string | null, conversation: string, o: { from?: number; limit?: number } = {}): Promise<HistoryPage | null> {
    const file = this.fileOf(projectId, conversation);
    if (!file) return null;
    const all = await this.linesOf(file);
    if (!all.length) return null;
    const from = Math.max(0, Math.min(all.length, Math.floor(o.from ?? 0)));
    const limit = Math.max(1, Math.min(HISTORY_LIMITS.page, Math.floor(o.limit ?? HISTORY_LIMITS.page)));
    const lines: HistoryLine[] = [];
    let bytes = 0;
    for (let i = from; i < all.length && lines.length < limit; i += 1) {
      const n = utf8(JSON.stringify(all[i]));
      if (lines.length && bytes + n > HISTORY_LIMITS.pageBytes) break;
      lines.push(all[i]);
      bytes += n;
    }
    const next = from + lines.length < all.length ? from + lines.length : null;
    return { chat: chatOf(conversation, all[0], all[all.length - 1]), total: all.length, from, lines, next };
  }

  /**
   * A saved chat by its conversation id, wherever it is (ids are unique; a conversation that
   * moved with its window to another project has lines in each): its lines from every folder,
   * oldest end first, and the key of the folder its newest line is in (where it was last); null
   * when none is saved.
   */
  async find(conversation: string): Promise<{ key: string; lines: HistoryLine[] } | null> {
    if (!CONVERSATION_ID_RE.test(conversation)) return null;
    let keys: string[];
    try {
      keys = await readdir(this.dir);
    } catch (err) {
      if (codeOf(err) === 'ENOENT') return null;
      throw err;
    }
    const found: Array<{ key: string; line: HistoryLine }> = [];
    for (const key of keys) {
      const lines = await this.linesOf(join(this.dir, key, `${conversation}.jsonl`)).catch(() => []);
      for (const line of lines) found.push({ key, line });
    }
    if (!found.length) return null;
    // A stable sort: one folder's lines keep their order.
    found.sort((a, b) => (Date.parse(a.line.ended_at) || 0) - (Date.parse(b.line.ended_at) || 0));
    return { key: found[found.length - 1].key, lines: found.map((f) => f.line) };
  }

  /** Clear history: every saved chat of a project (null: Home's) goes. Answers how many. */
  async clear(projectId: string | null): Promise<number> {
    const folder = this.folderOf(projectId);
    // Lines already on their way land first, so none comes back after the clear.
    await Promise.all([...this.queues].filter(([f]) => dirname(f) === folder).map(([, p]) => p));
    let names: string[];
    try {
      names = await readdir(folder);
    } catch (err) {
      if (codeOf(err) === 'ENOENT') return 0;
      throw err;
    }
    const n = names.filter((x) => x.endsWith('.jsonl')).length;
    await removeTree(folder);
    alog('info', 'chat history cleared', { chats: n });
    return n;
  }

  /** A project was deleted: its chats go, and no later line of it is written. */
  async forgetProject(projectId: string): Promise<void> {
    const key = historyKey(projectId);
    if (key === HOME_KEY) return;
    this.gone.add(key);
    await removeTree(join(this.dir, key));
  }

  /**
   * Removes each file whose last line ended more than HISTORY_LIMITS.keepDays days ago (by the
   * server's local date; a file with no line that reads back, by its modified time), then each
   * emptied folder. `later` moves the clock on (tests). Answers how many files went.
   */
  sweep(o: { later?: number } = {}): Promise<number> {
    if (this.sweeping) return this.sweeping;
    const run = this.sweepOnce(this.now() + (o.later ?? 0)).finally(() => {
      this.sweeping = null;
    });
    this.sweeping = run;
    return run;
  }

  private async sweepOnce(now: number): Promise<number> {
    let keys: string[];
    try {
      keys = await readdir(this.dir);
    } catch (err) {
      if (codeOf(err) === 'ENOENT') return 0;
      throw err;
    }
    const today = dayNumber(todayKey(() => new Date(now)));
    const old = (ms: number) => Number.isFinite(ms) && today - dayNumber(todayKey(() => new Date(ms))) > HISTORY_LIMITS.keepDays;
    let n = 0;
    for (const key of keys) {
      const folder = join(this.dir, key);
      let names: string[];
      try {
        names = await readdir(folder);
      } catch {
        continue;
      }
      for (const name of names.filter((x) => x.endsWith('.jsonl'))) {
        const file = join(folder, name);
        // A file still being written is new by definition.
        if (this.queues.has(file)) continue;
        const edges = await this.edgesOf(file).catch(() => null);
        const at = edges ? Date.parse(edges.last.ended_at) : await stat(file).then((s) => s.mtimeMs, () => NaN);
        if (!old(at)) continue;
        try {
          await unlink(file);
          n += 1;
        } catch (err) {
          if (codeOf(err) !== 'ENOENT') alog('warn', 'an old chat could not be removed', { error: redact(String((err as Error)?.message ?? err)).slice(0, 200) });
        }
      }
      // An emptied folder goes (one with anything left stays, and one a line is on its way to).
      if (![...this.queues.keys()].some((f) => dirname(f) === folder)) await rmdir(folder).catch(() => undefined);
    }
    if (n) alog('info', 'old chats swept', { removed: n });
    return n;
  }

  /** The boot sweep (soon after, not in the server's start) and one every 6 h while any server uses the store. */
  startSweeps(): () => void {
    this.sweepUsers += 1;
    if (!this.sweepTimer) {
      const boot = setTimeout(() => void this.sweep().catch(() => undefined), 1000);
      boot.unref?.();
      this.sweepTimer = setInterval(() => void this.sweep().catch(() => undefined), HISTORY_LIMITS.sweepEveryMs);
      this.sweepTimer.unref?.();
    }
    let done = false;
    return () => {
      if (done) return;
      done = true;
      this.sweepUsers -= 1;
      if (this.sweepUsers <= 0 && this.sweepTimer) {
        clearInterval(this.sweepTimer);
        this.sweepTimer = null;
      }
    };
  }

  /** Tests: every saved chat removed (a test reset with its files). */
  async clearAll(): Promise<void> {
    await this.flush();
    await removeTree(this.dir);
  }
}

const STORES = Symbol.for('magnusim.assistant.history');

/** The store of `<assistant home>/assistant/chats` (one per folder per process). */
export function chatHistory(dir: string = join(assistantDataDir(), 'chats')): ChatHistory {
  const g = globalThis as unknown as Record<symbol, Map<string, ChatHistory> | undefined>;
  const all = (g[STORES] ??= new Map());
  let s = all.get(dir);
  if (!s) {
    s = new ChatHistory({ dir });
    all.set(dir, s);
  }
  return s;
}
