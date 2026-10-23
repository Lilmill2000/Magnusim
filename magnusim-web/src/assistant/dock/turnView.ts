/**
 * A turn as the dock shows it (phase 4 spec 2.4-2.9, 4.5, 5.2): a pure reducer from the turn's
 * log events, its summaries and its `text_so_far` to the rows of its transcript.
 *
 * - Events are numbered by `seq`; one at or below the newest the view has is dropped, so a
 *   snapshot that comes again after a reconnect, or a long-poll answer that overlaps a
 *   channel frame, changes nothing (the same view object comes back). A gap is normal: the log
 *   keeps at most 4000 events and drops notes, then text, then progress first.
 * - Streamed text is grouped by `step` (one row per step, where its first text came);
 *   `discard {step}` removes that step's row.
 * - A tool call is one row keyed by `call`, which its progress and result update.
 * - A question (`gate`, `gate_closed`) is a line in the transcript, never a card: the card comes
 *   from the page relay (one place for questions, spec 4.1).
 * - A newer `plan` replaces the plan row in place; a coding agent's own tools are one group row,
 *   updated by `call`.
 * - The log may have dropped a step's text: `text_so_far` (the full summary of a snapshot or a
 *   long-poll answer) then fills it, as one row before the first text the view has, when it is
 *   longer and ends with what the view has.
 *
 * Nothing here reads the clock, the DOM or the network: the store (store.ts) feeds it.
 */
import type { GateView, ImageRef, SlimTurnSummary, ToolLink, TurnEvent, TurnState, TurnSummary } from '../wire';

/** A result's links the dock shows: the app's own export files only (the server checks them too). */
const DOWNLOAD_HREF = /^\/api\/results\/export-vtk\/job-[A-Za-z0-9-]{1,60}\/file\?project_id=[A-Za-z0-9._%-]{1,200}$/;

export function downloadLinks(raw: unknown): ToolLink[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((l): l is ToolLink => !!l && typeof l === 'object' && typeof (l as ToolLink).href === 'string' && DOWNLOAD_HREF.test((l as ToolLink).href))
    .slice(0, 4)
    .map((l) => ({ label: typeof l.label === 'string' && l.label ? l.label.slice(0, 80) : 'Download', href: l.href }));
}

type Risk = 'read' | 'edit' | 'compute' | 'destructive';
export type EndState = 'done' | 'stopped' | 'failed' | 'capped';
type PlanEntry = Extract<TurnEvent, { type: 'plan' }>['entries'][number];
type AgentToolRow = { call: string; title: string; kind: string; status: Extract<TurnEvent, { type: 'agent_tool' }>['status'] };
type Permission = Extract<TurnEvent, { type: 'agent_permission' }>;

export interface ToolProgress {
  fraction: number | null;
  label: string;
  /** The call waits for the person in its workspace. */
  waiting: boolean;
}

/** What a call changed in the project (its `ui_sync` events, merged): the step's "Updated" line. */
export interface ToolUpdated {
  kinds: string[];
  ids: Record<string, string[]>;
  names: Record<string, string>;
}

export interface ToolResult {
  ok: boolean;
  summary: string;
  ms: number;
  code: string | null;
  hint: string | null;
  /** The result's pictures the turn keeps (one per CAD edit). */
  images: ImageRef[];
  /** Files the person may save (a finished export), the app's own addresses only. */
  links: ToolLink[];
}

/** One row of a turn's transcript, in the order the log gave them. `key` is stable for React. */
export type TurnItem =
  | { kind: 'text'; key: string; step: number; text: string }
  /** Text the log no longer has, from `text_so_far`. */
  | { kind: 'earlier_text'; key: 'earlier'; text: string }
  | {
      kind: 'tool';
      key: string;
      call: string;
      step: number | null;
      tool: string;
      title: string;
      risk: Risk;
      source: string;
      input_preview: string;
      progress: ToolProgress | null;
      result: ToolResult | null;
      /** What it changed in the project, once a `ui_sync` said so. */
      updated?: ToolUpdated | null;
    }
  /** A change in the project no open call made (its call event was dropped). */
  | { kind: 'updated'; key: string; updated: ToolUpdated }
  | { kind: 'gate'; key: string; gate: string; gateKind: GateView['kind']; title: string; yes: string; no: string }
  | { kind: 'gate_closed'; key: string; gate: string; title: string; yes: string; no: string; answer: 'allow' | 'deny'; by: 'user' | 'timeout' | 'stop' }
  | { kind: 'note'; key: string; text: string }
  | { kind: 'fallback'; key: string; from: string; to: string }
  | { kind: 'review'; key: string; round: number; of: number }
  | { kind: 'plan'; key: 'plan'; entries: PlanEntry[] }
  | { kind: 'agent_tools'; key: 'agent_tools'; tools: AgentToolRow[] }
  | { kind: 'agent_permission'; key: string; title: string; outcome: Permission['outcome']; by: Permission['by'] }
  | { kind: 'agent_mode'; key: string; label: string }
  | { kind: 'agent_model'; key: string; label: string };

/**
 * The newest summary the view has, kept without `text_so_far`: a snapshot's or a long-poll's
 * (with `prompt`), or a `summary` frame's (slim: no `prompt`).
 */
export type SummaryView = Omit<TurnSummary, 'text_so_far'>;

export interface TurnView {
  id: string;
  /** The newest `seq` applied: events at or below it are dropped. */
  lastSeq: number;
  summary: SummaryView | null;
  /** The person's text (the snapshot's summary), once known. */
  prompt: string | null;
  promptImages: ImageRef[];
  state: TurnState;
  items: readonly TurnItem[];
  /** A coding agent's line at the top of the turn. */
  agent: { name: string; version: string | null; own_tools: 'off' | 'on' } | null;
  usage: { usd: number; estimated: boolean; turn_usd: number; day_usd: number; tokens: number } | null;
  /** The newest review round (the model checks its work after its last answer). */
  review: { round: number; of: number } | null;
  /** Questions asked in the log and not closed yet, oldest first. */
  openGates: readonly string[];
  end: { state: EndState; reason: string; message: string | null } | null;
  /** The server no longer has the turn (404): "This request's record is gone". */
  gone: boolean;
}

const TERMINAL: ReadonlySet<TurnState> = new Set(['done', 'stopped', 'failed', 'capped']);

export function emptyTurnView(id: string): TurnView {
  return { id, lastSeq: 0, summary: null, prompt: null, promptImages: [], state: 'starting', items: [], agent: null, usage: null, review: null, openGates: [], end: null, gone: false };
}

/** Whether the turn ended: its `end` event, or a summary that says so (its log no longer kept). */
export function isEnded(v: TurnView): boolean {
  return v.end !== null || v.gone || TERMINAL.has(v.state);
}

/** A working copy of a view's rows, with an index of the rows found by key. */
class Draft {
  items: TurnItem[];
  private index = new Map<string, number>();
  constructor(items: readonly TurnItem[]) {
    this.items = [...items];
    this.reindex();
  }
  private reindex(): void {
    this.index.clear();
    this.items.forEach((it, i) => this.index.set(it.key, i));
  }
  get<K extends TurnItem['kind']>(key: string, kind: K): Extract<TurnItem, { kind: K }> | null {
    const i = this.index.get(key);
    const it = i === undefined ? undefined : this.items[i];
    return it && it.kind === kind ? (it as Extract<TurnItem, { kind: K }>) : null;
  }
  put(item: TurnItem): void {
    const i = this.index.get(item.key);
    if (i === undefined) {
      this.index.set(item.key, this.items.length);
      this.items.push(item);
    } else {
      this.items[i] = item;
    }
  }
  insertAt(pos: number, item: TurnItem): void {
    this.items.splice(pos, 0, item);
    this.reindex();
  }
  remove(key: string): boolean {
    const i = this.index.get(key);
    if (i === undefined) return false;
    this.items.splice(i, 1);
    this.reindex();
    return true;
  }
}

const textKey = (step: number) => `text:${step}`;
const toolKey = (call: string) => `call:${call}`;

/**
 * The view with `events` applied (any order; each at most once, by `seq`). Answers the same
 * object when none of them is new.
 */
export function applyEvents(v: TurnView, events: readonly TurnEvent[]): TurnView {
  const fresh = events.filter((e) => e && typeof e.seq === 'number' && e.seq > v.lastSeq).sort((a, b) => a.seq - b.seq);
  if (!fresh.length) return v;
  const d = new Draft(v.items);
  const next: TurnView = { ...v, openGates: [...v.openGates] };
  let lastSeq = v.lastSeq;
  for (const e of fresh) {
    // Two events with one seq (a frame repeated within one batch): the first counts.
    if (e.seq <= lastSeq) continue;
    lastSeq = e.seq;
    applyOne(next, d, e);
  }
  next.lastSeq = lastSeq;
  next.items = d.items;
  return next;
}

function applyOne(v: TurnView, d: Draft, e: TurnEvent): void {
  switch (e.type) {
    case 'state':
      if (!v.end) v.state = e.state;
      return;
    case 'text': {
      const row = d.get(textKey(e.step), 'text');
      d.put({ kind: 'text', key: textKey(e.step), step: e.step, text: (row ? row.text : '') + e.text });
      return;
    }
    case 'discard':
      d.remove(textKey(e.step));
      return;
    case 'note':
      d.put({ kind: 'note', key: `note:${e.seq}`, text: e.text });
      return;
    case 'fallback':
      d.put({ kind: 'fallback', key: `fallback:${e.seq}`, from: e.from, to: e.to });
      return;
    case 'tool_call': {
      const row = d.get(toolKey(e.call), 'tool');
      d.put({
        kind: 'tool',
        key: toolKey(e.call),
        call: e.call,
        step: e.step,
        tool: e.tool,
        title: e.title,
        risk: e.risk,
        source: e.source,
        input_preview: e.input_preview,
        progress: row ? row.progress : null,
        result: row ? row.result : null,
        updated: row ? row.updated ?? null : null,
      });
      return;
    }
    case 'tool_progress': {
      const row = d.get(toolKey(e.call), 'tool');
      // Progress of a call the view never saw (its call event was dropped) shows nothing.
      if (!row || row.result) return;
      d.put({ ...row, progress: { fraction: typeof e.fraction === 'number' ? e.fraction : null, label: e.label ?? '', waiting: e.waiting === true } });
      return;
    }
    case 'tool_result': {
      const row = d.get(toolKey(e.call), 'tool') ?? {
        kind: 'tool' as const,
        key: toolKey(e.call),
        call: e.call,
        step: null,
        tool: '',
        title: '',
        risk: 'read' as const,
        source: '',
        input_preview: '',
        progress: null,
        result: null,
      };
      d.put({
        ...row,
        progress: null,
        result: {
          ok: e.ok === true,
          summary: e.summary ?? '',
          ms: typeof e.ms === 'number' ? e.ms : 0,
          code: e.code ?? null,
          hint: e.hint ?? null,
          images: Array.isArray(e.images) ? e.images : [],
          links: downloadLinks(e.links),
        },
      });
      return;
    }
    case 'ui_sync': {
      const row = e.call ? d.get(toolKey(e.call), 'tool') : null;
      if (row) {
        d.put({ ...row, updated: mergeUpdated(row.updated ?? null, e) });
        return;
      }
      d.put({ kind: 'updated', key: `updated:${e.seq}`, updated: mergeUpdated(null, e) });
      return;
    }
    case 'gate': {
      const g = e.gate;
      d.put({ kind: 'gate', key: `gate:${g.id}`, gate: g.id, gateKind: g.kind, title: g.title, yes: g.yes, no: g.no });
      if (!v.openGates.includes(g.id)) (v.openGates as string[]).push(g.id);
      return;
    }
    case 'gate_closed': {
      const asked = d.get(`gate:${e.gate}`, 'gate');
      d.put({ kind: 'gate_closed', key: `gate_closed:${e.gate}`, gate: e.gate, title: asked?.title ?? '', yes: asked?.yes ?? '', no: asked?.no ?? '', answer: e.answer, by: e.by });
      v.openGates = v.openGates.filter((id) => id !== e.gate);
      return;
    }
    case 'usage':
      v.usage = { usd: e.usd, estimated: e.estimated, turn_usd: e.turn_usd, day_usd: e.day_usd, tokens: e.tokens };
      return;
    case 'end':
      v.end = { state: e.state, reason: e.reason, message: e.message ?? null };
      v.state = e.state;
      v.openGates = [];
      return;
    case 'review':
      v.review = { round: e.round, of: e.of };
      d.put({ kind: 'review', key: `review:${e.seq}`, round: e.round, of: e.of });
      return;
    case 'agent':
      v.agent = { name: e.name, version: e.version ?? null, own_tools: e.own_tools === 'off' ? 'off' : 'on' };
      return;
    case 'plan':
      d.put({ kind: 'plan', key: 'plan', entries: Array.isArray(e.entries) ? e.entries : [] });
      return;
    case 'agent_tool': {
      const group = d.get('agent_tools', 'agent_tools');
      const tools = group ? [...group.tools] : [];
      const row: AgentToolRow = { call: e.call, title: e.title, kind: e.kind, status: e.status };
      const i = tools.findIndex((t) => t.call === e.call);
      if (i >= 0) tools[i] = row;
      else tools.push(row);
      d.put({ kind: 'agent_tools', key: 'agent_tools', tools });
      return;
    }
    case 'agent_permission':
      d.put({ kind: 'agent_permission', key: `permission:${e.seq}`, title: e.title, outcome: e.outcome, by: e.by });
      return;
    case 'agent_mode':
      d.put({ kind: 'agent_mode', key: `mode:${e.seq}`, label: e.label });
      return;
    case 'agent_model':
      d.put({ kind: 'agent_model', key: `model:${e.seq}`, label: e.label });
      return;
    default:
      // A newer server's event: nothing to show for it yet.
      return;
  }
}

/** A call's changes with one more `ui_sync` added (its kinds, ids and names, each once). */
function mergeUpdated(prev: ToolUpdated | null, e: Extract<TurnEvent, { type: 'ui_sync' }>): ToolUpdated {
  const out: ToolUpdated = prev
    ? { kinds: [...prev.kinds], ids: Object.fromEntries(Object.entries(prev.ids).map(([k, v]) => [k, [...v]])), names: { ...prev.names } }
    : { kinds: [], ids: {}, names: {} };
  for (const k of Array.isArray(e.kinds) ? e.kinds : []) if (!out.kinds.includes(k)) out.kinds.push(k);
  for (const [k, list] of Object.entries(e.ids && typeof e.ids === 'object' ? e.ids : {})) {
    const have = out.ids[k] || (out.ids[k] = []);
    for (const id of Array.isArray(list) ? list : []) if (!have.includes(id)) have.push(id);
  }
  Object.assign(out.names, e.names && typeof e.names === 'object' ? e.names : {});
  return out;
}

/**
 * The view with a newer summary (kept without `text_so_far`): the person's text and pictures
 * once a snapshot brought them, and its state when the log has said none or the turn ended (an
 * ended turn whose log is no longer kept still ends the view).
 */
export function applySummary(v: TurnView, s: SlimTurnSummary | TurnSummary): TurnView {
  if (!s || typeof s !== 'object' || s.id !== v.id) return v;
  const { text_so_far: _drop, ...slim } = s as TurnSummary;
  void _drop;
  // The same summary again (a replayed snapshot): the same view.
  if (v.summary && JSON.stringify(v.summary) === JSON.stringify(slim)) return v;
  const next: TurnView = { ...v, summary: slim };
  if (typeof slim.prompt === 'string') next.prompt = slim.prompt;
  if (Array.isArray(slim.prompt_images)) next.promptImages = slim.prompt_images;
  // The log's own state events win (a summary may be a moment older or newer than them); a
  // summary's says the state before any came, and an end the log may no longer have.
  if (!v.end && slim.state && (v.lastSeq === 0 || TERMINAL.has(slim.state))) next.state = slim.state;
  return next;
}

/**
 * The text the log dropped, from `text_so_far` (each step's text, trimmed, joined by a blank
 * line): when it is longer than the view's and ends with it, what comes before is one row
 * ahead of the view's first text. The longer of the two wins.
 */
export function fillDroppedText(v: TurnView, textSoFar: string | null | undefined): TurnView {
  if (typeof textSoFar !== 'string') return v;
  const full = textSoFar.trim();
  const known = v.items
    .filter((it): it is Extract<TurnItem, { kind: 'text' }> => it.kind === 'text')
    .map((it) => it.text.trim())
    .filter(Boolean)
    .join('\n\n');
  if (full.length <= known.length || !full.endsWith(known)) return v;
  const earlier = full.slice(0, full.length - known.length).trim();
  const had = v.items.find((it) => it.kind === 'earlier_text');
  if (!earlier || (had && had.text.length >= earlier.length)) return v;
  const d = new Draft(v.items);
  d.remove('earlier');
  const first = d.items.findIndex((it) => it.kind === 'text');
  d.insertAt(first >= 0 ? first : 0, { kind: 'earlier_text', key: 'earlier', text: earlier });
  return { ...v, items: d.items };
}

/** The view of a turn the server no longer has (404). */
export function markGone(v: TurnView): TurnView {
  return v.gone ? v : { ...v, gone: true, openGates: [] };
}

// ---------------------------------------------------------------- what the footer and the pill read

/** The newest call still running (no result yet), if any. */
export function currentTool(v: TurnView): Extract<TurnItem, { kind: 'tool' }> | null {
  for (let i = v.items.length - 1; i >= 0; i -= 1) {
    const it = v.items[i];
    if (it.kind === 'tool' && !it.result) return it;
  }
  return null;
}

/** The turn's last text (the newest step's), for the end's announcement. */
export function finalText(v: TurnView): string {
  for (let i = v.items.length - 1; i >= 0; i -= 1) {
    const it = v.items[i];
    if (it.kind === 'text' || it.kind === 'earlier_text') return it.text;
  }
  return '';
}

/** The step whose text is still streaming (the newest text while the model writes), or null. */
export function streamingStep(v: TurnView): number | null {
  if (isEnded(v) || v.state !== 'model') return null;
  const last = v.items[v.items.length - 1];
  return last && last.kind === 'text' ? last.step : null;
}

/** What the running footer says (spec 2.9), before its words (copy.ts). */
export type TurnPhase =
  | { kind: 'starting' }
  | { kind: 'answer_below' }
  | { kind: 'thinking' }
  | { kind: 'agent_working'; name: string }
  | { kind: 'reviewing'; round: number; of: number }
  | { kind: 'working'; title: string; label: string | null }
  | { kind: 'waiting'; label: string }
  | { kind: 'stopping'; still: boolean }
  | { kind: 'ended'; state: EndState };

/** How long after its Stop a turn that hasn't ended reads "Still stopping…" (the route's bound). */
export const STILL_STOPPING_MS = 5000;

/**
 * The footer's phase. `stop`: when this page sent Stop for it (ms) and now; the turn reads
 * "Stopping…" until its end, "Still stopping…" after STILL_STOPPING_MS.
 */
export function turnPhase(v: TurnView, stop?: { sentAt: number; now: number } | null): TurnPhase {
  if (isEnded(v)) {
    const state = v.end ? v.end.state : TERMINAL.has(v.state) ? (v.state as EndState) : 'failed';
    return { kind: 'ended', state };
  }
  if (stop) return { kind: 'stopping', still: stop.now - stop.sentAt >= STILL_STOPPING_MS };
  switch (v.state) {
    case 'starting':
      return { kind: 'starting' };
    case 'awaiting_consent':
    case 'awaiting_confirmation':
      return { kind: 'answer_below' };
    case 'tools': {
      const call = currentTool(v);
      if (!call) return { kind: 'thinking' };
      if (call.progress?.waiting) return { kind: 'waiting', label: call.progress.label };
      return { kind: 'working', title: call.title, label: call.progress?.label || null };
    }
    default: {
      if (v.review) return { kind: 'reviewing', round: v.review.round, of: v.review.of };
      const agent = v.agent ?? (v.summary?.agent ? { name: v.summary.agent.name } : null);
      return agent ? { kind: 'agent_working', name: agent.name } : { kind: 'thinking' };
    }
  }
}
