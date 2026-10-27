import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import shellHtml from '../app/shell.html?raw';

// Settings in Magnusim CAD (src/app/edition.ts): Units, Assistant and Plugins only, never
// opened by itself and no PC check; Magnusim's Settings unchanged.
vi.mock('../islands', () => ({ mountIsland: () => undefined, unmountIsland: () => undefined }));
vi.mock('../assistant/status', () => ({ settleStep: () => true }));

let prefs: Record<string, unknown>;
let checks = 0;

const $ = (sel: string) => document.querySelector(sel) as HTMLElement;
const shownRail = () => [...document.querySelectorAll<HTMLElement>('#wiz-rail li')].filter((li) => !li.hidden).map((li) => li.getAttribute('data-wiz-key'));
const shownPane = () => document.querySelector('.wiz-pane:not([hidden])')?.getAttribute('data-wiz-key');

function page(edition: 'cad' | null): void {
  const doc = new DOMParser().parseFromString(shellHtml, 'text/html');
  document.head.innerHTML = edition ? `<meta name="magnusim-edition" content="${edition}">` : '';
  document.body.innerHTML = doc.getElementById('setup-wizard')?.outerHTML || '';
}

async function load(p: Record<string, unknown>) {
  prefs = { ok: true, units: 'Metric', port: 8082, ...p };
  vi.resetModules();
  const c = await import('./controller');
  await c.initSetupWizard();
  return c;
}

beforeEach(() => {
  checks = 0;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      if (String(input) === '/api/prefs/hardware-check') {
        checks += 1;
        return new Response(JSON.stringify({ ok: true, hardware: { profile: 'standard' } }), { status: 200 });
      }
      return new Response(JSON.stringify(prefs), { status: 200 });
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  document.head.innerHTML = '';
  document.body.innerHTML = '';
});

describe('Settings in Magnusim CAD', () => {
  it('shows Units, Assistant and Plugins, and a hidden section cannot be opened', async () => {
    page('cad');
    const c = await load({ wizard_completed: true });
    c.openSetupWizard({});
    expect(shownRail()).toEqual(['units', 'assistant', 'plugins']);
    expect(shownPane()).toBe('units');
    c.openSetupWizard({ step: 'plugins' });
    expect(shownPane()).toBe('plugins');
    c.openSetupWizard({ step: 'assistant' });
    expect(shownPane()).toBe('assistant');
    expect(checks).toBe(0);
  });

  it('never opens by itself, and runs no PC check, on the first run', async () => {
    page('cad');
    await load({ wizard_completed: false });
    await new Promise((r) => setTimeout(r, 0));
    expect($('#setup-wizard').hidden).toBe(true);
    expect(checks).toBe(0);
  });
});

describe('Settings in Magnusim (unchanged)', () => {
  it('shows every section, and the first run opens it on Units with the PC check', async () => {
    page(null);
    await load({ wizard_completed: false });
    await new Promise((r) => setTimeout(r, 0));
    expect($('#setup-wizard').hidden).toBe(false);
    expect(shownRail()).toEqual(['units', 'pc', 'port', 'workspace', 'assistant', 'plugins']);
    expect(shownPane()).toBe('units');
    expect(checks).toBe(1);
  });
});
