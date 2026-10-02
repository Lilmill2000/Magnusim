import { expect, test } from '@playwright/test';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { NO_GEOMETRY_PROJECT, prepareE2eProjectsRoot } from './prepare-projects.js';
import { e2eTemp, startHost } from './support/host-server.mjs';
import { computeQueue, foamStoreFileFor, queueFileFor } from './support/compute-slot.js';

// Two queue notices that reach the page in one poll are both shown, one after the other,
// each long enough to read (H15 core bug 2). Before the fix the page wrote both into the one
// toast (#job-finish-toast) in the same frame, so only the last was ever painted. No WSL:
// before the server starts, two plugin cases of a plugin that is not installed wait in its
// queue; at boot the queue tries them, and both leave it together with "could not start".
// A second app server. (A run-finished toast meeting a notice: src/workbench/toastQueue.test.ts.)
const P = NO_GEOMETRY_PROJECT;
const PLUGIN = 'foam-demo';
const PLUGIN_NAME = 'Foam demo';
const STUDY = 'cavity-toasts';
const TITLE = 'Cavity case 1';
const WHY = `${PLUGIN_NAME} is off. Turn it on in Settings → Plugins`;
// From one paint to the next when another waits: the readable minimum (3 s) and the fade
// (280 ms), less a margin (timers only fire late).
const READ_MIN_MS = 3_200;

test('two queue notices that land in one poll are both shown, in turn', async ({ page, request }) => {
  test.setTimeout(300_000);
  page.setDefaultTimeout(30_000);
  const t0 = Date.now();
  const stage = (msg) => console.log(`[notice-toasts +${Math.round((Date.now() - t0) / 1000)}s] ${msg}`);
  const tmp = e2eTemp('notice-toasts');
  const projects = join(tmp, 'projects');
  prepareE2eProjectsRoot(projects);

  // Before any server: two queued plugin cases of P, in the queue and store files it reads at boot.
  const queueFile = queueFileFor(projects);
  const storeFile = foamStoreFileFor(projects);
  const root = resolve(projects).replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
  const created = Date.now() - 60_000;
  const cases = ['c1', 'c2'].map((c, i) => ({
    row: `q-toasts-${c}`,
    job: `fc-toasts${i + 1}-00000${i + 1}`,
    name: `${TITLE} · ${c} · ${PLUGIN_NAME}`,
    rel: `cases/${c}`,
    created: new Date(created + i).toISOString(),
  }));
  const texts = cases.map((c) => `${c.name} could not start from the queue: ${WHY}.`);
  mkdirSync(dirname(queueFile), { recursive: true });
  const records = cases.map((c) => ({
    id: c.job,
    kind: 'foam',
    plugin: PLUGIN,
    plugin_name: PLUGIN_NAME,
    project_id: P,
    study_id: STUDY,
    study_title: TITLE,
    case_rel: c.rel,
    case_parts: c.rel.split('/'),
    row_id: c.row,
    app: 'icoFoam',
    n_procs: 1,
    pre: [],
    stop: null,
    projects_root: root,
    status: 'queued',
    created_at: c.created,
    seq: 0,
  }));
  writeFileSync(storeFile, JSON.stringify({ records }));
  const items = cases.map((c) => ({ id: c.row, kind: 'foam', project_id: P, name: c.name, job_id: c.job, foam: { plugin: PLUGIN, study_id: STUDY } }));
  writeFileSync(queueFile, JSON.stringify({ items }));

  const host = await startHost({ name: 'notice-toasts', projects, tmp, env: { MAGNUSIM_WSL_PRUNE: '0' }, log: stage });
  const { base } = host;
  try {
    // 1. At boot both cases leave the queue together, before any page asks.
    await expect
      .poll(async () => (((await computeQueue(request, { base })) || {}).failed || []).map((f) => f.id), { timeout: 60_000 })
      .toEqual(cases.map((c) => c.row));
    const q = await computeQueue(request, { base });
    expect(q.failed.map((f) => [f.kind, f.project_id, f.name, f.error, f.reason || 'failed'])).toEqual(
      cases.map((c) => ['foam', P, c.name, WHY, 'failed']),
    );
    expect(q.items).toEqual([]);
    stage('both cases left the queue at boot');

    // 2. Every paint of the toast (text, style, page time) and every hide, from the page's first frame;
    // and for each text whether it could be seen: turned on (is-on) and at full opacity.
    await page.addInitScript(() => {
      window.__toastLog = [];
      window.__toastSeen = {};
      const look = (el) => {
        if (el.hidden || !el.textContent) return;
        const s = (window.__toastSeen[el.textContent] ||= { on: false, opacity: 0 });
        s.on = s.on || el.classList.contains('is-on');
        s.opacity = Math.max(s.opacity, Number(getComputedStyle(el).opacity) || 0);
      };
      const watch = (el) => {
        new MutationObserver(() => {
          const at = performance.now();
          if (el.hidden || !el.textContent) window.__toastLog.push({ hidden: true, at });
          else window.__toastLog.push({ text: el.textContent, at, fail: el.classList.contains('is-fail') });
        }).observe(el, { childList: true, characterData: true, subtree: true, attributes: true, attributeFilter: ['hidden'] });
        new MutationObserver(() => look(el)).observe(el, { attributes: true, attributeFilter: ['class'] });
        setInterval(() => look(el), 100);
      };
      const found = () => {
        const el = document.getElementById('job-finish-toast');
        if (el) watch(el);
        return !!el;
      };
      if (!found()) {
        const mo = new MutationObserver(() => {
          if (found()) mo.disconnect();
        });
        mo.observe(document, { childList: true, subtree: true });
      }
    });
    const log = () => page.evaluate(() => window.__toastLog.slice());
    const painted = async () => (await log()).filter((e) => !e.hidden).map((e) => e.text);
    // The page's queue answers that carry notices: the first must hold both (one poll).
    const answers = [];
    page.on('response', async (r) => {
      if (!/\/api\/compute-queue(\/kick)?(\?|$)/.test(r.url())) return;
      const j = await r.json().catch(() => null);
      if (j && Array.isArray(j.failed) && j.failed.length) answers.push(j.failed.map((f) => f.id));
    });
    await page.goto(`${base}/#/p/${P}`);
    await page.waitForFunction((id) => window.__CFD_PROJECT_READY__ === id, P, { timeout: 90_000 });
    const toast = page.locator('#job-finish-toast');
    await expect(toast).toHaveAttribute('role', 'status');
    await expect(toast).toHaveAttribute('aria-live', 'polite');

    // 3. Both texts are painted, in turn, each once, with the failure style; the first stays
    // readable before the second replaces it, and the last keeps its own 9 s.
    await expect.poll(painted, { timeout: 60_000 }).toContain(texts[1]);
    await expect.poll(async () => (await log()).at(-1)?.hidden === true, { timeout: 30_000 }).toBe(true);
    const events = await log();
    expect(answers[0], `the first queue answer with notices: ${JSON.stringify(answers)}`).toEqual(cases.map((c) => c.row));
    const paints = events.filter((e) => !e.hidden);
    expect(paints.map((e) => e.text), JSON.stringify(events)).toEqual(texts);
    expect(paints.map((e) => e.fail)).toEqual([true, true]);
    // Each could be seen, not only written: turned on, at full opacity.
    const seen = await page.evaluate(() => window.__toastSeen);
    expect(texts.map((t) => seen[t]), `each notice on and opaque: ${JSON.stringify(seen)}`).toEqual(texts.map(() => ({ on: true, opacity: 1 })));
    // How long each paint stayed before the next paint or the hide.
    const shown = paints.map((e) => Math.round(events[events.indexOf(e) + 1].at - e.at));
    expect(shown[0], `the first notice on screen (ms): ${JSON.stringify(events)}`).toBeGreaterThanOrEqual(READ_MIN_MS);
    // Its own 9 s and the fade, less the same margin.
    expect(shown[1], `the last notice on screen (ms): ${JSON.stringify(events)}`).toBeGreaterThanOrEqual(9_200);
    stage(`both notices shown: ${shown[0]} ms, then ${shown[1]} ms`);

    // 4. Once per tab: later polls bring neither back.
    await page.waitForTimeout(5_000);
    expect(await painted()).toEqual(texts);
  } finally {
    host.stop();
    rmSync(queueFile, { force: true });
    rmSync(storeFile, { force: true });
  }
});
