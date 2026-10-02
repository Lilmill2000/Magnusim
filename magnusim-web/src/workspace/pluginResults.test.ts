import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BridgeError } from './bridge';
import { openPluginResults, openWhenClosed, REPLACE_QUESTION, resolvePluginCase, type ResultsScope } from './pluginResults';

const SCOPE: ResultsScope = { projectId: 'proj a', plugin: 'foam-demo', pluginName: 'Foam demo', studyId: 'st-1', studyTitle: 'Cavity case 1' };
const RESOLVED = {
  ok: true,
  key: 'pf-0123456789ab',
  case_dir: 'C:\\projects\\proj a\\plugins\\foam-demo\\studies\\st-1\\cases\\c2',
  times: ['0.1', '0.2'],
  app: 'pimpleFoam',
  time_dependency: 'transient',
  frame_fields: ['U', 'p'],
};
const INFO = {
  key: RESOLVED.key,
  projectId: 'proj a',
  caseDir: RESOLVED.case_dir,
  plugin: 'foam-demo',
  pluginName: 'Foam demo',
  studyId: 'st-1',
  studyTitle: 'Cavity case 1',
  caseRel: 'cases/c2',
  app: 'pimpleFoam',
  timeDependency: 'transient',
  times: ['0.1', '0.2'],
};

let urls: string[] = [];
let reply: { status: number; body: unknown } = { status: 200, body: RESOLVED };
let opened: ReturnType<typeof vi.fn>;
let toasts: unknown[] = [];
const onToast = (e: Event) => toasts.push((e as CustomEvent).detail);

const close = () => window.dispatchEvent(new CustomEvent('cfd:workspace-close'));
const settle = () => new Promise((r) => setTimeout(r, 0));

function deps(over: { shown?: boolean; ask?: boolean; leave?: boolean } = {}) {
  return {
    ask: vi.fn(async () => over.ask ?? true),
    leave: vi.fn(async () => over.leave ?? true),
    resultsShown: vi.fn(() => over.shown ?? false),
  };
}

beforeEach(() => {
  urls = [];
  toasts = [];
  reply = { status: 200, body: RESOLVED };
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      urls.push(String(input));
      return new Response(JSON.stringify(reply.body), { status: reply.status });
    }),
  );
  opened = vi.fn(async () => ({ ok: true }));
  window.__CFD_OPEN_PLUGIN_RESULTS__ = opened as unknown as typeof window.__CFD_OPEN_PLUGIN_RESULTS__;
  window.addEventListener('cfd:toast', onToast);
});

afterEach(() => {
  // Nothing armed by one test opens in the next.
  close();
  window.removeEventListener('cfd:toast', onToast);
  vi.unstubAllGlobals();
  vi.useRealTimers();
  delete window.__CFD_OPEN_PLUGIN_RESULTS__;
});

describe('resolvePluginCase', () => {
  it("asks the app for the case of this study, and passes a refusal's code", async () => {
    expect(await resolvePluginCase(SCOPE, 'cases/c2')).toEqual({
      key: RESOLVED.key,
      case_dir: RESOLVED.case_dir,
      times: ['0.1', '0.2'],
      app: 'pimpleFoam',
      time_dependency: 'transient',
      frame_fields: ['U', 'p'],
    });
    expect(urls).toEqual(['/api/plugin-cases/resolve?project_id=proj+a&plugin=foam-demo&study_id=st-1&case_rel=cases%2Fc2']);
    for (const [status, code] of [
      [409, 'running'],
      [404, 'no_results'],
      [400, 'invalid_path'],
    ] as const) {
      reply = { status, body: { ok: false, code, error: `refused: ${code}` } };
      const err = await resolvePluginCase(SCOPE, 'cases/c2').then(
        () => null,
        (e: unknown) => e,
      );
      expect(err).toBeInstanceOf(BridgeError);
      expect([(err as BridgeError).code, (err as BridgeError).message]).toEqual([code, `refused: ${code}`]);
    }
  });
});

describe('openPluginResults', () => {
  it('with no results on screen: no question, it leaves for the project, and the results open once the workspace has closed', async () => {
    const d = deps();
    expect(await openPluginResults(SCOPE, 'cases/c2', d)).toBe(true);
    expect(d.ask).not.toHaveBeenCalled();
    expect(d.leave).toHaveBeenCalledWith('#/p/proj%20a');
    expect(opened).not.toHaveBeenCalled();
    close();
    await settle();
    expect(opened).toHaveBeenCalledTimes(1);
    expect(opened).toHaveBeenCalledWith(INFO);
    // Only once.
    close();
    await settle();
    expect(opened).toHaveBeenCalledTimes(1);
  });

  it('with results on screen it asks first; Cancel goes nowhere and opens nothing', async () => {
    const d = deps({ shown: true, ask: false });
    expect(await openPluginResults(SCOPE, 'cases/c2', d)).toBe(false);
    expect(d.ask).toHaveBeenCalledWith(REPLACE_QUESTION);
    expect(REPLACE_QUESTION).toEqual({ title: 'Open these results?', copy: 'This replaces the results currently shown.', yes: 'Open results' });
    expect(d.leave).not.toHaveBeenCalled();
    close();
    await settle();
    expect(opened).not.toHaveBeenCalled();
    // Open results: on.
    const yes = deps({ shown: true, ask: true });
    expect(await openPluginResults(SCOPE, 'cases/c2', yes)).toBe(true);
    close();
    await settle();
    expect(opened).toHaveBeenCalledTimes(1);
  });

  it('Stay (unsaved work in the page) opens nothing, also when the workspace closes later', async () => {
    const d = deps({ leave: false });
    expect(await openPluginResults(SCOPE, 'cases/c2', d)).toBe(false);
    close();
    await settle();
    expect(opened).not.toHaveBeenCalled();
  });

  it('a workspace that closes while the leave question is open opens nothing', async () => {
    let answer: (ok: boolean) => void = () => undefined;
    const d = deps();
    d.leave.mockImplementation(() => new Promise<boolean>((r) => (answer = r)));
    const p = openPluginResults(SCOPE, 'cases/c2', d);
    await settle();
    close();
    answer(false);
    expect(await p).toBe(false);
    await settle();
    expect(opened).not.toHaveBeenCalled();
  });

  it('a refused case asks nothing and leaves nothing', async () => {
    reply = { status: 409, body: { ok: false, code: 'running', error: 'This case is queued or running. Open its results when it has finished.' } };
    const d = deps({ shown: true });
    await expect(openPluginResults(SCOPE, 'cases/c1', d)).rejects.toMatchObject({ code: 'running' });
    expect(d.ask).not.toHaveBeenCalled();
    expect(d.leave).not.toHaveBeenCalled();
  });
});

describe('openWhenClosed', () => {
  it('is dropped when no close comes in time, and a newer one replaces an older one', async () => {
    vi.useFakeTimers();
    openWhenClosed(INFO, 1000);
    vi.advanceTimersByTime(1001);
    close();
    openWhenClosed({ ...INFO, caseRel: 'cases/old' }, 1000);
    openWhenClosed(INFO, 1000);
    close();
    vi.useRealTimers();
    await settle();
    expect(opened).toHaveBeenCalledTimes(1);
    expect(opened).toHaveBeenCalledWith(INFO);
  });

  it('says so when the results could not open, and nothing when a study click won', async () => {
    opened.mockResolvedValueOnce({ ok: false, error: 'These results could not be opened' });
    openWhenClosed(INFO);
    close();
    await vi.waitFor(() => expect(toasts).toEqual([{ message: 'These results could not be opened', kind: 'error' }]));
    opened.mockResolvedValueOnce({ ok: false, stale: true });
    openWhenClosed(INFO);
    close();
    await settle();
    await settle();
    expect(toasts.length).toBe(1);
    // The workbench not loaded: a warning, nothing thrown.
    delete window.__CFD_OPEN_PLUGIN_RESULTS__;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    openWhenClosed(INFO);
    close();
    expect(warn).toHaveBeenCalledWith('[workspace] the results view is not loaded: plugin case results not opened');
  });
});
