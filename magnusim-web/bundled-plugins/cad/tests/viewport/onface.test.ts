// E2, "the colour follows what's under it" (src/viewport/onface.ts): one stencil bit says a light
// surface shows here; the section caps' parity counter never touches it; bodies set or clear it
// (a dark custom colour is not a light surface); the marks that have a face ink or face colours
// are drawn twice, the mark over the background and a twin (its child, its geometry, a copy of
// its material in the face ink) over light surfaces, following the mark's material, geometry and
// look; in light nothing is restricted and no twin is drawn.
// SPDX-License-Identifier: GPL-3.0-or-later
import { AlwaysStencilFunc, BufferGeometry, DecrementWrapStencilOp, EqualStencilFunc, Float32BufferAttribute, Group, IncrementWrapStencilOp, KeepStencilOp, Line, LineBasicMaterial, Mesh, MeshBasicMaterial, NotEqualStencilFunc, Plane, Points, PointsMaterial, ReplaceStencilOp, SphereGeometry, Vector3, type Material, type Object3D } from 'three';
import { LineMaterial } from 'three/examples/jsm/lines/LineMaterial.js';
import { LineSegments2 } from 'three/examples/jsm/lines/LineSegments2.js';
import { LineSegmentsGeometry } from 'three/examples/jsm/lines/LineSegmentsGeometry.js';
import { describe, expect, it } from 'vitest';
import { BODY_COLOR, BODY_SELECTED_COLOR, HOVER_COLOR, PICK_COLOR } from '../../src/viewport/colors';
import { createBodyMaterial } from '../../src/viewport/materials';
import { drawOnly, FACE_BIT, faceColoursOf, faceInkOf, isFaceTwin, isLightSurface, PARITY_MASK, setFaceColours, setFaceInk, surfaceStencil, syncFaceTwins } from '../../src/viewport/onface';
import { SectionCaps } from '../../src/viewport/section';

const twinOf = (o: Object3D) => o.children.find(isFaceTwin) as (Object3D & { material: Material & { color: { getHex(): number } }; geometry: BufferGeometry }) | undefined;

describe('the stencil bits', () => {
  it('gives the face bit and the section parity count bits of their own', () => {
    expect(FACE_BIT & PARITY_MASK).toBe(0);
    expect(FACE_BIT | PARITY_MASK).toBe(0xff);
    expect(FACE_BIT).toBe(0x80);
  });

  it('keeps the section caps\' parity meshes to the count bits, the cap tests them only, and sets the face bit only in dark', () => {
    const caps = new SectionCaps(1);
    const g = new SphereGeometry(1);
    caps.setBodies([{ key: 'b|1', geometry: g, visible: true }], new Plane(new Vector3(0, 0, 1), 0));
    const meshes = caps.group.children.filter((o) => o.name === 'section-stencil') as Mesh[];
    expect(meshes).toHaveLength(2);
    for (const m of meshes) {
      const mat = m.material as MeshBasicMaterial;
      expect(mat.stencilWrite).toBe(true);
      expect(mat.stencilWriteMask).toBe(PARITY_MASK);
      expect(mat.stencilFunc).toBe(AlwaysStencilFunc);
      expect([IncrementWrapStencilOp, DecrementWrapStencilOp]).toContain(mat.stencilZPass);
    }
    const cap = (caps.group.children.find((o) => o.name === 'section-cap') as Mesh).material as Material;
    // Light: where the count is not 0, drawn, it writes 0 as before (the face bit is never set in light).
    expect([cap.stencilFunc, cap.stencilFuncMask, cap.stencilRef, cap.stencilWriteMask]).toEqual([NotEqualStencilFunc, PARITY_MASK, 0, 0xff]);
    expect([cap.stencilFail, cap.stencilZFail, cap.stencilZPass]).toEqual([KeepStencilOp, ReplaceStencilOp, ReplaceStencilOp]);
    // Dark: the cap (a light surface) sets the face bit where it shows, and leaves it where it is hidden.
    caps.setFaceBit(true);
    expect([cap.stencilFunc, cap.stencilFuncMask, cap.stencilRef]).toEqual([NotEqualStencilFunc, PARITY_MASK, FACE_BIT]);
    expect([cap.stencilFail, cap.stencilZFail, cap.stencilZPass]).toEqual([KeepStencilOp, KeepStencilOp, ReplaceStencilOp]);
    // The cap's test reads the count only: the face bit a body set never makes a cap.
    expect(FACE_BIT & cap.stencilFuncMask).toBe(0);
    caps.setFaceBit(false);
    expect(cap.stencilRef).toBe(0);
    caps.dispose();
    g.dispose();
  });

  it("writes the face bit from a body's faces (set, or cleared for a dark colour), never the count; off leaves the stencil", () => {
    const m = createBodyMaterial(BODY_COLOR);
    expect(m.stencilWrite).toBe(false);
    surfaceStencil(m, 'mark');
    expect([m.stencilWrite, m.stencilFunc, m.stencilRef, m.stencilWriteMask]).toEqual([true, AlwaysStencilFunc, FACE_BIT, FACE_BIT]);
    expect([m.stencilFail, m.stencilZFail, m.stencilZPass]).toEqual([KeepStencilOp, KeepStencilOp, ReplaceStencilOp]);
    expect(m.stencilWriteMask & PARITY_MASK).toBe(0);
    surfaceStencil(m, 'clear');
    expect([m.stencilWrite, m.stencilRef, m.stencilWriteMask, m.stencilZPass]).toEqual([true, 0, FACE_BIT, ReplaceStencilOp]);
    surfaceStencil(m, 'off');
    expect(m.stencilWrite).toBe(false);
  });

  it('calls a body colour a light surface when the light view\'s ink reads at least as well on it as the dark view\'s', () => {
    for (const c of [BODY_COLOR, 0xffffff, PICK_COLOR, HOVER_COLOR, BODY_SELECTED_COLOR, 0xf5d742, 0xe07a5f]) expect(isLightSurface(c), c.toString(16)).toBe(true);
    for (const c of [0x1d2939, 0x000000, 0x1b1f27, 0x3a2a6b, 0xd02828]) expect(isLightSurface(c), c.toString(16)).toBe(false);
  });

  it('restricts a mark to pixels with the bit or without it, writing nothing, and gives back only what it restricted', () => {
    const m = new LineBasicMaterial();
    drawOnly(m, 'ground');
    expect([m.stencilWrite, m.stencilWriteMask, m.stencilFunc, m.stencilRef, m.stencilFuncMask]).toEqual([true, 0, EqualStencilFunc, 0, FACE_BIT]);
    expect([m.stencilFail, m.stencilZFail, m.stencilZPass]).toEqual([KeepStencilOp, KeepStencilOp, KeepStencilOp]);
    drawOnly(m, 'face');
    expect([m.stencilRef, m.stencilFuncMask, m.stencilWriteMask]).toEqual([FACE_BIT, FACE_BIT, 0]);
    drawOnly(m, null);
    expect(m.stencilWrite).toBe(false);
    // A material with a stencil of its own (a section cap's) is never touched by `null`.
    const own = new MeshBasicMaterial({ stencilWrite: true });
    drawOnly(own, null);
    expect(own.stencilWrite).toBe(true);
  });
});

describe('the twins', () => {
  function line(color: number) {
    const g = new BufferGeometry();
    g.setAttribute('position', new Float32BufferAttribute([0, 0, 0, 1, 0, 0], 3));
    return new Line(g, new LineBasicMaterial({ color, transparent: true, depthTest: false }));
  }

  it('draws a mark with a face ink twice in dark: itself over the background, a twin in the face ink over light surfaces', () => {
    const root = new Group();
    const l = line(0x8fb5ff);
    l.renderOrder = 60;
    root.add(l);
    setFaceInk(l.material, 0x1a4fbf);
    expect(faceInkOf(l.material)).toBe(0x1a4fbf);
    syncFaceTwins(root, true);
    const t = twinOf(l)!;
    expect(t).toBeTruthy();
    expect(t.visible).toBe(true);
    expect((t as unknown as Line).isLine).toBe(true);
    expect(t.geometry).toBe(l.geometry);
    expect(t.material).not.toBe(l.material);
    expect(t.material.color.getHex()).toBe(0x1a4fbf);
    expect((l.material as LineBasicMaterial).color.getHex()).toBe(0x8fb5ff);
    expect([t.material.transparent, t.material.depthTest]).toEqual([true, false]);
    expect(t.renderOrder).toBe(60);
    // The mark over the background, its twin over a light surface.
    expect([l.material.stencilWrite, l.material.stencilRef, l.material.stencilFunc]).toEqual([true, 0, EqualStencilFunc]);
    expect([t.material.stencilWrite, t.material.stencilRef, t.material.stencilFunc]).toEqual([true, FACE_BIT, EqualStencilFunc]);
    // A twin is never picked and is never twinned itself (one per mark, however many syncs).
    const hits: unknown[] = [];
    t.raycast({} as never, hits as never);
    expect(hits).toEqual([]);
    syncFaceTwins(root, true);
    expect(l.children.filter(isFaceTwin)).toHaveLength(1);
    expect(t.children).toHaveLength(0);
    // Light: drawn once, as it is.
    syncFaceTwins(root, false);
    expect(t.visible).toBe(false);
    expect(l.material.stencilWrite).toBe(false);
  });

  it('follows the mark: a material swap (hover: no face ink, drawn once), a new face ink, a geometry, its look', () => {
    const root = new Group();
    const g = new LineSegmentsGeometry();
    g.setPositions([0, 0, 0, 1, 0, 0]);
    const rest = new LineMaterial({ color: 0x7aa7ff, linewidth: 1.6, dashed: true, transparent: true, opacity: 0.95 });
    const hover = new LineMaterial({ color: HOVER_COLOR, linewidth: 2.6 });
    setFaceInk(rest, 0x2f5fb8);
    const axis = new LineSegments2(g, rest);
    root.add(axis);
    syncFaceTwins(root, true);
    const t = twinOf(axis)! as unknown as LineSegments2 & { material: LineMaterial };
    expect((t as LineSegments2).isLineSegments2).toBe(true);
    expect([t.material.dashed, t.material.linewidth, t.material.opacity, t.material.color.getHex()]).toEqual([true, 1.6, 0.95, 0x2f5fb8]);
    // The dash follows the zoom, the width and the clipping (a section) too.
    rest.dashSize = 14;
    rest.gapSize = 5;
    rest.linewidth = 2;
    const cut = [new Plane(new Vector3(0, 0, 1), 0)];
    rest.clippingPlanes = cut;
    syncFaceTwins(root, true);
    expect([t.material.dashSize, t.material.gapSize, t.material.linewidth, t.material.clippingPlanes]).toEqual([14, 5, 2, cut]);
    // Hovered: one line in the hover blue, as it is everywhere (it reads on both).
    axis.material = hover;
    syncFaceTwins(root, true);
    expect(t.visible).toBe(false);
    expect(hover.stencilWrite).toBe(false);
    axis.material = rest;
    syncFaceTwins(root, true);
    expect(t.visible).toBe(true);
    expect(t.material.color.getHex()).toBe(0x2f5fb8);
    // A new palette's face ink, and a new geometry.
    setFaceInk(rest, 0x123456);
    const g2 = new LineSegmentsGeometry();
    g2.setPositions([0, 0, 0, 0, 1, 0]);
    axis.geometry = g2;
    syncFaceTwins(root, true);
    expect([t.material.color.getHex(), t.geometry]).toEqual([0x123456, g2]);
    // No face ink any more (light): drawn once.
    setFaceInk(rest, null);
    syncFaceTwins(root, true);
    expect(t.visible).toBe(false);
    expect(rest.stencilWrite).toBe(false);
  });

  it('gives a mark coloured per segment or point a twin with its face colours, gone with its geometry', () => {
    const root = new Group();
    const pos = new Float32BufferAttribute([0, 0, 0, 1, 1, 0], 3);
    const g = new BufferGeometry().setAttribute('position', pos).setAttribute('color', new Float32BufferAttribute([1, 1, 1, 0.5, 0.5, 1], 3));
    const face = new BufferGeometry().setAttribute('position', pos).setAttribute('color', new Float32BufferAttribute([0, 0, 0, 0, 0, 1], 3));
    const mat = new PointsMaterial({ size: 7, vertexColors: true, transparent: true });
    mat.defines = { ROUND_POINTS: '' };
    const dots = new Points(g, mat);
    root.add(dots);
    setFaceColours(g, face);
    expect(faceColoursOf(g)).toBe(face);
    syncFaceTwins(root, true);
    const t = twinOf(dots)!;
    expect(t.geometry).toBe(face);
    // The same material, copied: vertex colours, its size, its own shader edit (round points).
    const tm = t.material as PointsMaterial;
    expect([tm.vertexColors, tm.size, tm.color.getHex(), (tm.defines as Record<string, string>).ROUND_POINTS]).toEqual([true, 7, 0xffffff, '']);
    // The source geometry's dispose takes its face colours with it.
    let gone = false;
    face.addEventListener('dispose', () => (gone = true));
    g.dispose();
    expect(gone).toBe(true);
    expect(faceColoursOf(g)).toBeUndefined();
    // A new set of face colours replaces (and disposes) the old one.
    const g2 = new BufferGeometry().setAttribute('position', pos);
    const f1 = new BufferGeometry();
    const f2 = new BufferGeometry();
    let f1gone = false;
    f1.addEventListener('dispose', () => (f1gone = true));
    setFaceColours(g2, f1);
    setFaceColours(g2, f2);
    expect([f1gone, faceColoursOf(g2)]).toEqual([true, f2]);
  });

  it("disposes a twin's material with the mark's, and shares one twin material between marks of one material", () => {
    const root = new Group();
    const mat = new MeshBasicMaterial({ color: 0x7aa7ff });
    setFaceInk(mat, 0x2f5fb8);
    const a = new Mesh(new SphereGeometry(1), mat);
    const b = new Mesh(a.geometry, mat);
    b.position.set(5, 0, 0);
    root.add(a, b);
    syncFaceTwins(root, true);
    const ta = twinOf(a)!;
    const tb = twinOf(b)!;
    expect(ta.material).toBe(tb.material);
    // A child: it is where its mark is, and shows only while its mark does.
    expect(tb.parent).toBe(b);
    expect(tb.position.toArray()).toEqual([0, 0, 0]);
    let gone = false;
    ta.material.addEventListener('dispose', () => (gone = true));
    mat.dispose();
    expect(gone).toBe(true);
  });
});
