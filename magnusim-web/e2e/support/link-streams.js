// Projects whose geometries the test plugin link-demo linked (python/tests/fixtures/link-plugins),
// and what a spec about the browser's connections to the app needs to watch in their tabs: the
// event streams each tab holds, the requests that get no answer, a rename as the user makes it.
// Used by connection-limit.spec.js and connection-limit-hidden.spec.js.
import { expect } from '@playwright/test';
import { cpSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getJson } from './compute-slot.js';

const WEB = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const EXPORTS = join(WEB, 'python', 'tests', 'fixtures', 'link-plugins', 'link-demo', 'workspace', 'exports');
// The link streams the app opens: one per linked geometry (its own events route), or the
// tab's one event stream that carries them all.
const STREAM = /^\/api\/(plugin-geometry\/)?events$/;
const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

/** A progress line printer for one spec: `[label +12s] message`. */
export function stager(label) {
  let t0 = Date.now();
  const stage = (msg) => console.log(`[${label} +${Math.round((Date.now() - t0) / 1000)}s] ${msg}`);
  stage.reset = () => {
    t0 = Date.now();
  };
  return stage;
}

/** A bundled-plugins folder with only Incompressible Flow (no other plugin opens anything). */
export function bundledIfOnly(tmp) {
  const bundled = join(tmp, 'bundled');
  cpSync(join(WEB, 'bundled-plugins', 'incompressible_flow'), join(bundled, 'incompressible_flow'), {
    recursive: true,
    filter: (src) => !/[\\/](tests|__pycache__)([\\/]|$)/.test(src),
  });
  return bundled;
}

/**
 * Link a Demo study's export `version` (v1, v2, ...) as the plugin does: its files in the
 * study's folder, then the link, and its job done. The geometry's id.
 */
export async function linkVersion(request, host, pid, sid, version, sourceVersion, basedOnRev) {
  const files = {};
  for (const [as, file] of [
    ['shape.bin', `${version}.bbrep`],
    ['names.json', `${version}.face_names.json`],
  ]) {
    const rel = `studies/${sid}/exports/${as}`;
    const dest = join(host.projects, pid, 'plugins', 'link-demo', rel);
    mkdirSync(dirname(dest), { recursive: true });
    const buf = readFileSync(join(EXPORTS, file));
    writeFileSync(dest, buf);
    files[as] = { rel, sha256: sha256(buf) };
  }
  const r = await request.post(`${host.base}/api/plugin-geometry/link`, {
    data: {
      project_id: pid,
      plugin: 'link-demo',
      study_id: sid,
      shape: { ...files['shape.bin'], format: 'brep' },
      face_names: files['names.json'],
      source_version: sourceVersion,
      based_on_rev: basedOnRev,
    },
  });
  const body = await r.json();
  expect(r.status(), JSON.stringify(body)).toBeLessThan(300);
  let job = null;
  await expect
    .poll(
      async () => {
        job = (await getJson(request, `${host.base}/api/plugin-geometry/status?project_id=${pid}&plugin=link-demo&study_id=${sid}&job_id=${body.job_id}`)).job;
        return job && job.status;
      },
      { timeout: 180_000, intervals: [250] },
    )
    .toMatch(/^(done|failed|busy|gone|stale|cancelled)$/);
  expect(job.status, job.error).toBe('done');
  return body.geometry_id;
}

/** A project with `n` Demo studies of link-demo, each linked once: {pid, studies: [{sid, gid, title}]}. */
export async function linkedProject(request, host, title, n, stage) {
  const p = await request.post(`${host.base}/api/project`, { data: { title, folder: 'My Projects', units: 'Metric', category: 'Other' } });
  const pj = await p.json();
  expect(p.ok(), JSON.stringify(pj)).toBe(true);
  const studies = [];
  for (let i = 1; i <= n; i++) {
    const s = await request.post(`${host.base}/api/plugin-studies/create`, {
      data: { project_id: pj.id, plugin: 'link-demo', kind: 'demo', title: `Demo ${i}` },
    });
    const sj = await s.json();
    expect(s.ok(), JSON.stringify(sj)).toBe(true);
    const sid = sj.study.id;
    // The plugin writes its export into its study's folder, then links it (a first link adds a geometry).
    const gid = await linkVersion(request, host, pj.id, sid, 'v1', 1, null);
    studies.push({ sid, gid, title: `Demo ${i}` });
  }
  stage?.(`project ${pj.id}: ${n} linked geometries`);
  return { pid: pj.id, studies };
}

/**
 * Every request of the context's tabs: which link streams each tab holds open (answered,
 * never finished) and which requests have no answer yet.
 */
export function watchRequests(context) {
  /** @type {Map<import('@playwright/test').Request, {page: any, url: string, method: string, answered: boolean, at: number}>} */
  const live = new Map();
  const track = (page) => {
    page.on('request', (r) => live.set(r, { page, url: r.url(), method: r.method(), answered: false, at: Date.now() }));
    page.on('response', (res) => {
      const rec = live.get(res.request());
      if (rec) rec.answered = true;
    });
    page.on('requestfinished', (r) => live.delete(r));
    page.on('requestfailed', (r) => live.delete(r));
  };
  for (const p of context.pages()) track(p);
  context.on('page', track);
  const isStream = (rec) => STREAM.test(new URL(rec.url).pathname);
  return {
    /** Link streams `page` holds open (or every tab's, without one). */
    openStreams: (page) => [...live.values()].filter((r) => isStream(r) && r.answered && (!page || r.page === page)).length,
    /** Link streams asked for and not connected yet. */
    waitingStreams: () => [...live.values()].filter((r) => isStream(r) && !r.answered).length,
    /** Requests of `page` with no answer yet (streams aside), oldest first. */
    unanswered: (page) =>
      [...live.values()]
        .filter((r) => !isStream(r) && !r.answered && r.page === page)
        .map((r) => `${r.method} ${new URL(r.url).pathname} (${Math.round((Date.now() - r.at) / 1000)} s)`),
  };
}

export const geometryRow = (page, gid) => page.locator(`#left-tree [data-w16-geom="${gid}"] > .tree-row`);
export const studyRow = (page, sid) => page.locator(`[data-plugin-study="${sid}"] > .tree-row`);

/**
 * A tab shows the project: every linked geometry's row is in its tree (the tree read that
 * painted them also opened their link streams), and every stream it asked for is connected.
 */
export async function showsProject(page, host, project, seen, { ready = true } = {}) {
  await page.goto(`${host.base}/#/p/${project.pid}`);
  if (ready) await page.waitForFunction((id) => window.__CFD_PROJECT_READY__ === id, project.pid, { timeout: 60_000 });
  for (const s of project.studies) await expect(geometryRow(page, s.gid)).toBeVisible({ timeout: 60_000 });
  await expect.poll(() => seen.waitingStreams(), { timeout: 30_000, message: 'every link stream asked for is connected' }).toBe(0);
}

/** Whether a plain request from the page gets an answer within `ms` (it is aborted after). */
export function pageFetchAnswers(page, ms) {
  return page.evaluate(async (wait) => {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), wait);
    try {
      const r = await fetch('/api/registry', { cache: 'no-store', signal: ctl.signal });
      return `answered ${r.status}`;
    } catch {
      return `no answer within ${wait} ms`;
    } finally {
      clearTimeout(timer);
    }
  }, ms);
}

/** How long the server takes to answer from outside the browser (its own connection). */
export async function serverAnswersIn(request, host) {
  const t = Date.now();
  const r = await request.get(`${host.base}/api/registry`, { timeout: 15_000 });
  return `${r.status()} in ${Date.now() - t} ms`;
}

/** Rename a plugin study from its tree row, as the user does: the pencil, the name, Rename. */
export async function renameStudy(page, sid, title) {
  await studyRow(page, sid).hover();
  await studyRow(page, sid).locator('[data-plugin-study-act="rename"]').click();
  await expect(page.locator('#modal-prompt')).toBeVisible({ timeout: 10_000 });
  await page.locator('#pm-input').fill(title);
  await page.locator('#pm-confirm').click();
}

export async function studyTitleOnServer(request, host, pid, sid) {
  const j = await getJson(request, `${host.base}/api/plugin-studies/get?project_id=${pid}&plugin=link-demo&study_id=${sid}`);
  return String((j && j.study && j.study.title) || JSON.stringify(j));
}

/**
 * The renamed row shows within 20 s. If not: what the page waits for, and what the server says
 * (the title it has, and how fast it answers a request that does not come from the browser).
 */
export async function expectRenamed(page, request, host, pid, sid, title, seen, stage) {
  const row = page.locator(`[data-plugin-study="${sid}"] .tl`);
  const t = Date.now();
  const shown = await expect(row)
    .toHaveText(title, { timeout: 20_000 })
    .then(() => true, () => false);
  let why = '';
  if (!shown) {
    why = [
      `the row still says ${JSON.stringify(await row.textContent().catch(() => null))}`,
      `the server has the title ${JSON.stringify(await studyTitleOnServer(request, host, pid, sid))}`,
      `the server answers a request from outside the browser: ${await serverAnswersIn(request, host)}`,
      `link streams held open: ${seen.openStreams()} (this tab ${seen.openStreams(page)})`,
      `this tab's requests with no answer: ${seen.unanswered(page).join(', ') || 'none'}`,
    ].join('; ');
    stage?.(`NOT renamed after ${Date.now() - t} ms: ${why}`);
  }
  expect(shown, `"${title}" is saved and shown within 20 s (${why})`).toBe(true);
  expect(await studyTitleOnServer(request, host, pid, sid)).toBe(title);
}

/** The top of the part the viewport shows (mm, rounded), or null before one is shown. */
export function shownZmax(page) {
  return page.evaluate(() => {
    const b = window.__CFD_W16__ && window.__CFD_W16__.fingerprint && window.__CFD_W16__.fingerprint.bounds;
    return b ? Math.round(b.zmax) : null;
  });
}
