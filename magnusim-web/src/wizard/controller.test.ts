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
// The Assistant panel's key, when it is among them, is named first (catalog.ts appResetName, by
// the app's name: Magnusim CAD's is a plugin's name too).
const APP_KEY_NAME = vi.hoisted(() => "Magnusim (the Assistant panel's key)");
const keys = vi.hoisted(() => ({
  appName: 'Magnusim',
  own: ['Keys demo'] as string[],
  app: false,
  answer: true as boolean | Promise<boolean>,
  asked: [] as { title?: string; copy?: string; yes?: string; safe?: boolean }[],
  reset: 0,
  // What the reset answers besides: what it could not reset, the list not read, and the commands
  // the Assistant panel's key was kept off (keptOffKeys: the stored keys, worded as the reset is told).
  failed: [] as { name: string; why: string }[],
  error: '',
  keptOff: '',
  keptOffKeys: [] as string[],
  // How the reset was told to word a key (catalog.ts keptOffText's name).
  name: null as ((c: string) => string) | null,
}));
vi.mock('../workbench/dialogs', () => ({
  confirmAction: async (o: (typeof keys.asked)[number]) => {
    keys.asked.push(o);
    return keys.answer;
  },
}));
vi.mock('../keybinds/catalog', () => {
  const appResetName = () => `${keys.appName} (the Assistant panel's key)`;
  return {
    appResetName,
    // The question as catalog.ts words it (catalog.test.ts holds the real one to the same words).
    resetEveryQuestion: (names: string[]) => {
      const app = names.includes(appResetName());
      const plugins = names.filter((n) => n !== appResetName());
      const parts = [
        ...(app ? ["The Assistant panel's key goes back to Ctrl+/."] : []),
        ...(plugins.length ? [`Every command of ${plugins.join(', ')} gets its default keys back.`] : []),
        ...(app ? [] : ["The app's own keys stay as they are."]),
      ];
      return { title: 'Reset all keybinds?', copy: parts.join(' '), yes: 'Reset all' };
    },
    // Words a key as it is told to (by default quoted as stored, as catalog.ts does).
    resetEveryPlugin: async (ask: (names: string[]) => Promise<boolean>, name: (c: string) => string = (c) => JSON.stringify(c)) => {
      keys.name = name;
      if (keys.error) return { asked: false, reset: [], failed: [], error: keys.error, keptOff: '' };
      const names = [...(keys.app ? [appResetName()] : []), ...keys.own];
      if (!names.length) return { asked: false, reset: [], failed: keys.failed, error: '', keptOff: '' };
      if (!(await ask(names))) return { asked: true, reset: [], failed: [], error: '', keptOff: '' };
      keys.reset += 1;
      const reset = names.filter((n) => !keys.failed.some((f) => f.name === n));
      const keptOff = keys.keptOffKeys.length ? `${keys.keptOffKeys.map(name).join(', ')} kept off Line: the Assistant panel's key.` : keys.keptOff;
      return { asked: true, reset, failed: keys.failed, error: '', keptOff };
    },
  };
});

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
  Object.assign(keys, { appName: 'Magnusim', own: ['Keys demo'], app: false, answer: true, asked: [], reset: 0, failed: [], error: '', keptOff: '', keptOffKeys: [], name: null });
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

  it("Reset all keybinds' question says the Assistant panel's key goes back to Ctrl+/ when it is among them, and no longer that the app's keys stay", async () => {
    const c = await load({ wizard_completed: true });
    c.openSetupWizard({ step: 'keybinds' });
    const reset = $('[data-wiz-reset="keybinds"]');
    keys.app = true;
    keys.answer = false;
    reset.click();
    await flush();
    expect(keys.asked).toEqual([
      { title: 'Reset all keybinds?', copy: "The Assistant panel's key goes back to Ctrl+/. Every command of Keys demo gets its default keys back.", yes: 'Reset all', safe: true },
    ]);
    expect(keys.asked[0].copy).not.toContain("The app's own keys stay as they are.");
    expect(keys.asked[0].copy).not.toContain(APP_KEY_NAME);
    // Only the panel's key to reset: no plugin named.
    keys.own = [];
    keys.asked = [];
    reset.click();
    await flush();
    expect(keys.asked.map((a) => a.copy)).toEqual(["The Assistant panel's key goes back to Ctrl+/."]);
    expect(keys.reset).toBe(0);
    islands.calls = [];
    keys.answer = true;
    reset.click();
    await flush();
    expect(keys.reset).toBe(1);
    expect($('#wiz-saved').textContent).toBe('Saved');
    expect($('#wiz-saved')).not.toHaveClass('is-error');
    expect(islands.calls).toEqual(['mount wiz-keybinds']);
  });

  it("Reset all keybinds' question without the Assistant panel's key names every plugin and says the app's own keys stay as they are", async () => {
    const c = await load({ wizard_completed: true });
    c.openSetupWizard({ step: 'keybinds' });
    keys.own = ['Keys demo', 'Heat'];
    keys.answer = false;
    $('[data-wiz-reset="keybinds"]').click();
    await flush();
    expect(keys.asked.map((a) => a.copy)).toEqual(["Every command of Keys demo, Heat gets its default keys back. The app's own keys stay as they are."]);
    expect(keys.asked[0].copy).not.toContain('Ctrl+/');
  });

  it("Reset all keybinds says, after what it could not reset, the commands the Assistant panel's key was kept off", async () => {
    const c = await load({ wizard_completed: true });
    c.openSetupWizard({ step: 'keybinds' });
    const reset = $('[data-wiz-reset="keybinds"]');
    keys.app = true;
    keys.failed = [{ name: APP_KEY_NAME, why: 'the settings are not available right now' }];
    keys.keptOff = "Ctrl+/ kept off Line: the Assistant panel's key.";
    reset.click();
    await flush();
    expect($('#wiz-saved').textContent).toBe(
      "Reset Keys demo; not reset: Magnusim (the Assistant panel's key) (the settings are not available right now). Ctrl+/ kept off Line: the Assistant panel's key.",
    );
    expect($('#wiz-saved')).toHaveClass('is-error');
    // Nothing kept off: the error ends at what was not reset.
    keys.keptOff = '';
    reset.click();
    await flush();
    expect($('#wiz-saved').textContent).toBe("Reset Keys demo; not reset: Magnusim (the Assistant panel's key) (the settings are not available right now)");
  });

  it('Reset all keybinds words the keys it kept the Assistant panel\'s key off as people read them: Alt+L, not "Alt+KeyL"', async () => {
    const c = await load({ wizard_completed: true });
    c.openSetupWizard({ step: 'keybinds' });
    const reset = $('[data-wiz-reset="keybinds"]');
    keys.app = true;
    keys.failed = [{ name: APP_KEY_NAME, why: 'the settings are not available right now' }];
    keys.keptOffKeys = ['Alt+KeyL'];
    reset.click();
    await flush();
    expect($('#wiz-saved').textContent).toBe(
      "Reset Keys demo; not reset: Magnusim (the Assistant panel's key) (the settings are not available right now). Alt+L kept off Line: the Assistant panel's key.",
    );
    expect($('#wiz-saved')).toHaveClass('is-error');
    // Any key, as Settings shows it: no code names, no quotes.
    expect(['Alt+KeyL', 'Ctrl+Slash', 'Ctrl+Shift+KeyR', 'Digit1', 'F2'].map((k) => keys.name!(k))).toEqual(['Alt+L', 'Ctrl+/', 'Ctrl+Shift+R', '1', 'F2']);
    // A plugin not reset as well: every one not reset, then what was kept off.
    keys.own = ['Keys demo', 'Heat'];
    keys.failed = [...keys.failed, { name: 'Heat', why: 'Could not save the keys: disk full' }];
    keys.keptOffKeys = ['Alt+KeyL', 'Ctrl+Shift+KeyR'];
    reset.click();
    await flush();
    expect($('#wiz-saved').textContent).toBe(
      "Reset Keys demo; not reset: Magnusim (the Assistant panel's key) (the settings are not available right now), Heat (Could not save the keys: disk full). Alt+L, Ctrl+Shift+R kept off Line: the Assistant panel's key.",
    );
  });

  it("in Magnusim CAD, Reset all keybinds tells the Assistant panel's key from the plugin that has the app's name", async () => {
    const c = await load({ wizard_completed: true });
    c.openSetupWizard({ step: 'keybinds' });
    const reset = $('[data-wiz-reset="keybinds"]');
    keys.appName = 'Magnusim CAD';
    keys.own = ['Magnusim CAD'];
    keys.answer = false;
    reset.click();
    await flush();
    expect(keys.asked).toEqual([
      { title: 'Reset all keybinds?', copy: "Every command of Magnusim CAD gets its default keys back. The app's own keys stay as they are.", yes: 'Reset all', safe: true },
    ]);
    keys.app = true;
    keys.asked = [];
    reset.click();
    await flush();
    expect(keys.asked).toEqual([
      { title: 'Reset all keybinds?', copy: "The Assistant panel's key goes back to Ctrl+/. Every command of Magnusim CAD gets its default keys back.", yes: 'Reset all', safe: true },
    ]);
    // Cancel says nothing.
    expect(keys.reset).toBe(0);
    expect($('#wiz-saved').textContent).toBe('');
    keys.answer = true;
    keys.failed = [{ name: "Magnusim CAD (the Assistant panel's key)", why: 'the settings are not available right now' }];
    reset.click();
    await flush();
    expect($('#wiz-saved').textContent).toBe("Reset Magnusim CAD; not reset: Magnusim CAD (the Assistant panel's key) (the settings are not available right now)");
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
