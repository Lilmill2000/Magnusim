import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { followProjectTree } from '../chrome/treeFeed';
import { onTreeAction } from '../chrome/treeSession';
import type { PluginStudyKind } from '../chrome/treeModel';
import { pluginStudyScope } from '../scope';
import { useProjectStore } from '../store/project';

/**
 * The header's Workspaces menu (next to Queue and Settings): one entry per
 * study kind of an enabled plugin that opens in a workspace. Choosing one
 * names a new study and opens it. Nothing shows when there are none.
 */
export function WorkspacesMenu() {
  const projectId = useProjectStore((s) => s.projectId);
  const host = typeof document !== 'undefined' ? document.getElementById('ws-menu-host') : null;
  const [kinds, setKinds] = useState<PluginStudyKind[]>([]);
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!projectId) {
      setKinds([]);
      return undefined;
    }
    // The tree's reads (chrome/treeFeed.ts): the one out now (or a new one), then every
    // cfd:tree-sync's, shared with the tree. Plugins turned on or off sync the tree too.
    return followProjectTree(projectId, ({ doc }) => {
      if (doc) setKinds((doc.plugin_study_kinds || []).filter((k) => !!k.workspace));
    });
  }, [projectId]);

  useEffect(() => {
    if (!open) return undefined;
    const close = (e: MouseEvent | KeyboardEvent) => {
      if (e instanceof KeyboardEvent ? e.key === 'Escape' : !wrap.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', close);
    return () => {
      document.removeEventListener('mousedown', close);
      document.removeEventListener('keydown', close);
    };
  }, [open]);

  if (!host) return null;
  if (!projectId || !kinds.length) return null;
  return createPortal(
    <div className="ws-menu" ref={wrap} data-ws-menu="1">
      <button
        type="button"
        className="home-btn"
        id="btn-workspaces"
        aria-haspopup="true"
        aria-expanded={open}
        title="Open a new study in a plugin's workspace"
        onClick={() => setOpen((v) => !v)}
      >
        Workspaces
      </button>
      {open ? (
        <ul className="ws-menu-list" role="menu">
          {kinds.map((k) => (
            <li key={`${k.plugin}:${k.key}`} role="none">
              <button
                type="button"
                role="menuitem"
                data-ws-new={`${k.plugin}:${k.key}`}
                onClick={() => {
                  setOpen(false);
                  onTreeAction(pluginStudyScope(projectId, k.plugin), 'plugin-study-new', { kind: k.key, title: k.title, open: true });
                }}
              >
                New {k.title}
                <span className="ws-menu-plugin">{k.plugin_name}</span>
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>,
    host,
  );
}
