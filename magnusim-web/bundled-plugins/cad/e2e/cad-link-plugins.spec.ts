// gate:l2-cad, plugin_needed (host API 1.5): a Part linked into a project whose
// simulation study holds a record of another plugin (the app's test plugin
// bc-demo: a boundary-condition family with a field that holds faces). While that
// plugin is off, the app cannot update the geometry in place (it would not know
// which of the record's fields hold faces): its question offers Overwrite
// disabled, naming the record, and the Part's "Keep editing" changes nothing and
// says nothing; "Save as new" still adds the new shape as "Part 1 v2". With the
// plugin on again, Overwrite updates the geometry in place.
// This spec runs its own app server (startHost) with the app's link test plugins
// (python/tests/fixtures/link-plugins) beside CAD, on its own Vite cache.
// SPDX-License-Identifier: GPL-3.0-or-later
import { expect, test, type Page } from '@playwright/test';
import { join, resolve } from 'node:path';
// @ts-expect-error the app's host helper is plain JavaScript (e2e/host-server.d.mts types CAD's wrapper only)
import { startHost } from '../../../e2e/support/host-server.mjs';
import { addSolid, answerLinkQuestion, linkedGeometry, partOpened, readLinkQuestion, syncLink, workspaceFrame } from './helpers';

type Host = { base: string; stop(): void; log(): string };
let host: Host | null = null;

test.beforeAll(async () => {
  test.setTimeout(300_000);
  host = (await startHost({
    name: 'cad-link-plugins',
    pluginsFrom: 'python/tests/fixtures/link-plugins',
    enablePlugins: ['cad'],
    viteCacheDir: resolve('.cache', 'host-vite-link-plugins'),
    portFrom: Number(process.env.CAD_E2E_PORT_FROM || 8170) + 20,
    env: { MAGNUSIM_E2E_WSL: null, MAGNUSIM_WSL_PRUNE: '0' },
    timeoutMs: 240_000,
  })) as Host;
});
test.afterAll(() => host?.stop());

async function settled(page: Page) {
  await expect(page.frameLocator('#workspace-frame').locator('[data-chip="save"]')).toHaveText('Saved', { timeout: 30_000 });
}

async function setHeight(page: Page, extrude: string, mm: number) {
  await workspaceFrame(page).evaluate(
    ({ id, d }) => {
      const doc = (window as unknown as { __CAD__: { services: { doc: { beginEdit(id: string): { update(p: unknown): void; commit(): void } } } } }).__CAD__.services.doc;
      const s = doc.beginEdit(id);
      s.update({ extent: { kind: 'blind', distance: `${d} mm` } });
      s.commit();
    },
    { id: extrude, d: mm },
  );
  await settled(page);
}

test('cad:link-plugin-needed with the plugin of a study record off, Overwrite is disabled with the record named; Keep editing changes nothing; on again, Overwrite updates in place', async ({ page, request }, testInfo) => {
  test.setTimeout(480_000);
  const base = host!.base;
  try {
    const p = await request.post(`${base}/api/project`, { data: { title: 'CAD plugin needed', category: 'Other', units: 'Metric' } });
    const pid = (await p.json()).id as string;
    const s = await request.post(`${base}/api/plugin-studies/create`, { data: { project_id: pid, plugin: 'cad', kind: 'part', title: 'Part 1' } });
    const sj = await s.json();
    expect(s.ok(), JSON.stringify(sj)).toBe(true);
    const sid = sj.study.id as string;
    await page.goto(`${base}/#/p/${pid}/ws/cad/part/${sid}`);
    const frame = await partOpened(page);
    await expect(frame.locator('[data-cad-app]')).toHaveAttribute('data-doc', 'ready');
    const made = await addSolid(page, { size: [40, 30, 20] });
    await settled(page);
    const first = await syncLink(page);
    expect(first.outcome, JSON.stringify(first)).toBe('linked');
    const gid = first.result!.geometryId;

    // A simulation study on Part 1 with a BC of bc-demo's family on a face; then bc-demo off.
    const sim = await request.post(`${base}/api/simulation`, { data: { project_id: pid, geometry_id: gid } });
    const simj = await sim.json();
    expect(sim.ok(), JSON.stringify(simj)).toBe(true);
    const simName = simj.simulation.name as string;
    const bc = await request.post(`${base}/api/bcs`, {
      data: { project_id: pid, simulation_id: simj.simulation.id, name: 'Porous', bc_type: 'Demo porous', faces: [], extra_faces: ['face 1@Body1'], geometry_rev: 1 },
    });
    expect(bc.ok(), await bc.text()).toBe(true);
    const off = await request.post(`${base}/api/plugins/bc-demo/disable`, { data: {} });
    expect(off.ok(), await off.text()).toBe(true);

    // A new shape: the app asks; Overwrite is off, and says which record needs its plugin.
    await setHeight(page, made.extrude, 25);
    let run = syncLink(page);
    const q = await readLinkQuestion(page);
    expect(q.overwriteDisabled).toBe(true);
    expect(q.overwriteLine).toBe(`Records of Demo porous come from a plugin that is off or not installed: ${simName} › Porous. Turn it on or install it, or delete those records, to update Part 1.`);
    await page.screenshot({ path: testInfo.outputPath('plugin-needed.png') });
    if (process.env.CAD_E2E_SHOTS) await page.screenshot({ path: join(process.env.CAD_E2E_SHOTS, 'link-plugin-needed.png') });
    await answerLinkQuestion(page, 'cancel');
    const kept = await run;
    expect(kept.outcome).toBe('kept-editing');
    await expect(page.locator('#workspace-overlay [data-ws-toast]')).toHaveCount(0);
    expect((await linkedGeometry(page))!.rev).toBe(1);

    // bc-demo on again: Overwrite updates Part 1 in place.
    const on = await request.post(`${base}/api/plugins/bc-demo/enable`, { data: {} });
    expect(on.ok(), await on.text()).toBe(true);
    run = syncLink(page);
    const q2 = await readLinkQuestion(page);
    expect(q2.overwriteDisabled).toBe(false);
    await answerLinkQuestion(page, 'overwrite');
    let out: Awaited<typeof run> | null = null;
    void run.then((r) => (out = r));
    await expect
      .poll(
        async () => {
          if (out) return 'done';
          if (await page.locator('#modal-confirm').isVisible()) await page.locator('#cf-confirm').click();
          return 'waiting';
        },
        { timeout: 180_000, intervals: [250] },
      )
      .toBe('done');
    expect(out!.outcome, JSON.stringify(out)).toBe('linked');
    expect(out!.result).toMatchObject({ geometryId: gid, rev: 2, created: false });
  } finally {
    await request.post(`${base}/api/plugins/bc-demo/enable`, { data: {} }).catch(() => {});
  }
});
