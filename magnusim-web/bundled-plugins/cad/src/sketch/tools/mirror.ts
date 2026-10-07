// Sketch mirror (P4b, M): pick entities (or select them first), then a mirror
// line (any line, construction or not). The copies are tied to their sources by
// Symmetric relations about that line, so they follow every later edit; a
// copied circle also gets Equal. What lies on the mirror line is shared, not
// copied: an entity wholly on it is left out, and a point on it is used by the
// copy as it is (held on the line by On line). Copies only: nothing is
// mirrored onto existing geometry.
// Owner: P4b SKETCH.
// SPDX-License-Identifier: GPL-3.0-or-later
import type { SketchEntity, Vec2 } from '../../types/doc';
import { SketchBuilder, type EditOutcome, type SketchDraft } from '../edit';
import { entityLabel, entityOf, entityPoints, lineEnds } from '../model';
import { emptyPreview, type SketchMode, type SketchTool } from '../mode';
import { hitTest, samples } from '../pick';
import { copyEntities } from './copy';
import type { ToolOption } from './options';

/** The reflection of p across the line through a, b. */
export function reflect(p: Vec2, a: Vec2, b: Vec2): Vec2 {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const l2 = dx * dx + dy * dy;
  const t = ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l2;
  const fx = a[0] + t * dx;
  const fy = a[1] + t * dy;
  return [2 * fx - p[0], 2 * fy - p[1]];
}

const onLine = (p: Vec2, a: Vec2, b: Vec2, tol: number) => {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const l = Math.hypot(dx, dy);
  return Math.abs((p[0] - a[0]) * dy - (p[1] - a[1]) * dx) / l <= tol;
};

/** The mirror edit: copies of `ids` about line `lineId`, tied by Symmetric (and Equal for circles). */
export function mirrorEntities(d: SketchDraft, ids: readonly string[], lineId: string): EditOutcome {
  const ends = lineEnds(d, lineId);
  if (!ends) return { ok: false, reason: 'Mirror about a line: that is not one' };
  const [a, b] = ends;
  if (Math.hypot(b[0] - a[0], b[1] - a[1]) < 1e-9) return { ok: false, reason: 'That line has no length' };
  let scale = 1;
  for (const p of Object.values(d.points)) scale = Math.max(scale, Math.abs(p[0]), Math.abs(p[1]));
  const tol = 1e-7 * scale;
  const bld = new SketchBuilder(d);
  const at = (id: string) => bld.point(id);
  const sources: SketchEntity[] = [];
  for (const id of ids) {
    if (id === lineId) continue;
    const e = entityOf(d, id);
    if (!e) continue;
    // A circle's centre on the line is not "on the line" for the circle (its copy would be itself).
    const pts = e.kind === 'circle' ? [] : entityPoints(e);
    const allOn = pts.length > 0 && pts.every((p) => {
      const q = at(p);
      return !!q && onLine(q, a, b, tol);
    });
    if (allOn) continue;
    if (e.kind === 'circle') {
      const c = at(e.c);
      if (c && onLine(c, a, b, tol)) continue;
    }
    sources.push(e);
  }
  if (!sources.length) return { ok: false, reason: 'nothing to mirror: what is picked lies on the mirror line' };
  const shared: string[] = [];
  const map = copyEntities(
    bld,
    sources,
    (id, p) => {
      if (onLine(p, a, b, tol)) {
        shared.push(id);
        return null;
      }
      return reflect(p, a, b);
    },
    { flip: true },
  );
  for (const [p, q] of Object.entries(map.points)) {
    if (p === q) continue;
    bld.addRelation('symmetric', [p, q, lineId]);
  }
  // A shared point stays on the line (else the copy would leave the mirror when it moves).
  for (const p of shared) {
    const has = bld.constraints.some((c) => (c.kind === 'point_on_line' || c.kind === 'coincident') && c.refs[0] === p && c.refs[1] === lineId);
    if (!has && p !== 'origin') bld.addRelation('point_on_line', [p, lineId], { optional: true });
  }
  for (const e of sources) if (e.kind === 'circle') bld.addRelation('equal', [e.id, map.entities[e.id]]);
  return { ok: true, draft: bld.result(), optional: [...bld.optional], removed: [] };
}

export function mirrorTool(mode: SketchMode): SketchTool {
  const picked = () =>
    mode
      .selected()
      .filter((h) => h.what === 'entity')
      .map((h) => h.id);
  let step: 'pick' | 'line' = picked().length ? 'line' : 'pick';

  function previewFor(lineId: string | null) {
    const d = mode.draft();
    const p = emptyPreview();
    if (d && lineId) {
      const ends = lineEnds(d, lineId);
      if (ends) {
        for (const id of picked()) {
          const e = entityOf(d, id);
          if (!e || id === lineId) continue;
          const pts = samples(d, e, 48).map((q) => reflect(q, ends[0], ends[1]));
          for (let i = 1; i < pts.length; i++) p.lines.push([pts[i - 1], pts[i]]);
          if (e.kind === 'point' && pts[0]) p.points.push(pts[0]);
        }
      }
    }
    mode.setPreview(p);
  }

  function next() {
    if (!picked().length) {
      mode.note('Not applied: pick the entities to mirror first');
      return;
    }
    step = 'line';
    mode.note(null);
    mode.refreshHint();
  }

  return {
    id: 'mirror',
    hint: () => (step === 'pick' ? 'Pick the entities to mirror (or select them first), then Enter or Next.' : 'Click the mirror line (any line, construction too).'),
    // ci2: a label or glyph clicked while picking keeps the picks (src/sketch/mode.ts refusesPick).
    refusesPick: (what) => (step === 'pick' ? `${what === 'dimension' ? 'Dimensions' : 'Relations'} can't be mirrored: pick lines, arcs, circles, splines or points` : 'Click a line to mirror about'),
    cancel() {
      if (step === 'line') {
        step = 'pick';
        mode.setPreview(null);
        mode.refreshHint();
        return true;
      }
      return false;
    },
    commit() {
      if (step === 'pick' && picked().length) {
        next();
        return true;
      }
      return step === 'line';
    },
    options(): ToolOption[] {
      const n = picked().length;
      const d = mode.draft();
      const words = d ? picked().map((id) => entityLabel(d, id)) : [];
      const out: ToolOption[] = [{ kind: 'text', id: 'picked', text: n ? `To mirror: ${words.slice(0, 4).join(', ')}${n > 4 ? ` and ${n - 4} more` : ''}` : 'Nothing picked yet' }];
      if (step === 'pick') out.push({ kind: 'button', id: 'next', label: 'Next: the mirror line', primary: true, disabled: n ? null : 'Pick the entities to mirror first', run: next });
      return out;
    },
    pointer(e) {
      const d = mode.draft();
      if (!d) return;
      if (e.type === 'move') {
        const h = hitTest(d, e.uv, e.px, { points: false });
        mode.setHover(h);
        if (step === 'line') previewFor(h && entityOf(d, h.id)?.kind === 'line' ? h.id : null);
        return;
      }
      if (e.type !== 'click') return;
      const h = hitTest(d, e.uv, e.px);
      if (step === 'pick') {
        if (h && h.what === 'entity') {
          mode.select([h], true);
          mode.note(null);
        }
        mode.refreshHint();
        return;
      }
      const line = h && h.what === 'entity' && entityOf(d, h.id)?.kind === 'line' ? h.id : null;
      if (!line) {
        mode.note('Click a line to mirror about');
        return;
      }
      const ids = picked();
      void mode.apply('Mirror', (cur) => mirrorEntities(cur, ids, line)).then((r) => {
        if (r.ok) {
          mode.select([], false);
          step = 'pick';
          mode.setPreview(null);
          mode.refreshHint();
        }
      });
    },
  };
}
