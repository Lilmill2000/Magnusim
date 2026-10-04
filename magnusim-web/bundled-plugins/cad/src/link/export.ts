// LINK (host API 1.5): the export the app links. One BinTools BREP compound of
// the included SOLID bodies at the end of the history, in mm (the kernel's own
// unit), with no transform, in the order of the Bodies folder; and its face-name
// sidecar (sidecar.ts) in the app's face order (the kernel's link_export gives
// every TopExp_Explorer(FACE) visit over that compound, with no de-duplication).
// - Included: every body made by the history unless its "Include in simulation"
//   toggle is off (BodyDef.simulation === false). Hidden bodies are included:
//   hiding is a view of the part, not a change of the design.
// - A surface body (no solid) is never sent; a body of several solids sends each
//   one (ids "<id>#2", ...; names "Bar", "Bar · piece 2"; two bodies of one name
//   are made unique "Body 1 (2)").
// - The same saved design gives the same bytes (the kernel is deterministic and
//   BinTools writes indices, not pointers; the sidecar is canonical).
// Owner: LINK.
// SPDX-License-Identifier: GPL-3.0-or-later
import type { CadDoc, FeatureId } from '../types/doc';
import type { EndBodies, EndBody } from '../types/doc-service';
import type { KernelAdapter } from '../types/kernel';
import { faceKey, faceLabeler, faceNamesText, pieceName, uniqueNames, type SidecarBody, type SidecarFace } from './sidecar';

export interface LinkExport {
  /** The BinTools BREP compound of the included solids. */
  brep: Uint8Array;
  /** face_names.json, as text (UTF-8 when written). */
  faceNames: string;
  /** sha256 of `brep` (lower-case hex). */
  shapeSha256: string;
  /** Solids sent (the app's bodies) and face visits. */
  solids: number;
  faces: number;
  /** Bodies left out: by the toggle, and surface bodies (no solid), by name. */
  excluded: string[];
  surfaces: string[];
}

/** Why there is nothing to link. */
export interface NothingToLink {
  nothing: true;
  /** Bodies left out by the toggle, and surface bodies, by name. */
  excluded: string[];
  surfaces: string[];
}

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const view = new Uint8Array(bytes.byteLength);
  view.set(bytes);
  const digest = await crypto.subtle.digest('SHA-256', view.buffer);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** The bodies in the Bodies folder's order: the order the document made them, then the rest as built. */
export function inFolderOrder(doc: Pick<CadDoc, 'bodies'>, bodies: readonly EndBody[]): EndBody[] {
  const made = Object.keys(doc.bodies);
  const rank = (id: string) => {
    const i = made.indexOf(id);
    return i < 0 ? made.length : i;
  };
  return bodies
    .map((b, i) => ({ b, i }))
    .sort((x, y) => rank(x.b.id) - rank(y.b.id) || x.i - y.i)
    .map(({ b }) => b);
}

export function isIncluded(doc: Pick<CadDoc, 'bodies'>, id: string): boolean {
  return doc.bodies[id]?.simulation !== false;
}

/**
 * Export the bodies at the end of the history for the link. `end` comes from
 * DocService.bodiesAtEnd() for `doc` (the saved design).
 */
export async function exportForLink(kernel: KernelAdapter, doc: CadDoc, end: EndBodies, opts: { signal?: AbortSignal } = {}): Promise<LinkExport | NothingToLink> {
  const ordered = inFolderOrder(doc, end.bodies);
  const excluded = ordered.filter((b) => !isIncluded(doc, b.id)).map((b) => b.name);
  const included = ordered.filter((b) => isIncluded(doc, b.id));
  if (!included.length) return { nothing: true, excluded, surfaces: [] };

  let reply;
  try {
    reply = await kernel.call('link_export', { ids: included.map((b) => b.shape) }, { signal: opts.signal });
  } catch (e) {
    // Every included body is a surface body: nothing the app can mesh.
    if (/none of the shapes has a solid/.test(e instanceof Error ? e.message : String(e))) return { nothing: true, excluded, surfaces: included.map((b) => b.name) };
    throw e;
  }
  const r = reply.result;
  const buf = reply.buffers.brep;
  if (!buf) throw new Error('the kernel wrote no BREP');
  const brep = new Uint8Array(buf);
  const surfaces = r.empty.map((i) => included[i].name);
  const shapeSha256 = await sha256Hex(brep);

  // Bodies: one per solid. A body of several solids: "<id>#k" and a unique name.
  const names = uniqueNames(r.solids.map((s) => (s.piece === 1 ? included[s.src].name : pieceName(included[s.src].name, s.piece))));
  const bodies: SidecarBody[] = r.solids.map((s, k) => {
    const b = included[s.src];
    return {
      index: k + 1,
      id: s.piece === 1 ? b.id : `${b.id}#${s.piece}`,
      name: names[k],
      label: names[k],
      color: /^#[0-9a-f]{6}$/i.test(b.color) ? b.color.toLowerCase() : undefined,
    };
  });

  // Faces: every visit, in the app's order, named from its own body's face names.
  const nameOfVisit = (i: number): string | null => {
    const body = included[r.solids[r.visit_body[i] - 1].src];
    return body.names?.faces[r.visit_face[i]] ?? null;
  };
  const raw = r.visit_body.map((_b, i) => nameOfVisit(i));
  const featureName = (id: FeatureId) => doc.features.find((f) => f.id === id)?.name ?? null;
  const label = faceLabeler(raw, featureName);
  const faces: SidecarFace[] = raw.map((n, i) => ({
    index: i + 1,
    body: r.visit_body[i],
    name: faceKey(n) ?? undefined,
    label: label(n) ?? undefined,
  }));

  return {
    brep,
    faceNames: faceNamesText(bodies, faces, shapeSha256),
    shapeSha256,
    solids: r.solids.length,
    faces: faces.length,
    excluded,
    surfaces,
  };
}
