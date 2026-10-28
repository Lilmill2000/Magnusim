// The relations palette (Daniel, first test of the CAD desktop app: SolidWorks' Add Relations):
// with the Select tool, the sketch items selected show the relations that apply to them as a row
// of one-click buttons beside the selection, as SolidWorks' context toolbar does:
//   one line          Horizontal, Vertical, Fix
//   two lines         Parallel, Perpendicular, Equal, Collinear (Tangent where they share an end)
//   three lines       Symmetric when one of them is a centerline (src/sketch/constraints.ts)
//   point + line      Coincident, Midpoint (not the line's own end)
//   line + arc/circle Tangent
//   two circles/arcs  Tangent, Equal, Concentric
//   two points        Coincident, Horizontal, Vertical
//   point + circle    Coincident (On curve)
//   splines, ellipses, parabolas and conics: what the solver takes for them (planConstraint)
// and Fix for anything. Each button adds exactly what that CONSTRAIN toolbar command adds
// (applyRelation, src/sketch/commands.ts), refused with the same reasons (the command's enabled
// check first, then its own path); the selection stays, so what was added shows at once.
// Each relation the selection could take is first checked with the solver as the command would add
// it (SketchMode.tryApply, on the solver's second instance): one the selection has, or that the
// sketch's other relations already imply (Parallel of two horizontal lines), shows pressed (the
// toolbar commands never remove one: Delete on its glyph does); one that would over-define the
// sketch, shrink a curve to nothing or put two curves on top of each other (Perpendicular on two
// horizontal lines, Tangent on concentric circles) is left out. Placed by the overlay
// (src/sketch/overlay.ts) beside the selection, clear of what can be clicked.
// Owner: P3-SKETCH.
// SPDX-License-Identifier: GPL-3.0-or-later
import type { SketchFeature, SketchRelationKind } from '../types/doc';
import { uiFor } from '../ui/controller';
import { applyRelation, fullyDefined, IMPLIED, picks, relationEdit, relationIcon, relationRefusal } from './commands';
import { CONSTRAIN_COMMANDS, hasRelation, planConstraint, type RelationPlan } from './constraints';
import { entityOf, entityPoints, RELATION_LABELS } from './model';
import type { SketchMode } from './mode';

export { hasRelation };

type F = Pick<SketchFeature, 'points' | 'entities' | 'constraints'>;

/** One button of the palette. */
export interface RelationOffer {
  kind: SketchRelationKind;
  label: string;
  /** The selection has it already (every record the command would add). */
  present: boolean;
  /**
   * It holds already through the sketch's other relations (Parallel of two horizontal lines,
   * Coincident of a midpoint): shown pressed too. Known after the palette's check with the solver.
   */
  implied?: boolean;
}

/** The relation each kind contradicts on the same references (a quick first cut; the solver decides the rest). */
const OPPOSED: Partial<Record<SketchRelationKind, SketchRelationKind[]>> = {
  horizontal: ['vertical'],
  vertical: ['horizontal'],
  parallel: ['perpendicular'],
  collinear: ['perpendicular'],
  perpendicular: ['parallel', 'collinear'],
  // Review (relations lane): Tangent on concentric circles made one circle of the two.
  tangent: ['concentric'],
  concentric: ['tangent'],
};

/** A point and a curve it already belongs to (a line's own end): Coincident and Midpoint make no sense there. */
function ownPoint(f: F, plan: RelationPlan[]): boolean {
  return plan.some((r) => {
    if (r.kind !== 'coincident' && r.kind !== 'midpoint') return false;
    const e = r.refs.length === 2 ? entityOf(f, r.refs[1]) : null;
    return !!e && entityPoints(e).includes(r.refs[0]);
  });
}

/**
 * The relations the selection could take, before the solver's check: for these picks (point ids,
 * point entities, curve ids), in the CONSTRAIN toolbar's order, those the command plans, and those
 * already there (pressed).
 */
export function relationOffers(f: F, sel: readonly string[]): RelationOffer[] {
  if (!sel.length) return [];
  const out: RelationOffer[] = [];
  for (const c of CONSTRAIN_COMMANDS) {
    const p = planConstraint(f, c.kind, sel);
    if (!p.ok || !p.add.length) continue;
    const present = p.add.every((r) => hasRelation(f, r));
    if (!present) {
      if (ownPoint(f, p.add)) continue;
      const opposed = OPPOSED[c.kind] ?? [];
      if (p.add.some((r) => opposed.some((k) => hasRelation(f, { kind: k, refs: r.refs })))) continue;
    }
    out.push({ kind: c.kind, label: RELATION_LABELS[c.kind], present });
  }
  return out;
}

const SVG_NS = 'http://www.w3.org/2000/svg';
function icon(d: string): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', '16');
  svg.setAttribute('height', '16');
  svg.setAttribute('aria-hidden', 'true');
  const p = document.createElementNS(SVG_NS, 'path');
  p.setAttribute('d', d);
  p.setAttribute('fill', 'none');
  p.setAttribute('stroke', 'currentColor');
  p.setAttribute('stroke-width', '1.8');
  p.setAttribute('stroke-linecap', 'round');
  p.setAttribute('stroke-linejoin', 'round');
  svg.append(p);
  return svg;
}

export interface RelationsPalette {
  readonly el: HTMLElement;
  /** What it offers now (the e2e and the tests read the buttons). */
  offers(): RelationOffer[];
  /** Resolves once the offers for the current selection are checked and shown (tests). */
  settled(): Promise<void>;
  /** Clicks one of its buttons (as the person does): the command's reason when it is refused. */
  add(kind: SketchRelationKind): Promise<true | string>;
  sync(): void;
  dispose(): void;
}

/** The palette's element, kept in step with the selection, the draft and the tool. */
export function createRelationsPalette(mode: SketchMode, opts: { forwardWheel?(el: HTMLElement): void; onRender?(): void } = {}): RelationsPalette {
  const { services } = mode;
  const ui = uiFor(services);
  const el = document.createElement('div');
  el.className = 'cad-sk-relations';
  el.setAttribute('data-sketch-relations-palette', '1');
  el.setAttribute('role', 'toolbar');
  el.setAttribute('aria-label', 'Add relation');
  el.hidden = true;
  el.addEventListener('pointerdown', (e) => e.stopPropagation());
  el.addEventListener('click', (e) => e.stopPropagation());
  el.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    e.stopPropagation();
  });
  opts.forwardWheel?.(el);
  let shown: RelationOffer[] = [];
  const buttons = new Map<SketchRelationKind, HTMLButtonElement>();
  /** The selection, the draft and its analysis the offers were last asked for. */
  let askedSel = '';
  let askedDraft: unknown = null;
  let askedStatus: unknown = null;
  let gen = 0;
  let pending: Promise<void> = Promise.resolve();

  function candidates(): { sel: string[]; offers: RelationOffer[] } | null {
    const d = mode.draft();
    // Nothing while anything is dragged (a point, a curve, a fillet's radius arrow): its checks
    // would queue whole-sketch solves ahead of the drag's own on the solver.
    if (!d || !mode.active || mode.byAssistant || mode.dragging || mode.view.get().dragging) return null;
    if ((mode.tool?.id ?? 'select') !== 'select') return null;
    if (ui.editBlock()) return null;
    const hits = mode.selected();
    if (!hits.length || hits.some((h) => h.what === 'constraint')) return null;
    const sel = picks(mode);
    return { sel, offers: relationOffers(d, sel) };
  }

  /**
   * Each offer as the command would add it, solved: addable, implied (pressed), or left out. Null
   * once another check took its place (integration review: a stale check went on queueing dry
   * solves on the solver worker, ahead of the person's own solves and drag moves).
   */
  async function check(sel: string[], offers: RelationOffer[], my: number): Promise<RelationOffer[] | null> {
    const out: RelationOffer[] = [];
    for (const o of offers) {
      if (my !== gen) return null;
      if (o.present) {
        out.push(o);
        continue;
      }
      const r = await mode.tryApply(relationEdit(o.kind, sel, fullyDefined(mode)), { refuse: relationRefusal(sel, o.kind) });
      if (r.ok) out.push(o);
      else if (r.implied) out.push({ ...o, implied: true });
    }
    return out;
  }

  function button(o: RelationOffer): HTMLButtonElement {
    let b = buttons.get(o.kind);
    if (!b) {
      b = document.createElement('button');
      b.type = 'button';
      b.className = 'cad-sk-relations-btn';
      b.setAttribute('data-relation', o.kind);
      b.setAttribute('aria-label', o.label);
      b.append(icon(relationIcon(o.kind)));
      b.addEventListener('click', () => void add(o.kind));
      buttons.set(o.kind, b);
    }
    const pressed = o.present || !!o.implied;
    b.title = o.present ? `${o.label}: already in the sketch` : o.implied ? `${o.label}: ${IMPLIED}` : `${o.label}: add the relation`;
    b.classList.toggle('is-present', pressed);
    b.classList.toggle('is-implied', !!o.implied);
    b.setAttribute('aria-pressed', pressed ? 'true' : 'false');
    if (pressed) b.setAttribute('aria-disabled', 'true');
    else b.removeAttribute('aria-disabled');
    if (o.implied) b.setAttribute('data-implied', '1');
    else b.removeAttribute('data-implied');
    return b;
  }

  /**
   * The buttons updated in place (review, relations lane: rebuilding them dropped the keyboard focus
   * to the page, where the next Enter finished the sketch): the focused one keeps the focus, or its
   * neighbour takes it when that relation is no longer offered.
   */
  function render(next: RelationOffer[]) {
    const active = el.ownerDocument.activeElement as HTMLElement | null;
    const hadFocus = !!active && el.contains(active);
    const focusedKind = hadFocus ? (active!.getAttribute('data-relation') as SketchRelationKind | null) : null;
    const focusedAt = hadFocus ? Array.from(el.children).indexOf(active!) : -1;
    shown = next;
    const want = new Set(next.map((o) => o.kind));
    for (const [k, b] of buttons) {
      if (want.has(k)) continue;
      b.remove();
      buttons.delete(k);
    }
    next.forEach((o, i) => {
      const b = button(o);
      if (el.children[i] !== b) el.insertBefore(b, el.children[i] ?? null);
    });
    el.hidden = !next.length;
    if (hadFocus && !el.contains(el.ownerDocument.activeElement)) {
      const to = (focusedKind && buttons.get(focusedKind)) || (el.children[Math.min(Math.max(focusedAt, 0), el.children.length - 1)] as HTMLElement | undefined);
      to?.focus();
    }
    opts.onRender?.();
  }

  async function add(kind: SketchRelationKind): Promise<true | string> {
    // The command's own check, then its own path: the same reasons the toolbar gives (a pressed one
    // too: "Not applied: Horizontal is already in the sketch").
    const ok = services.commands.canRun(`sketch.${kind}`);
    if (ok !== true) {
      mode.note(`${RELATION_LABELS[kind]}: ${ok}`);
      return ok;
    }
    const r = await applyRelation(mode, kind, picks(mode));
    return r.ok ? true : r.reason;
  }

  function sync() {
    const c = candidates();
    const d = mode.draft();
    const selKey = c ? c.sel.join('|') : '';
    // The analysis comes after the edit's draft: what is implied is checked against it (its DOF).
    const status = mode.state.get().status;
    if (selKey === askedSel && d === askedDraft && status === askedStatus) return;
    const sameSel = selKey === askedSel;
    askedSel = selKey;
    askedDraft = d;
    askedStatus = status;
    const my = ++gen;
    if (!c || !c.offers.length) {
      render([]);
      pending = Promise.resolve();
      return;
    }
    // Another selection: nothing shown until its offers are checked. The same one after an edit:
    // the buttons stay (and keep the focus) until the new answer.
    if (!sameSel) el.hidden = true;
    // One check per edit: an edit's draft comes first and its analysis right after (the status the
    // check reads); while that analysis runs, the status it brings starts the check instead.
    pending = Promise.resolve()
      .then(() => (my !== gen || mode.state.get().analyzing ? null : check(c.sel, c.offers, my)))
      .then(
        (offers) => {
          if (offers && my === gen) render(offers);
        },
        () => {
          if (my === gen) render([]);
        },
      );
  }

  const offs = [mode.view.subscribe(sync), services.selection.subscribe(sync), mode.state.subscribe(sync)];
  sync();
  return {
    el,
    offers: () => shown,
    async settled() {
      for (;;) {
        const g = gen;
        await pending;
        if (g === gen) return;
      }
    },
    add,
    sync,
    dispose() {
      for (const off of offs) off();
      gen++;
      el.remove();
    },
  };
}
