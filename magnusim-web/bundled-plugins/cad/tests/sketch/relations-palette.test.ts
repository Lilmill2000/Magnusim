// @vitest-environment node
// Daniel's first test of the CAD desktop app:
//  - the relations palette (SolidWorks' Add Relations by the selection, src/sketch/relations-palette.ts):
//    what it offers per selection, relations already there pressed, contradicting ones left out;
//    a click adds the very records the CONSTRAIN toolbar command adds (the same path), refused
//    with the same reasons, and the button then shows pressed;
//  - the construction badge's × ("Turn off construction") turns construction drawing off.
// SPDX-License-Identifier: GPL-3.0-or-later
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { CONSTRUCTION_BADGE_TEXT, createConstructionBadge, TURN_OFF_CONSTRUCTION } from '../../src/sketch/construction-badge';
import { planConstraint } from '../../src/sketch/constraints';
import { createRelationsPalette, hasRelation, relationOffers } from '../../src/sketch/relations-palette';
import type { SketchConstraint, SketchEntity, SketchFeature, Vec2 } from '../../src/types/doc';
import type { Geo } from './fixtures';
import { sketchHarness, type Harness } from './harness';

/** Two lines apart, a centerline, a circle, an arc, an ellipse, a point. */
function zoo(constraints: SketchConstraint[] = []): Geo {
  const points: Record<string, Vec2> = {
    a: [0, 0],
    b: [20, 1],
    c: [0, 10],
    d: [21, 12],
    m1: [10, -20],
    m2: [10, 40],
    cc: [50, 0],
    ac: [80, 0],
    aa: [90, 0],
    ab: [80, 10],
    q: [5, 30],
    ec: [0, -60],
    emaj: [15, -60],
    emin: [0, -54],
  };
  const entities: SketchEntity[] = [
    { id: 'l1', kind: 'line', p: ['a', 'b'] },
    { id: 'l2', kind: 'line', p: ['c', 'd'] },
    { id: 'cl', kind: 'line', p: ['m1', 'm2'], construction: true, centerline: true } as SketchEntity,
    { id: 'c1', kind: 'circle', c: 'cc', r: 5 } as SketchEntity,
    { id: 'a1', kind: 'arc', c: 'ac', a: 'aa', b: 'ab' },
    { id: 'pt', kind: 'point', p: 'q' },
    { id: 'el', kind: 'ellipse', c: 'ec', major: 'emaj', minor: 'emin' },
  ];
  return { points, entities, constraints };
}

// The sketch harness runs the real solver in Node; the palette's and the badge's elements in a jsdom document.
const JSDOM_MODULE = 'jsdom';
beforeAll(async () => {
  const { JSDOM } = (await import(/* @vite-ignore */ JSDOM_MODULE)) as { JSDOM: new (html: string) => { window: { document: Document } } };
  (globalThis as { document?: Document }).document = new JSDOM('<!doctype html><html><body></body></html>').window.document;
});

const kinds = (g: Geo, sel: string[]) => relationOffers(g, sel).map((o) => `${o.kind}${o.present ? '*' : ''}`);

describe('relationOffers: what the palette offers by the selection', () => {
  it('one line: horizontal, vertical, fix', () => {
    expect(kinds(zoo(), ['l1'])).toEqual(['horizontal', 'vertical', 'fix']);
  });
  it('two lines: parallel, perpendicular, equal, collinear (and H / V for both, and fix)', () => {
    expect(kinds(zoo(), ['l1', 'l2'])).toEqual(['horizontal', 'vertical', 'parallel', 'perpendicular', 'equal', 'collinear', 'fix']);
  });
  it('two lines and a centerline: symmetric', () => {
    expect(kinds(zoo(), ['l1', 'l2', 'cl'])).toContain('symmetric');
    // Without a centerline among them there is no axis.
    const g = zoo();
    g.entities = g.entities.map((e) => (e.id === 'cl' ? { id: 'cl', kind: 'line', p: ['m1', 'm2'] } : e));
    expect(kinds(g, ['l1', 'l2', 'cl'])).not.toContain('symmetric');
  });
  it('a point and a line: coincident, midpoint (not with the line\'s own end)', () => {
    expect(kinds(zoo(), ['pt', 'l1'])).toEqual(['coincident', 'midpoint', 'fix']);
    expect(kinds(zoo(), ['a', 'l1'])).toEqual(['fix']);
  });
  it('a line and a circle or an arc: tangent', () => {
    expect(kinds(zoo(), ['l1', 'c1'])).toEqual(['tangent', 'fix']);
    expect(kinds(zoo(), ['l1', 'a1'])).toEqual(['tangent', 'fix']);
  });
  it('two circles or arcs: tangent, equal, concentric', () => {
    expect(kinds(zoo(), ['c1', 'a1'])).toEqual(['tangent', 'equal', 'concentric', 'fix']);
  });
  it('two points: coincident, horizontal, vertical', () => {
    expect(kinds(zoo(), ['q', 'b'])).toEqual(['coincident', 'horizontal', 'vertical', 'fix']);
  });
  it('a point and a circle: coincident (on the curve); a centre and a circle: concentric is by the curves', () => {
    expect(kinds(zoo(), ['pt', 'c1'])).toEqual(['coincident', 'fix']);
    expect(kinds(zoo(), ['c1', 'a1'])).toContain('concentric');
  });
  it('an ellipse: by what the solver takes (horizontal / vertical axis; a line tangent; a point on it; concentric with a circle)', () => {
    expect(kinds(zoo(), ['el'])).toEqual(['horizontal', 'vertical', 'fix']);
    expect(kinds(zoo(), ['l1', 'el'])).toContain('tangent');
    expect(kinds(zoo(), ['pt', 'el'])).toEqual(['coincident', 'fix']);
    expect(kinds(zoo(), ['c1', 'el'])).toEqual(['concentric', 'fix']);
  });
  it('a relation already there is pressed; one that contradicts it is left out', () => {
    const g = zoo([{ id: 'h', kind: 'horizontal', refs: ['l1'] }]);
    expect(kinds(g, ['l1'])).toEqual(['horizontal*', 'fix']);
    const p = zoo([{ id: 'par', kind: 'parallel', refs: ['l2', 'l1'] }]);
    expect(kinds(p, ['l1', 'l2'])).toEqual(['horizontal', 'vertical', 'parallel*', 'equal', 'collinear', 'fix']);
    // A point already on a line (stored On line) shows Coincident pressed.
    const on = zoo([{ id: 'on', kind: 'point_on_line', refs: ['q', 'l1'] }]);
    expect(kinds(on, ['pt', 'l1'])).toEqual(['coincident*', 'midpoint', 'fix']);
  });
  it('every offer is what planConstraint plans (the toolbar command\'s plan)', () => {
    const g = zoo();
    for (const sel of [['l1'], ['l1', 'l2'], ['pt', 'l1'], ['l1', 'c1'], ['c1', 'a1'], ['q', 'b'], ['l1', 'l2', 'cl']]) {
      for (const o of relationOffers(g, sel)) expect(planConstraint(g, o.kind, sel).ok, `${o.kind} on ${sel}`).toBe(true);
    }
  });
});

describe('Symmetric of two lines or two circles about a centerline (the command and the palette)', () => {
  it('pairs each end with the other line\'s nearer mirror end', () => {
    const g: Geo = {
      points: { a: [-10, 0], b: [-20, 10], c: [21, 11], d: [10, 0], m1: [0, -5], m2: [0, 20] },
      entities: [
        { id: 'l1', kind: 'line', p: ['a', 'b'] },
        { id: 'l2', kind: 'line', p: ['c', 'd'] },
        { id: 'cl', kind: 'line', p: ['m1', 'm2'], centerline: true } as SketchEntity,
      ],
      constraints: [],
    };
    expect(planConstraint(g, 'symmetric', ['l1', 'cl', 'l2'])).toEqual({
      ok: true,
      add: [
        { kind: 'symmetric', refs: ['a', 'd', 'cl'] },
        { kind: 'symmetric', refs: ['b', 'c', 'cl'] },
      ],
    });
  });
  it('a V: the far ends mirrored, the shared end on the axis', () => {
    const g: Geo = {
      points: { o: [0, 0], b: [-10, 10], c: [10, 10], m1: [0, -5], m2: [0, 20] },
      entities: [
        { id: 'l1', kind: 'line', p: ['o', 'b'] },
        { id: 'l2', kind: 'line', p: ['o', 'c'] },
        { id: 'cl', kind: 'line', p: ['m1', 'm2'], centerline: true } as SketchEntity,
      ],
      constraints: [],
    };
    expect(planConstraint(g, 'symmetric', ['l1', 'l2', 'cl'])).toEqual({
      ok: true,
      add: [
        { kind: 'symmetric', refs: ['b', 'c', 'cl'] },
        { kind: 'point_on_line', refs: ['o', 'cl'] },
      ],
    });
  });
  it('two circles: their centres', () => {
    const g: Geo = {
      points: { c1: [-10, 0], c2: [12, 1], m1: [0, -5], m2: [0, 20] },
      entities: [
        { id: 'k1', kind: 'circle', c: 'c1', r: 3 } as SketchEntity,
        { id: 'k2', kind: 'circle', c: 'c2', r: 4 } as SketchEntity,
        { id: 'cl', kind: 'line', p: ['m1', 'm2'], centerline: true } as SketchEntity,
      ],
      constraints: [],
    };
    expect(planConstraint(g, 'symmetric', ['k1', 'k2', 'cl'])).toEqual({ ok: true, add: [{ kind: 'symmetric', refs: ['c1', 'c2', 'cl'] }] });
  });
});

describe('the palette in sketch mode (the real solver)', () => {
  let h: Harness | null = null;
  let h2: Harness | null = null;
  afterEach(() => {
    h?.dispose();
    h2?.dispose();
    h = h2 = null;
  });
  const records = (f: SketchFeature) => f.constraints.map(({ id: _id, ...rest }) => rest);

  it('a click adds the same records as the toolbar command, the selection stays, the button shows pressed and the DOF drop', async () => {
    const geo = zoo();
    h = await sketchHarness({ points: geo.points, entities: geo.entities });
    h2 = await sketchHarness({ points: geo.points, entities: geo.entities });
    const palette = createRelationsPalette(h.mode);
    const dof0 = h.mode.state.get().status?.dof ?? 0;
    for (const [sel, kind] of [
      [['l1'], 'horizontal'],
      [['l1', 'l2'], 'parallel'],
      [['pt', 'l1'], 'midpoint'],
      [['l1', 'l2', 'cl'], 'symmetric'],
      [['c1', 'a1'], 'equal'],
    ] as const) {
      const hits = sel.map((id) => ({ what: 'entity' as const, id }));
      h.mode.select(hits, false);
      expect(palette.el.hidden).toBe(false);
      const btn = palette.el.querySelector<HTMLButtonElement>(`[data-relation="${kind}"]`);
      expect(btn, `${kind} offered for ${sel}`).not.toBeNull();
      btn!.click();
      await h.idle();
      // The toolbar's command on the same selection in a twin sketch.
      h2.mode.select(hits, false);
      expect(await h2.services.commands.run(`sketch.${kind}`)).toBe(true);
      await h2.idle();
      expect(records(h.sketch())).toEqual(records(h2.sketch()));
      // The selection stays; the button now shows the relation there.
      expect(h.mode.selected().map((x) => x.id)).toEqual([...sel]);
      const now = palette.el.querySelector(`[data-relation="${kind}"]`)!;
      expect(now.getAttribute('aria-pressed')).toBe('true');
    }
    expect(h.mode.state.get().status!.dof).toBeLessThan(dof0);
    // Vertical on the horizontal line is not offered; a click on the pressed one adds nothing.
    h.mode.select([{ what: 'entity', id: 'l1' }], false);
    expect(palette.offers().map((o) => o.kind)).toEqual(['horizontal', 'fix']);
    const before = h.sketch().constraints.length;
    expect(await palette.add('horizontal')).toMatch(/already in the sketch/);
    expect(h.sketch().constraints.length).toBe(before);
    palette.dispose();
  });

  it('a record the sketch has already is never added twice (the toolbar command and the palette alike)', async () => {
    const geo = zoo([{ id: 'h', kind: 'horizontal', refs: ['l1'] }]);
    h = await sketchHarness({ points: geo.points, entities: geo.entities, constraints: geo.constraints });
    const palette = createRelationsPalette(h.mode);
    h.mode.select([{ what: 'entity', id: 'l1' }, { what: 'entity', id: 'l2' }], false);
    expect(palette.offers().find((o) => o.kind === 'horizontal')).toEqual({ kind: 'horizontal', label: 'Horizontal', present: false });
    expect(await h.services.commands.run('sketch.horizontal')).toBe(true);
    await h.idle();
    expect(h.sketch().constraints.filter((c) => c.kind === 'horizontal').map((c) => c.refs)).toEqual([['l1'], ['l2']]);
    h.mode.select([{ what: 'entity', id: 'l1' }, { what: 'entity', id: 'l2' }], false);
    expect(palette.offers().find((o) => o.kind === 'horizontal')?.present).toBe(true);
    palette.dispose();
  });

  it('refused with the command\'s reason; hidden with a drawing tool, a relation selected or nothing selected', async () => {
    const geo = zoo();
    h = await sketchHarness({ points: geo.points, entities: geo.entities });
    const palette = createRelationsPalette(h.mode);
    expect(palette.el.hidden).toBe(true);
    h.mode.select([{ what: 'entity', id: 'l1' }], false);
    expect(palette.el.hidden).toBe(false);
    // Perpendicular on one line: the command's own reason.
    const reason = h.services.commands.canRun('sketch.perpendicular');
    expect(reason).toBe('Select two lines');
    expect(await palette.add('perpendicular')).toBe(reason);
    expect(h.mode.view.get().note).toBe('Perpendicular: Select two lines');
    h.tool('line');
    expect(palette.el.hidden).toBe(true);
    h.tool('select');
    h.mode.select([{ what: 'entity', id: 'l1' }], false);
    expect(palette.el.hidden).toBe(false);
    await palette.add('horizontal');
    await h.idle();
    const rel = h.sketch().constraints.find((c) => c.kind === 'horizontal')!;
    h.mode.select([{ what: 'constraint', id: rel.id }], false);
    expect(palette.el.hidden).toBe(true);
    h.mode.select([], false);
    expect(palette.el.hidden).toBe(true);
    expect(hasRelation(h.sketch(), { kind: 'horizontal', refs: ['l1'] })).toBe(true);
    palette.dispose();
  });

  it('the construction badge: "Construction · X" while construction drawing is on; its × turns it off', async () => {
    h = await sketchHarness({});
    const badge = createConstructionBadge(h.mode);
    expect(badge.el.hidden).toBe(true);
    await h.services.commands.run('sketch.construction');
    expect(h.mode.drawConstruction).toBe(true);
    expect(badge.el.hidden).toBe(false);
    expect(badge.el.querySelector('[data-sketch-construction-text]')!.textContent).toBe(CONSTRUCTION_BADGE_TEXT);
    const x = badge.el.querySelector<HTMLButtonElement>('button')!;
    expect(x.getAttribute('aria-label')).toBe(TURN_OFF_CONSTRUCTION);
    x.click();
    expect(h.mode.drawConstruction).toBe(false);
    expect(badge.el.hidden).toBe(true);
    badge.dispose();
  });
});
