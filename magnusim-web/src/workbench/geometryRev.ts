/**
 * Linked geometries in the workbench (host API 1.5, LINK proposal 5.16 to 5.18).
 *
 * A geometry a plugin study links has a rev. Every face- or body-carrying record of its
 * studies (boundary condition, material, refinement, draft run) carries `geometry_rev`,
 * the rev its labels were drawn at, and the server refuses a save drawn at an older rev
 * (409 geometry_changed) or while the geometry is updating (503 geometry_updating).
 *
 * This module is the client's side of that:
 * - the rev this tab shows for each linked geometry (`shownGeometryRev`): taken when the
 *   tab first sees the geometry, and moved only once the tab has loaded it again;
 * - the stamp on every save of such a record (`withGeometryRev`, `stampRecords`): the
 *   record's own stamp, else the shown rev, so a record made without one still saves
 *   while the tab is current and is refused when it is not;
 * - the refusals (`fetchLinkedSave`, `linkedWorkerRpc`): 503 waits Retry-After and tries
 *   once more; 409 says "<Geometry> was updated. This change was not saved." and loads
 *   the geometry and its setup again (the edit is lost, visibly);
 * - picks (`canPickInto`): a face is picked into a record only when its stamp is the
 *   shown rev (no stamp counts as shown); otherwise the record is read again first; and
 *   no pick lands while a landing or a reload loads the part and its setup again
 *   (`pauseFacePicks`, API 1.6);
 * - a second tab: each tree read compares a linked geometry's rev and names with the
 *   ones shown and loads it again, once, when they differ (only its names when the rev
 *   is the same: the faces file is not loaded again); this study's link events
 *   (`/api/plugin-geometry/events`) say when a job is queued, running or ended, for the
 *   geometry's row, and an ended one reads the tree again.
 *
 * The census test (geometryRev.census.test.ts) lists every save site of these records
 * and fails on one that does not go through this module.
 */
import { workerRpc } from '../api/workerRpc';
import { confirmAction } from './dialogs';
import { sendLinkChoice, showLinkChoice, type LinkQuestion } from '../workspace/linkChoice';

export interface LinkTreeNode {
  id?: string;
  name?: string;
  rev?: number;
  names8?: string;
  updating?: boolean;
  unlinked?: boolean;
  source?: { plugin?: string; study_id?: string; workspace?: string; study_title?: string } | null;
  studies?: Array<{ runs?: Array<{ id?: string; older_geometry?: boolean }> }>;
}

/** What a run made on an older version of its linked geometry says where its face tools were (D26). */
export const OLDER_RUN_TEXT = (geometry: string): string =>
  `This run was made on an older version of ${geometry || 'its geometry'}. Face seeds and highlights are off for it.`;

/** What a geometry row shows of its link job while one is queued, runs or waits for the user's choice. */
export interface LinkJobView {
  status: 'queued' | 'running' | 'choosing';
  stage: string | null;
  label: string | null;
  /** The host's question while it waits (5.0): the row offers "Choose…". */
  question?: LinkQuestion | null;
  jobId?: string | null;
  /** "Save as new" was chosen: the name of the geometry being added. */
  adding?: string | null;
}

interface Shown {
  rev: number;
  names8: string;
  updating: boolean;
  name: string;
}

/** How a linked geometry is loaded again (API 1.6). */
export interface ReloadOpts {
  namesOnly?: boolean;
  deferCad?: boolean;
  /** Load it even when a reload that just ended shows the server's rev (its part was set aside). */
  force?: boolean;
  /** Keep the viewport's camera exactly (the user moved it while a landing waited): no framing. */
  holdCamera?: boolean;
}

interface Host {
  /** The geometry the viewport shows (its id), or ''. */
  activeGeometryId: () => string;
  /**
   * Load a linked geometry and its studies' setup again (the viewport and the panels);
   * `namesOnly`: the rev is the same, only its face and body names are read again;
   * `deferCad`: results are opening, so the part itself loads when they close.
   */
  reloadGeometry: (geometryId: string, key: string, opts?: ReloadOpts) => Promise<unknown> | unknown;
}

const host: Host = {
  activeGeometryId: () => '',
  reloadGeometry: () => undefined,
};

const shown = new Map<string, Shown>();
/** Geometries this tab has seen as plain imports (API 1.7): one a study then takes over is loaded again. */
const plainSeen = new Set<string>();
const jobs = new Map<string, LinkJobView>();
const streams = new Map<string, EventSource>();
const listeners = new Set<() => void>();
/** Started runs made on an older rev of their linked geometry, by run id: the geometry's name. */
const olderRuns = new Map<string, string>();
let projectOf = '';
/** Reloads in flight, by geometry. */
let reloading = new Map<string, Promise<void>>();
/** Landings and reloads now loading a part and its setup: face picks wait for them. */
let picksPaused = 0;

/**
 * Face picks are off until the returned function is called (LINK 5.16, 6.5 step 3): a
 * landing turns them off before it loads the new part and on after its setup is read
 * again, so no face is picked into a record by the old part's numbers.
 */
export function pauseFacePicks(): () => void {
  picksPaused += 1;
  let done = false;
  return () => {
    if (done) return;
    done = true;
    picksPaused = Math.max(0, picksPaused - 1);
  };
}

/** A landing or a reload is loading a part and its setup: a face pick is dropped. */
export function facePicksPaused(): boolean {
  return picksPaused > 0;
}

export function bindGeometryRevHost(api: Partial<Host>): void {
  Object.assign(host, api || {});
}

/** Repaint the geometry rows when a link's state changes. Returns the stop. */
export function subscribeLinkedGeometries(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

function changed(): void {
  for (const fn of [...listeners]) {
    try {
      fn();
    } catch (e) {
      console.warn('[CFD] link listener', e);
    }
  }
}

/**
 * The geometry's name when this run was started on an older version of its linked
 * geometry (the tree's `older_geometry`, D26): its face seeds and highlights are off.
 * Null for any other run.
 */
export function runOlderGeometry(runId: string | null | undefined): string | null {
  if (!runId) return null;
  const hit = olderRuns.get(String(runId));
  return hit === undefined ? null : hit;
}

/**
 * The tree's geometry node for a linked geometry, read now. With `accept` (once the landing,
 * showLinkedGeometry, has loaded that geometry itself) this tab shows it at that rev, so
 * the next tree read does not load it again; never before the load.
 */
export async function adoptServerRev(geometryId: string, accept = true): Promise<LinkTreeNode | null> {
  if (!geometryId || !projectOf) return null;
  try {
    const r = await fetch(`/api/project/tree?project_id=${encodeURIComponent(projectOf)}`, { cache: 'no-store' });
    const doc = (await r.json()) as { geometries?: LinkTreeNode[] };
    const node = (doc.geometries || []).find((g) => String(g.id) === geometryId) || null;
    if (accept && node && typeof node.rev === 'number') {
      plainSeen.delete(geometryId);
      shown.set(geometryId, { rev: node.rev, names8: String(node.names8 || ''), updating: !!node.updating, name: String(node.name || '') });
      changed();
    }
    return node;
  } catch {
    return null;
  }
}

/**
 * Load the shown linked geometry again and show it at the server's rev (the landing's step
 * 3); `namesOnly` (step 4): only its names are read again.
 */
export function reloadLinkedToServer(geometryId: string, opts?: ReloadOpts): Promise<void> {
  return reloadToServer(geometryId, opts);
}

/** The rev and names this tab shows for a linked geometry, or null. */
export function shownGeometryKey(geometryId: string): { rev: number; names8: string } | null {
  const s = shown.get(String(geometryId));
  return s ? { rev: s.rev, names8: s.names8 } : null;
}

/** The link job a geometry row shows ("Queued", "Updating…"), or null. */
export function linkJobOf(geometryId: string): LinkJobView | null {
  return jobs.get(String(geometryId)) || null;
}

/** The rev this tab shows for a linked geometry (the shown geometry by default); null when not linked. */
export function shownGeometryRev(geometryId?: string | null): number | null {
  const gid = String(geometryId || host.activeGeometryId() || '');
  const s = gid ? shown.get(gid) : undefined;
  return s ? s.rev : null;
}

/**
 * A save's body with the stamp the server checks: the record's own `geometry_rev`, else
 * the shown rev. Unchanged on a geometry no link made.
 */
export function withGeometryRev<T extends Record<string, unknown>>(
  body: T,
  rec?: { geometry_rev?: unknown } | null,
  geometryId?: string | null,
): T {
  const own = rec && typeof rec.geometry_rev === 'number' ? rec.geometry_rev : null;
  const rev = own ?? shownGeometryRev(geometryId);
  return rev == null ? body : { ...body, geometry_rev: rev };
}

/** Each record of a whole-list save, with its stamp (its own, else the shown rev). */
export function stampRecords<T extends Record<string, unknown>>(list: T[], geometryId?: string | null): T[] {
  const rev = shownGeometryRev(geometryId);
  if (rev == null) return list;
  return list.map((r) => (r && typeof r === 'object' && typeof r.geometry_rev !== 'number' ? { ...r, geometry_rev: rev } : r));
}

/** A face may be picked into this record now: its stamp is the rev the viewport shows (no stamp counts as shown). */
export function canPickInto(rec: { geometry_rev?: unknown } | null | undefined, geometryId?: string | null): boolean {
  if (!rec || typeof rec.geometry_rev !== 'number') return true;
  const rev = shownGeometryRev(geometryId);
  return rev == null || rec.geometry_rev === rev;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function codeOf(r: Response): Promise<{ code: string; error: string }> {
  try {
    const j = (await r.clone().json()) as { code?: unknown; error?: unknown };
    return { code: typeof j.code === 'string' ? j.code : '', error: typeof j.error === 'string' ? j.error : '' };
  } catch {
    return { code: '', error: '' };
  }
}

/** The tab's labels are older than the geometry's: say so, and load it again (D28). */
async function refusedAsChanged(message: string, geometryId?: string | null): Promise<void> {
  const gid = String(geometryId || host.activeGeometryId() || '');
  void reloadToServer(gid);
  await confirmAction({ title: 'Not saved', copy: message, yes: 'OK', notice: true });
}

/**
 * Load a geometry again after a refusal, and show it at the rev the server has: read
 * first, so the rev shown is never newer than the labels loaded.
 */
async function reloadToServer(geometryId: string, opts?: ReloadOpts): Promise<void> {
  if (!geometryId) return;
  let node: LinkTreeNode | null = null;
  try {
    if (projectOf) {
      const r = await fetch(`/api/project/tree?project_id=${encodeURIComponent(projectOf)}`, { cache: 'no-store' });
      const doc = (await r.json()) as { geometries?: LinkTreeNode[] };
      node = (doc.geometries || []).find((g) => String(g.id) === geometryId) || null;
    }
  } catch {
    node = null;
  }
  // A tree read's reload in flight ends first; when it loaded the server's rev already, the
  // part is not loaded a second time (a faces file can be hundreds of MB).
  let waited = false;
  while (reloading.has(geometryId)) {
    waited = true;
    await reloading.get(geometryId)?.catch(() => undefined);
  }
  const now = shown.get(geometryId);
  const current =
    waited && !(opts && opts.force) && !!node && !!now && now.rev === node.rev && now.names8 === String(node.names8 || '');
  if (!current) await reloadNow(geometryId, opts, true);
  if (node && typeof node.rev === 'number') {
    shown.set(geometryId, { rev: node.rev, names8: String(node.names8 || ''), updating: !!node.updating, name: String(node.name || '') });
    changed();
  }
}

/**
 * fetch() for a save of face-carrying records: a 503 geometry_updating waits its
 * Retry-After and is sent once more; a 409 geometry_changed (or a second 503) shows
 * the server's message, and the 409 loads the geometry and its setup again. Returns
 * the last response, for the caller's own handling.
 */
export async function fetchLinkedSave(url: string, init?: RequestInit, geometryId?: string | null): Promise<Response> {
  let r = await fetch(url, init);
  if (r.status === 503) {
    const { code } = await codeOf(r);
    if (code === 'geometry_updating') {
      const wait = Math.min(10, Math.max(1, Number(r.headers.get('Retry-After')) || 2));
      await sleep(wait * 1000);
      r = await fetch(url, init);
      if (r.status === 503) {
        const again = await codeOf(r);
        if (again.code === 'geometry_updating') {
          void confirmAction({ title: 'Not saved', copy: again.error, yes: 'OK', notice: true });
        }
      }
    }
  }
  if (r.status === 409) {
    const { code, error } = await codeOf(r);
    if (code === 'geometry_changed') await refusedAsChanged(error, geometryId);
  }
  return r;
}

/** workerRpc for a save of face-carrying records, with fetchLinkedSave's handling. */
export async function linkedWorkerRpc<T = Record<string, unknown>>(
  method: string,
  params: Record<string, unknown>,
  geometryId?: string | null,
): Promise<T> {
  const codeOfErr = (e: unknown) => String((e as { code?: unknown })?.code || '');
  try {
    return await workerRpc<T>(method, params);
  } catch (first) {
    if (codeOfErr(first) === 'geometry_updating') {
      const wait = Math.min(10, Math.max(1, Number((first as { retryAfter?: unknown }).retryAfter) || 2));
      await sleep(wait * 1000);
      try {
        return await workerRpc<T>(method, params);
      } catch (second) {
        if (codeOfErr(second) === 'geometry_updating') {
          void confirmAction({ title: 'Not saved', copy: (second as Error).message, yes: 'OK', notice: true });
        } else if (codeOfErr(second) === 'geometry_changed') {
          await refusedAsChanged((second as Error).message, geometryId);
        }
        throw second;
      }
    }
    if (codeOfErr(first) === 'geometry_changed') await refusedAsChanged((first as Error).message, geometryId);
    throw first;
  }
}

// ---- the tree: second tabs and the rows -------------------------------------------------

function linkKey(s: { rev?: number; names8?: string }): string {
  return `${Number(s.rev) || 0}-${String(s.names8 || '')}`;
}

/**
 * Load a geometry again (once at a time). A tree read's reload is dropped while one runs;
 * `after` (a landing or a refusal, which then shows the geometry at the server's rev) waits
 * for the one in flight and loads it again itself, so the rev shown is never ahead of the
 * part and the labels loaded.
 */
async function reloadNow(geometryId: string, opts?: ReloadOpts, after = false): Promise<void> {
  if (!geometryId) return;
  if (reloading.has(geometryId)) {
    if (!after) return;
    while (reloading.has(geometryId)) await reloading.get(geometryId)?.catch(() => undefined);
  }
  const s = shown.get(geometryId);
  const run = (async () => {
    const key = s ? linkKey(s) : String(Date.now());
    if (opts && (opts.namesOnly || opts.deferCad || opts.holdCamera)) await host.reloadGeometry(geometryId, key, { ...opts });
    else await host.reloadGeometry(geometryId, key);
  })();
  reloading.set(geometryId, run);
  try {
    await run;
  } catch (e) {
    console.warn('[CFD] linked geometry reload', e);
  } finally {
    if (reloading.get(geometryId) === run) reloading.delete(geometryId);
  }
}

/**
 * Each tree read: a linked geometry seen for the first time is shown at its rev; one
 * whose rev or names changed (or whose update just finished) is loaded again, once,
 * and then shown at the new rev. Opens this project's link event streams.
 */
export function noteTreeGeometries(projectId: string, geometries: LinkTreeNode[] | null | undefined): void {
  if (projectId !== projectOf) {
    projectOf = projectId;
    shown.clear();
    plainSeen.clear();
    jobs.clear();
    reloading = new Map();
    for (const es of streams.values()) es.close();
    streams.clear();
  }
  const keep = new Set<string>();
  olderRuns.clear();
  for (const g of geometries || []) {
    const gid = String((g && g.id) || '');
    for (const study of (g && g.studies) || []) {
      for (const run of study.runs || []) {
        if (run && run.id && run.older_geometry) olderRuns.set(String(run.id), String(g.name || ''));
      }
    }
    if (!gid) continue;
    if (typeof g.rev !== 'number') {
      plainSeen.add(gid);
      continue;
    }
    const next: Shown = { rev: g.rev, names8: String(g.names8 || ''), updating: !!g.updating, name: String(g.name || '') };
    const before = shown.get(gid);
    if (!before && plainSeen.has(gid)) {
      // A plain import a study took over (its first edit, API 1.7): its new shape is loaded,
      // then shown at its rev (saves made meanwhile are refused).
      plainSeen.delete(gid);
      const target = next;
      void reloadNow(gid).then(() => {
        shown.set(gid, target);
        changed();
      });
    } else if (!before) {
      shown.set(gid, next);
    } else if (before.rev !== next.rev || before.names8 !== next.names8 || (before.updating && !next.updating)) {
      // Moved only once the geometry is loaded again: saves made meanwhile are refused.
      // Only new names at the same rev: no new part (its faces file is not loaded again).
      const target = next;
      const namesOnly = before.rev === next.rev && before.names8 !== next.names8 && !(before.updating && !next.updating);
      void reloadNow(gid, { namesOnly }).then(() => {
        shown.set(gid, target);
        changed();
      });
    } else if (before.updating !== next.updating) {
      shown.set(gid, { ...before, updating: next.updating });
    }
    const src = g.source;
    if (src && src.plugin && src.study_id && !g.unlinked) {
      // By geometry too: after "Save as new" the study's stream follows its new geometry.
      const key = `${src.plugin}|${src.study_id}|${gid}`;
      keep.add(key);
      if (!streams.has(key)) openStream(projectId, gid, String(src.plugin), String(src.study_id), key);
    }
  }
  for (const [key, es] of streams) {
    if (!keep.has(key)) {
      es.close();
      streams.delete(key);
    }
  }
  changed();
}

/** Where a geometry's link stream reads from: its project, plugin and study. */
const scopes = new Map<string, { projectId: string; plugin: string; studyId: string }>();

function openStream(projectId: string, geometryId: string, plugin: string, studyId: string, key: string): void {
  if (typeof EventSource === 'undefined') return;
  const q = new URLSearchParams({ project_id: projectId, plugin, study_id: studyId });
  const es = new EventSource(`/api/plugin-geometry/events?${q.toString()}`);
  streams.set(key, es);
  scopes.set(geometryId, { projectId, plugin, studyId });
  const set = (view: LinkJobView | null) => {
    if (view) jobs.set(geometryId, view);
    else jobs.delete(geometryId);
    changed();
  };
  // "Save as new" was chosen for this job: the row says "Adding <name>…" until it ends.
  const adding = new Map<string, string>();
  const viewOf = (jobId: string, status: 'queued' | 'running', stage: string | null, label: string | null): LinkJobView => ({
    status,
    stage,
    label,
    jobId,
    adding: adding.get(jobId) || null,
  });
  es.addEventListener('snapshot', (e) => {
    try {
      const snap = JSON.parse((e as MessageEvent).data) as {
        jobs?: Array<{ id?: string; status?: string; stage?: string | null; op?: string; choosing?: LinkQuestion | null; saveAsNew?: boolean; geometryName?: string | null }>;
      };
      const all = snap.jobs || [];
      const live = all.find((j) => j && (j.status === 'queued' || j.status === 'running'));
      const asking = all.find((j) => j && j.status === 'choosing' && j.choosing);
      if (live) {
        if (live.saveAsNew && live.id) adding.set(live.id, String(live.geometryName || ''));
        set(viewOf(String(live.id || ''), live.status as 'queued' | 'running', live.stage || null, null));
      } else if (asking) set({ status: 'choosing', stage: null, label: null, question: asking.choosing || null, jobId: String(asking.id || '') });
      else set(null);
      // Shown as updating (fenced): its recovery may have ended before this stream (re)opened,
      // after a restart for one, so read the tree again rather than wait for an event.
      if (shown.get(geometryId)?.updating) window.dispatchEvent(new CustomEvent('cfd:tree-sync', { detail: { link: true } }));
    } catch {
      /* not JSON */
    }
  });
  es.addEventListener('link', (e) => {
    try {
      const m = JSON.parse((e as MessageEvent).data) as {
        job_id?: string;
        ev?: { event?: string; stage?: string; label?: string; choosing?: LinkQuestion; choice?: string };
      };
      const ev = m.ev || {};
      const jobId = String(m.job_id || '');
      if (ev.event === 'choose') set({ status: 'choosing', stage: null, label: null, question: ev.choosing || null, jobId });
      else if (ev.event === 'chosen') {
        const was = jobs.get(geometryId);
        if (ev.choice === 'new') adding.set(jobId, String((was && was.question && was.question.new_name) || ''));
        set(null);
      } else if (ev.event === 'queued') set(viewOf(jobId, 'queued', null, null));
      else if (ev.event === 'start') set(viewOf(jobId, 'running', null, null));
      else if (ev.event === 'stage') set(viewOf(jobId, 'running', ev.stage || null, ev.label || null));
      else if (ev.event === 'end') {
        adding.delete(jobId);
        set(null);
        // The tree says the new rev: read it, and the geometry is loaded again.
        window.dispatchEvent(new CustomEvent('cfd:tree-sync', { detail: { link: true } }));
      } else if (ev.event === 'recovered') {
        // The recovery finished (or undid) an update that stopped half way: the fence is gone.
        window.dispatchEvent(new CustomEvent('cfd:tree-sync', { detail: { link: true } }));
      }
    } catch {
      /* not JSON */
    }
  });
}

/**
 * "Choose…" on a geometry's row (5.0, 5.18): the host's question that waits with no page
 * showing it. The same dialog; the answer goes to the choose route, and the landing shows
 * the geometry that results (a new one after "Save as new"). False when nothing was chosen.
 */
export async function chooseLinkFromRow(geometryId: string): Promise<boolean> {
  const view = jobs.get(String(geometryId));
  const scope = scopes.get(String(geometryId));
  if (!view || view.status !== 'choosing' || !view.question || !view.jobId || !scope) return false;
  const answer = await showLinkChoice(view.question);
  if (!answer) return false;
  let out: { geometry_id?: string; created?: boolean };
  try {
    out = await sendLinkChoice({ ...scope, jobId: view.jobId }, answer);
  } catch (e) {
    await confirmAction({ title: 'Not changed', copy: (e as Error).message, yes: 'OK', notice: true });
    return false;
  }
  if (answer.choice !== 'cancel' && out.geometry_id) {
    window.dispatchEvent(
      new CustomEvent('cfd:link-land', {
        detail: { ...scope, geometryId: String(out.geometry_id), jobId: view.jobId, created: !!out.created, reason: 'back' },
      }),
    );
  }
  return true;
}

/** Tests: forget everything this module holds. */
export function resetGeometryRevForTests(): void {
  shown.clear();
  plainSeen.clear();
  olderRuns.clear();
  jobs.clear();
  for (const es of streams.values()) es.close();
  streams.clear();
  scopes.clear();
  listeners.clear();
  projectOf = '';
  reloading = new Map();
  picksPaused = 0;
  host.activeGeometryId = () => '';
  host.reloadGeometry = () => undefined;
}
