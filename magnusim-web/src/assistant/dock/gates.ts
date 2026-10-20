/**
 * The Assistant's questions in the dock (phase 4 spec 4.1, 4.4, 5.5): the presenter the page
 * relay hands every `gate` frame of this tab to (setGatePresenter), so a question shows as a
 * card in the dock and never as the app's confirm dialog. The relay keeps its whole flow (one
 * card per gate id, its expiry, out of the frame's full screen first, the answer POSTed on the
 * link it was shown on); this module only shows it and resolves with the person's answer, or
 * null when the relay closed it unanswered (its signal).
 *
 * - A card opens the dock (store.ts questionShown) and keeps its turn's channel pinned.
 * - The keyboard: the oldest card's No takes it when it shows (whatever had it, the workspace
 *   frame included), never a newer card's; in a hidden tab, once the tab shows again. After an
 *   answer it goes to the next card's No, else back where it was before the first card took it
 *   (if that is still there), else the composer. A card closed unanswered while it had the
 *   keyboard gives it to the next card's No, else the composer.
 * - While questions wait the document title starts "(n) ".
 */
import { useSyncExternalStore } from 'react';
import { setGatePresenter, type GatePresenter } from '../relay';
import type { GateView } from '../wire';
import { keepTurn, questionClosed, questionShown } from './store';

export interface OpenCard {
  gate: GateView;
  /** The person's answer (once; later calls change nothing). */
  answer(allow: boolean): void;
}

let cards: readonly OpenCard[] = Object.freeze([]);
const listeners = new Set<() => void>();
/** Where the keyboard was before the first card took it. */
let returnTo: HTMLElement | null = null;
/** The page's own title, without the "(n) " prefix. */
let baseTitle: string | null = null;

function publish(): void {
  syncTitle();
  for (const fn of [...listeners]) fn();
}

export function gateCardsSnapshot(): readonly OpenCard[] {
  return cards;
}

export function subscribeGateCards(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

export function useGateCards(): readonly OpenCard[] {
  return useSyncExternalStore(subscribeGateCards, gateCardsSnapshot, gateCardsSnapshot);
}

function syncTitle(): void {
  if (typeof document === 'undefined') return;
  const strip = (t: string) => t.replace(/^\(\d+\) /, '');
  if (cards.length) {
    baseTitle ??= strip(document.title);
    document.title = `(${cards.length}) ${baseTitle}`;
  } else if (baseTitle !== null) {
    document.title = baseTitle;
    baseTitle = null;
  }
}

const cardEl = (id: string): HTMLElement | null => document.querySelector<HTMLElement>(`#assistant-dock [data-gate="${CSS.escape(id)}"]`);
const noOf = (id: string): HTMLElement | null => cardEl(id)?.querySelector<HTMLElement>('[data-gate-answer="no"]') ?? null;

/** Whether `el` can take the keyboard now: in the page, shown, not under an inert cover. */
function focusable(el: HTMLElement | null): el is HTMLElement {
  if (!el || !el.isConnected || el.closest('[hidden], [inert]')) return false;
  return !(el as HTMLButtonElement).disabled;
}

/** Whether the keyboard is in a card now. */
export function focusInCard(): boolean {
  const a = typeof document === 'undefined' ? null : document.activeElement;
  return !!a && !!a.closest?.('#assistant-dock [data-gate]');
}

/** The oldest card's No takes the keyboard (when the tab shows; the dock may still be opening). */
export function focusOldest(tries = 10): void {
  if (typeof document === 'undefined') return;
  const first = cards[0];
  if (!first) return;
  if (document.visibilityState === 'hidden') return;
  const no = noOf(first.gate.id);
  if (!focusable(no)) {
    if (tries > 0) requestAnimationFrame(() => focusOldest(tries - 1));
    return;
  }
  if (no.contains(document.activeElement)) return;
  if (!focusInCard()) {
    const a = document.activeElement as HTMLElement | null;
    returnTo = a && a !== document.body ? a : null;
  }
  no.focus({ preventScroll: false });
}

/**
 * A card was drawn again elsewhere (its request came into the transcript, so it moved from the
 * questions strip to under it): the keyboard it had went to the page's body; the oldest card's
 * No takes it back. A keyboard the person put elsewhere stays.
 */
export function cardRemounted(): void {
  if (typeof document === 'undefined' || !cards.length) return;
  const a = document.activeElement;
  if (a && a !== document.body) return;
  focusOldest();
}

function composerField(): HTMLElement | null {
  return document.querySelector<HTMLElement>('#assistant-dock .assistant-dock-composer textarea');
}

/** A card went: where the keyboard goes when it was in it. */
function afterClose(answered: boolean, hadFocus: boolean): void {
  if (!hadFocus) return;
  requestAnimationFrame(() => {
    if (cards.length) {
      focusOldest();
      return;
    }
    const back = answered && focusable(returnTo) ? returnTo : composerField();
    returnTo = null;
    if (focusable(back)) back.focus({ preventScroll: true });
  });
}

/** The relay's presenter: a card in the dock until answered or closed. */
export const presentInDock: GatePresenter = (g, { signal }) =>
  new Promise<boolean | null>((resolve) => {
    if (signal.aborted) {
      resolve(null);
      return;
    }
    let done = false;
    const release = g.turn ? keepTurn(g.turn) : () => undefined;
    const finish = (value: boolean | null) => {
      if (done) return;
      done = true;
      signal.removeEventListener('abort', onAbort);
      const hadFocus = (() => {
        const el = cardEl(g.id);
        const a = document.activeElement;
        return !!el && !!a && (el.contains(a) || a === document.body);
      })();
      cards = Object.freeze(cards.filter((c) => c !== card));
      release();
      questionClosed(g.id);
      publish();
      if (!cards.length) document.removeEventListener('visibilitychange', onVisible);
      afterClose(value !== null, hadFocus);
      resolve(value);
    };
    const onAbort = () => finish(null);
    const card: OpenCard = { gate: g, answer: (allow) => finish(allow === true) };
    cards = Object.freeze([...cards, card]);
    signal.addEventListener('abort', onAbort);
    document.addEventListener('visibilitychange', onVisible);
    publish();
    questionShown(g.id, g.title);
    // The oldest card only: a newer card never takes the keyboard from an older one.
    if (cards[0] === card) focusOldest();
  });

function onVisible(): void {
  if (document.visibilityState === 'visible' && !focusInCard()) focusOldest();
}

/** The dock shows this tab's questions while it is mounted. */
export function installGatePresenter(): () => void {
  setGatePresenter(presentInDock);
  return () => {
    setGatePresenter(null);
  };
}

/** Tests only: no cards. */
export function resetGateCardsForTests(): void {
  cards = Object.freeze([]);
  returnTo = null;
  if (baseTitle !== null && typeof document !== 'undefined') document.title = baseTitle;
  baseTitle = null;
}
