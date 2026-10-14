import { afterEach, describe, expect, it, vi } from 'vitest';
import { subscribeJobEvents } from './client';

// The tab's one event stream (src/api/eventHub.ts) hands each stream out as a channel shaped
// like an EventSource: here, the test's fake one.
vi.mock('./eventHub', () => ({
  openChannel: (url: string) => {
    const es = new (globalThis as unknown as { EventSource: new (u: string) => Record<string, unknown> }).EventSource(url);
    if (typeof es.pin !== 'function') es.pin = () => undefined;
    return es;
  },
}));

describe('job stream lifecycle', () => {
  afterEach(() => vi.unstubAllGlobals());
  it('delivers snapshot/event messages and closes terminal streams', () => {
    const listeners = new Map<string, (event: MessageEvent) => void>();
    const close = vi.fn();
    vi.stubGlobal('EventSource', class {
      onmessage = null;
      close = close;
      addEventListener(type: string, listener: (event: MessageEvent) => void) { listeners.set(type, listener); }
    });
    const received = vi.fn();
    const unsubscribe = subscribeJobEvents('test-job', received);
    for (const type of ['snapshot', 'event', 'end']) listeners.get(type)?.(new MessageEvent(type, {data: '{}'}));
    expect(received).toHaveBeenCalledTimes(3);
    expect(close).toHaveBeenCalledTimes(1);
    unsubscribe();
    expect(close).toHaveBeenCalledTimes(2);
  });
});
