import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import shellHtml from '../app/shell.html?raw';

// The wizard as shell.html has it; the islands it mounts are recorded, not rendered.
const islands = vi.hoisted(() => ({ calls: [] as string[] }));
vi.mock('../islands', () => ({
  mountIsland: (id: string) => islands.calls.push(`mount ${id}`),
  unmountIsland: (id: string) => islands.calls.push(`unmount ${id}`),
}));
// What the Assistant step answers when it is left (assistant/status.ts settleStep).
const leaving = vi.hoisted(() => ({ settle: (): true | Promise<boolean> => true, asked: 0 }));
vi.mock('../assistant/status', () => ({
  settleStep: () => {
    leaving.asked += 1;
    return leaving.settle();
  },
}));

type Controller = typeof import('./controller');

let prefs: Record<string, unknown>;
let saved: Array<Record<string, unknown>>;

function wizardMarkup(): string {
  const doc = new DOMParser().parseFromString(shellHtml, 'text/html');
  const el = doc.getElementById('setup-wizard');
  if (!el) throw new Error('no #setup-wizard in shell.html');
  return el.outerHTML;
}

const $ = (sel: string) => document.querySelector(sel) as HTMLElement;
const shownPane = () => document.querySelector('.wiz-pane:not([hidden])')?.getAttribute('data-wiz-key');
const railKeys = () => [...document.querySelectorAll('#wiz-rail li')].map((li) => li.getAttribute('data-wiz-key'));
const onKey = () => document.querySelector('#wiz-rail li.is-on')?.getAttribute('data-wiz-key');
const doneKeys = () => [...document.querySelectorAll('#wiz-rail li.is-done')].map((li) => li.getAttribute('data-wiz-key'));
const flush = () => new Promise((r) => setTimeout(r, 0));

async function load(p: Record<string, unknown>): Promise<Controller> {
  prefs = { ok: true, units: 'Metric', port: 8082, ...p };
  vi.resetModules();
  const c = await import('./controller');
  await c.initSetupWizard();
  return c;
}

beforeEach(() => {
  islands.calls = [];
  leaving.settle = () => true;
  leaving.asked = 0;
  saved = [];
  document.body.innerHTML = wizardMarkup();
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === '/api/prefs' && init?.method === 'POST') {
        const body = JSON.parse(String(init.body || '{}'));
        saved.push(body);
        prefs = { ...prefs, ...body };
        return new Response(JSON.stringify({ ok: true, prefs }), { status: 200 });
      }
      if (url === '/api/prefs/hardware-check') return new Response(JSON.stringify({ ok: true, hardware: { profile: 'standard' } }), { status: 200 });
      return new Response(JSON.stringify(prefs), { status: 200 });
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
});

describe('setup wizard steps', () => {
  it('walks Welcome … Workspace, Assistant, Plugins in that order, by position', async () => {
    await load({ wizard_completed: false });
    expect(railKeys()).toEqual(['welcome', 'units', 'pc', 'port', 'workspace', 'assistant', 'plugins']);
    const walked = [shownPane()];
    for (let i = 0; i < 6; i += 1) {
      $('#wiz-next').click();
      walked.push(shownPane());
    }
    expect(walked).toEqual(['welcome', 'units', 'pc', 'port', 'workspace', 'assistant', 'plugins']);
    expect(onKey()).toBe('plugins');
    // Back goes by position too: Plugins → Assistant → Workspace.
    $('#wiz-back').click();
    expect(shownPane()).toBe('assistant');
    $('#wiz-back').click();
    expect(shownPane()).toBe('workspace');
  });

  it('Next reads Finish only on Plugins, and Finish saves and closes', async () => {
    await load({ wizard_completed: false });
    for (let i = 0; i < 5; i += 1) $('#wiz-next').click();
    expect(shownPane()).toBe('assistant');
    expect($('#wiz-next').textContent).toBe('Next');
    $('#wiz-next').click();
    expect(shownPane()).toBe('plugins');
    expect($('#wiz-next').textContent).toBe('Finish');
    $('#wiz-next').click();
    await flush();
    await flush();
    expect(saved.some((b) => b.wizard_completed === true)).toBe(true);
    expect($('#setup-wizard').hidden).toBe(true);
  });

  it('marks the steps before the shown one done, by position', async () => {
    const c = await load({ wizard_completed: true });
    c.openSetupWizard({ required: false, step: 'plugins' });
    expect(doneKeys()).toEqual(['welcome', 'units', 'pc', 'port', 'workspace', 'assistant']);
    c.openSetupWizard({ required: false, step: 'assistant' });
    expect(doneKeys()).toEqual(['welcome', 'units', 'pc', 'port', 'workspace']);
    expect(onKey()).toBe('assistant');
  });

  it('mounts the Assistant step on entering it and unmounts it on leaving and on close', async () => {
    const c = await load({ wizard_completed: true });
    // Settings, for someone who finished the first run.
    c.openSetupWizard({ required: false });
    expect(shownPane()).toBe('workspace');
    islands.calls = [];
    $('#wiz-next').click();
    expect(islands.calls).toEqual(['mount wiz-assistant']);
    // Showing it again (its rail entry) does not mount it twice.
    ($('#wiz-rail li[data-wiz-key="assistant"]') as HTMLElement).click();
    expect(islands.calls).toEqual(['mount wiz-assistant']);
    $('#wiz-next').click();
    expect(islands.calls).toEqual(['mount wiz-assistant', 'unmount wiz-assistant', 'mount wiz-plugins']);
    ($('#wiz-rail li[data-wiz-key="assistant"]') as HTMLElement).click();
    islands.calls = [];
    $('#wiz-skip').click();
    expect(islands.calls).toEqual(['unmount wiz-plugins', 'unmount wiz-assistant']);
    expect($('#setup-wizard').hidden).toBe(true);
  });

  it("opens on the Assistant for step 'assistant', and returning users still open on Workspace", async () => {
    const c = await load({ wizard_completed: true });
    expect($('#setup-wizard').hidden).toBe(true);
    c.openSetupWizard({ required: false });
    expect(shownPane()).toBe('workspace');
    c.openSetupWizard({ required: false, step: 'assistant' });
    expect(shownPane()).toBe('assistant');
    expect(islands.calls).toContain('mount wiz-assistant');
    c.openSetupWizard({ required: false });
    expect(shownPane()).toBe('workspace');
    expect(islands.calls[islands.calls.length - 1]).toBe('unmount wiz-assistant');
    c.openSetupWizard({ required: false, step: 'plugins' });
    expect(shownPane()).toBe('plugins');
  });

  it('the required first run starts at Welcome, ignores a step, and Next always goes on from the Assistant', async () => {
    const c = await load({ wizard_completed: false });
    expect(shownPane()).toBe('welcome');
    expect($('#wiz-skip').hidden).toBe(true);
    c.openSetupWizard({ required: true, step: 'assistant' });
    expect(shownPane()).toBe('welcome');
    for (let i = 0; i < 5; i += 1) $('#wiz-next').click();
    expect(shownPane()).toBe('assistant');
    $('#wiz-next').click();
    expect(shownPane()).toBe('plugins');
  });
});

describe('leaving the Assistant step', () => {
  /** A settle the test answers: the step's changes on their way. */
  function pendingSettle() {
    let answer!: (ok: boolean) => void;
    leaving.settle = () => new Promise<boolean>((r) => (answer = r));
    return (ok: boolean) => answer(ok);
  }

  async function onAssistant(c: Controller) {
    c.openSetupWizard({ required: false, step: 'assistant' });
    expect(shownPane()).toBe('assistant');
  }

  it('any other step is left without asking it', async () => {
    const c = await load({ wizard_completed: true });
    c.openSetupWizard({ required: false });
    $('#wiz-back').click();
    $('#wiz-next').click();
    ($('#wiz-rail li[data-wiz-key="plugins"]') as HTMLElement).click();
    expect(shownPane()).toBe('plugins');
    expect(leaving.asked).toBe(0);
  });

  it('Next waits for the step to settle, a second press meanwhile does nothing more, and it goes on once saved', async () => {
    const c = await load({ wizard_completed: true });
    await onAssistant(c);
    const answer = pendingSettle();
    islands.calls = [];
    $('#wiz-next').click();
    $('#wiz-next').click();
    expect(leaving.asked).toBe(1);
    expect(shownPane()).toBe('assistant');
    expect(islands.calls).toEqual([]);
    answer(true);
    await flush();
    expect(shownPane()).toBe('plugins');
    expect(islands.calls).toEqual(['unmount wiz-assistant', 'mount wiz-plugins']);
  });

  it('a refused change keeps the step on screen; the next press, with nothing on its way, leaves', async () => {
    const c = await load({ wizard_completed: true });
    await onAssistant(c);
    const answer = pendingSettle();
    $('#wiz-back').click();
    answer(false);
    await flush();
    expect(shownPane()).toBe('assistant');
    leaving.settle = () => true;
    $('#wiz-back').click();
    expect(shownPane()).toBe('workspace');
  });

  it('Close and a rail entry wait the same way; the Assistant entry itself leaves nothing', async () => {
    const c = await load({ wizard_completed: true });
    await onAssistant(c);
    let answer = pendingSettle();
    ($('#wiz-rail li[data-wiz-key="assistant"]') as HTMLElement).click();
    expect(leaving.asked).toBe(0);
    ($('#wiz-rail li[data-wiz-key="units"]') as HTMLElement).click();
    expect(shownPane()).toBe('assistant');
    answer(true);
    await flush();
    expect(shownPane()).toBe('units');
    await onAssistant(c);
    answer = pendingSettle();
    $('#wiz-skip').click();
    expect($('#setup-wizard').hidden).toBe(false);
    answer(true);
    await flush();
    expect($('#setup-wizard').hidden).toBe(true);
    expect(islands.calls[islands.calls.length - 1]).toBe('unmount wiz-assistant');
  });

  it('a leave that settles after the step was shown again moves nothing', async () => {
    const c = await load({ wizard_completed: true });
    await onAssistant(c);
    const answer = pendingSettle();
    $('#wiz-next').click();
    // A link about plugins, then back on the Assistant: another showing of the step.
    c.openSetupWizard({ required: false, step: 'plugins' });
    leaving.settle = () => true;
    ($('#wiz-rail li[data-wiz-key="assistant"]') as HTMLElement).click();
    expect(shownPane()).toBe('assistant');
    answer(true);
    await flush();
    expect(shownPane()).toBe('assistant');
  });
});
