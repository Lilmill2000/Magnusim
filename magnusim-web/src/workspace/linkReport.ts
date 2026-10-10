/**
 * The report of a linked geometry's update (host API 1.5, LINK proposal 5.14): one app
 * dialog after the update lands, only when the update touched the user's setup: a record
 * whose face was lost, came back, split, merged with another, was claimed twice or moved
 * far, or a record saved for an older version. A face no record refers to is never
 * reported, however it changed. Every face is shown by its display label, else its name,
 * never by the long match key alone, and with the record that holds it.
 *
 * What touches the setup (`LinkSetup`) is the host's own: the link job keeps it beside the
 * plugin's LinkResult (whose `match` counts stay statistics of the whole part).
 */
import type { ClaimedTwice, LinkResult, LostFace } from '../plugin-sdk/workspace';

/** A face a record refers to that this update moved far, split or merged (the job's `setup`). */
export interface SetupFace {
  studyId: string;
  studyTitle: string;
  kind: string;
  item: string;
  field: string;
  old: string;
  name: string | null;
  label: string | null;
  /** Split: how many faces it is now; merged: how many faces became the one. */
  faces?: number;
  target?: string;
  targetLabel?: string | null;
}

/** What of an update touches the user's setup (the link job's `setup`, 5.14). */
export interface LinkSetup {
  movedFar: SetupFace[];
  split: SetupFace[];
  merged: SetupFace[];
  /** Records saved for an older version: their faces must be picked again. */
  stale: Array<{ studyId: string; studyTitle: string; item: string; kind: string }>;
  /** Boundary conditions now on a face two bodies share (inside the part: not used there). */
  inside?: Array<{ studyId: string; studyTitle: string; item: string; kind: string; faces: string[]; bodies?: number }>;
}

/** A job's `setup` as the host reads it (an older record has none: nothing of it to report). */
export function setupOf(raw: unknown): LinkSetup {
  const s = (raw && typeof raw === 'object' ? raw : {}) as Partial<Record<keyof LinkSetup, unknown>>;
  const list = <T,>(v: unknown): T[] => (Array.isArray(v) ? (v as T[]) : []);
  return { movedFar: list(s.movedFar), split: list(s.split), merged: list(s.merged), stale: list(s.stale), inside: list(s.inside) };
}

/** A lost or returned face as the user reads it: its label, else its name, else the host's label. */
export function faceShown(f: { label?: string | null; name?: string | null; old?: string | null; target?: string | null }): string {
  return String(f.label || f.name || f.old || f.target || 'a face');
}

function where(f: { studyTitle: string; item: string }): string {
  return `${f.studyTitle} › ${f.item}`;
}

function lostOf(r: LinkResult): LostFace[] {
  return (r.lost || []).filter((f: LostFace) => f.reason !== 'claimed_twice');
}

/**
 * The update touched the user's setup: some record's face was lost, came back, split,
 * merged, was claimed twice or moved far, or a record was saved for an older version.
 * Nothing else is worth a dialog (a face no record refers to is never reported).
 */
export function linkTouchesSetup(r: LinkResult | null | undefined, setup?: LinkSetup | null): boolean {
  if (!r) return false;
  const s = setup || setupOf(null);
  return !!(lostOf(r).length || r.returned?.length || r.claimedTwice?.length || s.movedFar.length || s.split.length || s.merged.length || s.stale.length || s.inside?.length);
}

/**
 * The update needs the user to act (faces to pick again, or to check): a lost face, a face
 * claimed twice, a face kept by name that moved far, or a record saved for an older version.
 * Splits, merges and returns are kept on their records with nothing to do.
 */
export function linkNeedsAction(r: LinkResult | null | undefined, setup?: LinkSetup | null): boolean {
  if (!r) return false;
  const s = setup || setupOf(null);
  return !!(lostOf(r).length || r.claimedTwice?.length || s.movedFar.length || s.stale.length || s.inside?.length);
}

/**
 * The first update of a study that edits a project geometry took that geometry over (API 1.7):
 * said every time, with where the imported file went.
 */
export function adoptedText(r: LinkResult, studyTitle?: string | null): string {
  return `${r.name} updated from ${studyTitle || 'its study'}. The original file is kept: Geometry panel → Add the original as a new geometry.`;
}

function meshesLine(r: LinkResult, studyCount: number): string {
  const meshes = (r.outOfDate && r.outOfDate.meshes) || [];
  if (!meshes.length) return '';
  return `Out of date: ${meshes.map((m) => (studyCount > 1 ? `${m.meshName} (${m.studyTitle})` : m.meshName)).join(', ')}. Generate ${meshes.length === 1 ? 'it' : 'them'} again before you run.`;
}

/** The report dialog's title and text (plain text, one line per item). */
export function linkReportText(r: LinkResult, setup?: LinkSetup | null, studyCount = 1, studyTitle?: string | null): { title: string; copy: string } {
  const s = setup || setupOf(null);
  const lines: string[] = [];
  if (r.adopted) lines.push(adoptedText(r, studyTitle));
  const lost = lostOf(r);
  if (r.match && (r.match.byName || r.match.byShape)) {
    lines.push('Boundary conditions, refinements and monitors kept their faces by name.');
  }
  if (lost.length) {
    lines.push('These faces are gone. Each one stays listed on its record and comes back if the face does:');
    for (const f of lost) lines.push(`${where(f)}: '${faceShown(f)}'`);
  }
  if (r.returned && r.returned.length) {
    lines.push('These came back:');
    for (const f of r.returned) lines.push(`${where(f)}: '${faceShown(f)}'`);
  }
  for (const f of s.split) lines.push(`Split: ${where(f)} now covers ${f.faces || 2} faces in place of '${faceShown(f)}'.`);
  for (const f of s.merged) {
    const others = Math.max(1, (f.faces || 2) - 1);
    lines.push(`Merged: ${where(f)}: '${faceShown(f)}' is now one face with ${others} other face${others === 1 ? '' : 's'}${f.targetLabel ? ` ('${f.targetLabel}')` : ''}.`);
  }
  if (s.movedFar.length) {
    const items = s.movedFar.map((f) => `${where(f)} ('${faceShown(f)}')`);
    lines.push(`Kept by name but moved far: ${items.join(', ')}. Check ${items.length === 1 ? 'it' : 'them'}.`);
  }
  for (const c of r.claimedTwice || ([] as ClaimedTwice[])) {
    lines.push(`Pick one: '${faceShown(c)}' was in ${c.items.join(' and ')}.`);
  }
  for (const st of s.stale) lines.push(`Saved for an older version: ${where(st)}. Pick its faces again.`);
  for (const f of s.inside || []) {
    const n = f.faces.length;
    lines.push(
      `${f.item} is now on ${n === 1 ? 'an inside face' : `${n} inside faces`} (shared by ${f.bodies || 2} bodies) and won't be used. Move it in Boundary conditions.`,
    );
  }
  const meshes = meshesLine(r, studyCount);
  if (meshes) lines.push(meshes);
  return { title: `${r.name} updated`, copy: lines.join('\n') };
}

/**
 * The quiet word on an update that needs nothing of the user (a toast, never a dialog):
 * '' when there is nothing worth saying (no record touched, no mesh out of date). After
 * "Continue in background" an update that touched the setup without needing the user is
 * said here too, in one line.
 */
export function linkQuietText(r: LinkResult, setup?: LinkSetup | null, studyCount = 1, studyTitle?: string | null): string {
  const s = setup || setupOf(null);
  const parts: string[] = [];
  if (r.adopted) {
    // The first update of an editing study is always said (a toast when nothing else needs the user).
    const rest: string[] = [];
    const kept0 = s.split.length + s.merged.length + (r.returned?.length || 0);
    if (kept0) rest.push(`${kept0} face${kept0 === 1 ? '' : 's'} of your setup changed and stayed on ${kept0 === 1 ? 'its record' : 'their records'}.`);
    const meshes0 = meshesLine(r, studyCount);
    if (meshes0) rest.push(meshes0);
    return [adoptedText(r, studyTitle), ...rest].join(' ');
  }
  const kept = s.split.length + s.merged.length + (r.returned?.length || 0);
  if (kept) parts.push(`${kept} face${kept === 1 ? '' : 's'} of your setup changed and stayed on ${kept === 1 ? 'its record' : 'their records'}.`);
  const meshes = meshesLine(r, studyCount);
  if (meshes) parts.push(meshes);
  return parts.length ? `${r.name} updated. ${parts.join(' ')}` : '';
}
