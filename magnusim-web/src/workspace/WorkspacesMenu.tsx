import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { MenuButton } from '../chrome/MenuButton';
import { followProjectTree } from '../chrome/treeFeed';
import { onTreeAction } from '../chrome/treeSession';
import type { PluginStudyKind, ProjectTreeDoc } from '../chrome/treeModel';
import { pluginStudyScope } from '../scope';
import { useProjectStore } from '../store/project';
import { StartActionPlaces } from './StartActionPlaces';
import { headerKinds, kindKey } from './startActions';

/**
 * The header's Workspaces menu (next to Queue and Settings): one entry per
 * study kind of an enabled plugin that opens in a workspace and is not shown
 * as a start action's header button. Choosing one names a new study and opens
 * it. Nothing shows when there are none.
 *
 * It reads the project's tree once for the in-project start action places too
 * (the header buttons and the empty project's buttons), so the menu and those
 * buttons always read the same rows.
 */
export function WorkspacesMenu() {
  const projectId = useProjectStore((s) => s.projectId);
  const host = typeof document !== 'undefined' ? document.getElementById('ws-menu-host') : null;
  const [doc, setDoc] = useState<ProjectTreeDoc | null>(null);

  useEffect(() => {
    setDoc(null);
    if (!projectId) return undefined;
    // The tree's reads (chrome/treeFeed.ts): the one out now (or a new one), then every
    // cfd:tree-sync's, shared with the tree. Plugins turned on or off sync the tree too.
    return followProjectTree(projectId, ({ doc: next }) => {
      if (next) setDoc(next);
    });
  }, [projectId]);

  const kinds: PluginStudyKind[] = projectId && doc ? doc.plugin_study_kinds || [] : [];
  // Kinds shown as a header button (after the cap) open from that button instead.
  const inHeader = headerKinds(kinds);
  const menuKinds = kinds.filter((k) => !!k.workspace && !inHeader.has(kindKey(k)));

  return (
    <>
      <StartActionPlaces projectId={projectId || ''} doc={projectId ? doc : null} />
      {host && projectId && menuKinds.length
        ? createPortal(
            <MenuButton
              id="btn-workspaces"
              label="Workspaces"
              title="Open a new study in a plugin's workspace"
              wrapAttrs={{ 'data-ws-menu': '1' }}
              items={menuKinds.map((k) => ({
                key: kindKey(k),
                attrs: { 'data-ws-new': kindKey(k) },
                onSelect: () =>
                  onTreeAction(pluginStudyScope(projectId, k.plugin), 'plugin-study-new', { kind: k.key, title: k.title, open: true }),
                label: (
                  <>
                    New {k.title}
                    <span className="ws-menu-plugin">{k.plugin_name}</span>
                  </>
                ),
              }))}
            />,
            host,
          )
        : null}
    </>
  );
}
