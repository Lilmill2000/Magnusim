/**
 * The provider adapters, built from the settings (Foundation spec 5).
 *
 * This is the only place a provider key is borrowed (SecretStore.withKey): each adapter
 * gets a lender for its own slot and borrows the key for one request at a time. The SDK
 * clients are built per request with the key, the base URL and every credential option
 * explicit, so no SDK reads a key, token, profile, organization or address from the
 * environment or from a profile file.
 */
import { isAgentProvider, isLoopbackUrl, serverOrigin, type AssistantSettings } from '../settings.ts';
import { withDebugScope } from '../debug-log.ts';
import { ProviderError, type ProviderAdapter, type ProviderId, type ProviderRequest, type ProviderResult, type StreamEvent } from '../types.ts';
import { KeyError, type KeySlot, type KeyStatus } from '../secrets/store.ts';
import { anthropicAdapter } from './anthropic.ts';
import type { AdapterOptions } from './common.ts';
import { cloudBaseUrl } from './endpoints.ts';
import type { WatchdogOptions } from './guarded-fetch.ts';
import { openAiAdapter } from './openai.ts';
import { openAiCompatibleAdapter } from './openai-compatible.ts';

export { ProviderError };

/** What the adapters need of the secret store: whether a key is set, and lending it. */
export interface KeyLender {
  load?(): Promise<void>;
  status(): Record<KeySlot, KeyStatus>;
  withKey<T>(slot: KeySlot, use: (key: string) => Promise<T>): Promise<T>;
}

type ProviderSettings = Pick<AssistantSettings, 'provider' | 'base_url'>;

export const PROVIDER_LABELS: Readonly<Record<ProviderId, string>> = Object.freeze({
  anthropic: 'Anthropic',
  openai: 'OpenAI',
  openai_compatible: 'Local server',
});

/**
 * Project data would leave this PC: a cloud provider, a local-server address that isn't on this
 * PC, or a coding agent (it sends what it reads to its own service).
 */
export function isCloud(s: ProviderSettings): boolean {
  if (s.provider === 'anthropic' || s.provider === 'openai') return true;
  if (isAgentProvider(s.provider)) return true;
  if (s.provider === 'openai_compatible') return !isLoopbackUrl(s.base_url);
  return false;
}

/**
 * Where project data goes: `anthropic`, `openai`, `host:<hostname>` for a local server, or
 * `agent:<id>` for a coding agent (a consent for one agent doesn't cover another); '' when off.
 */
export function destinationOf(s: ProviderSettings): string {
  if (s.provider === 'anthropic' || s.provider === 'openai') return s.provider;
  if (isAgentProvider(s.provider)) return s.provider;
  if (s.provider === 'openai_compatible') {
    try {
      return `host:${new URL(s.base_url).hostname.toLowerCase()}`;
    } catch {
      return 'host:';
    }
  }
  return '';
}

export interface CreateOptions {
  /** Tests: shorter watchdog waits. */
  watchdog?: WatchdogOptions;
  env?: NodeJS.ProcessEnv;
  /** Tests: the clock the local server's model rows are kept by. */
  now?: () => number;
}

/**
 * The store's refusal to lend a key, as the adapters report it. The first unlock after a
 * start can fail (Windows blocked the helper, or it timed out) before storage() knows it.
 */
function lendError(err: KeyError): ProviderError {
  if (err.code === 'storage_unavailable') return new ProviderError('storage_unavailable', err.message);
  return new ProviderError('no_key', err.message);
}

/** Why a saved server token is not sent: it was saved for another server address. */
export function tokenElsewhereText(origin: string | null): string {
  return `The saved server token is for ${origin ?? 'another server address'}. Save it again for this server, or remove it, in Settings → Assistant.`;
}

/** The adapter for the settings' provider (a snapshot: later settings changes don't reach it). */
export function createAdapter(settings: ProviderSettings, secrets: KeyLender, o: CreateOptions = {}): ProviderAdapter {
  const provider = settings.provider;
  if (provider === 'off') throw new ProviderError('other', 'The Assistant is off. Choose a provider in Settings → Assistant.');
  // A coding agent has no model adapter: its turns run on agents/turn.ts.
  if (isAgentProvider(provider)) throw new ProviderError('other', 'A coding agent has no model adapter.');
  const lend = (slot: KeySlot, optional: boolean): AdapterOptions['borrowKey'] =>
    async <T>(use: (key: string | null) => Promise<T>): Promise<T> => {
      await secrets.load?.();
      if (optional) {
        const saved = secrets.status()[slot];
        if (!saved?.set) return use(null);
        // A server token goes only to the server it was saved for (never to an address set later).
        if (!saved.origin || saved.origin !== serverOrigin(settings.base_url)) throw new ProviderError('no_key', tokenElsewhereText(saved.origin ?? null));
      }
      try {
        return await secrets.withKey(slot, (key) => use(key));
      } catch (err) {
        // Only the store throws KeyError (the adapters map their own failures).
        throw err instanceof KeyError ? lendError(err) : err;
      }
    };
  const common = { watchdog: o.watchdog, env: o.env };
  if (provider === 'anthropic') return anthropicAdapter({ ...common, baseURL: cloudBaseUrl('anthropic'), borrowKey: lend('anthropic', false) });
  if (provider === 'openai') return openAiAdapter({ ...common, baseURL: cloudBaseUrl('openai'), borrowKey: lend('openai', false) });
  return openAiCompatibleAdapter({
    ...common,
    baseURL: settings.base_url,
    borrowKey: lend('openai_compatible', true),
    cloud: isCloud(settings),
    destination: destinationOf(settings),
    ...(o.now ? { now: o.now } : {}),
  });
}

/** The wait before the one resend after an overload (spec 5.6). */
export const OVERLOAD_RESEND_MS = 2_000;

/**
 * adapter.send(), sent once more after 2 s when the provider was overloaded (often
 * mid-stream). The partial answer is never kept: `onResend` lets the caller discard
 * what it showed. Right before the resend, `resendRequest` may change the request (the
 * caller reserves its spend again, so a smaller output limit) or throw to send nothing
 * more. Any other failure, or a second overload, is thrown.
 */
export async function sendWithOneResend(
  adapter: ProviderAdapter,
  req: ProviderRequest,
  signal: AbortSignal,
  onEvent: (e: StreamEvent) => void,
  o: { onResend?: (err: ProviderError) => void; resendRequest?: (req: ProviderRequest) => ProviderRequest | Promise<ProviderRequest>; delayMs?: number } = {},
): Promise<ProviderResult> {
  try {
    return await adapter.send(req, signal, onEvent);
  } catch (err) {
    if (!(err instanceof ProviderError) || err.code !== 'overloaded' || signal.aborted) throw err;
    o.onResend?.(err);
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        signal.removeEventListener('abort', onAbort);
        resolve();
      }, o.delayMs ?? OVERLOAD_RESEND_MS);
      const onAbort = () => {
        clearTimeout(timer);
        reject(signal.reason instanceof ProviderError ? signal.reason : new ProviderError('aborted', 'Stopped.'));
      };
      signal.addEventListener('abort', onAbort, { once: true });
    });
    const again = o.resendRequest ? await o.resendRequest(req) : req;
    return withDebugScope({ resend: 'overloaded' }, () => adapter.send(again, signal, onEvent));
  }
}
