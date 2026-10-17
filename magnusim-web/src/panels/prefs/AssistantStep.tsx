/**
 * Settings → Assistant (Foundation spec 4.3): the provider, its endpoint, key and model,
 * effort, a connection Test, privacy, limits and today's spend. Every change saves at once,
 * and every save answers with the whole status (src/assistant/status.ts). Leaving the step
 * saves a key pasted but not saved, and waits for the changes on their way (stepChange):
 * a refused one keeps the step on screen with its reason.
 *
 * The key is write-only. Its field is uncontrolled, outside any form, with no name or id
 * hint and the password managers' ignore attributes; its value is read through a ref and
 * the field cleared before the save is sent, so the key is never in React state, the
 * store, `window` or the page's prefs. The status shows only whether a key is set and its
 * last 4 characters.
 *
 * Models, Test, prices, the packages line and the test-provider switch come from the
 * routes that bring the model adapters. Until a server has them the step leaves those
 * parts out (a missing models list or Test route says so plainly, nothing more).
 */
import { useEffect, useId, useRef, useState, type CSSProperties, type KeyboardEvent, type ReactNode } from 'react';
import { AssistantApiError, assistantGet, assistantPost, REMOTE_TEXT } from '../../assistant/api';
import { refreshStatus, retryStatus, stepChange, stepHolder, useAssistantStatus, writeStatus } from '../../assistant/status';
import type {
  AssistantStatus,
  Caps,
  Effort,
  KeyStatus,
  ModelInfo,
  ModelsAnswer,
  PrivacyMode,
  ProviderChoice,
  ProviderId,
  RefusalBody,
  StorageStatus,
  TestAnswer,
} from '../../assistant/wire';
import type { IslandProps } from '../../islands';
import { confirmAction } from '../../workbench/dialogs';

const SETTINGS = '/api/assistant/settings';

const PROVIDERS: ReadonlyArray<{ id: ProviderChoice; title: string; copy?: string }> = [
  { id: 'off', title: 'Off' },
  { id: 'openai_compatible', title: 'Local server', copy: 'LM Studio or Ollama on this PC. Project data stays here.' },
  { id: 'anthropic', title: 'Anthropic', copy: 'Claude models with your API key. Project data you ask about goes to Anthropic.' },
  { id: 'openai', title: 'OpenAI', copy: 'GPT models with your API key. Project data you ask about goes to OpenAI.' },
];

const CLOUD_LABEL: Record<'anthropic' | 'openai', string> = { anthropic: 'Anthropic', openai: 'OpenAI' };

const PRESETS = [
  { key: 'lmstudio', label: 'LM Studio', url: 'http://127.0.0.1:1234/v1' },
  { key: 'ollama', label: 'Ollama', url: 'http://127.0.0.1:11434/v1' },
] as const;

const EFFORTS: ReadonlyArray<{ id: Effort; label: string }> = [
  { id: 'default', label: 'Default' },
  { id: 'low', label: 'Low' },
  { id: 'medium', label: 'Medium' },
  { id: 'high', label: 'High' },
];

const PRIVACY: ReadonlyArray<{ id: PrivacyMode; label: string }> = [
  { id: 'ask', label: 'Ask once per project' },
  { id: 'allow', label: 'Always allow' },
  { id: 'deny', label: 'Never send project data' },
];

export const DEPS_TEXT = "The Assistant's packages aren't installed. Run Setup.bat again.";
export const UNKNOWN_PRICE_TEXT = "Magnusim doesn't know this model's price; the spend meter counts it at this provider's highest.";
export const LOCAL_PRICE_TEXT = 'No cost (runs on this PC).';
/** A local-server address that isn't on this PC: it may be a paid service Magnusim can't price. */
export const SERVER_PRICE_TEXT = "Magnusim doesn't know what this server charges, and today's spend doesn't count it.";
export const FALLBACK_TEXT =
  "If the model declines a request, the provider may retry it on an older model of its own, at that model's price.";
export const LIMITS_TEXT = 'Limits are checked before each step; one step can go a little over.';
export const SHARED_PC_TEXT =
  "Anyone signed in to this PC can use the Assistant through Magnusim (they can't see your key); these limits apply to them too.";
export const LOCAL_LIMITS_TEXT = 'Local servers cost nothing; the step and time limits still apply.';
export const SERVER_LIMITS_TEXT = "Magnusim can't price a server that isn't on this PC, so the $ limits don't apply to it; the step and time limits do.";
export const LOCAL_PRIVACY_TEXT = 'On this PC: project data stays here.';
const OLLAMA_HINT_TEXT =
  "Ollama gives a model a 4K context unless told otherwise, which can silently cut off the tools Magnusim sends. Give the model a larger context (num_ctx in its Modelfile).";
const TEMPLATE_FIX = 'In LM Studio, pick a model marked for tool use or load a template that has them.';
/** A local model wrote the test tool's call as text: its chat template has no tool calls. */
export const AS_TEXT_TEXT = `But the model wrote the tool call as text instead of making it: its chat template doesn't support tool calls, so Magnusim's tools won't work with it. ${TEMPLATE_FIX}`;
/** A local model answered without calling the test tool. */
export const TEMPLATE_TEXT = `But the model didn't call the test tool, so it may not handle Magnusim's tools: its chat template may not support tool calls. ${TEMPLATE_FIX}`;
/** A cloud model answered without calling the test tool (no chat template to blame). */
export const NOT_USED_TEXT = "But the model didn't call the test tool, so it may not handle Magnusim's tools. Test again, or choose another model.";
const NO_TEST_TEXT = "This copy of Magnusim can't test the connection yet.";

const NO_KEY: KeyStatus = { set: false, last4: null, set_at: null, state: 'none' };

const isCloud = (p: ProviderChoice): p is 'anthropic' | 'openai' => p === 'anthropic' || p === 'openai';

/** Which key the provider would use (none, or the one saved at that time: a new save is another key), and whether it opens. */
function keyStamp(status: AssistantStatus, provider: ProviderId): string {
  const k = status.keys?.[provider];
  return k?.set ? `set:${k.set_at ?? ''}:${k.state}` : 'none';
}

/**
 * What a Test result is about: the provider, its model, a local server's address, and which
 * key. Not whether the key opens: the server learns that only when it tries the key, often on
 * this very Test, and its refusal is the result to keep.
 */
function testKey(status: AssistantStatus, provider: ProviderId): string {
  const where = provider === 'openai_compatible' ? status.base_url : '';
  const k = status.keys?.[provider];
  const key = k?.set ? `set:${k.set_at ?? ''}` : 'none';
  return `test:${provider}:${status.models?.[provider] ?? ''}:${where}:${key}`;
}

/** The local-server choice's line when its saved address is on another computer. */
function offPcServerCopy(baseUrl: string): string {
  return `Your server at ${hostOf(baseUrl)}, not on this PC. Project data you ask about goes there.`;
}

/** A provider choice's line; the local server's says where its saved address is. */
function providerCopy(p: (typeof PROVIDERS)[number], status: AssistantStatus): string | undefined {
  if (p.id === 'openai_compatible' && status.base_url_is_local === false) return offPcServerCopy(status.base_url);
  return p.copy;
}

/** A $ limit as saved: dollars and cents, or every digit when cents don't hold it (0.125). */
function capText(saved: number, isMoney: boolean): string {
  if (!isMoney) return String(saved);
  const cents = saved.toFixed(2);
  return Number(cents) === saved ? cents : String(saved);
}

/** A price: $0.42, or $0.125 when cents are not enough. */
function money(n: number): string {
  const cents = n * 100;
  return `$${Math.abs(cents - Math.round(cents)) < 1e-9 ? n.toFixed(2) : n.toFixed(3)}`;
}

/** Dollars and cents ("Spent today: $0.42 of $15.00"); a spend under a cent is "under $0.01", never $0.00. */
function cents(n: number): string {
  const v = Number.isFinite(n) && n > 0 ? n : 0;
  const text = v.toFixed(2);
  return v > 0 && Number(text) === 0 ? 'under $0.01' : `$${text}`;
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

function portOf(url: string): string {
  try {
    return new URL(url).port;
  } catch {
    return '';
  }
}

/** The key's line: "Key set, ends in …x9Qa", "Key set", "No key", or why it can't be used. */
export function keyLine(k: KeyStatus, storage: StorageStatus | undefined, token: boolean): string {
  if (!k.set) return token ? 'No token' : 'No key';
  if (k.state === 'unreadable') {
    return storage?.kind === 'file'
      ? "Your saved key can't be decrypted. Enter it again."
      : "Your saved key can't be decrypted on this Windows account. Enter it again.";
  }
  const noun = token ? 'Token' : 'Key';
  return k.last4 ? `${noun} set, ends in …${k.last4}` : `${noun} set`;
}

/** The model's price line, or null when there is nothing honest to say. */
export function priceLine(s: AssistantStatus): string | null {
  if (s.provider === 'off') return null;
  if (s.provider === 'openai_compatible') return s.base_url_is_local ? LOCAL_PRICE_TEXT : SERVER_PRICE_TEXT;
  const p = s.price;
  if (!p) return null;
  if (p.known === false || p.estimated === true) return UNKNOWN_PRICE_TEXT;
  if (typeof p.input !== 'number' || typeof p.output !== 'number') return null;
  const asOf = s.prices_as_of ? ` (prices of ${s.prices_as_of})` : '';
  return `${money(p.input)} in · ${money(p.output)} out per million tokens${asOf}.`;
}

/** Whether the status says a declined request may be retried on another model: `true`, a non-empty list, or `{on: true}`. */
function hasFallback(s: AssistantStatus): boolean {
  const f = s.fallback;
  if (f === true) return true;
  if (Array.isArray(f)) return f.length > 0;
  return typeof f === 'object' && f !== null && f.on === true;
}

/** Tool-call verdicts that say tool calling works, and those that say the model didn't call the tool. */
const TOOLS_WORK: ReadonlySet<unknown> = new Set(['works', 'ok', true]);
const TOOLS_NOT_USED: ReadonlySet<unknown> = new Set(['not_used', false]);

/** What a Test cost: "$0.0021", "about $0.0021" for a model Magnusim has no price for, "under $0.0001". */
function testCost(usd: number, estimated: boolean): string {
  const text = usd < 0.00005 ? 'under $0.0001' : `$${usd.toFixed(4)}`;
  return estimated ? `about ${text}` : text;
}

/**
 * The Test result line, and whether everything works. `provider` says which advice fits a
 * model that didn't call the test tool: a local model's chat template, or not.
 */
export function testLine(a: TestAnswer, provider?: ProviderId): { ok: boolean; text: string } {
  if (!a.ok) return { ok: false, text: a.error || 'The test failed.' };
  const secs = (Number(a.ms) / 1000).toFixed(1);
  const estimated = (a as { estimated?: unknown }).estimated === true;
  const cost = typeof a.cost_usd === 'number' && a.cost_usd > 0 ? ` (${testCost(a.cost_usd, estimated)})` : '';
  const connected = `Connected to ${a.served_by || a.model} in ${secs} s${cost}.`;
  if (TOOLS_WORK.has(a.tools)) return { ok: true, text: `${connected} Tool calling works.` };
  if (a.tools === 'as_text') return { ok: false, text: `${connected} ${AS_TEXT_TEXT}` };
  if (TOOLS_NOT_USED.has(a.tools)) {
    return { ok: false, text: `${connected} ${provider === 'anthropic' || provider === 'openai' ? NOT_USED_TEXT : TEMPLATE_TEXT}` };
  }
  // A verdict this page doesn't know: the connection works; say nothing about tools.
  return { ok: true, text: connected };
}

/**
 * A server's sentence with its `code` spans shown as code (the local-server hint names a
 * command); text with an unmatched backtick shows as it came.
 */
export function withCode(text: string): ReactNode {
  const parts = text.split('`');
  if (parts.length < 3 || parts.length % 2 === 0) return text;
  return parts.map((p, i) => (i % 2 ? <code key={i}>{p}</code> : p));
}

function supportsTextSecurity(): boolean {
  try {
    return typeof CSS !== 'undefined' && typeof CSS.supports === 'function' && CSS.supports('-webkit-text-security', 'disc');
  } catch {
    return false;
  }
}

/** Blur on Enter: the field saves on blur, so Enter and leaving it save once. */
function blurOnEnter(e: KeyboardEvent<HTMLInputElement>): void {
  if (e.key === 'Enter') {
    e.preventDefault();
    e.currentTarget.blur();
  }
}

/**
 * Focus after one of the app's questions (its dialog doesn't give focus back): where it was
 * when the question opened, else the first of `fallbacks` still shown, so a keyboard user
 * stays in the step.
 */
function refocus(before: Element | null, ...fallbacks: Array<HTMLElement | null | undefined>): void {
  const shown = (el: Element | null | undefined): el is HTMLElement =>
    el instanceof HTMLElement && el !== document.body && el.isConnected && !el.closest('[hidden]') && !(el as HTMLButtonElement).disabled;
  [before, ...fallbacks].find(shown)?.focus();
}

/** A field's error line, for its aria-describedby. */
function described(error: string, id: string): { 'aria-invalid'?: true; 'aria-describedby'?: string } {
  return error ? { 'aria-invalid': true, 'aria-describedby': id } : {};
}

export function AssistantStep(_props: Partial<IslandProps>) {
  const snap = useAssistantStatus();
  useEffect(() => {
    void refreshStatus();
  }, []);
  if (snap.state === 'loading') {
    return (
      <p className="wiz-assistant-meta" data-assistant-loading="1">
        Checking the Assistant…
      </p>
    );
  }
  if (snap.state === 'remote') {
    return (
      <p className="wiz-assistant-note" data-assistant-local-only="1">
        {REMOTE_TEXT}
      </p>
    );
  }
  if (snap.state === 'error') {
    return (
      <div className="wiz-assistant-error-box" data-assistant-error="1" role="alert">
        <span>Couldn't read the Assistant's settings: {snap.message}</span>
        <button type="button" className="home-btn" onClick={() => void retryStatus()}>
          Retry
        </button>
      </div>
    );
  }
  return <AssistantSettings status={snap.status} />;
}

function AssistantSettings({ status }: { status: AssistantStatus }) {
  const provider = status.provider;
  return (
    <div className="wiz-assistant" data-assistant-step="1">
      {status.deps === 'missing' ? (
        <p className="wiz-assistant-warn" data-assistant-deps="1" role="alert">
          {DEPS_TEXT}
        </p>
      ) : null}
      {status.keys_notice ? (
        <p className="wiz-assistant-warn" data-assistant-keys-notice="1">
          {status.keys_notice}
        </p>
      ) : null}
      <ProviderBlock status={status} />
      {provider === 'openai_compatible' ? <EndpointBlock status={status} /> : null}
      {provider !== 'off' ? <KeyBlock key={`key:${provider}`} status={status} slot={provider} /> : null}
      {provider !== 'off' ? <ModelBlock key={`model:${provider}`} status={status} provider={provider} /> : null}
      {isCloud(provider) ? <EffortBlock status={status} /> : null}
      {/* A result is about one provider, model, address and key: a change starts the block afresh. */}
      {provider !== 'off' ? <TestBlock key={testKey(status, provider)} provider={provider} /> : null}
      {provider !== 'off' ? <PrivacyBlock status={status} provider={provider} /> : null}
      {provider !== 'off' ? <LimitsBlock status={status} /> : null}
      <TestSwitchLine status={status} />
    </div>
  );
}

function ErrorLine({ text, hook, id }: { text: string; hook: Record<string, string>; id?: string }) {
  if (!text) return null;
  return (
    <p id={id} className="wiz-assistant-error" role="alert" {...hook}>
      {text}
    </p>
  );
}

// ---------------------------------------------------------------- provider

function ProviderBlock({ status }: { status: AssistantStatus }) {
  const name = useId();
  const [error, setError] = useState('');
  // The choice shows at once; the saved one (data-assistant-provider) once the server has it.
  const [pending, setPending] = useState<ProviderChoice | null>(null);
  const choose = async (id: ProviderChoice): Promise<boolean> => {
    setError('');
    setPending(id);
    const r = await writeStatus(SETTINGS, { provider: id });
    setPending(null);
    if (!r.ok) setError(r.error.message);
    return r.ok;
  };
  const shown = pending ?? status.provider;
  return (
    <div className="wiz-assistant-block">
      <div className="wiz-assistant-options" role="radiogroup" aria-label="Assistant provider" data-assistant-provider={status.provider}>
        {PROVIDERS.map((p) => {
          const on = p.id === shown;
          const copy = providerCopy(p, status);
          return (
            <label key={p.id} className={`wiz-assistant-option${on ? ' is-selected' : ''}`} data-assistant-provider-option={p.id}>
              <input type="radio" name={name} value={p.id} checked={on} onChange={() => void stepChange(choose(p.id))} />
              <span className="wiz-assistant-option-copy">
                <strong>{p.title}</strong>
                {copy ? <span>{copy}</span> : null}
              </span>
            </label>
          );
        })}
      </div>
      <ErrorLine text={error} hook={{ 'data-assistant-provider-error': '1' }} />
    </div>
  );
}

// ---------------------------------------------------------------- endpoint (local server)

function EndpointBlock({ status }: { status: AssistantStatus }) {
  return (
    <div className="wiz-assistant-block">
      <h3 className="wiz-assistant-h">Server address</h3>
      {/* A new saved address starts the field afresh. */}
      <EndpointField key={status.base_url} saved={status.base_url} />
      {portOf(status.base_url) === '11434' ? (
        <p className="wiz-assistant-meta" data-assistant-ollama-hint="1">
          {OLLAMA_HINT_TEXT}
        </p>
      ) : null}
    </div>
  );
}

function EndpointField({ saved }: { saved: string }) {
  const [draft, setDraft] = useState(saved);
  const [error, setError] = useState('');
  const errorId = useId();
  const field = useRef<HTMLInputElement>(null);
  const busy = useRef(false);
  /** Saves the address (asking first for one on another computer): false when refused. */
  const commit = async (value: string): Promise<boolean> => {
    const next = value.trim();
    if (busy.current || next === saved) return true;
    busy.current = true;
    try {
      setError('');
      let r = await writeStatus(SETTINGS, { base_url: next });
      if (!r.ok && r.error.status === 409 && (r.error.body as RefusalBody).needs_confirm === 'base_url') {
        const before = document.activeElement;
        const yes = await confirmAction({
          title: 'Use a server on another computer?',
          copy: `${next} is not on this PC. Project data you ask the Assistant about would go to that server.`,
          yes: 'Use this server',
          safe: true,
        });
        refocus(before, field.current);
        if (!yes) {
          setDraft(saved);
          return true;
        }
        r = await writeStatus(SETTINGS, { base_url: next, confirm_remote: true });
      }
      if (!r.ok) setError(r.error.message);
      return r.ok;
    } finally {
      busy.current = false;
    }
  };
  return (
    <>
      <div className="wiz-assistant-row">
        <input
          ref={field}
          className="wiz-assistant-input wiz-assistant-wide"
          type="text"
          aria-label="Server address"
          spellCheck={false}
          autoComplete="off"
          value={draft}
          data-assistant-endpoint="1"
          {...described(error, errorId)}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={(e) => void stepChange(commit(e.currentTarget.value))}
          onKeyDown={blurOnEnter}
        />
        {PRESETS.map((p) => (
          <button
            key={p.key}
            type="button"
            className="home-btn"
            data-assistant-endpoint-preset={p.key}
            title={p.url}
            onClick={() => {
              setDraft(p.url);
              void stepChange(commit(p.url));
            }}
          >
            {p.label}
          </button>
        ))}
      </div>
      <ErrorLine id={errorId} text={error} hook={{ 'data-assistant-endpoint-error': '1' }} />
    </>
  );
}

// ---------------------------------------------------------------- key

const IGNORED_BY_PASSWORD_MANAGERS = {
  autoComplete: 'off',
  autoCorrect: 'off',
  autoCapitalize: 'off',
  spellCheck: false,
  'data-1p-ignore': '',
  'data-lpignore': 'true',
  'data-bwignore': '',
  'data-form-type': 'other',
} as const;

const TEXT_SECURITY = { WebkitTextSecurity: 'disc' } as unknown as CSSProperties;

function KeyBlock({ status, slot }: { status: AssistantStatus; slot: ProviderId }) {
  const token = slot === 'openai_compatible';
  const key = status.keys?.[slot] ?? NO_KEY;
  const storage = status.storage;
  const blocked = storage?.kind === 'unavailable' && storage.reason === 'blocked';
  const input = useRef<HTMLInputElement>(null);
  const block = useRef<HTMLDivElement>(null);
  const [masked] = useState(supportsTextSecurity);
  const [warning, setWarning] = useState('');
  const [error, setError] = useState('');
  const errorId = useId();
  const [busy, setBusy] = useState<'' | 'save' | 'remove'>('');
  const what = token ? 'token' : 'key';
  const label = token ? 'Server token' : `${CLOUD_LABEL[slot as 'anthropic' | 'openai']} API key`;

  /** Saves what the field holds: false when there is nothing or it was refused. */
  const save = async (): Promise<boolean> => {
    const el = input.current;
    if (!el || busy) return true;
    // Read and clear before anything is awaited: the field never holds it past this line.
    const value = el.value;
    el.value = '';
    setWarning('');
    setError('');
    if (!value.trim()) {
      setError(`Paste the ${what} first.`);
      return false;
    }
    setBusy('save');
    const r = await writeStatus('/api/assistant/key', { provider: slot, key: value });
    setBusy('');
    if (!r.ok) setError(r.error.message);
    else if (typeof r.body.warning === 'string') setWarning(r.body.warning);
    return r.ok;
  };
  // A key pasted but not saved is saved when the step is left (as Save would), not dropped.
  const latestSave = useRef(save);
  latestSave.current = save;
  useEffect(
    () =>
      stepHolder(() => {
        if (input.current?.value.trim()) void stepChange(latestSave.current());
      }),
    [],
  );

  const remove = async (): Promise<boolean> => {
    const before = document.activeElement;
    const yes = await confirmAction({
      title: token ? 'Remove the server token?' : `Remove the ${CLOUD_LABEL[slot as 'anthropic' | 'openai']} key?`,
      copy: token
        ? 'Magnusim forgets the token saved for the local server on this PC.'
        : `Magnusim forgets the key saved on this PC. The Assistant can't use ${CLOUD_LABEL[slot as 'anthropic' | 'openai']} until you save a key again.`,
      yes: 'Remove',
      safe: true,
    });
    if (!yes) {
      refocus(before, input.current, block.current);
      return true;
    }
    // Remove goes with the key: the key field (or the block) keeps the place.
    refocus(input.current, block.current);
    setWarning('');
    setError('');
    setBusy('remove');
    const r = await writeStatus('/api/assistant/key/remove', { provider: slot });
    setBusy('');
    if (!r.ok) setError(r.error.message);
    return r.ok;
  };

  return (
    <div className="wiz-assistant-block" data-assistant-key={slot} ref={block} tabIndex={-1}>
      <h3 className="wiz-assistant-h">{token ? 'Server token (optional)' : 'API key'}</h3>
      <p className="wiz-assistant-status" data-assistant-key-status={key.state}>
        {keyLine(key, storage, token)}
      </p>
      {warning ? (
        <p className="wiz-assistant-warn" data-assistant-key-warning="1">
          {warning}
        </p>
      ) : null}
      {/* Keys can't be stored and none is saved: no row at all (an empty one would still take a gap). */}
      {blocked && !key.set ? null : (
        <div className="wiz-assistant-row">
          {blocked ? null : (
            <>
              <input
                ref={input}
                className="wiz-assistant-input wiz-assistant-wide"
                aria-label={label}
                placeholder={token ? 'Only if your server asks for one' : `Paste your ${CLOUD_LABEL[slot as 'anthropic' | 'openai']} key`}
                data-assistant-key-input="1"
                {...IGNORED_BY_PASSWORD_MANAGERS}
                {...(masked ? { type: 'text', style: TEXT_SECURITY } : { type: 'password' })}
                {...described(error, errorId)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    void stepChange(save());
                  }
                }}
              />
              <button type="button" className="home-btn" data-assistant-key-save="1" disabled={!!busy} onClick={() => void stepChange(save())}>
                {busy === 'save' ? 'Saving…' : token ? 'Save token' : 'Save key'}
              </button>
            </>
          )}
          {key.set ? (
            <button type="button" className="home-btn" data-assistant-key-remove="1" disabled={!!busy} onClick={() => void stepChange(remove())}>
              {busy === 'remove' ? 'Removing…' : token ? 'Remove token' : 'Remove key'}
            </button>
          ) : null}
        </div>
      )}
      {storage ? (
        <p className={blocked ? 'wiz-assistant-warn' : 'wiz-assistant-meta'} data-assistant-storage={storage.kind}>
          {storage.note}
        </p>
      ) : null}
      <ErrorLine id={errorId} text={error} hook={{ 'data-assistant-key-error': '1' }} />
    </div>
  );
}

// ---------------------------------------------------------------- model

// Not a model id: ids have no spaces or brackets.
const OTHER = '(other model id)';

type ModelList = { state: 'loading' | 'ok' | 'none' | 'error'; models: ModelInfo[]; error?: string };

function ModelBlock({ status, provider }: { status: AssistantStatus; provider: ProviderId }) {
  const current = status.models?.[provider] ?? '';
  const [list, setList] = useState<ModelList>({ state: 'loading', models: [] });
  const [tick, setTick] = useState(0);
  const [other, setOther] = useState(false);
  const [error, setError] = useState('');
  const errorId = useId();
  // A local server's list depends on where it is; a provider's on the key (without one the
  // server lists only the models Magnusim knows).
  const where = provider === 'openai_compatible' ? status.base_url : '';
  const key = keyStamp(status, provider);
  useEffect(() => {
    const ac = new AbortController();
    setList((l) => ({ state: 'loading', models: l.models }));
    assistantGet<ModelsAnswer>('/api/assistant/models', { provider }, ac.signal).then(
      (a) => {
        if (!ac.signal.aborted) setList({ state: 'ok', models: Array.isArray(a.models) ? a.models : [] });
      },
      (e: unknown) => {
        if (ac.signal.aborted) return;
        // A server without the models route: the chosen model and "Other model id…" still work.
        if (e instanceof AssistantApiError && e.status === 404) {
          setList({ state: 'none', models: [] });
          return;
        }
        // A listing the provider refused may still come with the models Magnusim knows.
        const sent = e instanceof AssistantApiError ? (e.body as { models?: unknown }).models : undefined;
        setList({ state: 'error', models: Array.isArray(sent) ? (sent as ModelInfo[]) : [], error: e instanceof Error ? e.message : String(e) });
      },
    );
    return () => ac.abort();
  }, [provider, where, key, tick]);

  const choose = async (id: string): Promise<boolean> => {
    setError('');
    if (id === OTHER) {
      setOther(true);
      return true;
    }
    setOther(false);
    if (id === current) return true;
    const r = await writeStatus(SETTINGS, { model: id });
    if (!r.ok) setError(r.error.message);
    return r.ok;
  };

  const listed = list.models.some((m) => m.id === current);
  const price = priceLine(status);
  return (
    <div className="wiz-assistant-block">
      <h3 className="wiz-assistant-h">Model</h3>
      <div className="wiz-assistant-row">
        <select
          className="wiz-assistant-input wiz-assistant-wide"
          aria-label="Model"
          data-assistant-model={current}
          value={other ? OTHER : current}
          {...described(other ? '' : error, errorId)}
          onChange={(e) => void stepChange(choose(e.target.value))}
        >
          {current ? null : (
            <option value="" disabled>
              Choose a model
            </option>
          )}
          {current && !listed ? <option value={current}>{current}</option> : null}
          {list.models.map((m) => (
            <option key={m.id} value={m.id}>
              {m.label || m.id}
            </option>
          ))}
          <option value={OTHER}>Other model id…</option>
        </select>
        <button
          type="button"
          className="home-btn"
          data-assistant-models-refresh="1"
          disabled={list.state === 'loading'}
          onClick={() => setTick((t) => t + 1)}
        >
          {list.state === 'loading' ? 'Listing…' : 'Refresh list'}
        </button>
      </div>
      {other ? (
        <ModelIdField key={current} saved={current} onSaved={() => setOther(false)} onError={setError} aria={described(error, errorId)} />
      ) : null}
      {list.state === 'error' ? (
        <p className="wiz-assistant-error" data-assistant-models-error="1">
          Couldn't list the models: {withCode(list.error ?? '')}
        </p>
      ) : null}
      {price ? (
        <p className="wiz-assistant-meta" data-assistant-price="1">
          {price}
        </p>
      ) : null}
      <ErrorLine id={errorId} text={error} hook={{ 'data-assistant-model-error': '1' }} />
    </div>
  );
}

function ModelIdField({
  saved,
  onSaved,
  onError,
  aria,
}: {
  saved: string;
  onSaved: () => void;
  onError: (text: string) => void;
  aria: ReturnType<typeof described>;
}) {
  const [draft, setDraft] = useState(saved);
  const busy = useRef(false);
  const commit = async (value: string): Promise<boolean> => {
    const next = value.trim();
    if (busy.current || !next || next === saved) return true;
    busy.current = true;
    onError('');
    const r = await writeStatus(SETTINGS, { model: next });
    busy.current = false;
    if (r.ok) onSaved();
    else onError(r.error.message);
    return r.ok;
  };
  return (
    <div className="wiz-assistant-row">
      <input
        className="wiz-assistant-input wiz-assistant-wide"
        type="text"
        aria-label="Model id"
        placeholder="The model id, as the provider names it"
        spellCheck={false}
        autoComplete="off"
        value={draft}
        data-assistant-model-other="1"
        {...aria}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={(e) => void stepChange(commit(e.currentTarget.value))}
        onKeyDown={blurOnEnter}
      />
    </div>
  );
}

// ---------------------------------------------------------------- effort

function EffortBlock({ status }: { status: AssistantStatus }) {
  const [error, setError] = useState('');
  const errorId = useId();
  return (
    <div className="wiz-assistant-block">
      <label className="wiz-assistant-row">
        <span className="wiz-assistant-h">Effort</span>
        <select
          className="wiz-assistant-input"
          data-assistant-effort={status.effort}
          value={status.effort}
          {...described(error, errorId)}
          onChange={(e) => {
            setError('');
            void stepChange(
              writeStatus(SETTINGS, { effort: e.target.value }).then((r) => {
                if (!r.ok) setError(r.error.message);
                return r.ok;
              }),
            );
          }}
        >
          {EFFORTS.map((x) => (
            <option key={x.id} value={x.id}>
              {x.label}
            </option>
          ))}
        </select>
      </label>
      <ErrorLine id={errorId} text={error} hook={{ 'data-assistant-effort-error': '1' }} />
    </div>
  );
}

// ---------------------------------------------------------------- test

type TestView = { state: 'idle' } | { state: 'running' } | { state: 'done'; ok: boolean; text: string };

function TestBlock({ provider }: { provider: ProviderId }) {
  const [view, setView] = useState<TestView>({ state: 'idle' });
  // A Test nobody waits for any more (the block started afresh, the step was left, the page
  // went) is let go: the server stops it when its request closes, and the next one can run.
  const pending = useRef<AbortController | null>(null);
  useEffect(() => () => pending.current?.abort(), []);
  const run = async () => {
    const ac = new AbortController();
    pending.current = ac;
    setView({ state: 'running' });
    try {
      const answer = await assistantPost<TestAnswer>('/api/assistant/test', {}, ac.signal);
      setView({ state: 'done', ...testLine(answer, provider) });
    } catch (e) {
      if (ac.signal.aborted) return;
      const text = e instanceof AssistantApiError && e.status === 404 ? NO_TEST_TEXT : e instanceof Error ? e.message : String(e);
      setView({ state: 'done', ok: false, text });
    } finally {
      if (pending.current === ac) pending.current = null;
    }
    // A cloud test is spent too.
    void refreshStatus();
  };
  return (
    <div className="wiz-assistant-block">
      <div className="wiz-assistant-row">
        <button type="button" className="home-btn" data-assistant-test="1" disabled={view.state === 'running'} onClick={() => void run()}>
          {view.state === 'running' ? 'Testing…' : 'Test'}
        </button>
        <p
          role="status"
          className={`wiz-assistant-test-line ${view.state === 'done' && !view.ok ? 'wiz-assistant-error' : 'wiz-assistant-meta'}`}
          data-assistant-test-result={view.state === 'done' ? (view.ok ? 'ok' : 'failed') : view.state}
        >
          {view.state === 'done' ? withCode(view.text) : view.state === 'running' ? 'Testing the connection…' : ''}
        </p>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- privacy

function PrivacyBlock({ status, provider }: { status: AssistantStatus; provider: ProviderId }) {
  const name = useId();
  const [error, setError] = useState('');
  const [pending, setPending] = useState<PrivacyMode | null>(null);
  if (provider === 'openai_compatible' && status.base_url_is_local) {
    return (
      <div className="wiz-assistant-block">
        <p className="wiz-assistant-meta" data-assistant-privacy-local="1">
          {LOCAL_PRIVACY_TEXT}
        </p>
      </div>
    );
  }
  const destination = provider === 'openai_compatible' ? `the server at ${hostOf(status.base_url)}` : CLOUD_LABEL[provider];
  const save = async (patch: Record<string, unknown>): Promise<boolean> => {
    setError('');
    if (typeof patch.privacy === 'string') setPending(patch.privacy as PrivacyMode);
    const r = await writeStatus(SETTINGS, patch);
    setPending(null);
    if (!r.ok) setError(r.error.message);
    return r.ok;
  };
  const shown = pending ?? status.privacy;
  const remembered = Number(status.consents) || 0;
  return (
    <div className="wiz-assistant-block">
      <h3 className="wiz-assistant-h">Project data</h3>
      <div className="wiz-assistant-inline-options" role="radiogroup" aria-label="Project data" data-assistant-privacy={status.privacy}>
        {PRIVACY.map((p) => (
          <label key={p.id} className="wiz-assistant-inline-option" data-assistant-privacy-option={p.id}>
            <input type="radio" name={name} value={p.id} checked={shown === p.id} onChange={() => void stepChange(save({ privacy: p.id }))} />
            <span>{p.label}</span>
          </label>
        ))}
      </div>
      <p className="wiz-assistant-meta">
        When you ask about a project, your messages and what the Assistant reads from it (names, settings, results and pictures of the
        open workspace) go to {destination}.
      </p>
      <div className="wiz-assistant-row">
        <button
          type="button"
          className="home-btn"
          data-assistant-forget="1"
          disabled={!remembered}
          onClick={() => void stepChange(save({ forget_consents: true }))}
        >
          Forget project answers ({remembered})
        </button>
      </div>
      {provider !== 'openai_compatible' && hasFallback(status) ? (
        <p className="wiz-assistant-meta" data-assistant-fallback-note="1">
          {FALLBACK_TEXT}
        </p>
      ) : null}
      <ErrorLine text={error} hook={{ 'data-assistant-privacy-error': '1' }} />
    </div>
  );
}

// ---------------------------------------------------------------- limits

type CapKey = keyof Caps;
const CAP_HOOK: Record<CapKey, string> = {
  turn_usd: 'data-assistant-cap-turn-usd',
  day_usd: 'data-assistant-cap-day-usd',
  steps: 'data-assistant-cap-steps',
  turn_minutes: 'data-assistant-cap-minutes',
  turn_tokens: 'data-assistant-cap-tokens',
};

function LimitsBlock({ status }: { status: AssistantStatus }) {
  const cloud = isCloud(status.provider);
  const caps = status.caps;
  const field = (cap: CapKey, label: string, isMoney: boolean) => (
    // A new saved value starts the field afresh; a refused one keeps what was typed.
    <CapField key={`${cap}:${caps[cap]}`} cap={cap} label={label} saved={caps[cap]} isMoney={isMoney} />
  );
  return (
    <div className="wiz-assistant-block" data-assistant-limits="1">
      <h3 className="wiz-assistant-h">Limits</h3>
      <div className="wiz-assistant-caps">
        {cloud ? field('turn_usd', '$ per turn', true) : null}
        {cloud ? field('day_usd', '$ per day', true) : null}
        {field('steps', 'Steps per turn', false)}
        {field('turn_minutes', 'Minutes per turn', false)}
      </div>
      {cloud ? (
        <>
          <p className="wiz-assistant-status" data-assistant-spent="1">
            Spent today: {cents(Number(status.spent_today_usd))} of ${capText(caps.day_usd, true)}
          </p>
          <p className="wiz-assistant-meta">{LIMITS_TEXT}</p>
          <p className="wiz-assistant-meta" data-assistant-shared-pc="1">
            {SHARED_PC_TEXT}
          </p>
        </>
      ) : status.base_url_is_local === false ? (
        <p className="wiz-assistant-meta" data-assistant-server-limits="1">
          {SERVER_LIMITS_TEXT}
        </p>
      ) : (
        <p className="wiz-assistant-meta" data-assistant-local-limits="1">
          {LOCAL_LIMITS_TEXT}
        </p>
      )}
    </div>
  );
}

function CapField({ cap, label, saved, isMoney }: { cap: CapKey; label: string; saved: number; isMoney: boolean }) {
  // The limit as it is enforced: a $ limit with a third decimal is not shown rounded.
  const shown = capText(saved, isMoney);
  const [draft, setDraft] = useState(shown);
  const [error, setError] = useState('');
  const errorId = useId();
  /** Saves what was typed (nothing when it is the saved limit): false when refused. */
  const commit = async (): Promise<boolean> => {
    const text = draft.trim().replace(/^\$/, '');
    const n = Number(text);
    if (!text || !Number.isFinite(n)) {
      setError('Enter a number.');
      return false;
    }
    if (n === saved) {
      setError('');
      setDraft(shown);
      return true;
    }
    const r = await writeStatus(SETTINGS, { caps: { [cap]: n } });
    if (r.ok) setError('');
    else setError(r.error.message);
    return r.ok;
  };
  return (
    <label className="wiz-assistant-cap">
      <span>{label}</span>
      <input
        className="wiz-assistant-input"
        type="number"
        step={isMoney ? '0.01' : '1'}
        inputMode={isMoney ? 'decimal' : 'numeric'}
        value={draft}
        {...described(error, errorId)}
        {...{ [CAP_HOOK[cap]]: '1' }}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => void stepChange(commit())}
        onKeyDown={blurOnEnter}
      />
      {error ? (
        <span id={errorId} className="wiz-assistant-error" role="alert" data-assistant-cap-error={cap}>
          {error}
        </span>
      ) : null}
    </label>
  );
}

// ---------------------------------------------------------------- test switches

function TestSwitchLine({ status }: { status: AssistantStatus }) {
  const parts: string[] = [];
  if (status.test_protector) parts.push(`key protector (${status.test_protector})`);
  if (status.test_provider) parts.push('test provider address');
  if (!parts.length) return null;
  return (
    <p className="wiz-assistant-warn" data-assistant-test-provider="1">
      Test switches in use: {parts.join(', ')}.
    </p>
  );
}

