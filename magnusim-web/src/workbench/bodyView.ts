/**
 * Bodies hidden in the view, and the bodies picked together in the tree, for the
 * geometry the viewport shows. The workbench (runtime.js) owns the state and publishes
 * it here; the setup tree reads it (a hidden body's row is lighter grey) and asks for a
 * change through `requestBodyView`. A view state only: nothing saved changes.
 */
export interface BodyViewState {
  /** The geometry the viewport shows ('' for none). */
  geometryId: string;
  /** How many bodies it has. */
  count: number;
  /** Hidden bodies, 1-based (Body1 = 1). */
  hidden: number[];
  /** The bodies picked in the tree (Ctrl/Shift-click), 1-based. */
  selected: number[];
  /** The results view is open: its surface has no body per cell, so bodies don't hide there. */
  results: boolean;
}

export type BodyViewRequest = { kind: 'hide' | 'show'; bodies: number[] } | { kind: 'show-all' };

/** One item of a body's right-click menu. */
export interface BodyMenuItem {
  act: 'hide' | 'show' | 'show-all';
  label: string;
  bodies: number[];
}

const EMPTY: BodyViewState = { geometryId: '', count: 0, hidden: [], selected: [], results: false };

let state: BodyViewState = EMPTY;
let handler: ((req: BodyViewRequest) => void) | null = null;
const listeners = new Set<() => void>();

const ids = (list: unknown): number[] =>
  Array.from(new Set((Array.isArray(list) ? list : []).map(Number).filter((n) => Number.isInteger(n) && n > 0))).sort((a, b) => a - b);

export function getBodyView(): BodyViewState {
  return state;
}

/** The workbench's word: repaints the tree only when something changed. */
export function publishBodyView(next: Partial<BodyViewState>): void {
  const merged: BodyViewState = {
    geometryId: next.geometryId !== undefined ? String(next.geometryId || '') : state.geometryId,
    count: next.count !== undefined ? Math.max(0, Number(next.count) || 0) : state.count,
    hidden: next.hidden !== undefined ? ids(next.hidden) : state.hidden,
    selected: next.selected !== undefined ? ids(next.selected) : state.selected,
    results: next.results !== undefined ? !!next.results : state.results,
  };
  if (
    merged.geometryId === state.geometryId &&
    merged.count === state.count &&
    merged.results === state.results &&
    merged.hidden.join() === state.hidden.join() &&
    merged.selected.join() === state.selected.join()
  ) {
    return;
  }
  state = merged;
  for (const fn of [...listeners]) fn();
}

export function subscribeBodyView(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

export function setBodyViewHandler(fn: ((req: BodyViewRequest) => void) | null): void {
  handler = fn;
}

export function requestBodyView(req: BodyViewRequest): void {
  if (handler) handler(req);
}

/** Whether this body (1-based) of this geometry is hidden in the view. */
export function bodyHidden(view: BodyViewState, geometryId: string, body: number): boolean {
  return !!geometryId && view.geometryId === geometryId && view.hidden.includes(body);
}

/**
 * A body row's hide/show items: the row's body, or every picked body when the row is one
 * of several picked. Only for the geometry the viewport shows, only when it has more than
 * one body (a single body hides by its faces), and not while the results view is open.
 */
export function bodyMenuItems(view: BodyViewState, geometryId: string, body: number): BodyMenuItem[] {
  if (!geometryId || view.geometryId !== geometryId || view.count < 2 || view.results || !(body > 0)) return [];
  const picked = view.selected.length > 1 && view.selected.includes(body) ? view.selected : [body];
  const hidden = picked.filter((b) => view.hidden.includes(b));
  const out: BodyMenuItem[] = [];
  if (picked.length === 1) {
    out.push(hidden.length ? { act: 'show', label: 'Show body', bodies: picked } : { act: 'hide', label: 'Hide body', bodies: picked });
  } else {
    if (hidden.length < picked.length) out.push({ act: 'hide', label: `Hide ${picked.length} bodies`, bodies: picked });
    if (hidden.length) out.push({ act: 'show', label: `Show ${picked.length} bodies`, bodies: picked });
  }
  if (view.hidden.some((b) => !picked.includes(b))) out.push({ act: 'show-all', label: 'Show all bodies', bodies: [] });
  return out;
}

/** Tests: back to nothing shown. */
export function resetBodyViewForTests(): void {
  state = EMPTY;
  handler = null;
  listeners.clear();
}
