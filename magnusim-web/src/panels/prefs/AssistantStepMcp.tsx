/**
 * Settings → Assistant → Other apps (MCP) (phase 3 spec 5.6, 5.7): whether other AI apps on
 * this PC may use Magnusim's tools (off by default), the config to paste into such an app,
 * and the apps connected now.
 *
 * - The switch saves at once (`mcp: {clients}`); the answer is the whole status. Turned off,
 *   the server cuts off the apps connected now; coding agents use the connection whatever it
 *   says, and the block says so.
 * - The config comes from GET /api/assistant/mcp: the bridge Magnusim ships, with the
 *   absolute path of the connection file this Magnusim writes (`--info`), under the key
 *   `magnusim-apps`. It never holds the token: the bridge reads it from that file. Copy puts
 *   it on the clipboard as shown.
 * - "Connected now" lists other apps' connections (each as the app calls itself, since
 *   when, and how many calls), read again every few seconds while the switch is on and the
 *   step is shown. Coding agents' connections belong to their own rows, not here.
 * - When the connection can't run (its package missing, the port or its file refused), the
 *   reason shows whatever the switch says.
 * A server without Other apps (no `mcp` in its status) shows no block.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { assistantGet } from '../../assistant/api';
import { stepChange, writeStatus } from '../../assistant/status';
import type { AssistantStatus, McpStatus } from '../../assistant/wire';

const SETTINGS = '/api/assistant/settings';
const MCP_PATH = '/api/assistant/mcp';
/** How often the connections are read again while the switch is on and the step is shown. */
export const MCP_POLL_MS = 5_000;

export const MCP_SWITCH_LABEL = "Let other AI apps on this PC use Magnusim's tools";
export const MCP_SNIPPET_INTRO = "Add this to the app's MCP server settings:";
export const MCP_RULES_TEXT = 'They get the same tools, questions and privacy rules as the Assistant. Magnusim must be running.';
export const MCP_CONNECTED_TITLE = 'Connected now:';
export const MCP_NONE_TEXT = 'None connected.';
export const MCP_AGENTS_TEXT = 'Coding agents above use this connection whatever this switch says.';
export const MCP_DEPS_TEXT = "Magnusim's tool-connection package isn't installed. Run Setup.bat again.";
export const MCP_COPIED_TEXT = 'Copied.';
export const MCP_COPY_FAILED_TEXT = "Couldn't copy it: select the text above and copy it.";

/** Why the connection isn't running, as the person reads it (the server's refusals say the same: mcp/listener.ts mcpUnavailableText). */
export function mcpReasonText(reason: string, port: number | null): string {
  if (reason === 'deps_missing') return MCP_DEPS_TEXT;
  const where = typeof port === 'number' ? `port ${port}` : 'its port';
  return `Magnusim couldn't open the connection its tools use (${reason}). Restart Magnusim; if it keeps happening, another program may hold ${where}.`;
}

/** One connection as GET /api/assistant/mcp lists it. */
export interface McpConnectionRow {
  id: string;
  kind: 'external' | 'agent';
  /** As the app calls itself (self-declared, cleaned by the server). */
  name: string;
  /** ISO time it connected. */
  since: string;
  calls: number;
}

/** GET /api/assistant/mcp. */
interface McpAnswer {
  snippet: string;
  connections: McpConnectionRow[];
}

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/** The status's Other apps part, each field checked as it arrived (none from a server without it). */
function mcpPartOf(status: AssistantStatus): McpStatus | null {
  const m: unknown = status.mcp;
  if (!isRecord(m) || typeof m.clients !== 'boolean') return null;
  return {
    clients: m.clients,
    running: m.running === true,
    reason: typeof m.reason === 'string' && m.reason ? m.reason : null,
    port: typeof m.port === 'number' ? m.port : null,
    connected: typeof m.connected === 'number' ? m.connected : 0,
  };
}

/** Why the connection can't run now, as the status says it (null: it runs, it wasn't tried, or the server doesn't say). */
export function mcpDownReason(status: AssistantStatus): string | null {
  const part = mcpPartOf(status);
  return part && !part.running ? part.reason : null;
}

function answerOf(j: Record<string, unknown>): McpAnswer {
  const rows = Array.isArray(j.connections) ? j.connections : [];
  return {
    snippet: typeof j.snippet === 'string' ? j.snippet : '',
    connections: rows.filter(isRecord).map((r) => ({
      id: String(r.id ?? ''),
      kind: r.kind === 'agent' ? 'agent' : 'external',
      name: typeof r.name === 'string' ? r.name : '',
      since: typeof r.since === 'string' ? r.since : '',
      calls: typeof r.calls === 'number' && Number.isFinite(r.calls) ? r.calls : 0,
    })),
  };
}

const two = (n: number) => String(n).padStart(2, '0');

/** "Desk App · since 14:02 · 3 calls" (the time on this PC's clock). */
export function connectionLine(row: McpConnectionRow): string {
  const at = new Date(row.since);
  const since = Number.isNaN(at.getTime()) ? '' : ` · since ${two(at.getHours())}:${two(at.getMinutes())}`;
  return `${row.name || 'An app with no name'}${since} · ${row.calls} call${row.calls === 1 ? '' : 's'}`;
}

export function AssistantStepMcp({ status }: { status: AssistantStatus }) {
  const part = mcpPartOf(status);
  if (!part) return null;
  return <McpBlock part={part} />;
}

function McpBlock({ part }: { part: McpStatus }) {
  const [pending, setPending] = useState<boolean | null>(null);
  const [error, setError] = useState('');
  const [answer, setAnswer] = useState<McpAnswer | null>(null);
  const [copied, setCopied] = useState<'ok' | 'failed' | null>(null);
  const mounted = useRef(true);
  const reads = useRef(0);
  const shown = pending ?? part.clients;

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  /** Reads the config and the connections; only the newest read is shown. */
  const load = useCallback(async () => {
    const seq = ++reads.current;
    try {
      const j = await assistantGet<Record<string, unknown>>(MCP_PATH);
      if (mounted.current && seq === reads.current) setAnswer(answerOf(j));
    } catch {
      /* the last answer stays; the next read tries again */
    }
  }, []);

  // Read at once, and again whenever the status says the switch, the listener or the count changed.
  useEffect(() => {
    void load();
  }, [load, part.clients, part.running, part.connected]);

  // While other apps may connect: the connections are read again every few seconds.
  useEffect(() => {
    if (!shown) return undefined;
    const timer = setInterval(() => void load(), MCP_POLL_MS);
    return () => clearInterval(timer);
  }, [load, shown]);

  const toggle = async (on: boolean): Promise<boolean> => {
    setError('');
    setCopied(null);
    setPending(on);
    const r = await writeStatus(SETTINGS, { mcp: { clients: on } });
    if (!mounted.current) return r.ok;
    setPending(null);
    if (!r.ok) setError(r.error.message);
    else void load();
    return r.ok;
  };

  const snippet = answer?.snippet ?? '';
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(snippet);
      if (mounted.current) setCopied('ok');
    } catch {
      if (mounted.current) setCopied('failed');
    }
  };

  const apps = (answer?.connections ?? []).filter((c) => c.kind === 'external');
  const reason = !part.running && part.reason ? part.reason : null;

  return (
    <div className="wiz-assistant-block" data-assistant-mcp="1" data-assistant-mcp-clients={part.clients ? 'on' : 'off'}>
      <h3 className="wiz-assistant-h">Other apps (MCP)</h3>
      <label className="wiz-assistant-switch">
        <span className="switch">
          <input type="checkbox" role="switch" checked={shown} aria-checked={shown} data-assistant-mcp-switch="1" onChange={(e) => void stepChange(toggle(e.currentTarget.checked))} />
          <span className="slider" aria-hidden="true" />
        </span>
        <span>{MCP_SWITCH_LABEL}</span>
      </label>
      {reason ? (
        <p className="wiz-assistant-warn" role="alert" data-assistant-mcp-reason={reason}>
          {mcpReasonText(reason, part.port)}
        </p>
      ) : null}
      {shown ? (
        <>
          <p className="wiz-assistant-meta">{MCP_SNIPPET_INTRO}</p>
          <pre className="wiz-assistant-snippet" data-assistant-mcp-snippet="1">
            {snippet}
          </pre>
          <div className="wiz-assistant-row">
            <button type="button" className="home-btn" data-assistant-mcp-copy="1" disabled={!snippet} onClick={() => void copy()}>
              Copy
            </button>
            <span className="wiz-assistant-meta" aria-live="polite" data-assistant-mcp-copied={copied ?? ''}>
              {copied === 'ok' ? MCP_COPIED_TEXT : copied === 'failed' ? MCP_COPY_FAILED_TEXT : ''}
            </span>
          </div>
          <p className="wiz-assistant-meta" data-assistant-mcp-rules="1">
            {MCP_RULES_TEXT}
          </p>
          <p className="wiz-assistant-status">{MCP_CONNECTED_TITLE}</p>
          {apps.length ? (
            <ul className="wiz-assistant-connections" data-assistant-mcp-connections="1">
              {apps.map((c) => (
                <li key={c.id} data-assistant-mcp-connection={c.id}>
                  {connectionLine(c)}
                </li>
              ))}
            </ul>
          ) : (
            <p className="wiz-assistant-meta" data-assistant-mcp-none="1">
              {MCP_NONE_TEXT}
            </p>
          )}
        </>
      ) : null}
      <p className="wiz-assistant-meta" data-assistant-mcp-agents="1">
        {MCP_AGENTS_TEXT}
      </p>
      {error ? (
        <p className="wiz-assistant-error" role="alert" data-assistant-mcp-error="1">
          {error}
        </p>
      ) : null}
    </div>
  );
}
