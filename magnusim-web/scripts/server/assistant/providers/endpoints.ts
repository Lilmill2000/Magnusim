/**
 * Where the cloud providers are (fixed), and the one test switch that moves them.
 *
 * MAGNUSIM_TEST_ASSISTANT_PROVIDER_URL points both cloud adapters at a fake provider
 * (e2e/support/fake-llm.mjs: `<url>/anthropic`, `<url>/openai/v1`). It is read once, and
 * honoured only with MAGNUSIM_TEST_ASSISTANT=1, in a test home (MAGNUSIM_ASSISTANT_HOME
 * or MAGNUSIM_LOCAL_JSON), and for a plain-http address on this PC; anything else is
 * ignored with a log line, so a stray variable can never send a real key elsewhere.
 * Status reports `test_provider: true` while it is in use.
 */
import { assistantHomeIsOverridden } from '../home.ts';
import { alog } from '../log.ts';
import { isLoopbackHost } from '../settings.ts';

export const CLOUD_BASE_URLS = Object.freeze({
  anthropic: 'https://api.anthropic.com',
  openai: 'https://api.openai.com/v1',
});

/** The switch's address if it may be used with this environment, else null (and why). */
export function resolveTestProviderUrl(env: NodeJS.ProcessEnv): { url: string | null; ignored: string | null } {
  const raw = String(env.MAGNUSIM_TEST_ASSISTANT_PROVIDER_URL || '').trim();
  if (!raw) return { url: null, ignored: null };
  if (env.MAGNUSIM_TEST_ASSISTANT !== '1') return { url: null, ignored: 'it needs MAGNUSIM_TEST_ASSISTANT=1' };
  if (!assistantHomeIsOverridden({ env })) return { url: null, ignored: 'it is honoured only in a test home' };
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return { url: null, ignored: 'it is not a URL' };
  }
  if (u.protocol !== 'http:' || !isLoopbackHost(u.hostname)) return { url: null, ignored: 'it must be an http address on this PC' };
  if (u.username || u.password || u.search || u.hash) return { url: null, ignored: 'it must be a plain address' };
  return { url: `${u.origin}${u.pathname.replace(/\/+$/, '')}`, ignored: null };
}

let cached: { url: string | null } | null = null;

/** The fake provider's address, read once; null in normal use. */
export function testProviderUrl(): string | null {
  if (!cached) {
    const r = resolveTestProviderUrl(process.env);
    if (r.ignored) alog('warn', `MAGNUSIM_TEST_ASSISTANT_PROVIDER_URL is ignored: ${r.ignored}`);
    cached = { url: r.url };
  }
  return cached.url;
}

/** The base URL a cloud adapter talks to. */
export function cloudBaseUrl(provider: 'anthropic' | 'openai'): string {
  const test = testProviderUrl();
  if (!test) return CLOUD_BASE_URLS[provider];
  return provider === 'anthropic' ? `${test}/anthropic` : `${test}/openai/v1`;
}
