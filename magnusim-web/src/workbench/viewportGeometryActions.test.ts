// The viewport's right-click on the part (host API 1.7, viewportGeometryActions.ts): a menu
// opened before the project tree's read landed gets the geometry's actions when it lands.
import { describe, expect, it } from 'vitest';
import { rememberTreeActions, resetGeometryActionsForTests } from '../workspace/geometryActions';
import { fillViewportGeometryActions } from './viewportGeometryActions';

describe("the viewport's menu (1.7)", () => {
  it('opened before the tree read landed (right after a project opens), it gets the actions when the read comes; a closed one does not', () => {
    resetGeometryActionsForTests();
    document.body.innerHTML = '<div id="face-ctx-menu"><button id="face-ctx-hide">Hide face</button></div>';
    const menu = document.getElementById('face-ctx-menu') as HTMLElement;
    const node = {
      id: 'g1',
      edit_actions: [{ plugin: 'cad', plugin_name: 'Magnusim CAD', study_kind: 'part', label: 'Edit in CAD', hint: 'Open it in CAD.', places: ['viewport'], enabled: true, reason: '' }],
    };
    fillViewportGeometryActions(menu, { projectId: 'p1', geometryId: 'g1', geometryName: 'box', hit: { face: 'face 3@Body2', body: 'Body2' }, close: () => undefined });
    expect(menu.querySelector('[data-geom-action]')).toBeNull();
    rememberTreeActions('p1', [node]);
    const item = menu.querySelector('[data-geom-action="part"]') as HTMLButtonElement;
    expect(item.textContent).toContain('Edit in CAD');
    expect(item.disabled).toBe(false);
    expect(menu.firstElementChild?.getAttribute('data-geom-actions')).toBe('g1');
    // Another read: still one set of actions.
    rememberTreeActions('p1', [node]);
    expect(menu.querySelectorAll('[data-geom-action]').length).toBe(1);
    // A closed menu is left alone.
    menu.querySelector('[data-geom-actions]')?.remove();
    menu.hidden = true;
    rememberTreeActions('p1', [node]);
    expect(menu.querySelector('[data-geom-action]')).toBeNull();
    document.body.innerHTML = '';
    resetGeometryActionsForTests();
  });
});
