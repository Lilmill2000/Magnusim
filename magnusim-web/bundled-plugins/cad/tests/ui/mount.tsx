// Mounts the UI shell (install + the components the layout mounts) over test services.
// SPDX-License-Identifier: GPL-3.0-or-later
import { render } from '@testing-library/react';
import { vi } from 'vitest';
import { ServicesProvider } from '../../src/lib/services';
import { installUi } from '../../src/ui/commands';
import { tipTiming } from '../../src/ui/kit';
import { LeftStack, Overlays, StatusDock, Toolbar } from '../../src/ui';
import { bindCommandShortcuts, type TestServices } from './fake-doc';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
tipTiming.hoverDelayMs = 0;

export function mountUi(t: TestServices) {
  // Any React warning (duplicate keys, updates outside act) fails the test at dispose().
  const errors: string[] = [];
  const spy = vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
    errors.push(args.map(String).join(' '));
  });
  const uninstall = installUi(t.services);
  const unbind = bindCommandShortcuts(t.services.commands, t.services.keyboard);
  const view = render(
    <ServicesProvider services={t.services}>
      <div className="cad-app">
        <Toolbar />
        <div className="cad-stage">
          <LeftStack />
          <StatusDock />
          <Overlays />
        </div>
      </div>
    </ServicesProvider>,
  );
  const $ = <E extends Element = HTMLElement>(sel: string) => view.container.querySelector<E>(sel);
  const $$ = <E extends Element = HTMLElement>(sel: string) => [...view.container.querySelectorAll<E>(sel)];
  const row = (featureId: string) => $(`[data-tree-node="${featureId}"] > .tree-row`)!;
  const node = (featureId: string) => $(`[data-tree-node="${featureId}"]`)!;
  /** History labels in DOM order, with "|" for the rollback bar. */
  const history = () =>
    $$('[data-tree-section="history"] .tree-root > li').map((li) => (li.hasAttribute('data-rollback-bar') ? '|' : (li.querySelector('.tl')?.textContent ?? li.textContent)));
  const menu = () => $$('[data-cad-menu] [data-menu-item]').map((b) => (b.getAttribute('aria-disabled') ? `(${b.textContent})` : b.textContent));
  const menuItem = (id: string) => $(`[data-cad-menu] [data-menu-item="${id}"]`)!;
  const tip = () => {
    const el = $('[data-cad-tip]');
    return el ? el.textContent : null;
  };
  return {
    view,
    $,
    $$,
    row,
    node,
    history,
    menu,
    menuItem,
    tip,
    dispose() {
      unbind();
      uninstall();
      t.services.keyboard.dispose();
      spy.mockRestore();
      if (errors.length) throw new Error('console errors: ' + errors.join(' | ').slice(0, 800));
    },
  };
}
