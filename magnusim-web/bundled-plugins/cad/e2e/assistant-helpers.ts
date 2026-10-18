// Shared steps of the Assistant's specs (shard "assistant", CAD tools spec §2.1, §12.3): each spec's
// own app server with the Assistant's test switches and the scripted model (the app's
// e2e/support/fake-llm.mjs, the cloud dialects pointed at it, so no key of this PC is used and
// nothing leaves it), the app's vendor-neutral turn helpers (e2e/support/assistant.js) with this
// suite's own `expect`, a new project with a Part open in its workspace and the tab its event
// stream names, and recorders of what the frame shows over time.
// Owner: ASSISTANT.
// SPDX-License-Identifier: GPL-3.0-or-later
import { expect, type APIRequestContext, type Frame, type FrameLocator, type Page } from '@playwright/test';
import { resolve } from 'node:path';
// @ts-expect-error the app's helpers are plain JavaScript (the suite's tsconfig has no allowJs)
import * as core from '../../../e2e/support/assistant.js';
// @ts-expect-error the app's scripted model is plain JavaScript
import { startFakeLlm } from '../../../e2e/support/fake-llm.mjs';
// @ts-expect-error the app's host helper is plain JavaScript
import { startHost } from '../../../e2e/support/host-server.mjs';
import { newPartFromTree, partOpened, workspaceFrame } from './helpers';

// The helpers assert with this suite's Playwright (a second copy would refuse to load).
core.setExpect(expect);

/** One step's ceiling (Linux CI runs on two slow cores). */
export const STEP_MS = 20_000;
export const STEP = { timeout: STEP_MS };
/** How long the server holds a tab's link after its turns (MAGNUSIM_TEST_ASSISTANT_HOLD_MS). */
export const HOLD_MS = 2000;

/** A request the scripted model took (fake-llm.mjs requests()). */
export interface FakeRequest {
  kind: string;
  dialect: string;
  path: string;
  /** The request's headers, names in lower case. */
  headers: Record<string, string | string[] | undefined>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  body: any;
}

export interface FakeModel {
  base: string;
  compatBase: string;
  /** Queue answers (a step, or a function of the request's body that returns one). */
  reply(...steps: unknown[]): void;
  requests(): FakeRequest[];
  pending(): number;
  release(name: string): void;
  /** The model ids the models routes list (every dialect, or one); an entry may be a local server's row {id, context?, type?}. */
  models(list: (string | { id: string; context?: number; max?: number; type?: string })[], dialect?: string): void;
  stop(): Promise<void>;
}

export interface AssistantHost {
  base: string;
  fake: FakeModel;
  stop(): Promise<void>;
  log(): string;
}

/**
 * The spec's own app server (an empty projects root, CAD on, its own Vite cache) on
 * CAD_E2E_PORT_FROM + `offset`, with the scripted model and the Assistant's test switches: the
 * cloud dialects go to the fake, the event hub's test routes, a 2 s hold after a turn.
 */
export async function startAssistantHost(name: string, offset: number): Promise<AssistantHost> {
  const fake = (await startFakeLlm()) as FakeModel;
  const host = (await startHost({
    name,
    seed: false,
    enablePlugins: ['cad'],
    viteCacheDir: resolve('.cache', `host-vite-${name}`),
    portFrom: Number(process.env.CAD_E2E_PORT_FROM || 8170) + offset,
    env: {
      MAGNUSIM_TEST_ASSISTANT: '1',
      MAGNUSIM_TEST_ASSISTANT_PROVIDER_URL: fake.base,
      MAGNUSIM_TEST_EVENT_HUB: '1',
      MAGNUSIM_TEST_ASSISTANT_HOLD_MS: String(HOLD_MS),
      MAGNUSIM_E2E_WSL: null,
      MAGNUSIM_WSL_PRUNE: '0',
    },
    timeoutMs: 240_000,
  })) as { base: string; stop(): void; log(): string };
  return {
    base: host.base,
    fake,
    log: () => host.log(),
    async stop() {
      host.stop();
      await fake.stop();
    },
  };
}

/** The server's Assistant answers to the scripted model ('cloud': the first cloud dialect; 'local': the local server's). */
export function useScriptedModel(request: APIRequestContext, h: AssistantHost, kind: 'cloud' | 'local' = 'cloud'): Promise<{ kind: string; model: string; dialect: string }> {
  return core.useScriptedModel(request, h.base, h.fake, kind);
}

/** No turn, question or conversation of an earlier test (needs MAGNUSIM_TEST_ASSISTANT=1). */
export async function resetAssistant(request: APIRequestContext, h: AssistantHost): Promise<void> {
  await core.resetAssistant(request, h.base);
}

/** One event of a turn's log (GET /api/assistant/turns/:id). */
export type TurnEvent = { type: string } & Record<string, unknown>;

export interface FollowedTurn {
  id: string;
  events: TurnEvent[];
  conversation: string | null;
  answerKey: string | null;
  waitFor(pred: (e: TurnEvent) => boolean, what: string, ms?: number): Promise<TurnEvent>;
  latest(): Promise<TurnEvent[]>;
  ended(ms?: number): Promise<{ turn: Record<string, unknown>; events: TurnEvent[] }>;
}

/** POST /api/assistant/turns (202 expected), followed (the app's startTurn). */
export function startTurn(request: APIRequestContext, h: AssistantHost, body: { text: string; tab?: string; conversation?: string }): Promise<FollowedTurn> {
  return core.startTurn(request, h.base, body);
}

/** The tools a request offered, in order, and whether each went strict. */
export const offeredTools = (req: unknown): { name: string; strict: boolean }[] => core.offeredTools(req);

/** The tool results a request carries for the answer before it: each result's JSON, and its images. */
export const resultsIn = (req: unknown): ({ tool: string; ok: boolean; data?: Record<string, unknown>; text?: string; error?: { code: string; message: string; hint?: string; detail?: Record<string, unknown> } } & { images: unknown[] })[] => core.resultsIn(req);

/** The model's chat requests so far (not its model-list or model-row reads). */
export const chats = (h: AssistantHost) => h.fake.requests().filter((r) => r.kind === 'chat');

export async function newProject(request: APIRequestContext, h: AssistantHost, title: string): Promise<string> {
  const r = await request.post(`${h.base}/api/project`, { data: { title, category: 'Other', units: 'Metric' } });
  const j = await r.json();
  expect(r.ok(), JSON.stringify(j)).toBe(true);
  return String(j.id);
}

/** The app's tab of a page (its event stream's): a row of /api/assistant/tabs, or null. */
export async function tabRow(request: APIRequestContext, h: AssistantHost, tab: string): Promise<{ tab: string; connected: boolean; tools: string[]; refused: unknown[] } | null> {
  const r = await request.get(`${h.base}/api/assistant/tabs`);
  expect(r.status()).toBe(200);
  const j = (await r.json()) as { tabs: { tab: string; connected: boolean; tools: string[]; refused: unknown[] }[] };
  return j.tabs.find((t) => t.tab === tab) ?? null;
}

/**
 * Open project `pid` in `page`, make its first Part (the header's CAD menu, as the person does)
 * and wait until the Part's tools are offered on the page's tab: {frame, tab}.
 */
export async function openNewPart(page: Page, request: APIRequestContext, h: AssistantHost, pid: string, title = 'Part 1'): Promise<{ frame: FrameLocator; tab: string }> {
  const tabOf = core.trackTab(page) as () => string;
  await page.goto(`${h.base}/#/p/${pid}`);
  await page.waitForFunction((id) => (window as unknown as { __CFD_PROJECT_READY__?: string }).__CFD_PROJECT_READY__ === id, pid, { timeout: 90_000 });
  await newPartFromTree(page, title);
  const frame = await partOpened(page);
  await expect(frame.locator('[data-cad-app]')).toHaveAttribute('data-doc', 'ready', { timeout: 60_000 });
  await expect.poll(tabOf, { message: "the page's event stream names its tab", timeout: STEP_MS }).not.toBe('');
  const tab = tabOf();
  await expect.poll(async () => (await tabRow(request, h, tab))?.tools.length ?? 0, { message: "the Part's tools are offered on its tab", timeout: 60_000 }).toBe(18);
  return { frame, tab };
}

/** The Part's frame, for evaluate(). */
export const cadFrame = (page: Page): Frame => workspaceFrame(page);

/** The Assistant chip's words ("Assistant · thinking · 3 of 120 steps"), its buttons left out. */
export const chipWords = (frame: FrameLocator) => frame.locator('[data-chip="assistant"] [data-assistant-text]');

/** One of the Assistant chip's buttons (pause, resume, stop, pace, ask, keep, discard, undo). */
export const chipButton = (frame: FrameLocator, id: string) => frame.locator(`[data-chip="assistant"] [data-assistant-action="${id}"]`);

type HoldWindow = { __CAD__: { assistant: { hold(p: string): void; release(p: string): void; waiting(): string[]; setPace(p: string | null, scale?: number | null): void } } };

/** Calls stop at the frame's hold point `point` from now on (src/assistant/testing.ts). */
export const holdAt = (page: Page, point: string) => cadFrame(page).evaluate((p) => (window as unknown as HoldWindow).__CAD__.assistant.hold(p), point);
/** Let the calls held at `point` go on (and hold it no more). */
export const releaseHold = (page: Page, point: string) => cadFrame(page).evaluate((p) => (window as unknown as HoldWindow).__CAD__.assistant.release(p), point);
/** A call waits at `point` now. */
export const reachedHold = (page: Page, point: string) =>
  expect.poll(() => cadFrame(page).evaluate(() => (window as unknown as HoldWindow).__CAD__.assistant.waiting()), { message: `a call waits at ${point}`, timeout: STEP_MS * 2 }).toContain(point);
/** The Assistant's pace whatever the person chose (null: theirs), and the scale of its delays. */
export const forcePace = (page: Page, pace: 'watch' | 'fast' | null, scale: number | null = null) => cadFrame(page).evaluate(({ pace, scale }) => (window as unknown as HoldWindow).__CAD__.assistant.setPace(pace, scale), { pace, scale });

/** The keyboard in the frame: a click on an empty corner of the view (it only looks, in a sketch too). */
export async function keyboardInFrame(page: Page, frame: FrameLocator): Promise<void> {
  const box = (await frame.locator('[data-cad-viewport] canvas').boundingBox())!;
  await page.mouse.click(box.x + box.width - 30, box.y + box.height - 30);
}

/** A study's stored model (the Part's model.json on the server: its `doc`), or null before the first save. */
export async function storedModel(request: APIRequestContext, h: AssistantHost, projectId: string, studyId: string): Promise<{ features: { name: string }[]; params: { name: string }[] } | null> {
  const r = await request.post(`${h.base}/api/plugin-data/read`, { data: { project_id: projectId, plugin: 'cad', rel: `studies/${studyId}/model.json` } });
  expect(r.ok()).toBe(true);
  return ((await r.json()).doc as { doc?: { features: { name: string }[]; params: { name: string }[] } } | null)?.doc ?? null;
}

/** The open Part's study id (its workspace address). */
export function studyOf(page: Page): string {
  const m = /\/ws\/cad\/part\/([^/?#]+)/.exec(decodeURIComponent(page.url()));
  if (!m) throw new Error(`not a Part workspace address: ${page.url()}`);
  return m[1];
}

/**
 * Record, in the frame, every text and attribute value `selector`'s first match shows from now on
 * (a MutationObserver, so a state that lasts one frame is not missed); read them with readRecord.
 */
export async function recordShown(page: Page, name: string, selector: string, attr?: string): Promise<void> {
  await cadFrame(page).evaluate(
    ({ name, selector, attr }) => {
      const w = window as unknown as { __shown?: Record<string, string[]> };
      const log: string[] = [];
      (w.__shown ??= {})[name] = log;
      const take = () => {
        const el = document.querySelector(selector);
        const v = el ? (attr ? (el.getAttribute(attr) ?? '') : (el.textContent ?? '')) : '(none)';
        if (log[log.length - 1] !== v) log.push(v);
      };
      take();
      new MutationObserver(take).observe(document.body, { subtree: true, childList: true, characterData: true, attributes: true });
    },
    { name, selector, attr },
  );
}

export const readRecord = (page: Page, name: string): Promise<string[]> =>
  cadFrame(page).evaluate((n) => [...((window as unknown as { __shown?: Record<string, string[]> }).__shown?.[n] ?? [])], name);
