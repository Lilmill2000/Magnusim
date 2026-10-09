// Context menu (core .face-ctx-menu, style.css:994-1031): min-width 148,
// padding 4, radius 6; items 600 12px, hover #eef2f6, disabled #98a2b3,
// separators 1px #e4e7ec. Keyboard: arrows move, Enter runs, Escape closes.
// A disabled item says why in its tooltip. The highlight follows the pointer:
// hovering an item gives it the keyboard, hovering a disabled one gives it to
// the menu, so one item at most looks active (review P2/P3 round 3: Edit kept
// its focus highlight while the disabled Delete beside its reason was hovered).
// A command's item (the toolbar's More menus, P4a) draws its icon, its label
// and its shortcut, and has the toolbar button's tooltip (label, shortcut,
// hint or the reason it cannot run). A menu opened from a button (`anchor`)
// toggles on that button, and Escape or Tab gives the button the keyboard back.
// Owner: UI-SHELL.
// SPDX-License-Identifier: GPL-3.0-or-later
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Icon } from '../Icon';
import { useTip } from './Tooltip';

export interface MenuItem {
  id: string;
  label: string;
  /** null/undefined = enabled; a string = why not. */
  disabled?: string | null;
  danger?: boolean;
  /** A command's item: its id (data-command, as on its toolbar button). */
  command?: string;
  /** A command's icon (24x24 path), drawn before the label. */
  icon?: string;
  /** A command's shortcut ("E", "Ctrl+Z"), drawn at the item's right and in its tooltip. */
  shortcut?: string;
  /** A command's hint: the tooltip's second line while it can run. */
  hint?: string;
  /** Drawn pressed: the command's panel or tool is open. */
  active?: boolean;
  /** P4b SELECT: a state item (role menuitemcheckbox): true draws its check mark, false leaves room for it. */
  checked?: boolean;
  /** P4b fix 1 (TOOLBAR): a right-click on the item (the More menus' items: Show in toolbar). */
  onContext?(x: number, y: number): void;
  /**
   * UX 0.1.0 (TOOLBAR): a press on the item, which may start a drag (a More menu's item dragged
   * onto the toolbar). The click that ends a drag is swallowed by the dragger, not here.
   */
  onPress?(e: React.PointerEvent<HTMLButtonElement>): void;
  run(): void;
}
export type MenuEntry = MenuItem | { sep: true; id: string };

export function isSep(e: MenuEntry): e is { sep: true; id: string } {
  return (e as { sep?: boolean }).sep === true;
}

function Item({ item, onRun, onHover }: { item: MenuItem; onRun(item: MenuItem): void; onHover(el: HTMLButtonElement, disabled: boolean): void }) {
  // Beside the item, so the reason does not cover the items under it. A command's item always has
  // one, as its toolbar button does: the label, the shortcut, and the hint or the reason.
  const cmd = item.command != null;
  const tip = useTip(
    item.disabled
      ? { text: item.label, detail: item.disabled, side: true, ...(item.shortcut ? { shortcut: item.shortcut } : {}) }
      : cmd
        ? { text: item.label, side: true, ...(item.shortcut ? { shortcut: item.shortcut } : {}), ...(item.hint ? { detail: item.hint } : {}) }
        : null,
  );
  const cls = [item.danger ? 'is-danger' : '', cmd ? 'cad-menu-cmd' : '', item.active ? 'is-active' : ''].filter(Boolean).join(' ');
  return (
    <button
      type="button"
      role={item.checked != null ? 'menuitemcheckbox' : 'menuitem'}
      aria-checked={item.checked != null ? item.checked : undefined}
      className={cls || undefined}
      aria-disabled={item.disabled ? true : undefined}
      aria-current={item.active ? 'true' : undefined}
      aria-keyshortcuts={item.shortcut ? item.shortcut.replace(/Ctrl/g, 'Control') : undefined}
      data-menu-item={item.id}
      data-command={item.command}
      data-disabled-reason={item.disabled || undefined}
      {...tip}
      onPointerEnter={(e) => onHover(e.currentTarget, !!item.disabled)}
      onPointerDown={item.onPress}
      onContextMenu={
        item.onContext
          ? (e) => {
              e.preventDefault();
              e.stopPropagation();
              item.onContext?.(e.clientX, e.clientY);
            }
          : undefined
      }
      onClick={() => {
        if (!item.disabled) onRun(item);
      }}
    >
      {cmd ? (
        <>
          {/* ux010 (TOOLBAR, review N2): a command that toggles a mode (Construction) shows its state. */}
          {item.checked != null ? <span className="cad-menu-check" aria-hidden="true" data-on={item.checked ? '1' : undefined} /> : null}
          <span className="cad-menu-ico">{item.icon ? <Icon d={item.icon} size={16} stroke={1.7} /> : null}</span>
          <span className="cad-menu-label">{item.label}</span>
          {item.shortcut ? <kbd className="cad-menu-key">{item.shortcut}</kbd> : null}
        </>
      ) : item.checked != null ? (
        <>
          <span className="cad-menu-check" aria-hidden="true" data-on={item.checked ? '1' : undefined} />
          {item.label}
        </>
      ) : (
        item.label
      )}
    </button>
  );
}

export function ContextMenu({ x, y, items, onClose, label = 'Actions', anchor = null }: { x: number; y: number; items: MenuEntry[]; onClose(): void; label?: string; anchor?: HTMLElement | null }) {
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
    const first = el.querySelector<HTMLButtonElement>('button[role^="menuitem"]:not([aria-disabled])');
    first?.focus({ preventScroll: true });
  }, [x, y, items]);

  useEffect(() => {
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node;
      // A press on the button that opened it is that button's own (it toggles the menu).
      if (anchor?.contains(t)) return;
      // UX 0.1.0 (TOOLBAR): nor a press beside it in a [data-menu-keep] (a toolbar group's buttons,
      // one of which may be dragged into this More menu); the toolbar closes it on their click.
      if (anchor?.closest('[data-menu-keep]')?.contains(t)) return;
      if (ref.current && !ref.current.contains(t)) onClose();
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
  }, [onClose, anchor]);

  const hover = (el: HTMLButtonElement, disabled: boolean) => {
    const target = disabled ? ref.current : el;
    if (target && document.activeElement !== target) target.focus({ preventScroll: true });
  };

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
      tabIndex={-1}
      style={{ left: pos.left, top: pos.top }}
      onContextMenu={(e) => e.preventDefault()}
      onKeyDown={(e) => {
        const buttons = [...(ref.current?.querySelectorAll<HTMLButtonElement>('button[role^="menuitem"]') ?? [])];
        const i = buttons.indexOf(document.activeElement as HTMLButtonElement);
        if (e.key === 'Escape') {
          e.preventDefault();
          e.stopPropagation();
          onClose();
          anchor?.focus({ preventScroll: true });
        } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
          e.preventDefault();
          if (!buttons.length) return;
          const step = e.key === 'ArrowDown' ? 1 : -1;
          // From the menu itself (a disabled item was hovered): Down to the first item, Up to the last.
          const next = i < 0 ? buttons[step > 0 ? 0 : buttons.length - 1] : buttons[(i + step + buttons.length) % buttons.length];
          next.focus();
        } else if (e.key === 'Home' || e.key === 'End') {
          // The first and the last item, as in any menu (review P2/P3 round 4: only the arrows worked).
          e.preventDefault();
          if (buttons.length) buttons[e.key === 'Home' ? 0 : buttons.length - 1].focus();
        } else if (e.key === 'Tab') {
          e.preventDefault();
          onClose();
          anchor?.focus({ preventScroll: true });
        }
      }}
    >
      {items.map((it, i) =>
        isSep(it) ? <div key={`${i}:${it.id}`} className="face-ctx-sep" role="separator" /> : <Item key={`${i}:${it.id}`} item={it} onRun={run} onHover={hover} />,
      )}
    </div>
  );
}
