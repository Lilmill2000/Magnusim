// The orientation triad, drawn bottom-right in its own 72 px viewport like the
// core's vtkOrientationMarkerWidget (runtime.js:1113-1133): vtkAxesActor arrows
// (shaft radius .03, tip radius .1, tip length .2, length 1; AxesActor.js
// defaults, recenter false) in X/Y/Z colours, lit by a headlight with the
// mapper defaults (ambient 0, diffuse 1), and a camera that copies the main
// view's orientation and frames the arrows' bounds (resetCamera). Its colours and lighting
// follow the view's palette (setColors, setLight: the host's dark axis colours with some ambient
// in a dark view, so an arrow pointing at the eye still reads; LIGHT, the core's, in a picture).
// Owner: VIEWPORT.
// SPDX-License-Identifier: GPL-3.0-or-later
import { BufferAttribute, ConeGeometry, CylinderGeometry, Group, Mesh, PerspectiveCamera, Quaternion, Scene, Vector3 } from 'three';
import { createBodyMaterial, setBodyColor, type BodyMaterial } from './materials';
import { FOV_DEG, TRIAD_COLORS } from './colors';

const SHAFT_R = 0.03;
export const TIP_R = 0.1;
export const TIP_LEN = 0.2;

export class Triad {
  readonly scene = new Scene();
  readonly camera = new PerspectiveCamera(FOV_DEG, 1, 0.01, 100);
  private readonly center = new Vector3(0.45, 0.45, 0.45);
  private readonly distance: number;
  /** The X, Y and Z arrows' materials (each arrow's shaft and tip share one). */
  private readonly mats: BodyMaterial[] = [];

  constructor(colors: readonly [number, number, number] = TRIAD_COLORS) {
    const g = new Group();
    const axes: [Vector3, number][] = [
      [new Vector3(1, 0, 0), colors[0]],
      [new Vector3(0, 1, 0), colors[1]],
      [new Vector3(0, 0, 1), colors[2]],
    ];
    for (const [dir, color] of axes) {
      const mat = createBodyMaterial(color, { ambient: 0, diffuse: 1, specular: 0, power: 1 });
      mat.polygonOffset = false;
      this.mats.push(mat);
      const shaft = new Mesh(new CylinderGeometry(SHAFT_R, SHAFT_R, 1 - TIP_LEN, 24), mat);
      shaft.position.set(0, (1 - TIP_LEN) / 2, 0);
      const tip = new Mesh(new ConeGeometry(TIP_R, TIP_LEN, 32), mat);
      tip.position.set(0, 1 - TIP_LEN / 2, 0);
      const arrow = new Group();
      arrow.add(shaft, tip);
      // Cylinder/cone geometry runs along +Y: turn +Y onto the axis.
      arrow.quaternion.copy(new Quaternion().setFromUnitVectors(new Vector3(0, 1, 0), dir));
      for (const m of [shaft, tip]) m.geometry.setAttribute('hl', new BufferAttribute(new Uint8Array(m.geometry.getAttribute('position').count), 1));
      g.add(arrow);
    }
    this.scene.add(g);
    // Bounds of the arrows: [-tipR, 1] on each axis; centre .45, radius = half diagonal.
    const half = (1 + TIP_R) / 2;
    this.center.setScalar(1 - half);
    const radius = Math.sqrt(3) * half;
    this.distance = radius / Math.sin((FOV_DEG * Math.PI) / 360);
  }

  /** The arrows' colours, X, Y, Z (a uniform each: nothing is rebuilt). */
  setColors(colors: readonly [number, number, number]): void {
    this.mats.forEach((m, i) => setBodyColor(m, colors[i]));
  }

  /** How the arrows are lit: ambient + diffuse * the headlight's angle (uniforms only). */
  setLight(light: { ambient: number; diffuse: number }): void {
    for (const m of this.mats) {
      m.uniforms.uAmbient.value = light.ambient;
      m.uniforms.uDiffuse.value = light.diffuse;
    }
  }

  /** The arrows' lighting now (tests). */
  light(): { ambient: number; diffuse: number } {
    const u = this.mats[0].uniforms;
    return { ambient: u.uAmbient.value, diffuse: u.uDiffuse.value };
  }

  /** The arrows' colours now (tests). */
  colors(): [number, number, number] {
    return this.mats.map((m) => {
      const v = m.uniforms.uColor.value;
      return (Math.round(v.x * 255) << 16) | (Math.round(v.y * 255) << 8) | Math.round(v.z * 255);
    }) as [number, number, number];
  }

  /** Copy the main camera's orientation (direction and up). */
  sync(mainQuaternion: Quaternion): void {
    const back = new Vector3(0, 0, 1).applyQuaternion(mainQuaternion);
    this.camera.position.copy(this.center).addScaledVector(back, this.distance);
    this.camera.quaternion.copy(mainQuaternion);
    this.camera.near = this.distance * 0.2;
    this.camera.far = this.distance * 3;
    this.camera.aspect = 1;
    this.camera.updateProjectionMatrix();
    this.camera.updateMatrixWorld(true);
  }

  dispose(): void {
    this.scene.traverse((o) => {
      const m = o as Mesh;
      if (m.isMesh) {
        m.geometry.dispose();
        (m.material as { dispose(): void }).dispose();
      }
    });
  }
}
