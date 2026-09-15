const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

(async () => {
  const outDir = path.join(__dirname, '..', 'runs', 'phase0-ui-sim-tree');
  fs.mkdirSync(outDir, { recursive: true });
  const base = process.env.CFD_BASE || 'http://127.0.0.1:8082';
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  page.on('console', (m) => {
    if (m.type() === 'error' || m.type() === 'warning') console.log('CONSOLE', m.type(), m.text());
  });
  page.on('pageerror', (e) => console.log('PAGEERROR', e.message));

  const pid = process.env.CFD_PID || 'tester-phase0-ui-20260914-2154-20260915025538-22f74c';
  console.log('BASE', base, 'PID', pid);
  await page.goto(base.replace(/\/$/, '') + '/#/p/' + encodeURIComponent(pid));
  await page.waitForSelector('#app.workbench', { timeout: 90000 });
  await page.waitForTimeout(5000);

  const snap = async (label) => {
    const data = await page.evaluate(() => {
      const tree = document.getElementById('simulations-tree');
      return {
        stage: document.getElementById('app')?.getAttribute('data-wb-stage'),
        treeText: tree ? tree.innerText : null,
        hasMaterials: !!(tree && tree.querySelector('[data-w18-materials]')),
        hasMesh: !!(tree && tree.querySelector('[data-w20-mesh]')),
        hasBcs: !!(tree && tree.querySelector('[data-w19-bcs]')),
        hasSimControl: !!(tree && tree.querySelector('[data-w27-sim-control]')),
        materialsText: !!(tree && /Materials/i.test(tree.innerText)),
        meshText: !!(tree && /\bMesh\b/i.test(tree.innerText)),
        bcText: !!(tree && /Boundary/i.test(tree.innerText)),
        studyNodes: tree
          ? [...tree.querySelectorAll('[data-w17-sim]')].map((n) => ({
              id: n.getAttribute('data-w17-sim-id'),
              text: n.querySelector(':scope > .tree-row .tl')?.textContent,
              expanded: n.classList.contains('expanded'),
              kids: [...n.querySelectorAll(':scope > ul > li')].map(
                (li) => li.getAttribute('data-label') || li.innerText.slice(0, 40),
              ),
            }))
          : [],
        w17: window.__CFD_W17__,
        w17State:
          typeof w17State !== 'undefined'
            ? {
                sims: w17State.simulations,
                sim: w17State.simulation,
                active: w17State.activeId,
                ready: w17State.ready,
                created: w17State.created,
              }
            : 'no',
        geoms:
          typeof w16State !== 'undefined'
            ? {
                selected: w16State.selectedGeomId,
                geomId: w16State.geometry && w16State.geometry.id,
                geoms: (w16State.geometries || []).map((g) => ({ id: g.id, name: g.name })),
              }
            : null,
        html: tree ? tree.innerHTML.slice(0, 6000) : null,
      };
    });
    console.log(label, JSON.stringify(data, null, 2));
    await page.screenshot({ path: path.join(outDir, label + '.png'), fullPage: true });
    return data;
  };

  const hydrated = await snap('01-hydrated');

  // If no studies yet, create; else create another
  await page.click('#btn-create-simulation');
  await page.waitForSelector('#modal-create-simulation:not([hidden])', { timeout: 15000 });
  const modalState = await page.evaluate(() => ({
    geomVal: (document.getElementById('cs-geometry') || {}).value,
    geomHidden: document.getElementById('cs-geom-wrap')?.hidden,
    copyVal: (document.getElementById('cs-copy-from') || {}).value,
  }));
  console.log('MODAL', modalState);
  await page.screenshot({ path: path.join(outDir, '02-modal.png'), fullPage: true });
  await page.click('#cs-create');
  await page.waitForTimeout(6000);
  const after = await snap('03-after-create');

  fs.writeFileSync(
    path.join(outDir, 'diag.json'),
    JSON.stringify({ base, pid, hydrated, after, modalState }, null, 2),
  );
  await browser.close();
  console.log('DONE');
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
