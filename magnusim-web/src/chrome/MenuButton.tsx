import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from 'react';

/** One row of a MenuButton's menu. */
export type MenuItem =
  | {
      kind?: 'item';
      key: string;
      label: ReactNode;
      onSelect: () => void;
      disabled?: boolean;
      title?: string;
      /** Extra attributes on the item's button (data-* for tests and styles). */
      attrs?: Record<string, string | undefined>;
    }
  | { kind: 'separator'; key: string }
  /** A line of text (e.g. "No Part yet"): not focusable. */
  | { kind: 'note'; key: string; label: ReactNode; attrs?: Record<string, string | undefined> };

export interface MenuButtonProps {
  /** The button's content. */
  label: ReactNode;
  items: MenuItem[];
  id?: string;
  title?: string;
  /** The button's class (default `home-btn`). */
  buttonClassName?: string;
  /** The wrapper's class (default `ws-menu`). */
  className?: string;
  disabled?: boolean;
  /** Extra attributes on the wrapper and on the button. */
  wrapAttrs?: Record<string, string | undefined>;
  buttonAttrs?: Record<string, string | undefined>;
}

/**
 * A header button with a menu (the Workspaces menu, a start action's menu), with the
 * keyboard a menu button has: Down, Enter or Space opens it on its first item; Up, Down,
 * Home and End move; Escape closes it and gives the button the focus back; Tab closes it.
 * A click outside closes it.
 */
export function MenuButton({
  label,
  items,
  id,
  title,
  buttonClassName = 'home-btn',
  className = 'ws-menu',
  disabled = false,
  wrapAttrs,
  buttonAttrs,
}: MenuButtonProps) {
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const list = useRef<HTMLUListElement>(null);
  // Which item gets the focus when the menu opens: the first or the last one, or none (a click).
  const focusOnOpen = useRef<'first' | 'last' | null>(null);

  const menuItems = (): HTMLButtonElement[] =>
    Array.from(list.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not(:disabled)') || []);

  useEffect(() => {
    if (!open) return undefined;
    const where = focusOnOpen.current;
    focusOnOpen.current = null;
    if (where) {
      const all = menuItems();
      (where === 'last' ? all[all.length - 1] : all[0])?.focus();
    }
    const outside = (e: MouseEvent) => {
      if (!wrap.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', outside);
    return () => document.removeEventListener('mousedown', outside);
  }, [open]);

  useEffect(() => {
    if (disabled) setOpen(false);
  }, [disabled]);

  const close = (refocus: boolean) => {
    setOpen(false);
    if (refocus) button.current?.focus();
  };

  const onButtonKey = (e: ReactKeyboardEvent<HTMLButtonElement>) => {
    if (e.key === 'ArrowDown' || e.key === 'Enter' || e.key === ' ' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (open) {
        const all = menuItems();
        (e.key === 'ArrowUp' ? all[all.length - 1] : all[0])?.focus();
        return;
      }
      focusOnOpen.current = e.key === 'ArrowUp' ? 'last' : 'first';
      setOpen(true);
    } else if (e.key === 'Escape' && open) {
      e.preventDefault();
      close(true);
    }
  };

  const onMenuKey = (e: ReactKeyboardEvent<HTMLUListElement>) => {
    const all = menuItems();
    const at = all.indexOf(document.activeElement as HTMLButtonElement);
    const go = (i: number) => all[(i + all.length) % all.length]?.focus();
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      go(at + 1);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      go(at < 0 ? all.length - 1 : at - 1);
    } else if (e.key === 'Home') {
      e.preventDefault();
      go(0);
    } else if (e.key === 'End') {
      e.preventDefault();
      go(all.length - 1);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      close(true);
    } else if (e.key === 'Tab') {
      // The focus moves on as Tab moves it; the menu closes behind it.
      setOpen(false);
    }
  };

  return (
    <div className={className} ref={wrap} {...wrapAttrs}>
      <button
        ref={button}
        type="button"
        id={id}
        className={buttonClassName}
        aria-haspopup="menu"
        aria-expanded={open}
        title={title}
        disabled={disabled}
        onClick={() => setOpen((v) => !v)}
        onKeyDown={onButtonKey}
        {...buttonAttrs}
      >
        {label}
      </button>
      {open ? (
        <ul className="ws-menu-list" role="menu" ref={list} onKeyDown={onMenuKey}>
          {items.map((item) => {
            if (item.kind === 'separator') return <li key={item.key} role="separator" className="ws-menu-sep" />;
            if (item.kind === 'note') {
              return (
                <li key={item.key} role="presentation" className="ws-menu-note" {...item.attrs}>
                  {item.label}
                </li>
              );
            }
            return (
              <li key={item.key} role="none">
                <button
                  type="button"
                  role="menuitem"
                  tabIndex={-1}
                  disabled={item.disabled}
                  title={item.title}
                  onClick={() => {
                    close(false);
                    item.onSelect();
                  }}
                  {...item.attrs}
                >
                  {item.label}
                </button>
              </li>
            );
          })}
        </ul>
      ) : null}
    </div>
  );
}
