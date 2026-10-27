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
// check first); the selection stays, so what was added shows at once. A relation the selection
// already has shows pressed and does nothing (the toolbar commands never remove one: Delete on its
// glyph does); one that contradicts a relation it has (Vertical on a horizontal line, Perpendicular
// on parallel lines) is left out. Placed by the overlay (src/sketch/overlay.ts) beside the
// selection, clear of the sketch's curves, labels and the floating chrome.
// Owner: P3-SKETCH.
// SPDX-License-Identifier: GPL-3.0-or-later
import type { SketchFeature, SketchRelationKind } from '../types/doc';
import { uiFor } from '../ui/controller';
import { applyRelation, picks, relationIcon } from './commands';
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
}

/** The relation each kind contradicts on the same references. */
const OPPOSED: Partial<Record<SketchRelationKind, SketchRelationKind[]>> = {
  horizontal: ['vertical'],
  vertical: ['horizontal'],
  parallel: ['perpendicular'],
  collinear: ['perpendicular'],
  perpendicular: ['parallel', 'collinear'],
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
 * The relations the palette offers for these picks (point ids, point entities, curve ids), in the
 * CONSTRAIN toolbar's order: those the command would add now, and those already there (pressed).
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
  /** Clicks one of its buttons (as the person does): the command's reason when it is refused. */
  add(kind: SketchRelationKind): Promise<true | string>;
  sync(): void;
  dispose(): void;
}

/** The palette's element, kept in step with the selection, the draft and the tool. */
export function createRelationsPalette(mode: SketchMode, opts: { forwardWheel?(el: HTMLElement): void } = {}): RelationsPalette {
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
  let key = '';

  function current(): RelationOffer[] {
    const d = mode.draft();
    if (!d || !mode.active || mode.byAssistant || mode.dragging) return [];
    if ((mode.tool?.id ?? 'select') !== 'select') return [];
    if (ui.editBlock()) return [];
    const sel = mode.selected();
    if (!sel.length || sel.some((h) => h.what === 'constraint')) return [];
    return relationOffers(d, picks(mode));
  }

  async function add(kind: SketchRelationKind): Promise<true | string> {
    const offer = shown.find((o) => o.kind === kind);
    if (offer?.present) {
      const why = `${offer.label} is already in the sketch (Delete on its glyph removes it)`;
      mode.note(why);
      return why;
    }
    // The command's own check first: the same reason the toolbar gives.
    const ok = services.commands.canRun(`sketch.${kind}`);
    if (ok !== true) {
      mode.note(`${RELATION_LABELS[kind]}: ${ok}`);
      return ok;
    }
    const r = await applyRelation(mode, kind, picks(mode));
    return r.ok ? true : r.reason;
  }

  function sync() {
    const next = current();
    const k = next.map((o) => `${o.kind}${o.present ? '*' : ''}`).join(',');
    shown = next;
    el.hidden = !next.length;
    if (k === key) return;
    key = k;
    el.replaceChildren(
      ...next.map((o) => {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'cad-sk-relations-btn';
        b.setAttribute('data-relation', o.kind);
        b.setAttribute('aria-label', o.label);
        b.title = o.present ? `${o.label}: already in the sketch` : `${o.label}: add the relation`;
        if (o.present) {
          b.classList.add('is-present');
          b.setAttribute('aria-pressed', 'true');
          b.setAttribute('aria-disabled', 'true');
        } else b.setAttribute('aria-pressed', 'false');
        b.append(icon(relationIcon(o.kind)));
        b.addEventListener('click', () => void add(o.kind));
        return b;
      }),
    );
  }

  const offs = [mode.view.subscribe(sync), services.selection.subscribe(sync), mode.state.subscribe(sync)];
  sync();
  return {
    el,
    offers: () => shown,
    add,
    sync,
    dispose() {
      for (const off of offs) off();
      el.remove();
    },
  };
}
