const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const BASE = (process.env.CFD_BASE || 'https://simulation.lilmill2000.com').replace(/\/$/, '');
const outDir = path.join(__dirname, '..', 'runs', 'phase0-ui-sim-tree');
fs.mkdirSync(outDir, { recursive: true });

function stepFile() {
  return 'C:\\Users\\drmil\\Desktop\\Code\\CFD\\cfd-web\\projects\\tester-phase0-ui-20260914-2154-20260915025538-22f74c\\geometry\\source.step';
}

(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  const errors = [];
  page.on('console', (m) => {
    const t = m.type();
    const text = m.text();
    if (t === 'error' || t === 'warning') {
      if (/Maximum call stack|hydrate/i.test(text)) errors.push(text.slice(0, 300));
      console.log('CONSOLE', t, text.slice(0, 240));
    }
  });
  page.on('pageerror', (e) => {
    errors.push(e.message);
    console.log('PAGEERROR', e.message);
  });

  // Fresh project via public API
  const create = await page.request.post(BASE + '/api/project', {
    data: {
      title: 'proto-ui-sim-tree-' + Date.now(),
      category: 'Fluid dynamics',
      units: 'Metric',
      folder: 'My Projects',
    },
  });
  const cj = await create.json();
  const pid = cj.id || (cj.project && cj.project.id);
  console.log('project', create.status(), pid);
  if (!pid) throw new Error('no project id: ' + JSON.stringify(cj).slice(0, 400));

  const imp = await page.request.post(BASE + '/api/geometry/import', {
    data: { project_id: pid, step_path: stepFile() },
  });
  const ij = await imp.json();
  console.log('import', imp.status(), ij.geometry && ij.geometry.id, ij.error || '');
  if (!imp.ok()) throw new Error('import failed: ' + (ij.error || imp.status()));

  await page.goto(BASE + '/#/p/' + encodeURIComponent(pid), { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#app.workbench', { timeout: 90000 });
  await page.waitForTimeout(6000);

  const snap = async (label) => {
    const data = await page.evaluate(() => {
      const tree = document.getElementById('simulations-tree') || document.getElementById('left-tree');
      const text = tree ? tree.innerText : '';
      return {
        stage: document.getElementById('app')?.getAttribute('data-wb-stage'),
        treeText: text,
        hasMaterialsAttr: !!document.querySelector('#simulations-tree [data-w18-materials], #left-tree [data-w18-materials]'),
        hasBcsAttr: !!document.querySelector('#simulations-tree [data-w19-bcs], #left-tree [data-w19-bcs]'),
        hasMeshAttr: !!document.querySelector('#simulations-tree [data-w20-mesh], #left-tree [data-w20-mesh]'),
        hasSimControlAttr: !!document.querySelector('#simulations-tree [data-w27-sim-control], #left-tree [data-w27-sim-control]'),
        materialsText: /Materials/i.test(text),
        bcText: /Boundary/i.test(text),
        meshText: /\bMesh\b/i.test(text),
        simText: /\bSimulation\b/i.test(text),
        studyCount: document.querySelectorAll('#simulations-tree [data-w17-sim]').length,
        createBtnVisible: (() => {
          const b = document.getElementById('btn-create-simulation');
          if (!b) return false;
          const s = getComputedStyle(b);
          return s.display !== 'none' && s.visibility !== 'hidden' && b.offsetParent !== null;
        })(),
        w17ready: !!(window.__CFD_W17__ && window.__CFD_W17__.ready),
        w17sim: window.__CFD_W17__ && window.__CFD_W17__.simulation && window.__CFD_W17__.simulation.id,
      };
    });
    await page.screenshot({ path: path.join(outDir, label + '.png'), fullPage: true });
    console.log(label, JSON.stringify(data, null, 2));
    return data;
  };

  const before = await snap('public-before-create');

  // Create Simulation via UI
  const btn = page.locator('#btn-create-simulation');
  await btn.waitFor({ state: 'visible', timeout: 30000 });
  await btn.click();
  await page.waitForSelector('#modal-create-simulation:not([hidden])', { timeout: 15000 });
  await page.screenshot({ path: path.join(outDir, 'public-modal.png'), fullPage: true });
  await page.click('#cs-create');
  await page.waitForTimeout(7000);

  const after = await snap('public-after-create');

  const pass =
    after.materialsText &&
    after.bcText &&
    after.meshText &&
    (after.simText || after.hasSimControlAttr) &&
    after.studyCount >= 1 &&
    !errors.some((e) => /Maximum call stack/i.test(e));

  const report = {
    verdict: pass ? 'PASS' : 'FAIL',
    base: BASE,
    project_id: pid,
    before,
    after,
    errors,
    screenshots: {
      before: 'public-before-create.png',
      modal: 'public-modal.png',
      after: 'public-after-create.png',
    },
    fix: 'meshListAll no longer falls back to meshList when meshes_all empty (breaks meshesForStudy recursion)',
    checked_at: new Date().toISOString(),
  };
  fs.writeFileSync(path.join(outDir, 'report.json'), JSON.stringify(report, null, 2));
  console.log('VERDICT', report.verdict);
  await browser.close();
  if (!pass) process.exit(2);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});

