/**
 * Where a Back from a plugin study's workspace sends its design (core host tools spec 5.1, 14.2):
 * the leave-CAD card names the project, the study, and the geometry it updates with how many
 * studies use it (none when it adds a new geometry). Read only: the worker's link check (the
 * same one the link job starts with) and the project's study folders.
 */
import { join } from 'node:path';
import { linkTargetOf } from '../link-job.js';
import { catalogFromWalk, readJsonFile } from '../../project-layout.js';
import { projectDir } from '../../w17-sim-catalog.js';

export interface LeaveTarget {
  /** The project's title ('' when unknown). */
  project: string;
  /** The plugin study's title ('' when unknown). */
  study: string;
  /** The geometry it updates (linked, or the plain one an editing study takes over); null: it adds a new one. */
  geometry: { id: string; name: string; studies: number } | null;
}

export type LeaveTargetFn = (projectId: string, plugin: string, studyId: string) => Promise<LeaveTarget | null>;

/** How long the card waits for the link check (the runner's escalation gives up after 10 s). */
const CHECK_MS = 8_000;

/** The leave's target, or null when it can't be read now (the card then says it generally). */
export const leaveTargetOf: LeaveTargetFn = async (projectId, plugin, studyId) => {
  try {
    const t = (await linkTargetOf(projectId, plugin, studyId, CHECK_MS)) as { study: string; geometry: { id: string; name: string } | null } | null;
    if (!t) return null;
    const dir = String(projectDir(projectId));
    const proj = readJsonFile(join(dir, 'project.json')) as { title?: unknown } | null;
    const g = t.geometry;
    const studies = g ? (catalogFromWalk(dir, null).simulations as Array<{ geometry_id?: unknown }>).filter((s) => String(s.geometry_id ?? '') === g.id).length : 0;
    return {
      project: typeof proj?.title === 'string' ? proj.title : '',
      study: t.study,
      geometry: g ? { id: g.id, name: g.name, studies } : null,
    };
  } catch {
    return null;
  }
};
