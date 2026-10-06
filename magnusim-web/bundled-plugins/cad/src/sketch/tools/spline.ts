// The spline tools (P4b): Spline (fit points, S) and Control-point spline.
// Click the points; a double-click or Enter places the spline; a click on its
// first point closes it. Every point is a sketch point (joined to the point it
// snaps to, with the snap's relation), so a spline's points take dimensions and
// relations and drag like any other. The control-point spline draws its control
// polygon dashed while it is drawn; its degree (3 or 5) and Closed are options
// in the panel.
// Owner: P4b SKETCH.
// SPDX-License-Identifier: GPL-3.0-or-later
import { newId } from '../../lib/ids';
import type { Vec2 } from '../../types/doc';
import { SketchBuilder } from '../edit';
import { dist } from '../geom';
import type { Inference } from '../inference';
import { emptyPreview, type SketchMode, type SketchPointer, type SketchTool } from '../mode';
import { base, glyphsOf, joinedPoint, placePoint } from '../tools';
import { splineCurve, splinePolyline } from './bspline';
import type { ToolOption } from './options';

const CLOSE_PX = 8;

/** The fewest points a spline takes (fit: 2 open, 3 closed; control: degree + 1). */
export function minPoints(form: 'fit' | 'control', degree: number, closed: boolean): number {
  if (form === 'control') return degree + 1;
  return closed ? 3 : 2;
}

export function splineTool(mode: SketchMode, form: 'fit' | 'control'): SketchTool {
  const id = form === 'fit' ? 'spline-fit' : 'spline-control';
  const t = base(mode, id);
  let placed: Inference[] = [];
  let degree = 3;
  let closed = false;
  let last: SketchPointer | null = null;
  const word = form === 'fit' ? 'spline' : 'control-point spline';

  function curvePoly(pts: Vec2[], close: boolean): Vec2[] {
    if (pts.length < 2) return [];
    try {
      if (form === 'control' && pts.length < degree + 1) return pts;
      return splinePolyline(splineCurve({ form, degree, pts, closed: close && pts.length >= minPoints(form, degree, true) }), 16);
    } catch {
      return [];
    }
  }

  /** Whether the pointer is on the first point (a click there closes the spline). */
  function onFirst(inf: Inference, e: SketchPointer): boolean {
    if (placed.length < minPoints(form, degree, true) - 1) return false;
    const first = placed[0];
    const j = joinedPoint(first);
    if (j && joinedPoint(inf) === j) return true;
    return dist(inf.at, first.at) <= CLOSE_PX * e.px;
  }

  function show(e: SketchPointer) {
    last = e;
    const p = emptyPreview();
    const inf = t.infer(e);
    const closing = placed.length > 0 && onFirst(inf, e);
    const pts = [...placed.map((x) => x.at), ...(closing ? [] : [inf.at])];
    const poly = curvePoly(pts, closing || closed);
    for (let i = 1; i < poly.length; i++) p.lines.push([poly[i - 1], poly[i]]);
    // The control polygon, dashed (the guides layer).
    if (form === 'control') for (let i = 1; i < pts.length; i++) p.guides.push([pts[i - 1], pts[i]]);
    if (form === 'control' && (closing || closed) && pts.length > 2) p.guides.push([pts[pts.length - 1], pts[0]]);
    else if (!placed.length) p.guides.push(...inf.guides);
    p.points = pts;
    p.glyphs = closing ? [{ at: placed[0].at, kinds: ['coincident'] }] : glyphsOf(inf);
    mode.setPreview(p);
  }

  function place(close: boolean): boolean {
    const need = minPoints(form, degree, close);
    if (placed.length < need) {
      mode.note(`Not applied: a ${close ? 'closed ' : ''}${word}${form === 'control' ? ` of degree ${degree}` : ''} needs ${need} points or more`);
      return false;
    }
    const pts = [...placed];
    const deg = degree;
    placed = [];
    void mode.apply(form === 'fit' ? 'Spline' : 'Control-point spline', (d) => {
      const b = new SketchBuilder(d);
      const ids = pts.map((inf) => placePoint(b, inf));
      if (new Set(ids).size !== ids.length) return { ok: false, reason: 'a spline cannot pass through one point twice' };
      b.addEntity({ id: newId('e'), kind: 'spline', form, pts: ids, degree: form === 'fit' ? 3 : deg, ...(close ? { closed: true } : {}) });
      return b.result();
    });
    mode.setPreview(null);
    mode.note(null);
    mode.refreshHint();
    return true;
  }

  return {
    id,
    hint: () =>
      !placed.length
        ? `Click where the ${word} starts.`
        : `Click the next point (${placed.length} so far). Double-click or Enter places the ${word}; a click on its first point closes it.`,
    cancel() {
      const had = placed.length > 0;
      placed = [];
      mode.setPreview(null);
      mode.refreshHint();
      return had;
    },
    commit() {
      if (!placed.length) return false;
      place(closed);
      return true;
    },
    options(): ToolOption[] {
      const out: ToolOption[] = [];
      if (form === 'control') {
        out.push({
          kind: 'choice',
          id: 'degree',
          label: 'Degree',
          value: String(degree),
          choices: [
            { value: '3', label: '3 (cubic)' },
            { value: '5', label: '5 (quintic)' },
          ],
          set: (v) => {
            degree = v === '5' ? 5 : 3;
            if (last) show(last);
            mode.refreshHint();
          },
        });
      }
      out.push({
        kind: 'check',
        id: 'closed',
        label: 'Closed',
        value: closed,
        set: (v) => {
          closed = v;
          if (last) show(last);
          mode.refreshHint();
        },
      });
      if (placed.length) {
        const need = minPoints(form, degree, closed);
        out.push({ kind: 'button', id: 'place', label: `Place ${word}`, primary: true, disabled: placed.length < need ? `It needs ${need} points or more` : null, run: () => place(closed) });
      }
      return out;
    },
    pointer(e) {
      if (e.type === 'move') return show(e);
      if (e.type === 'leave') {
        if (!placed.length) mode.setPreview(null);
        return;
      }
      if (e.type === 'dblclick') {
        // The double-click's own clicks placed its point already.
        if (placed.length) place(closed);
        return;
      }
      if (e.type !== 'click') return;
      const inf = t.infer(e);
      if (placed.length && onFirst(inf, e)) {
        place(true);
        return;
      }
      const prev = placed[placed.length - 1];
      if (prev && (dist(prev.at, inf.at) <= 2 * e.px || (joinedPoint(prev) && joinedPoint(prev) === joinedPoint(inf)))) return;
      placed.push(inf);
      mode.note(null);
      mode.refreshHint();
      show(e);
    },
  };
}
