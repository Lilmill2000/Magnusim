// Context menu (core .face-ctx-menu, style.css:994-1031): min-width 148,
// padding 4, radius 6; items 600 12px, hover #eef2f6, disabled #98a2b3,
// separators 1px #e4e7ec. Keyboard: arrows move, Enter runs, Escape closes.
// A disabled item says why in its tooltip.
// Owner: UI-SHELL.
// SPDX-License-Identifier: GPL-3.0-or-later
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useTip } from './Tooltip';

export interface MenuItem {
  id: string;
  label: string;
  /** null/undefined = enabled; a string = why not. */
  disabled?: string | null;
  danger?: boolean;
  run(): void;
}
export type MenuEntry = MenuItem | { sep: true; id: string };

export function isSep(e: MenuEntry): e is { sep: true; id: string } {
  return (e as { sep?: boolean }).sep === true;
}

function Item({ item, onRun }: { item: MenuItem; onRun(item: MenuItem): void }) {
  // Beside the item, so the reason does not cover the items under it.
  const tip = useTip(item.disabled ? { text: item.label, detail: item.disabled, side: true } : null);
  return (
    <button
      type="button"
      role="menuitem"
      className={item.danger ? 'is-danger' : undefined}
      aria-disabled={item.disabled ? true : undefined}
      data-menu-item={item.id}
      {...tip}
      onClick={() => {
        if (!item.disabled) onRun(item);
      }}
    >
      {item.label}
    </button>
  );
}

export function ContextMenu({ x, y, items, onClose, label = 'Actions' }: { x: number; y: number; items: MenuEntry[]; onClose(): void; label?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ left: x, top: y });

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const vw = window.innerWidth || document.documentElement.clientWidth;
    const vh = window.innerHeight || document.documentElement.clientHeight;
    const w = el.offsetWidth;
    const h = el.offsetHeight;
    setPos({ left: Math.max(4, Math.min(x, vw - w - 4)), top: Math.max(4, Math.min(y, vh - h - 4)) });
    const first = el.querySelector<HTMLButtonElement>('button[role="menuitem"]:not([aria-disabled])');
    first?.focus({ preventScroll: true });
  }, [x, y, items]);

  useEffect(() => {
    const onDown = (e: PointerEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    const onBlur = () => onClose();
    // Capture: a pointerdown anywhere else (tree, viewport canvas) closes first.
    document.addEventListener('pointerdown', onDown, true);
    window.addEventListener('blur', onBlur);
    window.addEventListener('resize', onBlur);
    return () => {
      document.removeEventListener('pointerdown', onDown, true);
      window.removeEventListener('blur', onBlur);
      window.removeEventListener('resize', onBlur);
    };
  }, [onClose]);

  const run = (item: MenuItem) => {
    onClose();
    item.run();
  };

  return (
    <div
      ref={ref}
      className="face-ctx-menu cad-ctx-menu"
      role="menu"
      aria-label={label}
      data-cad-menu="1"
      style={{ left: pos.left, top: pos.top }}
      onContextMenu={(e) => e.preventDefault()}
      onKeyDown={(e) => {
        const buttons = [...(ref.current?.querySelectorAll<HTMLButtonElement>('button[role="menuitem"]') ?? [])];
        const i = buttons.indexOf(document.activeElement as HTMLButtonElement);
        if (e.key === 'Escape') {
          e.preventDefault();
          e.stopPropagation();
          onClose();
        } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
          e.preventDefault();
          if (!buttons.length) return;
          const step = e.key === 'ArrowDown' ? 1 : -1;
          const next = buttons[(i + step + buttons.length) % buttons.length];
          next.focus();
        } else if (e.key === 'Tab') {
          e.preventDefault();
          onClose();
        }
      }}
    >
      {items.map((it, i) =>
        isSep(it) ? <div key={`${i}:${it.id}`} className="face-ctx-sep" role="separator" /> : <Item key={`${i}:${it.id}`} item={it} onRun={run} />,
      )}
    </div>
  );
}
