import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PluginStudyKind, PluginStudyRow, ProjectTreeDoc } from '../chrome/treeModel';
import type { StartAction } from './startActions';

// gate:l1-menus: the header's start buttons, the empty project's buttons and the
// Workspaces menu read the same tree rows; STUDIES follows the same answer.

const tree = vi.hoisted(() => ({ reader: null as null | ((a: { seq: number; doc: unknown }) => void) }));
vi.mock('../chrome/treeFeed', () => ({
  followProjectTree: (_pid: string, reader: (a: { seq: number; doc: unknown }) => void) => {
    tree.reader = reader;
    return () => undefined;
  },
}));
vi.mock('../store/project', () => ({
  useProjectStore: (pick: (s: { projectId: string }) => unknown) => pick({ projectId: 'proj' }),
}));
const actions = vi.hoisted(() => ({ calls: [] as unknown[][] }));
vi.mock('../chrome/treeSession', () => ({
  onTreeAction: (...args: unknown[]) => actions.calls.push(args),
}));

import { studiesSectionShown } from '../chrome/LeftTree';
import { WorkspacesMenu } from './WorkspacesMenu';

const ALL = ['empty_project', 'header', 'new_project', 'home'];

function act1(kind: string, title: string, places: string[], extra: Partial<StartAction> = {}): StartAction {
  return { study_kind: kind, kind_title: title, workspace: kind, workspace_title: `${title} bench`, label: `Start ${title}`, home_label: '', header_label: '', hint: '', icon: '', places, ...extra };
}

function kind(plugin: string, key: string, title: string, start: StartAction | null, workspace = key): PluginStudyKind {
  return { plugin, plugin_name: `${plugin} name`, key, title, icon: '', workspace, links_geometry: false, start_action: start };
}

function study(plugin: string, kindKey: string, id: string, title: string, extra: Partial<PluginStudyRow> = {}): PluginStudyRow {
  return {
    id, plugin, plugin_name: plugin, kind: kindKey, kind_title: kindKey, icon: '', workspace: kindKey, title, rev: 1,
    available: true, read_only: false, reason: '', scope_key: `p:proj/plugin:${plugin}/study:${id}`, ...extra,
  };
}

// start-demo (Demo with a header label, Note without an action) and start-demo-2
// (three header actions): four header actions over two plugins, one past the cap.
const KINDS = [
  kind('start-demo', 'demo', 'Demo', act1('demo', 'Demo', ALL, { header_label: 'Demo', hint: 'Make a demo here' })),
  kind('start-demo', 'note', 'Note', null),
  kind('start-demo-2', 'alpha', 'Alpha', act1('alpha', 'Alpha', ['header', 'empty_project', 'new_project', 'home'])),
  kind('start-demo-2', 'beta', 'Beta', act1('beta', 'Beta', ['header', 'new_project'])),
  kind('start-demo-2', 'gamma', 'Gamma', act1('gamma', 'Gamma', ['header', 'empty_project', 'home'])),
  kind('other', 'raw', 'Raw', null, ''),
];

function hosts() {
  for (const id of ['ws-start-host', 'ws-menu-host', 'wb-empty-start']) {
    const el = document.createElement('div');
    el.id = id;
    document.body.appendChild(el);
  }
}

function paint(doc: ProjectTreeDoc) {
  act(() => tree.reader?.({ seq: 1, doc }));
}

beforeEach(() => {
  actions.calls = [];
  hosts();
});

afterEach(() => {
  vi.unstubAllGlobals();
  document.body.replaceChildren();
  location.hash = '';
});

describe('start actions in a project', () => {
  it('draws the header buttons in load order, capped, and leaves the rest in the Workspaces menu', () => {
    render(<WorkspacesMenu />);
    paint({ plugin_study_kinds: KINDS, plugin_studies: [] });
    const header = document.getElementById('ws-start-host') as HTMLElement;
    const buttons = within(header).getAllByRole('button');
    expect(buttons.map((b) => b.textContent)).toEqual(['Demo', 'Alpha bench', 'Beta bench']);
    expect(buttons[0]).toHaveAttribute('title', 'Demo: open one or start a new one (start-demo name)');
    // The Workspaces menu: kinds with a workspace that are not header buttons (Gamma was cut).
    fireEvent.click(screen.getByRole('button', { name: 'Workspaces' }));
    const items = within(document.getElementById('ws-menu-host') as HTMLElement).getAllByRole('menuitem');
    expect(items.map((b) => b.getAttribute('data-ws-new'))).toEqual(['start-demo:note', 'start-demo-2:gamma']);
    // The empty project: Demo, Alpha, Gamma (each with its hint when it has one).
    const empty = document.getElementById('wb-empty-start') as HTMLElement;
    expect(within(empty).getAllByRole('button').map((b) => b.getAttribute('data-start-empty'))).toEqual([
      'start-demo:demo',
      'start-demo-2:alpha',
      'start-demo-2:gamma',
    ]);
    expect(empty).toHaveTextContent('Make a demo here');
    // STUDIES: Note (no action) and Gamma (cut) are made only from the menu or STUDIES.
    expect(studiesSectionShown('proj', [], KINDS)).toBe(true);
  });

  it('the Workspaces menu goes when every kind is a header button, and so does STUDIES until a study exists', () => {
    const only = KINDS.filter((k) => k.plugin === 'start-demo-2');
    render(<WorkspacesMenu />);
    paint({ plugin_study_kinds: only, plugin_studies: [] });
    expect(screen.queryByRole('button', { name: 'Workspaces' })).toBeNull();
    expect(within(document.getElementById('ws-start-host') as HTMLElement).getAllByRole('button')).toHaveLength(3);
    expect(studiesSectionShown('proj', [], only)).toBe(false);
    expect(studiesSectionShown('proj', [study('start-demo-2', 'alpha', 'st-1', 'Alpha 1')], only)).toBe(true);
    expect(studiesSectionShown('', [], KINDS)).toBe(false);
  });

  it("lists the kind's studies (read only marked), then New <kind>, which makes 'Demo 2' with no prompt and opens it", async () => {
    const posted: Array<Record<string, unknown>> = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
        posted.push(JSON.parse(String(init?.body)));
        return new Response(JSON.stringify({ ok: true, study: { id: 'st-9', workspace: 'demo' } }), { status: 200 });
      }),
    );
    render(<WorkspacesMenu />);
    paint({
      plugin_study_kinds: KINDS,
      // "Demo 1" is another plugin's study: names are free across every plugin.
      plugin_studies: [
        study('start-demo-2', 'alpha', 'st-a', 'Demo 1'),
        study('start-demo', 'demo', 'st-1', 'Wing', { read_only: true }),
      ],
    });
    const demo = document.querySelector('[data-start-header="start-demo:demo"] button') as HTMLButtonElement;
    demo.focus();
    fireEvent.keyDown(demo, { key: 'ArrowDown' });
    const menu = screen.getByRole('menu');
    expect(within(menu).getAllByRole('menuitem').map((b) => b.textContent)).toEqual(['WingRead only', 'New Demo']);
    expect(document.activeElement?.textContent).toBe('WingRead only');
    fireEvent.keyDown(menu, { key: 'End' });
    await act(async () => {
      fireEvent.click(document.activeElement as HTMLElement);
    });
    await vi.waitFor(() => expect(location.hash).toBe('#/p/proj/ws/start-demo/demo/st-9'));
    expect(posted).toEqual([{ project_id: 'proj', plugin: 'start-demo', kind: 'demo', title: 'Demo 2' }]);
    // No prompt was asked for (the tree's "+ New" action is not used).
    expect(actions.calls).toEqual([]);
  });

  it('with no study of its kind the menu says so; the empty project buttons wait for an import', () => {
    render(<WorkspacesMenu />);
    paint({ plugin_study_kinds: KINDS, plugin_studies: [] });
    fireEvent.click(document.querySelector('[data-start-header="start-demo-2:beta"] button') as HTMLElement);
    expect(screen.getByRole('menu')).toHaveTextContent('No Beta yet');
    const btn = document.querySelector('[data-start-empty="start-demo:demo"]') as HTMLButtonElement;
    expect(btn.disabled).toBe(false);
    act(() => {
      window.dispatchEvent(new CustomEvent('cfd:geometry-import', { detail: { busy: true } }));
    });
    expect(btn.disabled).toBe(true);
    act(() => {
      window.dispatchEvent(new CustomEvent('cfd:geometry-import', { detail: { busy: false } }));
    });
    expect(btn.disabled).toBe(false);
  });
});
