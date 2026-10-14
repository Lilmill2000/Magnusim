/**
 * Face and body names as the user reads them (host API 1.5, D15).
 *
 * A linked geometry's cad_preview.json gives each face the name and display label its
 * plugin sent (`faces[].name`, `faces[].label`) and each body its own (`body_info`).
 * Face lists show "Label (face N)", else "Name (face N)", else the host's label; body
 * lists show "Label (Body2)", else "Name (Body2)", else "Body2". Matching and every
 * stored value keep the host's labels ("face 12@Body1", "Body2"); only the text changes.
 * Long match keys never show when a label exists.
 *
 * A React component reads them with useFaceNamesVersion(): it re-renders on every new
 * table, also one set between its first render and its subscription (a panel that
 * opens while the shown geometry's preview is still on its way, right after a reload).
 */
import { useSyncExternalStore } from 'react';

const FACE_RE = /^\s*face\s*(\d+)\s*(?:@\s*Body\s*(\d+))?\s*$/i;

interface Named {
  name?: string | null;
  label?: string | null;
}

let faces = new Map<number, Named>();
let bodies = new Map<string, Named>();
let geometryId = '';
// Goes up with every table set: what a component compares to know it missed one.
let version = 0;
const listeners = new Set<() => void>();

/** The shown geometry's face table (its cad_preview.json, as /api/geometry/cad?part=preview answers it). */
export function setShownFaceTable(meta: unknown, id?: string | null): void {
  const m = (meta && typeof meta === 'object' ? meta : {}) as { faces?: unknown; body_info?: unknown };
  const nextFaces = new Map<number, Named>();
  for (const f of Array.isArray(m.faces) ? m.faces : []) {
    const row = f as { id?: unknown; name?: unknown; label?: unknown };
    const n = Number(row && row.id);
    if (!Number.isFinite(n) || (!row.name && !row.label)) continue;
    nextFaces.set(n, { name: row.name ? String(row.name) : null, label: row.label ? String(row.label) : null });
  }
  const nextBodies = new Map<string, Named>();
  for (const b of Array.isArray(m.body_info) ? m.body_info : []) {
    const row = b as { ref?: unknown; name?: unknown; label?: unknown };
    if (!row || !row.ref) continue;
    nextBodies.set(String(row.ref), { name: row.name ? String(row.name) : null, label: row.label ? String(row.label) : null });
  }
  faces = nextFaces;
  bodies = nextBodies;
  geometryId = String(id || '');
  version += 1;
  for (const fn of [...listeners]) fn();
}

/** How many tables were set so far (a snapshot for useSyncExternalStore). */
export function faceNamesVersion(): number {
  return version;
}

/**
 * Re-render on every new face table. useSyncExternalStore checks the version again after
 * it subscribes, so a table set between the render and the subscription is not missed (a
 * plain useEffect subscription missed it: the list kept "face 15@Body1").
 */
export function useFaceNamesVersion(): number {
  return useSyncExternalStore(subscribeFaceNames, faceNamesVersion, faceNamesVersion);
}

/** The geometry whose names are held (''). */
export function faceNamesGeometry(): string {
  return geometryId;
}

export function subscribeFaceNames(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

/** "Extrude 1 · Side 3 (face 12)" for "face 12@Body1"; the label itself when the face has no name. */
export function faceDisplay(label: string): string {
  const m = FACE_RE.exec(String(label || ''));
  if (!m) return String(label || '');
  const f = faces.get(Number(m[1]));
  const text = f && (f.label || f.name);
  return text ? `${text} (face ${m[1]})` : String(label);
}

/** "Fluid (Body1)" for "Body1"; the body label itself when the body has no name. */
export function bodyDisplay(ref: string, named?: Named | null): string {
  const b = named || bodies.get(String(ref || ''));
  const text = b && (b.label || b.name);
  return text ? `${text} (${ref})` : String(ref || '');
}

/** A lost entry as the user reads it: its label, else its name, else the label it had. */
export function lostDisplay(e: { label?: unknown; name?: unknown; old?: unknown }): string {
  return String(e.label || e.name || e.old || 'a face');
}

/** Tests: forget the table. */
export function resetFaceNamesForTests(): void {
  faces = new Map();
  bodies = new Map();
  geometryId = '';
  version += 1;
  listeners.clear();
}
