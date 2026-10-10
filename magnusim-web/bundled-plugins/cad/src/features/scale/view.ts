// The banana in the viewport (ux010): an overlay layer of its own (never a body: not in the
// bodies, the picking BVHs, Measure, box selection, the export or the linked geometry), framed by
// Fit while it is shown, and a pointer tool that drags it on its own height in model mode. A press
// on it never starts an orbit or a box (the tool takes the press first); the hover shows the open
// hand, a drag the closed one (sketch mode's hand cursors, src/sketch/cursors.ts). Right-click on
// it: Remove banana. Its place is kept with the Part's view (DocService.setScaleModel).
// Owner: TOOLBAR builder (ux010).
// SPDX-License-Identifier: GPL-3.0-or-later
import { BufferAttribute, BufferGeometry, DoubleSide, Line, LineBasicMaterial, Matrix4, Mesh, Ray, ShaderMaterial, Vector3 } from 'three';
import { MeshBVH } from 'three-mesh-bvh';
import { sketchCursor } from '../../sketch/cursors';
import type { AppServices } from '../../types/app';
import type { ScaleModelPlace, Vec3 } from '../../types/doc';
import type { OverlayLayer, ViewportHandle, ViewportPointer, ViewportTool } from '../../types/viewport';
import { uiFor } from '../../ui/controller';
import { BODY_LIGHT } from '../../viewport/colors';
import { loadBanana, type BananaMesh } from './banana-mesh';
import type { BBox } from '../../types/kernel-protocol';
import { halfFootprint, leashOf, nearestSlot, onLeash3, placeBeside, placedBox, rayOnPlane, slotsAround, unionBox, type Slot } from './placement';

export const BANANA_LAYER = 'scale-banana';
/** A number for the test hooks, 3 decimals, never "-0.000". */
const fixed = (v: number): string => (Math.abs(v) < 5e-4 ? 0 : v).toFixed(3);

/** A slot snaps the banana when its centre comes this close on screen (CSS px). */
export const SNAP_PX = 12;

/** The boxes the banana is placed beside: the shown bodies' (all bodies' when none is shown). */
export function bodyBoxes(services: AppServices): BBox[] {
  const bodies = services.doc.state.get().rebuild.bodies;
  const visible = bodies.filter((b) => b.visible);
  return (visible.length ? visible : bodies).map((b) => b.bbox);
}

const VS = /* glsl */ `
attribute vec3 bcol;
varying vec3 vNormalV;
varying vec3 vCol;
void main() {
  vNormalV = normalize(normalMatrix * normal);
  vCol = bcol;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;
// Lit as the bodies are (a headlight, two-sided), in its own colours; a hovered banana is lighter.
const FS = /* glsl */ `
uniform float uAmbient;
uniform float uDiffuse;
uniform float uSpecular;
uniform float uPower;
uniform float uHover;
varying vec3 vNormalV;
varying vec3 vCol;
void main() {
  vec3 n = normalize(vNormalV);
  if (!gl_FrontFacing) n = -n;
  float df = max(0.0, n.z);
  float sf = pow(df, uPower);
  vec3 c = vCol;
  vec3 lit = c * (uAmbient + 0.18) + df * c * uDiffuse + sf * vec3(1.0) * uSpecular * 0.6;
  gl_FragColor = vec4(mix(lit, vec3(1.0), uHover * 0.18), 1.0);
}
`;

interface Shown {
  layer: OverlayLayer;
  mesh: Mesh;
  /** The faint line along the side of the part the banana snapped to (while dragging). */
  guide: Line;
  bvh: MeshBVH;
  data: BananaMesh;
  place: ScaleModelPlace;
  popTool: () => void;
  canvas: HTMLCanvasElement | null;
}

/** Show the banana while the view says so; returns the uninstall. */
export function installBananaView(services: AppServices): () => void {
  let shown: Shown | null = null;
  let handle: ViewportHandle | null = null;
  let token = 0;
  let geometry: { geo: BufferGeometry; bvh: MeshBVH; data: BananaMesh } | null = null;
  const material = new ShaderMaterial({
    vertexShader: VS,
    fragmentShader: FS,
    side: DoubleSide,
    uniforms: {
      uAmbient: { value: BODY_LIGHT.ambient },
      uDiffuse: { value: BODY_LIGHT.diffuse },
      uSpecular: { value: BODY_LIGHT.specular },
      uPower: { value: BODY_LIGHT.power },
      uHover: { value: 0 },
    },
  });

  // The snap guide: faint, over everything (a hint, not geometry).
  const guideMaterial = new LineBasicMaterial({ color: 0x1570ef, transparent: true, opacity: 0.55, depthTest: false });
  const placeOf = (): ScaleModelPlace | null => services.doc.state.get().view.scaleModels?.banana ?? null;

  const geometryOf = (data: BananaMesh) => {
    if (geometry?.data === data) return geometry;
    const geo = new BufferGeometry();
    geo.setAttribute('position', new BufferAttribute(data.positions, 3));
    geo.setAttribute('normal', new BufferAttribute(data.normals, 3));
    geo.setAttribute('bcol', new BufferAttribute(data.colors, 3));
    geo.setIndex(new BufferAttribute(data.indices, 1));
    geo.computeBoundingBox();
    geo.computeBoundingSphere();
    geometry = { geo, bvh: new MeshBVH(geo), data };
    return geometry;
  };

  const put = (s: Shown, place: ScaleModelPlace) => {
    s.place = place;
    s.mesh.position.set(place.at[0], place.at[1], place.at[2]);
    s.mesh.rotation.set(0, 0, (place.rot * Math.PI) / 180);
    s.mesh.updateMatrixWorld(true);
    const box = placedBox(place, s.data);
    s.layer.html.dataset.bananaAt = place.at.map(fixed).join(' ');
    s.layer.html.dataset.bananaBox = box.map(fixed).join(' ');
    s.layer.changed();
  };

  /** The point of the banana under the pointer's ray (model mm), or null. */
  const hitOf = (s: Shown, ray: { origin: Vec3; dir: Vec3 }): Vector3 | null => {
    const inv = new Matrix4().copy(s.mesh.matrixWorld).invert();
    const local = new Ray(new Vector3(...ray.origin), new Vector3(...ray.dir)).applyMatrix4(inv);
    const hit = s.bvh.raycastFirst(local, DoubleSide);
    return hit ? hit.point.clone().applyMatrix4(s.mesh.matrixWorld) : null;
  };

  let cursorSet = '';
  const cursor = (s: Shown, c: '' | 'grab' | 'grabbing') => {
    if (!s.canvas || c === cursorSet) return;
    cursorSet = c;
    s.canvas.style.cursor = c ? sketchCursor(c) : '';
    s.layer.html.dataset.bananaCursor = c || 'none';
  };
  const hover = (s: Shown, on: boolean) => {
    const v = on ? 1 : 0;
    if (material.uniforms.uHover.value === v) return;
    material.uniforms.uHover.value = v;
    s.layer.html.dataset.bananaHover = on ? '1' : '0';
    s.layer.changed();
  };

  /** Where the banana goes after a turn: beside the part, the slot nearest it for its new footprint. */
  const besideBox = (s: Shown, rot: number): [number, number] | null => {
    const box = unionBox(bodyBoxes(services));
    if (!box) return null;
    const slot = nearestSlot(slotsAround(box, halfFootprint(s.data, rot)), [s.place.at[0], s.place.at[1]]);
    return slot ? slot.at : null;
  };

  const showGuide = (s: Shown, slot: Slot | null, box: BBox | null, z: number) => {
    const g = s.guide;
    if (!slot || !box) {
      if (g.visible) {
        g.visible = false;
        s.layer.changed();
      }
      delete s.layer.html.dataset.bananaGuide;
      return;
    }
    const [hx, hy] = halfFootprint(s.data, s.place.rot);
    const [cx, cy] = slot.at;
    // Along the side of the part it lies beside, as long as the part and the banana together.
    const side = slot.name.slice(0, 2);
    const pts =
      side === '+x' || side === '-x'
        ? [
            [side === '+x' ? box[3] : box[0], Math.min(box[1], cy - hy), z],
            [side === '+x' ? box[3] : box[0], Math.max(box[4], cy + hy), z],
          ]
        : [
            [Math.min(box[0], cx - hx), side === '+y' ? box[4] : box[1], z],
            [Math.max(box[3], cx + hx), side === '+y' ? box[4] : box[1], z],
          ];
    const pos = g.geometry.getAttribute('position') as BufferAttribute;
    pos.setXYZ(0, pts[0][0], pts[0][1], pts[0][2]);
    pos.setXYZ(1, pts[1][0], pts[1][1], pts[1][2]);
    pos.needsUpdate = true;
    g.geometry.computeBoundingSphere();
    g.visible = true;
    s.layer.html.dataset.bananaGuide = '1';
    s.layer.changed();
  };

  const toolFor = (s: Shown): ViewportTool => {
    type Drag = {
      /** The banana's place once on the drag plane, and its grabbed point there. */
      at0: Vec3;
      grab0: Vec3;
      /** The drag plane: through the grabbed point, parallel to the screen (normal: the view direction). */
      normal: Vec3;
      moved: boolean;
      /** The banana's centre above its underside point `at` (its middle height). */
      lift: number;
      box: BBox;
      hasBodies: boolean;
      reach: number;
      slots: Slot[];
    };
    let drag: Drag | null = null;
    let swallowClick = false;
    const screenOf = (p: Vec3): [number, number] | null => handle?.project(p) ?? null;
    const viewDir = (): Vec3 | null => {
      const cam = handle?.camera();
      if (!cam) return null;
      const d: Vec3 = [cam.target[0] - cam.position[0], cam.target[1] - cam.position[1], cam.target[2] - cam.position[2]];
      const l = Math.hypot(...d);
      return l > 0 ? [d[0] / l, d[1] / l, d[2] / l] : null;
    };
    return {
      id: 'scale-banana',
      onPointer(e: ViewportPointer) {
        // Model mode only: in sketch mode the banana is only drawn.
        if (services.mode.get().mode !== 'model' && !drag) return false;
        if (drag) {
          if (e.type === 'move') {
            const d = drag;
            // The grabbed point follows the pointer on the screen-parallel plane (it may leave the ground).
            const q = rayOnPlane(e.ray, d.grab0, d.normal);
            if (!q) return true;
            let at: Vec3 = [d.at0[0] + q[0] - d.grab0[0], d.at0[1] + q[1] - d.grab0[1], d.at0[2] + q[2] - d.grab0[2]];
            // The leash round the part, in 3D (it slides along its limit).
            const c = onLeash3([at[0], at[1], at[2] + d.lift], d.box, d.reach);
            at = [c[0], c[1], c[2] - d.lift];
            // The magnet slots beside the part, on its ground (not with Alt): by their place on screen.
            let snapped: Slot | null = null;
            if (!e.alt && d.hasBodies) {
              const sc = screenOf(at);
              let best = SNAP_PX;
              for (const slot of d.slots) {
                const ss = screenOf([slot.at[0], slot.at[1], d.box[2]]);
                if (!sc || !ss) continue;
                const dist = Math.hypot(ss[0] - sc[0], ss[1] - sc[1]);
                if (dist <= best) {
                  best = dist;
                  snapped = slot;
                }
              }
            }
            if (snapped) at = [snapped.at[0], snapped.at[1], d.box[2]];
            d.moved = true;
            put(s, { at, rot: s.place.rot });
            showGuide(s, snapped, d.hasBodies ? d.box : null, d.box[2]);
            s.layer.html.dataset.bananaSnap = snapped ? snapped.name : '';
            const g: Vec3 = [at[0] + d.grab0[0] - d.at0[0], at[1] + d.grab0[1] - d.at0[1], at[2] + d.grab0[2] - d.at0[2]];
            s.layer.html.dataset.bananaGrab = g.map(fixed).join(' ');
            return true;
          }
          if (e.type === 'up' || e.type === 'leave') {
            const d = drag;
            drag = null;
            swallowClick = e.type === 'up';
            cursor(s, e.type === 'up' && hitOf(s, e.ray) ? 'grab' : '');
            showGuide(s, null, null, 0);
            // One write of the view per drag, at the release (a full 3D place, and the turn).
            if (d.moved) services.doc.setScaleModel('banana', s.place);
            delete s.layer.html.dataset.bananaDragging;
            return true;
          }
          return true;
        }
        if (e.type === 'click' && swallowClick) {
          swallowClick = false;
          return true;
        }
        swallowClick = false;
        const hit = e.type === 'down' || e.type === 'move' || e.type === 'contextmenu' || e.type === 'dblclick' || e.type === 'click' ? hitOf(s, e.ray) : null;
        if (e.type === 'down' && e.button === 0 && hit) {
          const normal = viewDir();
          if (!normal) return true;
          const lift = (s.data.min[2] + s.data.max[2]) / 2;
          const box = unionBox(bodyBoxes(services));
          // Daniel: "have it move on the plane parallel to the screen, but the plane is coincident
          // with the banana": the plane through the grabbed point, normal along the view direction;
          // nothing moves on the press, and the banana keeps its depth while dragged.
          drag = {
            at0: [s.place.at[0], s.place.at[1], s.place.at[2]],
            grab0: [hit.x, hit.y, hit.z],
            normal,
            moved: false,
            lift,
            box: box ?? [0, 0, 0, 0, 0, 0],
            hasBodies: !!box,
            reach: leashOf(box),
            slots: box ? slotsAround(box, halfFootprint(s.data, s.place.rot)) : [],
          };
          s.layer.html.dataset.bananaDragging = '1';
          s.layer.html.dataset.bananaGrab = drag.grab0.map(fixed).join(' ');
          s.layer.html.dataset.bananaLeash = drag.reach.toFixed(3);
          cursor(s, 'grabbing');
          return true;
        }
        if (e.type === 'move' && !e.buttons) {
          hover(s, !!hit);
          cursor(s, hit ? 'grab' : '');
          return !!hit;
        }
        if (e.type === 'leave') {
          hover(s, false);
          cursor(s, '');
          return false;
        }
        if (e.type === 'contextmenu' && hit) {
          uiFor(services).showMenu(
            e.clientX,
            e.clientY,
            [
              { id: 'banana-place', label: 'Place next to part', run: () => services.doc.setScaleModel('banana', placeBeside(bodyBoxes(services), s.data)) },
              {
                id: 'banana-turn',
                label: 'Turn 90°',
                run: () => {
                  const rot = (s.place.rot + 90) % 360;
                  const at = besideBox(s, rot);
                  const box = unionBox(bodyBoxes(services));
                  // Beside the part, on its ground; with no body, turned where it is.
                  services.doc.setScaleModel('banana', { at: at && box ? [at[0], at[1], box[2]] : [s.place.at[0], s.place.at[1], s.place.at[2]], rot });
                },
              },
              { sep: true, id: 'banana-sep' },
              { id: 'banana-remove', label: 'Remove banana', run: () => services.doc.setScaleModel('banana', null) },
            ],
            'Banana for scale',
          );
          return true;
        }
        // A click or double-click on it is its own: it never selects or edits the body behind it.
        return (e.type === 'click' || e.type === 'dblclick') && !!hit;
      },
    };
  };

  const hide = () => {
    token++;
    if (!shown) return;
    const s = shown;
    shown = null;
    cursor(s, '');
    cursorSet = '';
    material.uniforms.uHover.value = 0;
    s.popTool();
    s.layer.group.remove(s.mesh);
    s.layer.group.remove(s.guide);
    s.guide.geometry.dispose();
    s.layer.dispose();
  };

  const sync = () => {
    const place = placeOf();
    if (!place || !handle) return hide();
    if (shown) {
      if (JSON.stringify(shown.place) !== JSON.stringify(place) && !shown.layer.html.dataset.bananaDragging) put(shown, place);
      return;
    }
    const mine = ++token;
    const h = handle;
    void loadBanana().then(
      (data) => {
        if (mine !== token || shown || handle !== h) return;
        const now = placeOf();
        if (!now) return;
        const g = geometryOf(data);
        const mesh = new Mesh(g.geo, material);
        mesh.name = 'banana-for-scale';
        let box = placedBox(now, data);
        const layer = h.addLayer(BANANA_LAYER, {
          order: 1,
          frame: () => {
            if (!shown) return null;
            box = placedBox(shown.place, data);
            return { min: [box[0], box[1], box[2]], max: [box[3], box[4], box[5]] };
          },
        });
        layer.group.add(mesh);
        const guideGeo = new BufferGeometry();
        guideGeo.setAttribute('position', new BufferAttribute(new Float32Array(6), 3));
        const guide = new Line(guideGeo, guideMaterial);
        guide.visible = false;
        guide.renderOrder = 2;
        guide.frustumCulled = false;
        layer.group.add(guide);
        layer.html.dataset.banana = 'shown';
        const canvas = layer.html.parentElement?.querySelector<HTMLCanvasElement>('canvas') ?? null;
        const s: Shown = { layer, mesh, guide, bvh: g.bvh, data, place: now, popTool: () => {}, canvas };
        shown = s;
        put(s, now);
        s.popTool = h.pushTool(toolFor(s));
      },
      (err: unknown) => {
        if (mine !== token) return;
        services.bridge.toast(`The banana could not be shown: ${err instanceof Error ? err.message : String(err)}`, 'error');
      },
    );
  };

  const offView = services.doc.state.subscribe(() => sync());
  const offHandle = services.viewport.subscribe((st) => {
    if (st.handle === handle) return;
    hide();
    handle = st.handle;
    sync();
  });
  handle = services.viewport.get().handle;
  sync();
  return () => {
    offView();
    offHandle();
    hide();
    geometry?.geo.dispose();
    material.dispose();
    guideMaterial.dispose();
  };
}
