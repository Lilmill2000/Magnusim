// Assembly fixtures for the check tests, built in code on the REAL kernel (never a person's Parts):
// shafts (rods along Z, with a head when asked; D shafts with a flat), rings (wheels, collars,
// spacers: a bore through a disc; D bores), boxes, rods lying along X, a comb with many levels,
// and clock hands, each as the checks read a body (name, shape, box, faces).
// SPDX-License-Identifier: GPL-3.0-or-later
import type { AssemblyBody } from '../../../src/features/assembly/check';
import type { KernelAdapter } from '../../../src/types/kernel';
import type { ShapeId } from '../../../src/types/kernel-protocol';

export class Fixture {
  readonly bodies: AssemblyBody[] = [];
  constructor(readonly kernel: KernelAdapter) {}

  private async add(name: string, id: ShapeId): Promise<AssemblyBody> {
    const p = (await this.kernel.call('props', { id, bbox: 'exact' })).result;
    const b: AssemblyBody = { id: `b${this.bodies.length + 1}`, name, shape: id, bbox: p.bbox as AssemblyBody['bbox'], faces: p.faces, solids: p.solids };
    this.bodies.push(b);
    return b;
  }

  private cyl(r: number, z0: number, h: number, at: [number, number] = [0, 0]): Promise<ShapeId> {
    return this.kernel.call('cylinder', { r, h, origin: [at[0], at[1], z0], axis: [0, 0, 1] }).then((x) => x.result.id);
  }

  /** A rod of radius r from z0 to z0 + h about (x, y), with a head (radius, height) at its foot when given. */
  async shaft(name: string, r: number, z0: number, h: number, o: { head?: [number, number]; at?: [number, number] } = {}): Promise<AssemblyBody> {
    let id = await this.cyl(r, z0, h, o.at);
    if (o.head) {
      const head = await this.cyl(o.head[0], z0, o.head[1], o.at);
      id = (await this.kernel.call('boolean', { op: 'fuse', targets: [id], tools: [head] })).result.id;
    }
    return this.add(name, id);
  }

  /** A disc with a bore: inner radius, outer radius, from z0, thick h, about (x, y). */
  async ring(name: string, rIn: number, rOut: number, z0: number, h: number, at: [number, number] = [0, 0]): Promise<AssemblyBody> {
    const outer = await this.cyl(rOut, z0, h, at);
    const hole = await this.cyl(rIn, z0, h, at);
    return this.add(name, (await this.kernel.call('boolean', { op: 'cut', targets: [outer], tools: [hole] })).result.id);
  }

  /** A box from `origin`, size dx, dy, dz. */
  async box(name: string, origin: [number, number, number], size: [number, number, number]): Promise<AssemblyBody> {
    return this.add(name, (await this.kernel.call('box', { dx: size[0], dy: size[1], dz: size[2], origin })).result.id);
  }

  /** A rod of radius r with a flat at x = flat (a D) from z0 to z0 + h, with a round head (radius, height) at its foot when given. */
  async dShaft(name: string, r: number, flat: number, z0: number, h: number, o: { head?: [number, number] } = {}): Promise<AssemblyBody> {
    let id = await this.cyl(r, z0, h);
    const side = (await this.kernel.call('box', { dx: 2 * r, dy: 4 * r, dz: h, origin: [flat, -2 * r, z0] })).result.id;
    id = (await this.kernel.call('boolean', { op: 'cut', targets: [id], tools: [side] })).result.id;
    if (o.head) {
      const head = await this.cyl(o.head[0], z0, o.head[1]);
      id = (await this.kernel.call('boolean', { op: 'fuse', targets: [id], tools: [head] })).result.id;
    }
    return this.add(name, id);
  }

  /** A disc with a D bore (radius rIn, its flat at x = flat), outer radius rOut, from z0, thick h. */
  async dRing(name: string, rIn: number, flat: number, rOut: number, z0: number, h: number): Promise<AssemblyBody> {
    const outer = await this.cyl(rOut, z0, h);
    let hole = await this.cyl(rIn, z0, h);
    const side = (await this.kernel.call('box', { dx: 2 * rIn, dy: 4 * rIn, dz: h, origin: [flat, -2 * rIn, z0] })).result.id;
    hole = (await this.kernel.call('boolean', { op: 'cut', targets: [hole], tools: [side] })).result.id;
    return this.add(name, (await this.kernel.call('boolean', { op: 'cut', targets: [outer], tools: [hole] })).result.id);
  }

  /** A rod of radius r lying along X from x0 to x0 + length, its axis at (y, z). */
  async rodX(name: string, r: number, x0: number, length: number, y: number, z: number): Promise<AssemblyBody> {
    return this.add(name, (await this.kernel.call('cylinder', { r, h: length, origin: [x0, y, z], axis: [1, 0, 0] })).result.id);
  }

  /**
   * A comb standing beside the Z axis: a sawtooth from x0 to x1 with `teeth` teeth along Z from z0
   * to z1 (two levels each), extruded dy along Y from y0: a body with many levels and no round face.
   */
  async comb(name: string, x0: number, x1: number, z0: number, z1: number, teeth: number, y0: number, dy: number): Promise<AssemblyBody> {
    const pitch = (z1 - z0) / teeth;
    const pts: [number, number][] = [[x1, z0]];
    for (let i = 0; i < teeth; i++) pts.push([x0, z0 + i * pitch + pitch * 0.25], [x1, z0 + i * pitch + pitch * 0.75]);
    pts.push([x1, z1], [x1 + 1, z1], [x1 + 1, z0]);
    const loop = pts.map((a, i) => ({ id: `s${i}`, kind: 'line' as const, a, b: pts[(i + 1) % pts.length] }));
    // The sketch plane's v is +Z (normal -Y): extruded along -Y, from y0 + dy back to y0.
    const id = (await this.kernel.call('extrude', { profile: { plane: { origin: [0, y0 + dy, 0], normal: [0, -1, 0], xdir: [1, 0, 0] }, loops: [loop] }, extent: { kind: 'blind', d: dy } })).result.id;
    return this.add(name, id);
  }

  /** A clock hand: a hub ring (bore rIn, outer rHub) from z0, thick h, with an arm along +X to `length`, `width` wide. */
  async hand(name: string, rIn: number, rHub: number, z0: number, h: number, length: number, width: number): Promise<AssemblyBody> {
    const hub = await this.cyl(rHub, z0, h);
    const arm = (await this.kernel.call('box', { dx: length, dy: width, dz: h, origin: [0, -width / 2, z0] })).result.id;
    const both = (await this.kernel.call('boolean', { op: 'fuse', targets: [hub], tools: [arm] })).result.id;
    const hole = await this.cyl(rIn, z0, h);
    return this.add(name, (await this.kernel.call('boolean', { op: 'cut', targets: [both], tools: [hole] })).result.id);
  }
}
