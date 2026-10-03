/**
 * The report of a linked geometry's update (host API 1.5, LINK proposal 5.14): one app
 * dialog after the update lands, when anything was lost, came back, split, merged,
 * moved far, was claimed twice or was saved for an older version. Every face is shown
 * by its display label, else its name, never by the long match key alone.
 */
import type { ClaimedTwice, LinkResult, LostFace } from '../plugin-sdk/workspace';

/** A lost or returned face as the user reads it: its label, else its name, else the host's label. */
export function faceShown(f: { label?: string | null; name?: string | null; old?: string | null; target?: string | null }): string {
  return String(f.label || f.name || f.old || f.target || 'a face');
}

function where(f: { studyTitle: string; item: string }): string {
  return `${f.studyTitle} › ${f.item}`;
}

/** The report dialog's title and text (plain text, one line per item). */
export function linkReportText(r: LinkResult, studyCount = 1): { title: string; copy: string } {
  const lines: string[] = [];
  const lost = (r.lost || []).filter((f: LostFace) => f.reason !== 'claimed_twice');
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
  if (r.match && r.match.split) lines.push(`Split: ${r.match.split} face${r.match.split === 1 ? '' : 's'} became more than one; their records keep every part.`);
  if (r.match && r.match.movedFar) lines.push(`Kept by name but moved far: ${r.match.movedFar} face${r.match.movedFar === 1 ? '' : 's'}. Check them.`);
  for (const c of r.claimedTwice || ([] as ClaimedTwice[])) {
    lines.push(`Pick one: '${faceShown(c)}' was in ${c.items.join(' and ')}.`);
  }
  const meshes = (r.outOfDate && r.outOfDate.meshes) || [];
  if (meshes.length) {
    lines.push(`Out of date: ${meshes.map((m) => (studyCount > 1 ? `${m.meshName} (${m.studyTitle})` : m.meshName)).join(', ')}. Generate ${meshes.length === 1 ? 'it' : 'them'} again before you run.`);
  }
  return { title: `${r.name} updated`, copy: lines.join('\n') };
}
