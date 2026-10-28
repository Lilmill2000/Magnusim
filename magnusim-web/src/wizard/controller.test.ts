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

// Keybinds' Reset all keybinds: the plugins it would change, the person's answer to its question.
const keys = vi.hoisted(() => ({
  own: ['Keys demo'] as string[],
  answer: true as boolean | Promise<boolean>,
  asked: [] as { title?: string; copy?: string; yes?: string; safe?: boolean }[],
  reset: 0,
  // What the reset answers besides: plugins it could not reset, or the list not read.
  failed: [] as { name: string; why: string }[],
  error: '',
}));
vi.mock('../workbench/dialogs', () => ({
  confirmAction: async (o: (typeof keys.asked)[number]) => {
    keys.asked.push(o);
    return keys.answer;
  },
}));
vi.mock('../keybinds/catalog', () => ({
  resetEveryPlugin: async (ask: (names: string[]) => Promise<boolean>) => {
    if (keys.error) return { asked: false, reset: [], failed: [], error: keys.error };
    if (!keys.own.length) return { asked: false, reset: [], failed: keys.failed, error: '' };
    if (!(await ask(keys.own))) return { asked: true, reset: [], failed: [], error: '' };
    keys.reset += 1;
    return { asked: true, reset: keys.own, failed: keys.failed, error: '' };
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
const rail = (key: string) => $(`#wiz-rail li[data-wiz-key="${key}"]`);
const flush = () => new Promise((r) => setTimeout(r, 0));
const esc = () => $('#setup-wizard').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));

async function load(p: Record<string, unknown>): Promise<Controller> {
  prefs = { ok: true, units: 'Metric', port: 8082, ...p };
  vi.resetModules();
  const c = await import('./controller');
  await c.initSetupWizard();
  return c;
}

let checks = 0;

beforeEach(() => {
  islands.calls = [];
  Object.assign(keys, { own: ['Keys demo'], answer: true, asked: [], reset: 0, failed: [], error: '' });
  leaving.settle = () => true;
  leaving.asked = 0;
  saved = [];
  checks = 0;
  document.body.innerHTML = wizardMarkup();
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === '/api/prefs' && init?.method === 'POST') {
        const body = JSON.parse(String(init.body || '{}'));
        saved.push(body);
        prefs = { ...prefs, ...body };
        return new Response(JSON.stringify({ ok: true, prefs, restart_required: body.port != null && body.port !== 8082 }), { status: 200 });
      }
      if (url === '/api/prefs/hardware-check') {
        checks += 1;
        return new Response(JSON.stringify({ ok: true, hardware: { profile: 'standard' } }), { status: 200 });
      }
      return new Response(JSON.stringify(prefs), { status: 200 });
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
});

describe('Settings', () => {
  it("is sections on the left (no Welcome), an X and Esc, and no Next, Back, Finish or Close (Daniel: the sections are the way around)", async () => {
    const c = await load({ wizard_completed: true });
    expect(railKeys()).toEqual(['units', 'pc', 'port', 'workspace', 'keybinds', 'assistant', 'plugins']);
    expect(document.querySelectorAll('[data-wiz-key="welcome"], #wiz-next, #wiz-back, #wiz-skip, .wiz-foot')).toHaveLength(0);
    expect($('#wiz-heading')).toHaveTextContent('Settings');
    expect($('#wiz-close')).toHaveAccessibleName('Close settings');
    c.openSetupWizard({});
    expect(shownPane()).toBe('units');
    for (const key of ['port', 'plugins', 'pc', 'keybinds', 'workspace']) {
      rail(key).click();
      expect([shownPane(), onKey(), rail(key).getAttribute('aria-current')]).toEqual([key, key, 'page']);
    }
    $('#wiz-close').click();
    expect($('#setup-wizard').hidden).toBe(true);
    c.openSetupWizard({});
    expect(shownPane()).toBe('units');
    esc();
    expect($('#setup-wizard').hidden).toBe(true);
  });

  it("opens on the Assistant, Plugins or Keybinds for a link about one, else on Units", async () => {
    const c = await load({ wizard_completed: true });
    expect($('#setup-wizard').hidden).toBe(true);
    c.openSetupWizard({ step: 'assistant' });
    expect(shownPane()).toBe('assistant');
    expect(islands.calls).toContain('mount wiz-assistant');
    c.openSetupWizard({});
    expect(shownPane()).toBe('units');
    expect(islands.calls[islands.calls.length - 1]).toBe('unmount wiz-assistant');
    c.openSetupWizard({ step: 'plugins' });
    expect(shownPane()).toBe('plugins');
    c.openSetupWizard({ step: 'keybinds' });
    expect(shownPane()).toBe('keybinds');
    expect(islands.calls[islands.calls.length - 1]).toBe('mount wiz-keybinds');
  });

  it('Reset all keybinds asks once (Enter keeps them), resets every plugin and shows the lists again; nothing to reset asks nothing', async () => {
    const c = await load({ wizard_completed: true });
    c.openSetupWizard({ step: 'keybinds' });
    const reset = $('[data-wiz-reset="keybinds"]');
    expect(reset).toHaveTextContent('Reset all keybinds');
    keys.answer = false;
    reset.click();
    await flush();
    expect(keys.asked).toEqual([
      { title: 'Reset all keybinds?', copy: "Every command of Keys demo gets its default keys back. The app's own keys stay as they are.", yes: 'Reset all', safe: true },
    ]);
    expect(keys.reset).toBe(0);
    islands.calls = [];
    keys.answer = true;
    reset.click();
    await flush();
    expect(keys.reset).toBe(1);
    expect($('#wiz-saved')).toHaveTextContent('Saved');
    expect(islands.calls).toEqual(['mount wiz-keybinds']);
    keys.own = [];
    keys.asked = [];
    reset.click();
    await flush();
    expect(keys.asked).toEqual([]);
    expect($('#wiz-saved')).toHaveTextContent('Every key is its default already');
    expect($('#wiz-saved')).not.toHaveClass('is-error');
  });

  it('Reset all keybinds is busy while it runs (a second press asks nothing more) and gives the keyboard back to its button', async () => {
    const c = await load({ wizard_completed: true });
    c.openSetupWizard({ step: 'keybinds' });
    const reset = $('[data-wiz-reset="keybinds"]') as HTMLButtonElement;
    let answer!: (yes: boolean) => void;
    keys.answer = new Promise<boolean>((r) => (answer = r));
    reset.click();
    await flush();
    expect([reset.disabled, reset.getAttribute('aria-busy')]).toEqual([true, 'true']);
    reset.dispatchEvent(new MouseEvent('click'));
    await flush();
    expect(keys.asked).toHaveLength(1);
    answer(true);
    await flush();
    await flush();
    expect(keys.reset).toBe(1);
    expect([reset.disabled, reset.hasAttribute('aria-busy'), document.activeElement]).toEqual([false, false, reset]);
  });

  it("Reset all keybinds says, as an error, what it could not reset and why", async () => {
    const c = await load({ wizard_completed: true });
    c.openSetupWizard({ step: 'keybinds' });
    const reset = $('[data-wiz-reset="keybinds"]');
    keys.failed = [{ name: 'Heat', why: 'its keys could not be read' }];
    reset.click();
    await flush();
    expect($('#wiz-saved')).toHaveTextContent('Reset Keys demo; not reset: Heat (its keys could not be read)');
    expect($('#wiz-saved')).toHaveClass('is-error');
    keys.own = [];
    reset.click();
    await flush();
    expect($('#wiz-saved')).toHaveTextContent('Not reset: Heat (its keys could not be read)');
    keys.error = 'Could not read the plugin list: worker RPC timeout.';
    reset.click();
    await flush();
    expect($('#wiz-saved')).toHaveTextContent('Could not read the plugin list: worker RPC timeout.');
    expect($('#wiz-saved')).toHaveClass('is-error');
  });

  it('mounts Keybinds on entering it (each time: it reads the lists again) and unmounts it on leaving and on close', async () => {
    const c = await load({ wizard_completed: true });
    c.openSetupWizard({});
    islands.calls = [];
    rail('keybinds').click();
    rail('keybinds').click();
    expect(islands.calls).toEqual(['mount wiz-keybinds']);
    rail('units').click();
    rail('keybinds').click();
    expect(islands.calls).toEqual(['mount wiz-keybinds', 'unmount wiz-keybinds', 'mount wiz-keybinds']);
    islands.calls = [];
    $('#wiz-close').click();
    expect(islands.calls).toEqual(['unmount wiz-plugins', 'unmount wiz-keybinds']);
  });

  it('the first run opens it on Units with the PC check running, and closing marks setup done', async () => {
    await load({ wizard_completed: false });
    expect($('#setup-wizard').hidden).toBe(false);
    expect(shownPane()).toBe('units');
    await flush();
    expect(checks).toBe(1);
    expect(saved.some((b) => b.wizard_completed === true)).toBe(false);
    $('#wiz-close').click();
    await flush();
    expect(saved.filter((b) => b.wizard_completed === true)).toHaveLength(1);
    expect($('#setup-wizard').hidden).toBe(true);
  });

  it('each change saves as it is made, with "Saved" in the header: units, port (with the restart note) and workspace', async () => {
    const c = await load({ wizard_completed: true });
    c.openSetupWizard({});
    ($('[data-wiz-units="Imperial"]') as HTMLElement).click();
    await flush();
    expect(saved.at(-1)).toEqual({ units: 'Imperial' });
    expect($('#wiz-saved')).toHaveTextContent('Saved');
    rail('port').click();
    const port = $('#wiz-port') as HTMLInputElement;
    port.value = '8090';
    port.dispatchEvent(new Event('change'));
    await flush();
    await flush();
    expect(saved.at(-1)).toEqual({ port: 8090 });
    expect($('#wiz-port-note')).toHaveTextContent('Saved. Double-click stop.bat, then run.bat, so the app listens on 8090.');
    rail('workspace').click();
    const collapse = $('#wiz-collapse-completed') as HTMLInputElement;
    collapse.checked = false;
    collapse.dispatchEvent(new Event('change'));
    await flush();
    expect(saved.at(-1)).toEqual({ collapse_completed_sections: false });
  });

  it('Reset to defaults: Units Metric, Port 8082, Workspace collapsing finished sections; This PC checks again', async () => {
    const c = await load({ wizard_completed: true, units: 'Imperial', port: 8090, collapse_completed_sections: false });
    c.openSetupWizard({});
    ($('[data-wiz-reset="units"]') as HTMLElement).click();
    await flush();
    expect(saved.at(-1)).toEqual({ units: 'Metric' });
    expect($('[data-wiz-units="Metric"]')).toHaveClass('is-selected');
    rail('port').click();
    ($('[data-wiz-reset="port"]') as HTMLElement).click();
    await flush();
    await flush();
    expect(saved.at(-1)).toEqual({ port: 8082 });
    expect(($('#wiz-port') as HTMLInputElement).value).toBe('8082');
    rail('workspace').click();
    ($('[data-wiz-reset="workspace"]') as HTMLElement).click();
    await flush();
    expect(saved.at(-1)).toEqual({ collapse_completed_sections: true });
    expect(($('#wiz-collapse-completed') as HTMLInputElement).checked).toBe(true);
    rail('pc').click();
    await flush();
    const before = checks;
    ($('[data-wiz-recheck]') as HTMLElement).click();
    await flush();
    expect(checks).toBe(before + 1);
  });

  it('mounts the Assistant section on entering it and unmounts it on leaving and on close', async () => {
    const c = await load({ wizard_completed: true });
    c.openSetupWizard({});
    islands.calls = [];
    rail('assistant').click();
    expect(islands.calls).toEqual(['mount wiz-assistant']);
    // Showing it again (its rail entry) does not mount it twice.
    rail('assistant').click();
    expect(islands.calls).toEqual(['mount wiz-assistant']);
    rail('plugins').click();
    expect(islands.calls).toEqual(['mount wiz-assistant', 'unmount wiz-assistant', 'mount wiz-plugins']);
    rail('assistant').click();
    islands.calls = [];
    $('#wiz-close').click();
    expect(islands.calls).toEqual(['unmount wiz-plugins', 'unmount wiz-assistant']);
    expect($('#setup-wizard').hidden).toBe(true);
  });
});

describe('leaving the Assistant section', () => {
  /** A settle the test answers: the section's changes on their way. */
  function pendingSettle() {
    let answer!: (ok: boolean) => void;
    leaving.settle = () => new Promise<boolean>((r) => (answer = r));
    return (ok: boolean) => answer(ok);
  }

  async function onAssistant(c: Controller) {
    c.openSetupWizard({ step: 'assistant' });
    expect(shownPane()).toBe('assistant');
  }

  it('any other section is left without asking it', async () => {
    const c = await load({ wizard_completed: true });
    c.openSetupWizard({});
    rail('port').click();
    rail('plugins').click();
    expect(shownPane()).toBe('plugins');
    $('#wiz-close').click();
    expect(leaving.asked).toBe(0);
  });

  it('a rail entry waits for the section to settle, a second press meanwhile does nothing more, and it goes on once saved', async () => {
    const c = await load({ wizard_completed: true });
    await onAssistant(c);
    const answer = pendingSettle();
    islands.calls = [];
    rail('plugins').click();
    rail('plugins').click();
    expect(leaving.asked).toBe(1);
    expect(shownPane()).toBe('assistant');
    expect(islands.calls).toEqual([]);
    answer(true);
    await flush();
    expect(shownPane()).toBe('plugins');
    expect(islands.calls).toEqual(['unmount wiz-assistant', 'mount wiz-plugins']);
  });

  it('a refused change keeps the section on screen; the next press, with nothing on its way, leaves', async () => {
    const c = await load({ wizard_completed: true });
    await onAssistant(c);
    const answer = pendingSettle();
    rail('workspace').click();
    answer(false);
    await flush();
    expect(shownPane()).toBe('assistant');
    leaving.settle = () => true;
    rail('workspace').click();
    expect(shownPane()).toBe('workspace');
  });

  it('the X and Esc wait the same way; the Assistant entry itself leaves nothing', async () => {
    const c = await load({ wizard_completed: true });
    await onAssistant(c);
    let answer = pendingSettle();
    rail('assistant').click();
    expect(leaving.asked).toBe(0);
    $('#wiz-close').click();
    expect($('#setup-wizard').hidden).toBe(false);
    answer(true);
    await flush();
    expect($('#setup-wizard').hidden).toBe(true);
    expect(islands.calls[islands.calls.length - 1]).toBe('unmount wiz-assistant');
    await onAssistant(c);
    answer = pendingSettle();
    esc();
    expect($('#setup-wizard').hidden).toBe(false);
    answer(true);
    await flush();
    expect($('#setup-wizard').hidden).toBe(true);
  });

  it('a leave that settles after the section was shown again moves nothing', async () => {
    const c = await load({ wizard_completed: true });
    await onAssistant(c);
    const answer = pendingSettle();
    rail('plugins').click();
    // A link about plugins, then back on the Assistant: another showing of the section.
    c.openSetupWizard({ step: 'plugins' });
    leaving.settle = () => true;
    rail('assistant').click();
    expect(shownPane()).toBe('assistant');
    answer(true);
    await flush();
    expect(shownPane()).toBe('assistant');
  });
});
