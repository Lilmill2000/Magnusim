// Three app tabs with the Assistant on: each still holds one event stream, and the app's own
// requests in each are answered promptly. The app server speaks plain HTTP/1.1, where the
// browser opens at most 6 connections to it for all of its tabs together, and an event stream
// holds its connection while it is open. With the Assistant every app tab follows more: its
// window's core page (the relay channel, Home too: core host tools spec C7), the open project's
// `ui` channel (what the Assistant changed: C2), and the dock's running turn. Were each its own
// stream, three tabs would hold nine, and every other request of every tab would wait for a
// connection that never frees. They are channels of the tab's one stream (src/api/eventHub.ts).
//   - Home, a project's workbench and a second project's workbench, each with the dock open
//     and a turn running in the last (held mid-answer);
//   - each tab holds exactly one event stream (the browser's own count), and the server carries
//     the relay, ui and turn channels on those streams (MAGNUSIM_TEST_EVENT_HUB);
//   - in each tab a plain request is answered within 5 s, a BC saved from each workbench is
//     answered within 5 s, and Home opens a third project, which draws within 30 s.
// Its own server with the Assistant's test switches and the scripted model
// (support/fake-llm.mjs). No WSL.
// SPDX-License-Identifier: GPL-3.0-or-later
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { seedElbowProject } from './prepare-projects.js';
import { appReady, dockSend, dockTurn, openDock, useScriptedModel } from './support/assistant.js';
import { startFakeLlm } from './support/fake-llm.mjs';
import { e2eTemp, startHost } from './support/host-server.mjs';
import { pageFetchAnswers, serverAnswersIn, serverStream } from './support/link-streams.js';
import { expect, test } from './support/stress.js';

const P1 = 'conn-assistant-one';
const P2 = 'conn-assistant-two';
const P3 = 'conn-assistant-three';
const PROMPT = 5_000;
let host;
let fake;

const api = (path) => `${host.base}${path}`;
const getJson = async (request, path) => (await request.get(api(path))).json();

test.beforeAll(async ({ request }) => {
  test.setTimeout(240_000);
  fake = await startFakeLlm();
  const tmp = e2eTemp('connection-limit-assistant');
  const projects = join(tmp, 'projects');
  mkdirSync(projects, { recursive: true });
  seedElbowProject(projects, P1, 'Connections one');
  seedElbowProject(projects, P2, 'Connections two');
  seedElbowProject(projects, P3, 'Connections three');
  host = await startHost({
    name: 'connection-limit-assistant',
    tmp,
    projects,
    env: { MAGNUSIM_TEST_ASSISTANT: '1', MAGNUSIM_TEST_ASSISTANT_PROVIDER_URL: fake.base, MAGNUSIM_TEST_EVENT_HUB: '1' },
  });
  const r = await request.post(api('/api/test/assistant/reset'), { data: {} });
  expect(r.ok()).toBe(true);
  await useScriptedModel(request, host.base, fake, 'cloud');
});

test.afterAll(async () => {
  host?.stop();
  await fake?.stop();
});

/** Each page's event streams (GET /api/events) the browser holds open now, and its tab id. */
function watchStreams(context) {
  const open = new Map();
  const tabIds = new Map();
  const track = (page) => {
    page.on('response', (res) => {
      const u = new URL(res.url());
      if (u.pathname !== '/api/events') return;
      open.set(res.request(), page);
      if (u.searchParams.get('tab')) tabIds.set(page, u.searchParams.get('tab'));
    });
    page.on('requestfinished', (r) => open.delete(r));
    page.on('requestfailed', (r) => open.delete(r));
  };
  for (const p of context.pages()) track(p);
  context.on('page', track);
  return {
    held: (page) => [...open.values()].filter((p) => p === page).length,
    total: () => open.size,
    tabOf: (page) => tabIds.get(page) || '',
  };
}

/** A request the page makes itself, timed: `answered <status> in <ms> ms` or `no answer within <ms> ms`. */
function pageRequest(page, path, init, ms = PROMPT) {
  return page.evaluate(
    async ([p, i, wait]) => {
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), wait);
      const t = performance.now();
      try {
        const r = await fetch(p, { ...i, cache: 'no-store', signal: ctl.signal });
        await r.text();
        return { ok: r.ok, text: `answered ${r.status} in ${Math.round(performance.now() - t)} ms` };
      } catch {
        return { ok: false, text: `no answer within ${wait} ms` };
      } finally {
        clearTimeout(timer);
      }
    },
    [path, init, ms],
  );
}

async function openWorkbench(page, pid) {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto(api(`/#/p/${pid}`));
  await page.waitForFunction((id) => window.__CFD_PROJECT_READY__ === id, pid, { timeout: 60_000 });
  await openDock(page);
}

test('Home and two workbenches, the dock open in each and a turn running: one event stream per tab, and every tab\'s requests are answered promptly', async ({ page, request }) => {
  test.setTimeout(300_000);
  const context = page.context();
  const streams = watchStreams(context);
  // Tab 1: Home.
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto(api('/#/'));
  await appReady(page);
  await openDock(page);
  // Tabs 2 and 3: two projects' workbenches.
  const two = await context.newPage();
  await openWorkbench(two, P1);
  const three = await context.newPage();
  await openWorkbench(three, P2);
  // A turn running in tab 3 (held mid-answer): the dock follows it.
  fake.reply({ text: 'Thinking it over, then done.', hold: 'held' });
  await dockSend(three, 'Think about it.');
  await expect(dockTurn(three)).toContainText('Thinking', { timeout: 30_000 });

  const tabs = [page, two, three];
  // One stream per tab, as the browser holds them.
  await expect.poll(() => tabs.map((t) => streams.held(t)), { timeout: 15_000, message: 'each tab holds one event stream' }).toEqual([1, 1, 1]);
  expect(streams.total(), 'streams held across the tabs').toBe(3);
  // The server carries what each tab follows as channels of that one stream.
  const kinds = [];
  for (const t of tabs) {
    const s = await serverStream(request, host, streams.tabOf(t));
    expect(s, `the server holds tab ${tabs.indexOf(t) + 1}'s stream`).toBeTruthy();
    kinds.push(s.kinds);
  }
  test.info().annotations.push({ type: 'channels per tab', description: JSON.stringify(kinds) });
  // Every tab's core page relay; each workbench its project's ui channel; tab 3 its running turn too.
  for (const k of kinds) expect(k.assistant, JSON.stringify(kinds)).toBeGreaterThanOrEqual(1);
  expect(kinds[1].ui, JSON.stringify(kinds)).toBe(1);
  expect(kinds[2].ui, JSON.stringify(kinds)).toBe(1);
  expect(Object.values(kinds[2]).reduce((n, v) => n + v, 0), JSON.stringify(kinds)).toBeGreaterThan(Object.values(kinds[1]).reduce((n, v) => n + v, 0));

  // A plain request from each tab is answered at once.
  for (const t of tabs) expect(await pageFetchAnswers(t, PROMPT), `tab ${tabs.indexOf(t) + 1}`).toMatch(/^answered 200/);
  // A BC saved from each workbench is answered at once.
  for (const [t, pid] of [
    [two, P1],
    [three, P2],
  ]) {
    const sim = (await getJson(request, `/api/mesh?project_id=${pid}`)).simulation_id;
    const saved = await pageRequest(t, '/api/bcs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ project_id: pid, simulation_id: sim, name: 'Tab wall', bc_type: 'Wall', faces: [] }),
    });
    expect(saved.ok, `${pid}: ${saved.text}; the server answers from outside the browser: ${await serverAnswersIn(request, host)}`).toBe(true);
    expect(saved.text).toMatch(/^answered 200/);
  }
  // Home opens a third project: it draws.
  const card = page.locator(`.home-card[data-project-id="${P3}"]`);
  await expect(card).toBeVisible({ timeout: 30_000 });
  await card.dblclick();
  await page.waitForFunction((id) => window.__CFD_PROJECT_READY__ === id, P3, { timeout: 30_000 });
  await expect(page.locator('#app')).toBeVisible();
  // Still one stream per tab, now three workbenches.
  await expect.poll(() => tabs.map((t) => streams.held(t)), { timeout: 15_000 }).toEqual([1, 1, 1]);
  for (const t of tabs) expect(await pageFetchAnswers(t, PROMPT), `tab ${tabs.indexOf(t) + 1} after the open`).toMatch(/^answered 200/);

  // The held turn ends, as the person sees it.
  fake.release('held');
  await expect(dockTurn(three).locator('[data-turn-end="done"]')).toBeVisible({ timeout: 30_000 });
  expect(fake.pending(), 'scripted answers left unused').toBe(0);
  await two.close();
  await three.close();
});
