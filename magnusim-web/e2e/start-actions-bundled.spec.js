import { expect, test } from '@playwright/test';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { PYTHON } from '../scripts/python-env.js';
import { e2eTemp, startHost } from './support/host-server.mjs';

// The core meets the start actions (API 1.4) of its REAL bundled plugins, each at its
// manifest default, as on a fresh install (no settings file). Written from the
// manifests, naming no plugin:
//   - every bundled plugin that ships on (no `default_enabled = false`) shows its
//     [[start_actions]] in their places: the header button and its menu, the empty
//     project, Home and the New Project dialog; Home's button opens New Project with
//     that action chosen and "Untitled <kind> 1" filled in, one Create click opens the
//     study's workspace, and the header menu and the empty project make the next ones;
//     all of it still there after a reload;
//   - every bundled plugin that ships off shows none of them, and that is because it is
//     off: turned on, its actions show (when it is ready on this PC; one that needs
//     setup shows none either), turned off again, they go.
// It is a contract spec (scripts/e2e-suites.mjs CONTRACT_SPECS): a change to any
// bundled plugin, its labels or places included, runs it.

const PLACES = ['empty_project', 'header', 'new_project', 'home'];
const CAPS = { empty_project: 3, header: 3, new_project: Infinity, home: 3 };
const PY_READ_MANIFESTS = `
import json, pathlib, sys
try:
    import tomllib
except ModuleNotFoundError:
    import tomli as tomllib
out = []
for d in sorted(pathlib.Path(sys.argv[1]).iterdir()):
    m = d / "manifest.toml"
    if m.is_file():
        out.append({"dir": d.name, "meta": tomllib.loads(m.read_text(encoding="utf-8"))})
print(json.dumps(out))
`;

/** The bundled plugins as their manifests declare them (plugin key order, as the host loads them). */
function bundledPlugins() {
  const r = spawnSync(PYTHON, ['-c', PY_READ_MANIFESTS, resolve('bundled-plugins')], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`reading the bundled manifests failed: ${r.stderr || r.error}`);
  return JSON.parse(r.stdout)
    .map(({ dir, meta }) => {
      const key = String(meta.key || dir);
      const kinds = meta.study_kinds || [];
      const workspaces = meta.workspaces || [];
      const actions = (meta.start_actions || []).map((a) => {
        const kind = kinds.find((k) => k.key === a.study_kind) || {};
        const ws = workspaces.find((w) => w.key === kind.workspace) || {};
        return {
          id: `${key}:${a.study_kind}`,
          plugin: key,
          kindTitle: String(kind.title || ''),
          workspace: String(kind.workspace || ''),
          label: String(a.label || ''),
          hint: String(a.hint || ''),
          home: String(a.home_label || a.label || ''),
          header: String(a.header_label || ws.title || kind.title || ''),
          places: (a.places || PLACES).filter((p) => PLACES.includes(p)),
        };
      });
      return { key, name: String(meta.name || key), defaultOn: meta.default_enabled !== false, actions };
    })
    .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
}

const BUNDLED = bundledPlugins();
const ON = BUNDLED.filter((p) => p.defaultOn);
const OFF = BUNDLED.filter((p) => !p.defaultOn);
const onActions = ON.flatMap((p) => p.actions);
const offWithActions = OFF.filter((p) => p.actions.length);

/** What each place shows for these actions: those naming it, in load order (bundled plugins by
 * key, then manifest order), cut at its cap. */
function shown(actions) {
  const rank = (a) => BUNDLED.findIndex((p) => p.key === a.plugin);
  const ordered = actions.map((a, i) => [a, i]).sort((x, y) => rank(x[0]) - rank(y[0]) || x[1] - y[1]).map(([a]) => a);
  const out = Object.fromEntries(PLACES.map((p) => [p, []]));
  for (const a of ordered) for (const p of a.places) if (out[p].length < CAPS[p]) out[p].push(a);
  return out;
}

function stage(t0, msg) {
  console.log(`[start-actions-bundled +${Math.round((Date.now() - t0) / 1000)}s] ${msg}`);
}

let host;
let t0 = 0;

test.beforeAll(async () => {
  test.setTimeout(240_000);
  t0 = Date.now();
  // The checkout's own bundled-plugins folder, no user plugins, a fresh settings file.
  host = await startHost({ name: 'start-bundled', tmp: e2eTemp('start-bundled') });
  stage(t0, `server up at ${host.base}; on: ${ON.map((p) => p.key).join(', ')}; off: ${OFF.map((p) => p.key).join(', ')}`);
});

test.afterAll(() => {
  host?.stop();
});

async function catalog(request) {
  const r = await request.get(`${host.base}/api/plugins`);
  expect(r.ok(), await r.text()).toBe(true);
  return Object.fromEntries(((await r.json()).plugins || []).map((row) => [row.key, row]));
}

async function setPlugin(request, key, on) {
  const r = await request.post(`${host.base}/api/plugins/${key}/${on ? 'enable' : 'disable'}`);
  expect(r.ok(), await r.text()).toBe(true);
  await request.post(`${host.base}/api/worker`, { data: { method: 'registry.reload', params: {} } });
}

async function newProject(request, title) {
  const r = await request.post(`${host.base}/api/project`, { data: { title, folder: 'My Projects', units: 'Metric', category: 'Other' } });
  const j = await r.json();
  expect(r.ok(), JSON.stringify(j)).toBe(true);
  return j.id;
}

// A fresh page load: a goto that changes only the hash would not reload the app, and
// what a place shows is checked as a fresh load draws it.
async function load(page, url) {
  await page.goto('about:blank');
  await page.goto(url);
}

// How many actions each place draws for what the page was sent (start actions with a
// workspace, each place cut at its cap). Used only to wait until the page has drawn what
// it was sent, so a place that should be empty is checked after the page drew it; what
// it shows is then compared with the manifests.
function sentCounts(actions) {
  const n = Object.fromEntries(PLACES.map((p) => [p, 0]));
  for (const a of actions) if (a && a.workspace) for (const p of a.places || []) if (p in n && n[p] < CAPS[p]) n[p] += 1;
  return n;
}

// A project, loaded fresh (or reloaded) and drawn from the tree it was sent.
async function openProject(page, pid, { reload = false } = {}) {
  const tree = page.waitForResponse((r) => {
    const u = new URL(r.url());
    return u.pathname === '/api/project/tree' && u.searchParams.get('project_id') === pid && r.ok();
  }, { timeout: 60_000 });
  if (reload) await page.reload();
  else await load(page, `${host.base}/#/p/${pid}`);
  await page.waitForFunction((id) => window.__CFD_PROJECT_READY__ === id && window.__CFD_PLUGINS_READY__ === true, pid, { timeout: 60_000 });
  const doc = await (await tree).json();
  const n = sentCounts((doc.plugin_study_kinds || []).map((k) => k.workspace && k.start_action));
  await expect(page.locator('#btn-add-geometry')).toBeVisible({ timeout: 60_000 });
  await expect(headerButtons(page)).toHaveCount(n.header, { timeout: 30_000 });
  await expect(emptyButtons(page)).toHaveCount(n.empty_project, { timeout: 30_000 });
}

// Home, loaded fresh (or reloaded), with its cards and drawn from the plugins it was sent.
async function goHome(page, reload = false) {
  const plugins = page.waitForResponse((r) => new URL(r.url()).pathname === '/api/plugins' && r.ok(), { timeout: 60_000 });
  if (reload) await page.reload();
  else await load(page, `${host.base}/#/`);
  const rows = (await (await plugins).json()).plugins || [];
  await expect(page.locator('#home-grid [data-project-id]').first()).toBeVisible({ timeout: 60_000 });
  const n = sentCounts(rows.filter((r) => r.status === 'enabled').flatMap((r) => r.start_actions || []));
  await expect(homeButtons(page)).toHaveCount(n.home, { timeout: 30_000 });
}

const texts = async (loc) => (await loc.allTextContents()).map((t) => t.trim());

/** A place shows exactly these texts (any order), or, past its cap, `cap` of them. */
async function expectPlace(loc, want, cap, what) {
  if (want.length <= cap) {
    await expect.poll(async () => (await texts(loc)).sort(), { message: what, timeout: 30_000 }).toEqual([...want].sort());
  } else {
    await expect(loc, what).toHaveCount(cap, { timeout: 30_000 });
    for (const t of await texts(loc)) expect(want, what).toContain(t);
  }
}

const headerButtons = (page) => page.locator('#ws-start-host [data-start-header] > button');
const emptyButtons = (page) => page.locator('#wb-empty-start [data-start-empty]');
const homeButtons = (page) => page.locator('#home-start-host [data-home-start]');
const overlay = (page) => page.locator('#workspace-overlay');

/** The project places (header, empty project) show exactly `actions`' share. */
async function expectProjectPlaces(page, actions, why) {
  const s = shown(actions);
  await expectPlace(headerButtons(page), s.header.map((a) => a.header), CAPS.header, `header buttons ${why}`);
  await expectPlace(emptyButtons(page), s.empty_project.map((a) => a.label), CAPS.empty_project, `empty project ${why}`);
  for (const a of s.empty_project) if (a.hint) await expect(page.locator('#wb-empty-start')).toContainText(a.hint);
  await expect(page.locator('#btn-add-geometry')).toBeVisible();
}

/** Home's buttons and the New Project dialog's "Start from" show exactly `actions`' share. */
async function expectHomePlaces(page, actions, why) {
  const s = shown(actions);
  await expectPlace(homeButtons(page), s.home.map((a) => a.home), CAPS.home, `Home ${why}`);
  await page.locator('#home-new-project').click();
  await expect(page.locator('#modal-new-project')).toBeVisible();
  if (s.new_project.length) {
    await expect(page.locator('#np-start')).toBeVisible({ timeout: 30_000 });
    await expect(page.locator('#np-start .np-start-label')).toHaveText(['Import geometry', ...s.new_project.map((a) => a.label)]);
    await expect(page.locator('#np-start-import')).toBeChecked();
  } else {
    await expect(page.locator('#np-start')).toBeHidden();
  }
  await page.locator('#np-cancel').click();
  await expect(page.locator('#modal-new-project')).toBeHidden();
}

test('the bundled plugins that ship on show their start actions in every place, and the ones that ship off show none, also after a reload', async ({ page, request }) => {
  test.setTimeout(240_000);
  page.setDefaultTimeout(30_000);
  // The manifests declare start actions somewhere, so the places below are checked against something.
  expect(BUNDLED.flatMap((p) => p.actions).length, 'no bundled plugin declares [[start_actions]]').toBeGreaterThan(0);
  // The server agrees with the manifests: on ones are loaded and ready, off ones publish nothing.
  const rows = await catalog(request);
  for (const p of ON) expect([p.key, rows[p.key]?.status]).toEqual([p.key, 'enabled']);
  for (const p of OFF) expect([p.key, rows[p.key]?.status, rows[p.key]?.start_actions]).toEqual([p.key, 'disabled', []]);

  const pid = await newProject(request, 'Bundled places');
  for (const pass of ['first load', 'after a reload']) {
    await openProject(page, pid, { reload: pass !== 'first load' });
    await expectProjectPlaces(page, onActions, `in a project, ${pass}`);
    for (const p of OFF) {
      await expect(page.locator(`#ws-start-host [data-start-header^="${p.key}:"]`)).toHaveCount(0);
      await expect(page.locator(`#wb-empty-start [data-start-empty^="${p.key}:"]`)).toHaveCount(0);
    }
    stage(t0, `project places checked, ${pass}`);
  }
  for (const pass of ['first load', 'after a reload']) {
    await goHome(page, pass !== 'first load');
    await expectHomePlaces(page, onActions, `on Home, ${pass}`);
    for (const p of OFF) await expect(page.locator(`#home-start-host [data-home-start^="${p.key}:"]`)).toHaveCount(0);
    stage(t0, `Home places checked, ${pass}`);
  }
});

test('each start action of a bundled plugin that ships on opens its workspace: from Home in one Create click, then from the header menu and the empty project', async ({ page, request }) => {
  test.skip(onActions.length === 0, 'no bundled plugin that ships on declares [[start_actions]]');
  test.setTimeout(600_000);
  page.setDefaultTimeout(30_000);
  const s = shown(onActions);
  const isShown = (a, place) => s[place].some((x) => x.id === a.id);
  for (const a of onActions) {
    const route = new RegExp(`#/p/[^/]+/ws/${a.plugin}/${a.workspace}/st-[a-z0-9-]+$`);
    const opened = async (title) => {
      await expect(overlay(page)).toBeVisible({ timeout: 60_000 });
      await expect(page).toHaveURL(route, { timeout: 60_000 });
      await expect(overlay(page).locator('[data-ws-title]')).toHaveText(title, { timeout: 60_000 });
      await expect(page.locator('#modal-prompt')).toBeHidden();
    };
    const back = async (pid) => {
      await overlay(page).locator('[data-ws-back]').click();
      await expect(overlay(page)).toBeHidden({ timeout: 60_000 });
      await expect(page).toHaveURL(new RegExp(`#/p/${pid}$`));
    };
    let pid;
    const titles = [];
    if (isShown(a, 'home')) {
      // Home: New Project with this action chosen and the title filled in; one Create click.
      await goHome(page);
      await page.locator(`#home-start-host [data-home-start="${a.id}"]`).click();
      await expect(page.locator('#modal-new-project')).toBeVisible();
      await expect(page.locator(`#np-start input[value="${a.id}"]`)).toBeChecked();
      await expect(page.locator('#np-title')).toHaveValue(`Untitled ${a.kindTitle} 1`);
      await page.locator('#np-create').click();
      titles.push(`${a.kindTitle} 1`);
      await opened(titles.at(-1));
      pid = decodeURIComponent(new URL(page.url()).hash.split('/')[2]);
      await back(pid);
      await expect(page.locator('.project-name')).toHaveText(`Untitled ${a.kindTitle} 1`);
      stage(t0, `${a.id}: Home, one Create click`);
    } else {
      pid = await newProject(request, `Start ${a.id}`);
      await openProject(page, pid);
    }
    if (isShown(a, 'header')) {
      // The header button's menu lists the studies of its kind, then "New <kind>".
      const button = page.locator(`#ws-start-host [data-start-header="${a.id}"] > button`);
      await expect(button).toHaveText(a.header);
      await button.click();
      const menu = page.locator(`#ws-start-host [data-start-header="${a.id}"] [role="menu"]`);
      await expect(menu).toBeVisible();
      if (titles.length) await expect(menu.locator('[data-start-study]')).toHaveText(titles);
      else await expect(menu.locator('[data-start-none]')).toHaveText(`No ${a.kindTitle} yet`);
      await expect(menu.locator(`[data-start-new="${a.id}"]`)).toHaveText(`New ${a.kindTitle}`);
      await menu.locator(`[data-start-new="${a.id}"]`).click();
      titles.push(`${a.kindTitle} ${titles.length + 1}`);
      await opened(titles.at(-1));
      await back(pid);
      stage(t0, `${a.id}: header menu`);
    }
    if (isShown(a, 'empty_project')) {
      await page.locator(`#wb-empty-start [data-start-empty="${a.id}"]`).click();
      titles.push(`${a.kindTitle} ${titles.length + 1}`);
      await opened(titles.at(-1));
      await back(pid);
      stage(t0, `${a.id}: empty project`);
    }
    // After a reload the project lists every study made, and the action is still in its places.
    await openProject(page, pid, { reload: true });
    const made = page.locator('#plugin-studies-section [data-plugin-study] .tl');
    await expect.poll(async () => (await texts(made)).filter((t) => titles.includes(t)).sort(), { message: 'the studies made, in STUDIES after a reload', timeout: 30_000 }).toEqual([...titles].sort());
    await expectProjectPlaces(page, onActions, `after making ${a.id} studies and a reload`);
  }
});

test('a bundled plugin that ships off has no start actions only because it is off: turned on they show (when it is ready), turned off they go', async ({ page, request }) => {
  test.skip(offWithActions.length === 0, 'no bundled plugin that ships off declares [[start_actions]]');
  test.setTimeout(600_000);
  page.setDefaultTimeout(30_000);
  const pid = await newProject(request, 'Turned on');
  for (const p of offWithActions) {
    await setPlugin(request, p.key, true);
    try {
      const row = (await catalog(request))[p.key];
      // Ready on this PC: its actions join the ones that ship on. Needing setup (its
      // environment is not built here): on, but still nowhere.
      const ready = row?.status === 'enabled';
      test.info().annotations.push({ type: 'turned on', description: `${p.key}: ${row?.status}` });
      stage(t0, `${p.key} turned on: ${row?.status}`);
      if (!ready) expect(row?.start_actions || []).toEqual([]);
      const want = [...onActions, ...(ready ? p.actions : [])];
      await openProject(page, pid);
      await expectProjectPlaces(page, want, `with ${p.key} on (${row?.status})`);
      await goHome(page);
      await expectHomePlaces(page, want, `with ${p.key} on (${row?.status})`);
    } finally {
      await setPlugin(request, p.key, false);
    }
    // Off again: back to the plugins that ship on.
    await goHome(page);
    await expectHomePlaces(page, onActions, `with ${p.key} off again`);
    await openProject(page, pid);
    await expectProjectPlaces(page, onActions, `with ${p.key} off again`);
  }
});
