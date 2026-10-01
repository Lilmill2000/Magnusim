// Tooltip (core .mat-k-tip look: #1f2430 on #f5f6f8, 12px/1.45, radius 5).
// One tooltip layer for the whole frame, drawn with position: fixed by
// <TooltipLayer/> (mounted in Overlays), so toolbars with overflow never clip
// it. No portal: the host import map offers react-dom/client, not react-dom.
// Hover shows it after a short delay; keyboard focus shows it at once; it
// works on aria-disabled controls, whose tooltip carries the reason.
// Owner: UI-SHELL.
// SPDX-License-Identifier: GPL-3.0-or-later
import { useEffect, useLayoutEffect, useRef, useState, type FocusEvent, type MouseEvent } from 'react';
import { createStateStore, useStateStore } from '../../lib/store';

export interface TipContent {
  /** Main line: "Box", "Undo Box 1", "What's wrong: …". */
  text: string;
  /** Shown as a key cap after the text: "Ctrl+Z". */
  shortcut?: string;
  /** Second line, muted: a hint or the reason a control is unavailable. */
  detail?: string;
  /**
   * Beside the anchor instead of below it: for a menu item, so the reason does
   * not cover the items under it (review round 2).
   */
  side?: boolean;
}

interface TipState {
  tip: (TipContent & { rect: { left: number; top: number; width: number; height: number }; owner: object }) | null;
}

const store = createStateStore<TipState>({ tip: null });
let timer: ReturnType<typeof setTimeout> | null = null;

/** Delay before a hover tooltip shows (ms). Tests may set it to 0. */
export const tipTiming = { hoverDelayMs: 450 };

function clearTimer() {
  if (timer) clearTimeout(timer);
  timer = null;
}

export function hideTip(owner?: object): void {
  clearTimer();
  const cur = store.get().tip;
  if (!cur || (owner && cur.owner !== owner)) return;
  store.set({ tip: null });
}

function showTipFor(el: Element, content: TipContent, owner: object) {
  const r = el.getBoundingClientRect();
  store.set({ tip: { ...content, rect: { left: r.left, top: r.top, width: r.width, height: r.height }, owner } });
}

function isFocusVisible(el: Element): boolean {
  try {
    return el.matches(':focus-visible');
  } catch {
    return false;
  }
}

/**
 * Tooltip handlers to spread on the anchor element:
 * `<button {...useTip({ text: 'Undo', shortcut: 'Ctrl+Z' })}>`.
 * Pass null for no tooltip.
 */
export function useTip(content: TipContent | null) {
  const owner = useRef<object>({}).current;
  const latest = useRef(content);
  latest.current = content;
  // A tooltip never outlives its anchor or its content: the anchor can go
  // away under a still pointer (a fixed feature loses its error badge).
  const has = content != null;
  useEffect(() => {
    if (!has) hideTip(owner);
  }, [has, owner]);
  useEffect(() => () => hideTip(owner), [owner]);
  return {
    onMouseEnter(e: MouseEvent<HTMLElement>) {
      const c = latest.current;
      if (!c) return;
      const el = e.currentTarget;
      clearTimer();
      if (tipTiming.hoverDelayMs <= 0) showTipFor(el, c, owner);
      else timer = setTimeout(() => el.isConnected && showTipFor(el, c, owner), tipTiming.hoverDelayMs);
    },
    onMouseLeave() {
      hideTip(owner);
    },
    onMouseDown() {
      hideTip(owner);
    },
    onFocus(e: FocusEvent<HTMLElement>) {
      const c = latest.current;
      if (c && e.target === e.currentTarget && isFocusVisible(e.currentTarget)) showTipFor(e.currentTarget, c, owner);
    },
    onBlur() {
      hideTip(owner);
    },
  };
}

/** The frame's single tooltip, positioned below its anchor (above when there is no room), or beside it (`side`). */
export function TooltipLayer() {
  const tip = useStateStore(store, (s) => s.tip);
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!tip || !el) {
      setPos(null);
      return;
    }
    const w = el.offsetWidth;
    const h = el.offsetHeight;
    const vw = window.innerWidth || document.documentElement.clientWidth;
    const vh = window.innerHeight || document.documentElement.clientHeight;
    const { left, top, width, height } = tip.rect;
    if (tip.side) {
      // Right of the anchor, or left of it when there is no room; level with it.
      let x = left + width + 6;
      if (x + w > vw - 6) x = Math.max(6, left - w - 6);
      const y = Math.max(6, Math.min(top + height / 2 - h / 2, vh - h - 6));
      setPos({ left: Math.round(x), top: Math.round(y) });
      return;
    }
    let x = left + width / 2 - w / 2;
    x = Math.max(6, Math.min(x, vw - w - 6));
    let y = top + height + 6;
    if (y + h > vh - 6) y = Math.max(6, top - h - 6);
    setPos({ left: Math.round(x), top: Math.round(y) });
  }, [tip]);
  if (!tip) return null;
  return (
    <div
      ref={ref}
      className="cad-tip"
      role="tooltip"
      id="cad-tip"
      data-cad-tip="1"
      style={pos ? { left: pos.left, top: pos.top } : { left: -9999, top: -9999 }}
    >
      <span className="cad-tip-text">{tip.text}</span>
      {tip.shortcut ? <kbd className="cad-tip-key">{tip.shortcut}</kbd> : null}
      {tip.detail ? <span className="cad-tip-detail">{tip.detail}</span> : null}
    </div>
  );
}
