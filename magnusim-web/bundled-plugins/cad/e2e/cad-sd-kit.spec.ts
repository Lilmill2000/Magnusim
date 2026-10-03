// The host UI kit in the Part workspace (SD pass, H14, host API 1.3). CAD draws its
// panels with @magnusim/plugin-ui: Field, Select, Hint, DisabledReason, EmptyState and
// Toggle are the kit's own components; PanelChrome, the buttons and NumberUnitInput are
// CAD's, drawn with the kit's classes (ARCHITECTURE.md §7). The kit's own gate
// (core e2e/h14-kit.spec.js, gate:h14-kit-parity) holds every kit component equal to the
// core control it copies, in the page and in a frame; this spec holds CAD's controls
// equal to the kit's, so CAD equals the core through the kit.
//   kit-parity     Each adopted control in a real CAD panel, property by property against
//                  the kit's own component rendered in the same frame from the frame's
//                  /plugin-sdk/plugin-ui.js (the same props the kit gate compares). The
//                  only differences allowed are CAD's own, named in SKIP with their reason.
//   kit-behaviour  What the kit's components would have lost and CAD keeps: Done that
//                  cannot close yet is focusable and says why; the Switch is the kit's
//                  checkbox and Space turns it; a refused expression stays with its reason.
// SPDX-License-Identifier: GPL-3.0-or-later
import { expect, test, type Frame, type FrameLocator, type Page } from '@playwright/test';
import { addSketch, addSolid, newPartFromTree, newProject, openProject, partOpened, watchPage, workspaceFrame } from './helpers';

test.use({ viewport: { width: 1280, height: 800 } });

async function freshPart(page: Page, request: Parameters<typeof newProject>[0]) {
  const seen = await watchPage(page);
  const projectId = await newProject(request);
  await openProject(page, projectId);
  await newPartFromTree(page, 'Part 1');
  const frame = await partOpened(page);
  await expect(frame.locator('[data-cad-app]')).toHaveAttribute('data-doc', 'ready');
  await expect(frame.locator('[data-cad-app]')).toHaveAttribute('data-viewport', 'ready');
  return { seen, frame };
}

const tb = (frame: FrameLocator) => frame.locator('[data-cad-toolbar]');
const panel = (frame: FrameLocator) => frame.locator('[data-cad-panel]');

// The kit gate's property set (e2e/h14-kit.spec.js PAIR_PROPS, BEFORE_PROPS).
const SIDES = ['top', 'right', 'bottom', 'left'];
const CORNERS = ['top-left', 'top-right', 'bottom-right', 'bottom-left'];
const PROPS = [
  'display',
  'box-sizing',
  ...SIDES.map((s) => `margin-${s}`),
  ...SIDES.map((s) => `padding-${s}`),
  ...SIDES.flatMap((s) => [`border-${s}-width`, `border-${s}-style`, `border-${s}-color`]),
  ...CORNERS.map((c) => `border-${c}-radius`),
  'background-color',
  'background-image',
  'box-shadow',
  'opacity',
  'color',
  'font-family',
  'font-size',
  'font-weight',
  'font-style',
  'line-height',
  'letter-spacing',
  'text-align',
  'text-decoration-line',
  'text-transform',
  'white-space',
  'gap',
  'align-items',
  'justify-content',
  'flex-direction',
  'list-style-type',
];
const BEFORE_PROPS = ['width', 'height', 'left', 'top', 'background-color', 'border-radius', 'transform'];

/**
 * CAD's own differences, each with its reason. Nothing else may differ.
 *  - panel card: the 3 px accent bar on the left of a feature panel (CAD's, with no kit
 *    counterpart); the card in the flyout also scrolls (overflow, not compared).
 *  - the number field's unit: CAD aligns units left in an 18 px column so the fields of a
 *    panel line up ("mm" under "mm"); the kit's sits after its field.
 */
const SKIP: Record<string, string[]> = {
  'PanelChrome/card': ['border-left-width', 'border-left-color', 'border-left-style'],
  'NumberUnitInput/unit': ['text-align'],
};

interface Want {
  name: string;
  /** Selector under the open CAD panel (or `scope`). */
  cad: string;
  /** Selector under the kit's specimens. */
  kit: string;
  /** Pick the element with this text. */
  text?: string;
  before?: boolean;
  /** CAD side is searched under this selector instead of the open panel. */
  scope?: string;
}

/**
 * Renders the kit's own components in the frame (outside the CAD app, so no CAD rule
 * reaches them), from the import map's @magnusim/plugin-ui: the module the host serves.
 */
const RENDER_SPECIMENS = `(async () => {
  const kit = await import('@magnusim/plugin-ui');
  const React = await import('react');
  const { createRoot } = await import('react-dom/client');
  const h = React.createElement;
  const none = () => {};
  document.getElementById('kit-specimens')?.remove();
  const host = document.createElement('div');
  host.id = 'kit-specimens';
  host.setAttribute('aria-hidden', 'true');
  host.style.cssText = 'position:absolute;left:-4000px;top:0;width:320px';
  document.body.appendChild(host);
  const s = (name, ...children) => h('div', { 'data-s': name }, ...children);
  // A flex item's display is blockified (inline-block -> block): the CAD controls below sit
  // in flex rows (the panel foot, the switch row, the number field's column), so these do too.
  const flex = (...children) => h('div', { style: { display: 'flex', alignItems: 'center' } }, ...children);
  createRoot(host).render(
    h(kit.PanelChrome, { title: 'Combine 1', card: true, onDone: none, onDelete: none },
      s('field-select', h(kit.Field, { label: 'Operation', htmlFor: 'ks-op' },
        h(kit.Select, { id: 'ks-op', label: 'Operation', value: 'join', options: [{ value: 'join', label: 'Join' }, { value: 'cut', label: 'Cut' }], onChange: none }))),
      s('toggle', flex(h(kit.Toggle, { label: 'Keep the tool bodies', checked: false, onChange: none }))),
      s('hint', h(kit.Hint, { as: 'div' }, 'Works on imported and modelled bodies alike.')),
      s('reason', h(kit.DisabledReason, { reason: 'Pick at least one target', role: 'status' })),
      s('nui', h(kit.Field, { label: 'Distance', htmlFor: 'ks-d' },
        h('span', { style: { display: 'inline-flex', flexDirection: 'column' } },
          h(kit.NumberUnitInput, { id: 'ks-d', label: 'Distance', valueSi: 0.02, quantity: 'length', units: 'metric', onCommitSi: none })))),
      s('empty', h(kit.EmptyState, null, 'No parameters yet')),
      s('buttons', flex(
        h(kit.Button, { variant: 'primary' }, 'Export'),
        h(kit.Button, { variant: 'neutral', className: 'mgk-panel-done', disabled: true }, 'Done')),
        // "+ Add parameter" sits in a table cell, not a flex row.
        h(kit.Button, { variant: 'secondary' }, '+ Add parameter')),
    ),
  );
  for (let i = 0; i < 100 && !host.querySelector('[data-s="buttons"] button'); i++) await new Promise((r) => setTimeout(r, 20));
  return kit.PLUGIN_UI_API_VERSION;
})()`;

type Styles = Record<string, string> | null;

async function readPairs(frame: Frame, wants: Want[]): Promise<{ name: string; cad: Styles; kit: Styles }[]> {
  return frame.evaluate(
    ({ wants, props, beforeProps }) => {
      const pick = (root: Element | null, sel: string, text?: string) => {
        if (!root) return null;
        if (sel === ':scope') return root;
        const all = Array.from(root.querySelectorAll(sel));
        return (text ? all.find((e) => e.textContent?.trim() === text) : all[0]) ?? null;
      };
      const read = (el: Element | null, before?: boolean) => {
        if (!el) return null;
        const cs = getComputedStyle(el);
        const o: Record<string, string> = {};
        for (const p of props) o[p] = cs.getPropertyValue(p);
        if (before) {
          const b = getComputedStyle(el, '::before');
          for (const p of beforeProps) o[`::before ${p}`] = b.getPropertyValue(p);
        }
        return o;
      };
      const kitRoot = document.getElementById('kit-specimens');
      return wants.map((w) => ({
        name: w.name,
        cad: read(pick(document.querySelector(w.scope ?? '[data-cad-panel]'), w.cad, w.text), w.before),
        kit: read(pick(kitRoot, w.kit, w.text), w.before),
      }));
    },
    { wants, props: PROPS, beforeProps: BEFORE_PROPS },
  );
}

function diffsOf(rows: { name: string; cad: Styles; kit: Styles }[]): string[] {
  const out: string[] = [];
  for (const r of rows) {
    if (!r.cad || !r.kit) {
      out.push(`${r.name}: no ${r.cad ? 'kit' : 'CAD'} element`);
      continue;
    }
    for (const k of Object.keys(r.kit)) {
      if ((SKIP[r.name] ?? []).includes(k)) continue;
      if (r.cad[k] !== r.kit[k]) out.push(`${r.name} ${k}: CAD ${r.cad[k]} | kit ${r.kit[k]}`);
    }
  }
  return out;
}

const COMBINE: Want[] = [
  { name: 'PanelChrome/card', cad: ':scope', kit: '.mgk-panel', scope: '[data-cad-panel]' },
  { name: 'PanelChrome/head', cad: '.mgk-panel-head', kit: '.mgk-panel-head' },
  { name: 'PanelChrome/title', cad: '.mgk-panel-title', kit: '.mgk-panel-title' },
  { name: 'PanelChrome/body', cad: '.mgk-panel-body', kit: '.mgk-panel-body' },
  { name: 'PanelChrome/foot', cad: '.mgk-panel-foot', kit: '.mgk-panel-foot' },
  { name: 'PanelChrome/foot-left', cad: '.mgk-panel-foot-left', kit: '.mgk-panel-foot-left' },
  { name: 'PanelChrome/delete', cad: '[data-panel-delete]', kit: '.mgk-panel-foot-left button' },
  { name: 'Button/neutral-disabled (Done)', cad: '[data-panel-done]', kit: '[data-s="buttons"] .mgk-panel-done' },
  { name: 'Field/root', cad: '[data-field-row="op"] .mgk-field', kit: '[data-s="field-select"] .mgk-field' },
  { name: 'Field/k', cad: '[data-field-row="op"] .mgk-field-k', kit: '[data-s="field-select"] .mgk-field-k' },
  { name: 'Field/label', cad: '[data-field-row="op"] .mgk-field-k label', kit: '[data-s="field-select"] .mgk-field-k label' },
  { name: 'Field/v', cad: '[data-field-row="op"] .mgk-field-v', kit: '[data-s="field-select"] .mgk-field-v' },
  { name: 'Select', cad: '[data-field="op"] select', kit: '[data-s="field-select"] select' },
  { name: 'Toggle/root', cad: '[data-switch="keep-tools"] .mgk-switch', kit: '[data-s="toggle"] .mgk-switch' },
  { name: 'Toggle/input', cad: '[data-switch="keep-tools"] input', kit: '[data-s="toggle"] input' },
  { name: 'Toggle/track', cad: '[data-switch="keep-tools"] .mgk-switch-track', kit: '[data-s="toggle"] .mgk-switch-track', before: true },
  { name: 'Hint', cad: '.mgk-hint', kit: '[data-s="hint"] .mgk-hint', text: 'Works on imported and modelled bodies alike.' },
  { name: 'DisabledReason/root', cad: '[data-run-reason] .mgk-reason', kit: '[data-s="reason"] .mgk-reason' },
  { name: 'DisabledReason/msg', cad: '[data-run-reason] .mgk-reason-msg', kit: '[data-s="reason"] .mgk-reason-msg' },
];

test('cad:sd-kit-parity every adopted kit control in a CAD panel draws as the kit component does', async ({ page, request }) => {
  test.setTimeout(300_000);
  const { seen, frame } = await freshPart(page, request);
  const f = workspaceFrame(page);
  const version = await f.evaluate(RENDER_SPECIMENS);
  expect(version, 'the frame loaded the host kit').toMatch(/^1\.\d+\.\d+$/);

  // Combine (new, nothing picked): panel chrome, Delete, Done disabled with its reason,
  // a Field with a Select, the Switch, a Hint and the reason in the foot.
  await addSolid(page, { at: [0, 0, 0] });
  await addSolid(page, { at: [40, 0, 0] });
  await page.keyboard.press('Escape');
  await tb(frame).locator('[data-command="modify.combine"]').click();
  await expect(panel(frame).locator('[data-panel-title]')).toHaveText('Combine 1');
  await expect(panel(frame).locator('[data-run-reason] .mgk-reason-msg')).toHaveText('Pick at least one target');
  await expect(panel(frame).locator('[data-panel-done]')).toHaveAttribute('aria-disabled', 'true');
  const combine = diffsOf(await readPairs(f, COMBINE));
  await panel(frame).locator('[data-panel-delete]').click();
  await expect(panel(frame)).toHaveCount(0);

  // Extrude (a sketch's profile): NumberUnitInput.
  await addSketch(page, { at: [0, 40] });
  await tb(frame).locator('[data-command="solid.extrude"]').click();
  await expect(panel(frame).locator('[data-panel-title]')).toHaveText('Extrude 3');
  const extrude = diffsOf(
    await readPairs(f, [
      { name: 'NumberUnitInput/row', cad: '.nui[data-field="distance"] .mgk-value-row', kit: '[data-s="nui"] .mgk-value-row' },
      { name: 'NumberUnitInput/input', cad: '.nui[data-field="distance"] input', kit: '[data-s="nui"] input' },
      { name: 'NumberUnitInput/unit', cad: '.nui[data-field="distance"] .mgk-unit', kit: '[data-s="nui"] .mgk-unit' },
    ]),
  );
  await expect(panel(frame).locator('.nui[data-field="distance"] .mgk-unit')).toHaveText('mm');
  await panel(frame).locator('[data-panel-done]').click();
  await expect(panel(frame)).toHaveCount(0);

  // Parameters (none yet): EmptyState and a secondary button.
  await tb(frame).locator('[data-command="modify.parameters"]').click();
  await expect(panel(frame).locator('[data-params-empty]')).toHaveText('No parameters yet');
  const params = diffsOf(
    await readPairs(f, [
      { name: 'EmptyState', cad: '[data-params-empty] .mgk-empty', kit: '[data-s="empty"] .mgk-empty' },
      { name: 'Button/secondary', cad: '[data-param-add-btn]', kit: '[data-s="buttons"] .mgk-btn--secondary' },
    ]),
  );
  await panel(frame).locator('[data-panel-done]').click();
  await expect(panel(frame)).toHaveCount(0);

  // Export STEP: the primary button.
  await tb(frame).locator('[data-command="file.export-step"]').click();
  await expect(panel(frame).locator('[data-export-run]')).toBeVisible();
  await expect(panel(frame).locator('[data-export-run]')).not.toHaveAttribute('aria-disabled', 'true');
  const exp = diffsOf(await readPairs(f, [{ name: 'Button/primary', cad: '[data-export-run]', kit: '[data-s="buttons"] .mgk-btn--primary' }]));

  expect([...combine, ...extrude, ...params, ...exp], 'CAD vs kit').toEqual([]);
  // The kit's stylesheet came from the host, and CAD ships no copy of its rules.
  const sheets = await f.evaluate(() => Array.from(document.styleSheets).map((s) => (s.href ? new URL(s.href).pathname : 'inline')));
  expect(sheets).toContain('/plugin-sdk/plugin-ui.css');
  const cadOwn = await f.evaluate(() =>
    Array.from(document.styleSheets)
      .filter((s) => s.href && !s.href.includes('/plugin-sdk/'))
      .flatMap((s) => Array.from(s.cssRules).map((r) => r.cssText))
      .filter((t) => /\.(fp-btn|js-btn|tree-panel-done|mat-clear-link|bc-select|bc-input|bc-value-row|bc-unit-label|mat-assign-hint|sim-run-hint-msg|sim-fix-go|mat-panel|mat-row|mat-k|mat-v|switch|slider)\b/.test(t)),
  );
  expect(cadOwn, 'CAD stylesheet rules that copy a kit recipe').toEqual([]);
  expect(seen.csp, 'CSP violations').toEqual([]);
  expect(seen.errors, 'console errors').toEqual([]);
});

test('cad:sd-kit-behaviour Done says why it cannot close, the Switch takes Space, a refused value keeps its reason', async ({ page, request }) => {
  const { seen, frame } = await freshPart(page, request);
  await addSolid(page, { at: [0, 0, 0] });
  await addSolid(page, { at: [40, 0, 0] });
  await page.keyboard.press('Escape');
  await tb(frame).locator('[data-command="modify.combine"]').click();
  const p = panel(frame);
  await expect(p.locator('[data-panel-title]')).toHaveText('Combine 1');

  // Done cannot close a Combine with nothing picked: focusable (the kit's would be
  // natively disabled, out of the Tab order), aria-disabled, and its tooltip says why.
  const done = p.locator('[data-panel-done]');
  await expect(done).toHaveAttribute('aria-disabled', 'true');
  await expect(done).not.toHaveAttribute('disabled', /.*/);
  await done.focus();
  await expect(done).toBeFocused();
  await done.hover();
  await expect(frame.locator('.cad-tip')).toContainText('Pick at least one target');
  // A click does nothing (Playwright would wait for an enabled button: force it).
  await done.click({ force: true });
  await expect(p).toHaveCount(1);

  // The Switch is the kit's Toggle: a real checkbox in the kit's markup; Space turns it,
  // and the change applies live (the stored feature says so).
  const keep = p.locator('[data-switch="keep-tools"] input.mgk-switch-input');
  await expect(keep).not.toBeChecked();
  await keep.focus();
  await page.keyboard.press('Space');
  await expect(keep).toBeChecked();
  // Its words are its label: a click on them turns it back.
  await p.locator('[data-switch="keep-tools"] .cad-switch-label').click();
  await expect(keep).not.toBeChecked();

  // The Select is the kit's: choosing Cut applies at once (the op hint follows).
  const opHint = await p.locator('[data-combine-op-hint]').textContent();
  await p.locator('[data-field="op"] select.mgk-select').selectOption('cut');
  await expect(p.locator('[data-field="op"] select')).toHaveValue('cut');
  await expect(p.locator('[data-combine-op-hint]')).toHaveText('Remove the tools from each target');
  expect(opHint).not.toBe('Remove the tools from each target');
  await p.locator('[data-panel-delete]').click();
  await expect(p).toHaveCount(0);

  // A number field keeps CAD's expressions on the kit's look: a refused value stays
  // typed with its reason under it, Escape puts the applied one back, Enter applies.
  await addSketch(page, { at: [0, 40] });
  await tb(frame).locator('[data-command="solid.extrude"]').click();
  const input = p.locator('.nui[data-field="distance"] input.mgk-input');
  await input.fill('nope * 2');
  await page.keyboard.press('Enter');
  await expect(p.locator('.nui[data-field="distance"] [data-nui-error]')).toBeVisible();
  await expect(input).toHaveValue('nope * 2');
  await page.keyboard.press('Escape');
  await expect(p.locator('.nui[data-field="distance"] [data-nui-error]')).toHaveCount(0);
  await expect(p).toHaveCount(1);
  await input.fill('12 + 3');
  await page.keyboard.press('Enter');
  await expect(p.locator('.nui[data-field="distance"] .nui-eq')).toHaveText('= 15 mm');
  await p.locator('[data-panel-done]').click();
  await expect(p).toHaveCount(0);
  expect(seen.csp, 'CSP violations').toEqual([]);
  expect(seen.errors, 'console errors').toEqual([]);
});
