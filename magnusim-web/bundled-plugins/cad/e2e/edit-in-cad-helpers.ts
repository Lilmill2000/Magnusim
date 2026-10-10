// Edit in CAD e2e steps (host API 1.7), shared by cad-edit-in-cad.spec.ts and the opt-in
// big STEP timing (cad-edit-in-cad-big.spec.ts): the spec's own app server, a geometry
// imported in the simulation view, BCs and a generated mesh through the app's routes,
// the tree row's Edit in CAD, the Part that opens (its import and face matching done),
// press-pull through the panel, Back and the landing's report.
// SPDX-License-Identifier: GPL-3.0-or-later
import { expect, type APIRequestContext, type FrameLocator, type Page, type TestInfo } from '@playwright/test';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
// @ts-expect-error the app's host helper is plain JavaScript (e2e/host-server.d.mts types CAD's wrapper only)
import { startHost } from '../../../e2e/support/host-server.mjs';
import { geometryRow, partOpened, workspaceFrame } from './helpers';

export { partOpened };

export type Host = { base: string; projects: string; stop(): void; log(): string };
let host: Host | null = null;

/**
 * The spec's own app server (an empty projects root: the tests make theirs, and the mesh record
 * is written on disk), on its own Vite cache and port (CAD_E2E_PORT_FROM + `offset`).
 */
export async function startEditHost(name: string, offset: number): Promise<void> {
  host = (await startHost({
    name,
    seed: false,
    enablePlugins: ['cad'],
    viteCacheDir: resolve('.cache', `host-vite-${name}`),
    portFrom: Number(process.env.CAD_E2E_PORT_FROM || 8170) + offset,
    env: { MAGNUSIM_E2E_WSL: null, MAGNUSIM_WSL_PRUNE: '0' },
    timeoutMs: 240_000,
  })) as Host;
}

export function stopEditHost(): void {
  host?.stop();
  host = null;
}

export const baseUrl = (): string => host!.base;

export async function newProject(request: APIRequestContext, title: string): Promise<string> {
  const r = await request.post(`${baseUrl()}/api/project`, { data: { title, category: 'Other', units: 'Metric' } });
  const j = await r.json();
  expect(r.ok(), JSON.stringify(j)).toBe(true);
  return String(j.id);
}

export async function openProject(page: Page, pid: string) {
  await page.goto(`${baseUrl()}/#/p/${pid}`);
  await page.waitForFunction((id) => (window as unknown as { __CFD_PROJECT_READY__?: string }).__CFD_PROJECT_READY__ === id, pid, { timeout: 90_000 });
}

export const HERE = dirname(fileURLToPath(import.meta.url));
export const FIXTURES = resolve(HERE, '..', 'fixtures', 'kernel');
export const STEPPED = join(FIXTURES, 'stepped-bore.step');
export const BOX = join(FIXTURES, 'box20.step');
export const BOX_FACES = join(FIXTURES, 'box20-faces.step');
export const VORTEX = process.env.CAD_E2E_VORTEX_STEP || '';
export const REQUIRE = process.env.CAD_L3_REQUIRE === '1';
export const SHOTS = process.env.CAD_E2E_SHOTS || '';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type W = { __CAD__: any };
export type V3 = [number, number, number];
export type MetaFace = { id: number; area: number; centroid: V3; normal?: V3 | null; body?: number };

export async function shot(page: Page, name: string) {
  if (!SHOTS) return;
  mkdirSync(SHOTS, { recursive: true });
  await page.screenshot({ path: join(SHOTS, `${name}.png`), timeout: 15_000 }).catch(() => {});
}

export const cad = <T>(page: Page, fn: (arg: never) => T | Promise<T>, arg?: unknown) => workspaceFrame(page).evaluate(fn as never, arg as never) as Promise<T>;

/** A file in the simulation view, as the app's Import does it: {id, name}. */
export async function importGeometry(request: APIRequestContext, pid: string, path: string, filename: string): Promise<{ id: string; name: string }> {
  const r = await request.post(`${baseUrl()}/api/geometry/import`, { data: { project_id: pid, step_path: path, filename }, timeout: 600_000 });
  const j = await r.json();
  expect(r.ok(), JSON.stringify(j)).toBe(true);
  return { id: String(j.geometry.id), name: String(j.geometry.name) };
}

/** The geometry's faces as the app reads them (its preview). */
export async function metaOf(request: APIRequestContext, pid: string, gid: string): Promise<{ faces: MetaFace[]; nFaces: number; zmax: number }> {
  const r = await request.get(`${baseUrl()}/api/geometry/cad?project_id=${pid}&geometry_id=${gid}&part=meta`, { timeout: 600_000 });
  expect(r.ok(), await r.text()).toBe(true);
  const m = await r.json();
  return { faces: m.faces as MetaFace[], nFaces: Number(m.n_faces), zmax: Number(m.bounds?.zmax) };
}

export const near = (a: number, b: number, tol = 1e-3) => Math.abs(a - b) <= tol;
export const up = (f: MetaFace) => !!f.normal && near(f.normal[2], 1, 1e-6);

/** The one face that passes `pick`, by its id. */
export function oneFace(faces: MetaFace[], pick: (f: MetaFace) => boolean, what: string): MetaFace {
  const hits = faces.filter(pick);
  expect(hits.map((f) => f.id), `one ${what}`).toHaveLength(1);
  return hits[0];
}

export async function simulationWithBcs(request: APIRequestContext, pid: string, gid: string, bcs: { name: string; type: string; face: number }[]) {
  const sim = await request.post(`${baseUrl()}/api/simulation`, { data: { project_id: pid, geometry_id: gid } });
  const simj = await sim.json();
  expect(sim.ok(), JSON.stringify(simj)).toBe(true);
  const ids: Record<string, string> = {};
  for (const b of bcs) {
    const r = await request.post(`${baseUrl()}/api/bcs`, { data: { project_id: pid, simulation_id: simj.simulation.id, name: b.name, bc_type: b.type, faces: [`face ${b.face}@Body1`], geometry_rev: 0 } });
    const j = await r.json();
    expect(r.ok(), JSON.stringify(j)).toBe(true);
    ids[b.name] = String(j.bc.id);
  }
  return { simId: String(simj.simulation.id), simName: String(simj.simulation.name), bcIds: ids };
}

export type Bc = { id: string; name: string; faces: string[]; lost_faces?: unknown[] };
export async function bcsOf(request: APIRequestContext, pid: string, simId: string): Promise<Bc[]> {
  return (await (await request.get(`${baseUrl()}/api/bcs?project_id=${pid}&simulation_id=${simId}`)).json()).boundary_conditions as Bc[];
}
export const faceNo = (label: string) => Number(/face\s*(\d+)/.exec(label)?.[1]);

/** A study's record folder (a mesh's) on disk. */
export function meshDir(pid: string, id: string): string {
  const geoms = join(host!.projects, pid, 'geometries');
  for (const g of readdirSync(geoms)) {
    const root = join(geoms, g, 'simulations');
    if (!existsSync(root)) continue;
    for (const s of readdirSync(root)) {
      const meshes = join(root, s, 'meshes');
      if (!existsSync(meshes)) continue;
      for (const f of readdirSync(meshes)) {
        try {
          if (JSON.parse(readFileSync(join(meshes, f, 'id.json'), 'utf8')).id === id) return join(meshes, f);
        } catch {
          /* not a record */
        }
      }
    }
  }
  throw new Error(`no mesh ${id}`);
}

/** "Mesh 1" of a simulation as its generate leaves it at geometry rev 0 (a whole polyMesh, no WSL). */
export async function generatedMesh(request: APIRequestContext, pid: string, simId: string): Promise<string> {
  const m = await request.post(`${baseUrl()}/api/mesh`, { data: { project_id: pid, simulation_id: simId, name: 'Mesh 1' } });
  const mj = await m.json();
  expect(m.ok(), JSON.stringify(mj)).toBe(true);
  const meshId = String(mj.mesh.id);
  const dir = meshDir(pid, meshId);
  const poly = join(dir, 'case', 'constant', 'polyMesh');
  mkdirSync(poly, { recursive: true });
  for (const n of ['points', 'faces', 'owner', 'neighbour']) writeFileSync(join(poly, n), `${n}\n`);
  writeFileSync(
    join(poly, 'boundary'),
    ['FoamFile { version 2.0; format ascii; class polyBoundaryMesh; location "constant/polyMesh"; object boundary; }', '1', '(', '    wall', '    {', '        type wall;', '        nFaces 1;', '        startFace 0;', '    }', ')', ''].join('\n'),
  );
  const file = join(dir, 'mesh.json');
  writeFileSync(
    file,
    JSON.stringify({
      ...JSON.parse(readFileSync(file, 'utf8')),
      generated: true,
      live_mesh_result: { status: 'done', generate_id: 'g-e2e', built_from_rev: 0, n_cells: 8, n_points: 27, case_dir: join(dir, 'case'), mesh_path: poly },
    }),
  );
  return meshId;
}

/** The study's link as the app reads it. */
export async function linkedOf(request: APIRequestContext, pid: string, sid: string) {
  const r = await request.get(`${baseUrl()}/api/plugin-geometry/linked?project_id=${pid}&plugin=cad&study_id=${sid}`);
  expect(r.ok(), await r.text()).toBe(true);
  return ((await r.json()).linked ?? null) as { geometryId: string; rev: number; sourceVersion: number; lostFaces: number; adopted?: boolean; original?: { fileName: string | null; format: string; sha256: string } | null } | null;
}

/** The right-click menu of a geometry's tree row, and its Edit in CAD item. */
export async function treeMenuItem(page: Page, gid: string) {
  const row = geometryRow(page, gid);
  await expect(row).toBeVisible({ timeout: 60_000 });
  await row.click({ button: 'right' });
  const menu = page.locator(`[data-geom-menu="${gid}"]`);
  await expect(menu).toBeVisible();
  return menu.locator('[data-geom-action="part"][data-geom-action-plugin="cad"]');
}

/** The Part that opens on Edit in CAD: its study id from the address, and its frame once the import is done and the faces matched. */
export async function editOpened(page: Page, pid: string, timeout = 180_000): Promise<{ sid: string; frame: FrameLocator }> {
  await expect(page).toHaveURL(new RegExp(`#/p/${pid}/ws/cad/part/[^/]+$`), { timeout: 60_000 });
  const sid = decodeURIComponent(/\/ws\/cad\/part\/([^/]+)$/.exec(page.url())![1]);
  const frame = await partOpened(page);
  await expect(frame.locator('[data-cad-app]')).toHaveAttribute('data-doc', 'ready', { timeout: 60_000 });
  await expect.poll(() => cad<string>(page, (() => (window as unknown as W).__CAD__.edit?.state.get().phase ?? 'none') as never), { timeout, intervals: [500] }).toBe('ready');
  await settled(page);
  return { sid, frame };
}

export async function settled(page: Page) {
  await expect(page.frameLocator('#workspace-frame').locator('[data-chip="save"]')).toHaveText('Saved', { timeout: 60_000 });
  await expect
    .poll(() =>
      cad<boolean>(page, (() => {
        const st = (window as unknown as W).__CAD__.services.doc.state.get();
        return st.rebuild.status === 'done' && st.doc.features.every((f: { id: string }) => st.rebuild.features[f.id] && st.rebuild.features[f.id].state !== 'pending');
      }) as never),
    )
    .toBe(true);
}

export const history = (page: Page) => cad<string[]>(page, (() => (window as unknown as W).__CAD__.services.doc.state.get().doc.features.map((f: { type: string }) => f.type)) as never);

/** The CAD faces of the first body: index, centroid, normal (the kernel's own reading). */
export async function cadFaces(page: Page): Promise<{ i: number; centroid: V3; normal?: V3; area: number; type: string }[]> {
  return cad(page, (async () => {
    const s = (window as unknown as W).__CAD__.services;
    const b = s.doc.state.get().rebuild.bodies[0];
    return (await s.kernel.call('topo', { id: b.shape, faces: 'all', edges: 'none', vertices: 'none', face_bbox: 'none', face_mass: true })).result.faces;
  }) as never);
}

/** A page point where the Part's own pick finds face `index` of the first body, in some standard view. */
export async function clickFace(page: Page, frame: FrameLocator, index: number) {
  const tryPoint = () =>
    cad<[number, number] | null>(page, ((i: number) => {
      const s = (window as unknown as W).__CAD__.services;
      const b = s.doc.state.get().rebuild.bodies[0];
      const h = s.viewport.get().handle;
      const t = b.tess;
      const st = t.faceRanges[2 * i];
      const n = t.faceRanges[2 * i + 1];
      const pts: { p: number[]; area: number }[] = [];
      for (let k = st; k < st + n; k += 3) {
        const v = [t.indices[k], t.indices[k + 1], t.indices[k + 2]].map((j: number) => [t.positions[3 * j], t.positions[3 * j + 1], t.positions[3 * j + 2]]);
        const a = [0, 1, 2].map((c) => v[1][c] - v[0][c]);
        const bb = [0, 1, 2].map((c) => v[2][c] - v[0][c]);
        const cr = [a[1] * bb[2] - a[2] * bb[1], a[2] * bb[0] - a[0] * bb[2], a[0] * bb[1] - a[1] * bb[0]];
        pts.push({ p: [0, 1, 2].map((c) => (v[0][c] + v[1][c] + v[2][c]) / 3), area: Math.hypot(cr[0], cr[1], cr[2]) });
      }
      pts.sort((x, y) => y.area - x.area);
      for (const q of pts) {
        const c = h.project(q.p);
        if (!c) continue;
        const hit = h.pick(c[0], c[1]);
        if (hit && hit.item.kind === 'face' && hit.item.index === i && hit.item.body === b.id) return c;
      }
      return null;
    }) as never, index);
  for (const view of [null, 'view.iso', 'view.top', 'view.front']) {
    if (view) {
      await frame.locator(`[data-cad-toolbar] [data-command="${view}"]`).click().catch(() => {});
      await page.waitForTimeout(600);
    }
    const xy = await tryPoint();
    if (!xy) continue;
    const box = (await page.locator('#workspace-frame').boundingBox())!;
    await page.mouse.move(box.x + xy[0] + 2, box.y + xy[1] + 2);
    await page.mouse.move(box.x + xy[0], box.y + xy[1], { steps: 2 });
    await page.mouse.click(box.x + xy[0], box.y + xy[1]);
    return;
  }
  expect(null, `face ${index} in some standard view`).not.toBeNull();
}

/** Press-pull face `index` of the first body by `mm` through the panel (Q, the distance, Done). */
export async function pressPull(page: Page, frame: FrameLocator, index: number, mm: number) {
  await clickFace(page, frame, index);
  await expect.poll(() => cad(page, (() => (window as unknown as W).__CAD__.services.selection.get().items) as never)).toEqual([expect.objectContaining({ kind: 'face', index })]);
  await page.keyboard.press('q');
  const panel = frame.locator('[data-cad-panel="feature"]');
  await expect(panel.locator('[data-pick-field="faces"] [data-pick-row]')).toHaveCount(1);
  const field = panel.locator('.nui[data-field="distance"] input');
  await field.fill(String(mm));
  await field.press('Enter');
  await settled(page);
  await panel.locator('[data-panel-done]').click();
  await expect(panel).toHaveCount(0);
  await settled(page);
}

export const landings = (page: Page) => page.evaluate(() => (window as unknown as { __CFD_LANDINGS__?: number }).__CFD_LANDINGS__ || 0);
export const linkToasts = (page: Page) => page.evaluate(() => (window as unknown as { __CFD_LINK_TOASTS__?: string[] }).__CFD_LINK_TOASTS__ ?? []);

/**
 * After Overwrite: the landing, and the app's report on it (a dialog, OK'd, or a toast).
 * Any other dialog fails the test with its words.
 */
export async function landed(page: Page, pid: string, before: number): Promise<{ title: string | null; lines: string[]; toast: string | null }> {
  await expect(page).toHaveURL(new RegExp(`#/p/${pid}$`), { timeout: 600_000 });
  await expect.poll(() => landings(page), { timeout: 600_000 }).toBeGreaterThan(before);
  const until = Date.now() + 4_000;
  while (Date.now() < until) {
    if (await page.locator('#modal-confirm').isVisible()) {
      const title = ((await page.locator('#cf-heading').textContent()) ?? '').trim();
      const lines = (await page.locator('#cf-copy').innerText()).split('\n').map((l) => l.trim()).filter(Boolean);
      if (!/ updated$/.test(title)) throw new Error(`an unexpected dialog over the project: "${title}" ${JSON.stringify(lines)}`);
      await page.locator('#cf-confirm').click();
      await expect(page.locator('#modal-confirm')).toBeHidden();
      return { title, lines, toast: null };
    }
    await page.waitForTimeout(250);
  }
  return { title: null, lines: [], toast: (await linkToasts(page)).at(-1) ?? null };
}

export const backButton = (page: Page) => page.locator('#workspace-overlay [data-ws-back]');

/** Back with no change: the Part leaves and links nothing (no question, no landing report). */
export async function backUnchanged(page: Page, pid: string) {
  await backButton(page).click();
  await expect(page).toHaveURL(new RegExp(`#/p/${pid}$`), { timeout: 120_000 });
  await expect(page.locator('#modal-link-choice')).toBeHidden();
}

export function timingsNote(info: TestInfo, name: string, t: Record<string, number>, extra: Record<string, unknown> = {}) {
  const line = `${name}: ${Object.entries(t)
    .map(([k, v]) => (/helpers$|heap_mb$|failed$|chunks$|_ms_max$/.test(k) ? `${k} ${v}` : `${k} ${(v / 1000).toFixed(2)} s`))
    .join(', ')}${Object.keys(extra).length ? ` ${JSON.stringify(extra)}` : ''}`;
  console.log(`[cad-edit] ${line}`);
  info.annotations.push({ type: 'timings', description: line });
}

export const edit = (page: Page) => cad<{ timings: Record<string, number>; adopt: { matched: number; total: number; baselineVersion: number } | null; launched: unknown }>(page, (async () => {
  const e = (window as unknown as W).__CAD__.edit;
  return { timings: { ...e.timings }, adopt: await e.ready(), launched: e.state.get().launched };
}) as never);
