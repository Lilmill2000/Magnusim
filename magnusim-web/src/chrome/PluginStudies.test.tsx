import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PluginStudiesView } from './LeftTree';
import { setTreeActionHandler } from './treeSession';
import type { PluginStudyKind, PluginStudyRow } from './treeModel';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// H11: plugin studies in the tree, as real tree rows with the core's actions.
const kinds: PluginStudyKind[] = [
  { plugin: 'study-demo', plugin_name: 'Study demo', key: 'demo_analysis', title: 'Demo analysis', icon: 'M4 18h16' },
];

function row(overrides: Partial<PluginStudyRow> = {}): PluginStudyRow {
  return {
    id: 'st-1',
    plugin: 'study-demo',
    plugin_name: 'Study demo',
    kind: 'demo_analysis',
    kind_title: 'Demo analysis',
    icon: 'M4 18h16',
    workspace: '',
    title: 'Wing 1',
    rev: 3,
    available: true,
    read_only: false,
    reason: '',
    scope_key: 'p:proj/plugin:study-demo/study:st-1',
    ...overrides,
  };
}

afterEach(() => {
  cleanup();
  setTreeActionHandler(null);
});

// The declarations of style.css's .plugin-study-settings rule (jsdom does not lay out
// the page; the h13 e2e checks the look the browser computes).
function settingsRule(): Record<string, string> {
  const appCss = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'style.css'), 'utf8');
  const body = /(?:^|\n)\.plugin-study-settings\s*\{([^}]*)\}/.exec(appCss)?.[1] ?? '';
  return Object.fromEntries(
    body
      .split(';')
      .map((d) => d.replace(/\/\*[\s\S]*?\*\//g, '').split(':').map((s) => s.trim()))
      .filter(([k, v]) => k && v),
  );
}

describe('plugin studies in the tree', () => {
  it('draws each study as a tree row with New, Rename and Delete', () => {
    const act = vi.fn();
    setTreeActionHandler(act);
    render(<PluginStudiesView projectId="proj" studies={[row()]} kinds={kinds} />);
    expect(screen.getByText('STUDIES (1)')).toBeInTheDocument();
    const li = document.querySelector('[data-plugin-study="st-1"]') as HTMLElement;
    expect(li).toHaveClass('tree-node', 'plugin-study');
    expect(li.getAttribute('data-scope-key')).toBe('p:proj/plugin:study-demo/study:st-1');
    expect(within(li).getByText('Wing 1')).toHaveClass('tl');

    fireEvent.click(screen.getByRole('button', { name: '+ New Demo analysis' }));
    expect(act).toHaveBeenLastCalledWith('p:proj/plugin:study-demo', 'plugin-study-new', {
      kind: 'demo_analysis',
      title: 'Demo analysis',
      titles: ['Wing 1'],
    });
    fireEvent.click(within(li).getByRole('button', { name: 'Rename Wing 1' }));
    expect(act).toHaveBeenLastCalledWith(li.getAttribute('data-scope-key'), 'plugin-study-rename', { title: 'Wing 1', rev: 3 });
    fireEvent.click(within(li).getByRole('button', { name: 'Delete Wing 1' }));
    expect(act).toHaveBeenLastCalledWith(li.getAttribute('data-scope-key'), 'plugin-study-delete', {
      title: 'Wing 1',
      available: true,
      plugin_name: 'Study demo',
    });
  });

  it("New sends the titles of that plugin's studies, for the name prompt", () => {
    const act = vi.fn();
    setTreeActionHandler(act);
    const studies = [
      row(),
      row({ id: 'st-2', title: 'Demo analysis 1', scope_key: 'p:proj/plugin:study-demo/study:st-2' }),
      row({ id: 'st-3', plugin: 'other', title: 'Other 1', scope_key: 'p:proj/plugin:other/study:st-3' }),
    ];
    render(<PluginStudiesView projectId="proj" studies={studies} kinds={kinds} />);
    fireEvent.click(screen.getByRole('button', { name: '+ New Demo analysis' }));
    expect(act).toHaveBeenLastCalledWith('p:proj/plugin:study-demo', 'plugin-study-new', {
      kind: 'demo_analysis',
      title: 'Demo analysis',
      titles: ['Wing 1', 'Demo analysis 1'],
    });
  });

  it('greys a study whose plugin is off: the reason and a Settings link, delete only', () => {
    const act = vi.fn();
    setTreeActionHandler(act);
    render(
      <PluginStudiesView
        projectId="proj"
        studies={[row({ available: false, reason: 'Requires the Study demo plugin' })]}
        kinds={[]}
      />,
    );
    const li = document.querySelector('[data-plugin-study="st-1"]') as HTMLElement;
    expect(li).toHaveClass('is-unavailable');
    expect(li).toHaveAttribute('data-unavailable', '1');
    expect(within(li).getByText(/Requires the Study demo plugin/)).toBeInTheDocument();
    expect(within(li).queryByRole('button', { name: /Rename/ })).toBeNull();
    const settings = within(li).getByRole('button', { name: 'Open Settings → Plugins' });
    // Styled as the tree's inline link (style.css), not the browser's default button.
    expect(settings).toHaveClass('plugin-study-settings');
    expect(settingsRule()).toMatchObject({
      padding: '0',
      border: '0',
      background: 'none',
      font: 'inherit',
      color: 'var(--mg-link)',
    });
    fireEvent.click(settings);
    expect(act).toHaveBeenLastCalledWith(li.getAttribute('data-scope-key'), 'open-plugin-settings', undefined);
    expect(within(li).getByRole('button', { name: 'Delete Wing 1' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /\+ New/ })).toBeNull();
  });

  it('marks a study saved by a newer plugin version read-only (no rename)', () => {
    render(<PluginStudiesView projectId="proj" studies={[row({ read_only: true })]} kinds={kinds} />);
    expect(screen.getByText('read-only')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Rename Wing 1' })).toBeNull();
  });

  it('says so when the project has no study yet', () => {
    render(<PluginStudiesView projectId="proj" studies={[]} kinds={kinds} />);
    expect(screen.getByText('No study yet')).toBeInTheDocument();
  });
});
