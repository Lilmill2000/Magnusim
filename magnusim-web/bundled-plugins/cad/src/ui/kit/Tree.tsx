// Tree / TreeRow (core LeftTree.tsx:18-80, style.css:665-805): li.tree-node
// [.expanded][.selected] > div.tree-row > [span.tw][icon][span.tl][sub][actions],
// nested ul indented 18 px; twisty glyphs "+" / "-"; 12 px text, 24 px rows,
// selected #d7e8ff, hover #f2f4f7; section headers .geo-head (11px/600).
// Owner: UI-SHELL.
// SPDX-License-Identifier: GPL-3.0-or-later
import type { MouseEvent, ReactNode } from 'react';
import { Icon } from '../Icon';

/** A label cut short by its ellipsis gets the full name as its tooltip; one that fits has none. */
function fullNameTip(el: HTMLElement, name: string | null) {
  const text = name ?? el.textContent ?? '';
  if (el.scrollWidth > el.clientWidth + 1 && text) el.title = text;
  else el.removeAttribute('title');
}

export function TreeSection({ title, section, action, children }: { title: ReactNode; section: string; action?: ReactNode; children: ReactNode }) {
  return (
    <div className="tree-section" data-tree-section={section}>
      <div className="geo-head">
        <span>{title}</span>
        {action}
      </div>
      <ul className="tree-root" role="tree" aria-label={typeof title === 'string' ? title : section}>
        {children}
      </ul>
    </div>
  );
}

export interface TreeNodeProps {
  /** data-tree-node (stable key: "origin", "origin:top", "bodies", a feature id). */
  nodeKey: string;
  label: ReactNode;
  icon?: string;
  /** A folder: the twisty and the row click toggle it. */
  folder?: { expanded: boolean; onToggle(): void } | null;
  /** A leaf beside folders: keep the twisty column so icons line up. */
  indent?: boolean;
  selected?: boolean;
  className?: string;
  attrs?: Record<string, string | undefined>;
  /** Right-aligned 11px muted text (.tree-sub). */
  sub?: ReactNode;
  /** Status badge after the label (error dot, warning triangle). */
  badge?: ReactNode;
  /** Inline buttons at the right end of the row. */
  actions?: ReactNode;
  onClick?(e: MouseEvent<HTMLDivElement>): void;
  onDoubleClick?(e: MouseEvent<HTMLDivElement>): void;
  onContextMenu?(e: MouseEvent<HTMLDivElement>): void;
  onMouseEnter?(): void;
  onMouseLeave?(): void;
  /** Row tooltip (title attribute is not used: the kit tooltip is). */
  rowProps?: Record<string, unknown>;
  /** The full name, shown as the label's tooltip when the row cuts it short (default: a string label). */
  labelTitle?: string;
  children?: ReactNode;
}

export function TreeNode({
  nodeKey,
  label,
  icon,
  folder,
  indent = false,
  selected = false,
  className,
  attrs,
  sub,
  badge,
  actions,
  onClick,
  onDoubleClick,
  onContextMenu,
  onMouseEnter,
  onMouseLeave,
  rowProps,
  labelTitle,
  children,
}: TreeNodeProps) {
  const expanded = folder ? folder.expanded : false;
  const cls = ['tree-node', expanded ? 'expanded' : '', selected ? 'selected' : '', className || ''].filter(Boolean).join(' ');
  const dataAttrs: Record<string, string> = {};
  for (const [k, v] of Object.entries(attrs ?? {})) if (v != null && v !== '') dataAttrs[k] = v;
  return (
    <li className={cls} data-tree-node={nodeKey} role="treeitem" aria-selected={selected} aria-expanded={folder ? expanded : undefined} {...dataAttrs}>
      <div
        className="tree-row"
        {...rowProps}
        onClick={(e) => {
          if (folder) folder.onToggle();
          onClick?.(e);
        }}
        onDoubleClick={onDoubleClick}
        onContextMenu={onContextMenu}
        onMouseEnter={onMouseEnter}
        onMouseLeave={onMouseLeave}
      >
        {folder ? (
          <span className="tw" aria-label={expanded ? 'Collapse' : 'Expand'}>
            {expanded ? '-' : '+'}
          </span>
        ) : indent ? (
          <span className="tw" aria-hidden="true" />
        ) : null}
        {icon ? <Icon d={icon} className="tree-ico" /> : null}
        <span className="tl" onMouseEnter={(e) => fullNameTip(e.currentTarget, labelTitle ?? (typeof label === 'string' ? label : null))}>
          {label}
        </span>
        {badge}
        {sub != null ? <span className="tree-sub">{sub}</span> : null}
        {actions ? <span className="tree-acts">{actions}</span> : null}
      </div>
      {folder ? <ul role="group">{children}</ul> : null}
    </li>
  );
}
