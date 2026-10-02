import { act } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mount } from './page';

const HERE = dirname(fileURLToPath(import.meta.url));

describe('the dev sheet page', () => {
  let host: HTMLElement;
  let frame: HTMLIFrameElement;
  let other: HTMLIFrameElement;

  beforeAll(async () => {
    // jsdom has no document.fonts; the page waits on it before it marks itself ready.
    Object.defineProperty(document, 'fonts', { configurable: true, value: { ready: Promise.resolve() } });
    host = document.createElement('div');
    document.body.appendChild(host);
    other = document.createElement('iframe');
    document.body.appendChild(other);
    await act(async () => {
      mount(host);
    });
    frame = host.querySelector('iframe[title="UI kit in a workspace frame"]') as HTMLIFrameElement;
  });

  afterAll(() => {
    host.remove();
    other.remove();
  });

  function post(source: Window | null, data: unknown) {
    act(() => {
      window.dispatchEvent(new MessageEvent('message', { data, source }));
    });
  }

  it('draws the frame sandboxed like a workspace, and marks itself ready', () => {
    expect(frame.getAttribute('sandbox')).toBe('allow-scripts allow-downloads');
    expect(frame.getAttribute('src')).toBe('/plugin-sdk/ui-kit-sheet.html');
    expect(host.querySelector('[data-kit-sheet-ready="page"]')).not.toBeNull();
  });

  it('takes its frame height only from a message its own frame posts', () => {
    expect(frame.style.height).toBe('800px');
    expect(frame.contentWindow).not.toBeNull();
    post(window, { type: 'kit-sheet-height', height: 1234 });
    post(other.contentWindow, { type: 'kit-sheet-height', height: 1234 });
    post(null, { type: 'kit-sheet-height', height: 1234 });
    expect(frame.style.height).toBe('800px');
    // From the frame: other messages and bad heights do nothing.
    post(frame.contentWindow, { type: 'something-else', height: 1234 });
    post(frame.contentWindow, { type: 'kit-sheet-height', height: -5 });
    post(frame.contentWindow, { type: 'kit-sheet-height', height: '900' });
    expect(frame.style.height).toBe('800px');
    post(frame.contentWindow, { type: 'kit-sheet-height', height: 1234.2 });
    expect(frame.style.height).toBe('1235px');
  });
});

describe('the dev sheet route (main.tsx)', () => {
  const main = readFileSync(join(HERE, '..', '..', 'app', 'main.tsx'), 'utf8');

  it('opens only on a dev server started with VITE_MAGNUSIM_DEV_SHEETS=1, before the shell', () => {
    expect(main).toContain("const DEV_SHEETS = import.meta.env.DEV && import.meta.env.VITE_MAGNUSIM_DEV_SHEETS === '1';");
    const route = main.indexOf("if (DEV_SHEETS && location.hash.startsWith('#/dev/ui-kit')) {");
    expect(route).toBeGreaterThan(0);
    expect(main.indexOf("(await import('../dev/ui-kit/page')).mount(ensureReactRoot());", route)).toBeGreaterThan(route);
    expect(main.indexOf('injectShell();', route)).toBeGreaterThan(route);
    // The page module is reached through that branch only.
    expect(main.match(/import\(['"][^'"]*dev\/ui-kit/g)).toHaveLength(1);
    expect(main).not.toMatch(/^\s*import\b[^;]*dev\/ui-kit/m);
  });
});
