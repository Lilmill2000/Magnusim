// @ts-check
/**
 * Linked geometries, the job (host API 1.5; LINK proposal section 5, L2 step 1).
 *
 * A plugin study whose kind has `links_geometry` links one project geometry through
 * POST /api/plugin-geometry/link (link-routes.ts). The call never parses anything: it
 * checks the scope, applies the accept rule (an older design never lands), copies the
 * shape and its face-name sidecar into the project's staging folder, hashing as it
 * copies, and answers one of:
 *
 * - `none`: the bytes equal the committed state's (recorded on the main lane, no slot);
 * - a create (the first link, or after the geometry was removed): a job that runs
 *   outside the compute slot, like an import, under the study's lock;
 * - an update: a queued compute job (`kind: 'geometry'`), the one compute slot held
 *   from its start until its follow-ups end, so no mesh, run or plugin case reads the
 *   geometry while it changes;
 * - the host's question (revision 7, proposal 5.0): when the shape changed and a
 *   simulation study on the geometry has saved setup, the record is `choosing` (no
 *   queue row, no slot, its staging kept) until the user answers through
 *   POST /api/plugin-geometry/choose: "Save as new geometry" (a create beside the old
 *   geometry, with copies of the chosen studies' setup), "Overwrite" (the queued update)
 *   or "Keep editing" (`cancelled`).
 *
 * A create (a first link, "Save as new") builds its folder in staging with
 * link/pending.json, renames it into geometries/, makes the copies, and commits with
 * geometry.link_commit (pending.json removed: the commit point; the old geometry marked
 * link/unlinked.json). A crash before that leaves a hidden folder the boot scan removes.
 *
 * An update's commit: close the project's gate (link-gate.js) and drain it; plan on the
 * main lane (geometry.plan writes <staging>/plan.json); swap the files in one
 * synchronous step that undoes itself on any error (swapOnce); apply on the main lane
 * (geometry.apply writes link/state.json last: the commit point); open the gate. The
 * journal <geometry>/link/commit.json exists from the swap until the apply ends; a
 * geometry with a journal no live job owns is fenced until the recovery, which runs
 * first in line on the compute slot (runFirst), finishes or undoes it.
 *
 * Everything shared lives on globalThis (the study locks, the live jobs, the recovery
 * list), so a Vite re-import of this module shares it. Records and events are in
 * link-store.js. Test switches (inert when unset, read once when this module loads):
 * MAGNUSIM_TEST_LINK_APPLY_TIMEOUT_MS (the apply timeout) and MAGNUSIM_TEST_LINK_HOOKS=1
 * (globalThis[Symbol.for('magnusim.linkTestHooks')]: afterMove(i) inside the swap step;
 * beforeLinkCommit(job) right before a create's commit call; afterLinkCommitPoint, which
 * makes the commit stop between its commit point and unlinked.json).
 */
import { spawn } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, promises as fsp, readdirSync, readFileSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { PYTHON, PY_ROOT, pyTool } from '../python-env.js';
import { PROJECTS_ROOT } from '../project-isolation.js';
import { claimComputeSlot, computeSlotHolder, releaseComputeSlot, sameProjectFolder } from '../compute-slot.js';
import {
  dropComputeRows,
  enqueueGeometryJob,
  queueAheadOf,
  scheduleComputeQueueKick,
  snapshotComputeQueue,
} from './compute-queue.ts';
import { LINK_JOB_RE, createLinkRecord, emitLinkEvent, listLinkRecords, newLinkJobId, readLinkRecord, updateLinkRecord } from '../link-store.js';
import { closeGate, gateKey, openGate } from './link-gate.js';
import { geometriesRoot, geometryFolderName, readJsonFile, walkGeometries, writeJsonAtomic } from '../project-layout.js';
import { pluginLoaded } from '../registry-defaults.js';
import { linkFaceMap } from '../geometry-face-match.js';

const APPLY_TIMEOUT_MS = Number(process.env.MAGNUSIM_TEST_LINK_APPLY_TIMEOUT_MS) > 0 ? Number(process.env.MAGNUSIM_TEST_LINK_APPLY_TIMEOUT_MS) : 10 * 60_000;
const HOOKS_ON = process.env.MAGNUSIM_TEST_LINK_HOOKS === '1';
const MB = 1024 * 1024;
const DISK_SPARE = 256 * MB;
const STAGING = '.magnusim-staging';
const PLUGIN_KEY_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,120}$/;
const STUDY_ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
const HEX64 = /^[0-9a-fA-F]{64}$/;
const RETRY_CODES = new Set(['EPERM', 'EACCES', 'EBUSY']);
// Every file a geometry folder holds that an update replaces (or moves aside: no reader
// may meet a STEP, a triangle cache or a mesh input of the old shape).
const SHAPE_FILES_OUT = ['source.bbrep', 'cad_faces.vtp', 'cad_edges.vtp', 'cad_preview.json', 'face_names.json', 'source.tris.npz', 'Body1.stl', 'Body1.json', 'source.step'];
const SHAPE_FILES_IN = ['source.bbrep', 'cad_faces.vtp', 'cad_edges.vtp', 'cad_preview.json', 'face_names.json'];
const NAME_FILES = ['cad_preview.json', 'face_names.json'];

export const LINK_TEXT = Object.freeze({
  lostQueue: 'Lost from the queue',
  restart: 'Stopped by a restart',
  removed: 'The geometry was removed',
  cancelled: 'Removed from the Queue',
  lostInput: (row) => `${row} lost its saved input. Update it again.`,
  fenced: (g) => `Couldn't finish updating ${g}. The app will finish it.`,
  fencedNoInput: (g, s) => `Couldn't finish updating ${g}. Remove it, then update it from ${s} again.`,
  waiting: (g) => `Waiting for another program to release ${g}'s files`,
  busy: (g) => `Another program held ${g}'s files for 10 minutes. ${g} is unchanged.`,
  stale: (s) => `${s} changed in another tab. Reload to continue.`,
  rowName: (g, s) => `Update ${g} from ${s}`,
  finishName: (g) => `Finish updating ${g}`,
  pluginNeededOff: (plugin, g, s) => `Turn ${plugin} on, then update ${g} from ${s} again. ${g} keeps its last update.`,
  pluginNeeded: (key, list, g) =>
    `Records of ${key} come from a plugin that is off or not installed: ${list}. Turn it on or install it, or delete those records, to update ${g}.`,
  kept: 'You kept editing. Nothing changed.',
  answered: 'This question was already answered.',
  stillUpdating: (g) => `${g} is still updating`,
  added: (g2, g) => `${g2} added. ${g} and its studies are kept as they were.`,
  copied: (s) => `Copied the setup of ${s} onto it.`,
  copyFailed: (s, why) => `Couldn't copy the setup of ${s}: ${why}`,
  studyDeleted: 'The study was deleted',
  notLinked: (g, s) => `${g} is no longer linked to ${s}. ${g} is unchanged.`,
  adding: (g2) => `Adding ${g2}. Choose again when it is done.`,
});

/** A refusal: an HTTP status, a 5.3 code and the message a plugin may show. */
export class LinkJobError extends Error {
  /** @param {number} status @param {string} code @param {string} message @param {Record<string, any>} [extra] */
  constructor(status, code, message, extra = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.extra = extra;
  }
}

// ---- process-wide state -------------------------------------------------------------

/**
 * @typedef {{ id: string, projectId: string, geometryId: string | null, aborted: boolean, children: Set<any>, phase: string }} LiveJob
 * @typedef {{ projectId: string, geometryId: string, name: string, tries: number, nextAt: number }} Pending
 */

function defaultDeps() {
  return {
    /** @type {{ call: (method: string, params?: any, timeoutMs?: number) => Promise<any> } | null} */
    worker: null,
    /** @type {any} */
    files: null,
    runPreview: (/** @type {string[]} */ args, /** @type {{ timeoutMs: number, live?: LiveJob }} */ opts) => runPy(['-m', 'cfddesk.cad.link_preview', ...args], opts),
    runCom: (/** @type {string} */ bbrep, /** @type {{ timeoutMs: number, live?: LiveJob }} */ opts) =>
      runPy(['-m', 'cfddesk.cad.link_preview', '--com', bbrep], opts),
    renderThumb: (/** @type {string[]} */ args, /** @type {{ timeoutMs: number, live?: LiveJob }} */ opts) =>
      runPy([pyTool('render_geometry_thumb.py'), ...args], opts),
    freeBytes: async (/** @type {string} */ dir) => {
      try {
        const st = await fsp.statfs(dir);
        return Number(st.bavail) * Number(st.bsize);
      } catch {
        return Number.POSITIVE_INFINITY;
      }
    },
    pluginLoaded: (/** @type {string} */ key) => pluginLoaded(key),
    // "Save as new": a copy of a study's setup onto the new geometry (w17), and its removal.
    copyStudy: async (/** @type {string} */ projectId, /** @type {any} */ o) => (await import('../w17-simulation.js')).createLinkedStudyCopy(projectId, o),
    dropStudy: async (/** @type {string} */ projectId, /** @type {string} */ simId) => (await import('../w17-simulation.js')).dropLinkedStudyCopy(projectId, simId),
    indexStudies: async (/** @type {string} */ projectId, /** @type {any[]} */ rows) => (await import('../w17-simulation.js')).indexLinkedStudyCopies(projectId, rows),
    sleep: (/** @type {number} */ ms) => new Promise((r) => setTimeout(r, ms)),
    now: () => Date.now(),
    timing: {
      previewMs: 15 * 60_000,
      followMs: 10 * 60_000,
      applyMs: APPLY_TIMEOUT_MS,
      waitLoopMs: 10 * 60_000,
      waitSteps: [500, 1000, 2000, 4000],
      waitEvery: 30_000,
      applyRetries: [1000, 4000],
      recoveryBackoff: [60_000, 120_000, 240_000, 480_000],
      recoveryEvery: 30 * 60_000,
    },
  };
}

/**
 * @returns {{ deps: ReturnType<typeof defaultDeps>, live: Map<string, LiveJob>, locks: Map<string, string>,
 *   pending: Map<string, Pending>, bootPid: number | null, timer: ReturnType<typeof setTimeout> | null,
 *   recovering: boolean, aheads: Map<string, number> }}
 */
function L() {
  const key = Symbol.for('magnusim.linkJobs');
  const g = /** @type {any} */ (globalThis);
  if (!g[key]) {
    g[key] = { deps: defaultDeps(), live: new Map(), locks: new Map(), pending: new Map(), bootPid: null, timer: null, recovering: false, aheads: new Map() };
  }
  return g[key];
}

/** The worker and the plugin files the routes made (routes.ts calls this once per instance). */
export function configureLinkJobs(/** @type {{ worker?: any, files?: any }} */ next) {
  const d = L().deps;
  if (next.worker) d.worker = next.worker;
  if (next.files) d.files = next.files;
}

/**
 * Replace some of the job's calls (a null value puts the default back; no argument resets all).
 * @param {Record<string, any> | null} over
 */
export function setLinkJobDepsForTests(over) {
  const s = L();
  const base = defaultDeps();
  if (!over) {
    s.deps = { ...base, worker: s.deps.worker, files: s.deps.files };
    return;
  }
  const next = { ...s.deps };
  for (const [k, v] of Object.entries(over)) {
    if (k === 'timing') continue;
    /** @type {any} */ (next)[k] = v === null ? /** @type {any} */ (base)[k] : v;
  }
  next.timing = { ...s.deps.timing, ...(over.timing || {}) };
  s.deps = next;
}

export function resetLinkJobsForTests() {
  const s = L();
  if (s.timer) clearTimeout(s.timer);
  s.timer = null;
  s.live.clear();
  s.locks.clear();
  s.pending.clear();
  s.bootPid = null;
  s.recovering = false;
  s.aheads.clear();
  s.deps = defaultDeps();
}

/** @param {string} name @param {...any} args */
function hook(name, ...args) {
  if (!HOOKS_ON) return;
  const h = /** @type {any} */ (globalThis)[Symbol.for('magnusim.linkTestHooks')];
  if (h && typeof h[name] === 'function') h[name](...args);
}

/**
 * A named test hook from outside this module (MAGNUSIM_TEST_LINK_HOOKS=1 only; inert in
 * production): `beforeCommitRpc` holds a two-step material save between its Node write
 * and its main-lane call (w18).
 * @param {string} name @param {...any} args
 */
export function linkTestHook(name, ...args) {
  if (!HOOKS_ON) return undefined;
  const h = /** @type {any} */ (globalThis)[Symbol.for('magnusim.linkTestHooks')];
  return h && typeof h[name] === 'function' ? h[name](...args) : undefined;
}

/** Whether this process read the test switches (false in production). */
export function linkTestSwitches() {
  return { hooks: HOOKS_ON, applyTimeoutMs: APPLY_TIMEOUT_MS };
}

// ---- small helpers ------------------------------------------------------------------

/** @param {string} id */
function projectDirOf(id) {
  const dir = resolve(PROJECTS_ROOT, String(id || ''));
  if (!id || resolve(dir, '..') !== resolve(PROJECTS_ROOT)) throw new LinkJobError(400, 'bad_request', 'invalid project id');
  return dir;
}

/** @param {string} projectId @param {string} plugin @param {string} studyId */
function studyKey(projectId, plugin, studyId) {
  return `${gateKey(projectId)}|${plugin}|${studyId}`;
}

/** @param {any} rec @param {string} projectId @param {string} plugin @param {string} studyId */
function sameStudy(rec, projectId, plugin, studyId) {
  return rec.plugin === plugin && rec.study_id === studyId && sameProjectFolder(rec.project_id, projectId);
}

/** @param {string} projectId @param {string} plugin @param {string} studyId @param {string | string[]} status */
function studyRecords(projectId, plugin, studyId, status) {
  return listLinkRecords({ status, filter: (r) => sameStudy(r, projectId, plugin, studyId) });
}

/** @param {string} projectId @param {string} jobId */
function stagingDirOf(projectId, jobId) {
  return join(projectDirOf(projectId), STAGING, `link-${jobId}`);
}

/** @param {string} jobId */
function stagingRelOf(jobId) {
  return `${STAGING}/link-${jobId}`;
}

/** @param {string} path */
function readJson(path) {
  return readJsonFile(path);
}

/** @param {string} dir */
function linkStateOf(dir) {
  const st = readJson(join(dir, 'link', 'state.json'));
  return st && typeof st === 'object' ? st : null;
}

/** @param {string} dir */
function journalOf(dir) {
  const j = readJson(join(dir, 'link', 'commit.json'));
  return j && typeof j === 'object' ? j : null;
}

/** A geometry folder of the project by id (null when gone or marked removed). */
function geometryDirOf(/** @type {string} */ projectId, /** @type {string} */ geometryId) {
  let pdir;
  try {
    pdir = projectDirOf(projectId);
  } catch {
    return null;
  }
  if (!existsSync(join(pdir, 'project.json'))) return null;
  const g = walkGeometries(pdir).find((x) => String(x.id) === String(geometryId));
  if (!g || existsSync(join(g.dir, 'link', 'removed.json'))) return null;
  return String(g.dir);
}

/** A geometry folder a link made (it has link/state.json). @param {string} dir */
export function isLinkedGeometryDir(dir) {
  return !!dir && existsSync(join(dir, 'link', 'state.json'));
}

/**
 * A geometry with a commit journal that no live job of this process owns, or whose
 * job is retrying a failed undo with the gate open: its files and its records may
 * disagree until the recovery (or the undo) runs (proposal 5.6 step 9, 5.17).
 * @param {string} dir
 */
export function geometryFenced(dir) {
  if (!dir) return false;
  const j = journalOf(dir);
  if (!j && !existsSync(join(dir, 'link', 'commit.json'))) return false;
  const job = j && j.job ? String(j.job) : '';
  const live = job ? L().live.get(job) : null;
  return !live || live.phase === 'undo' || live.phase === 'fenced';
}

/** The geometry is still the study's linked one: there, not removed, not unlinked by "Save as new". @param {string} projectId @param {string} geometryId */
function stillLinked(projectId, geometryId) {
  const dir = geometryDirOf(projectId, geometryId);
  return !!dir && existsSync(join(dir, 'link', 'state.json')) && !existsSync(join(dir, 'link', 'unlinked.json')) && !existsSync(join(dir, 'link', 'pending.json'));
}

/** @param {string} dir */
function rmQuiet(dir) {
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 50 });
  } catch {
    /* a later clean-up takes it */
  }
}

/** @param {string} dir */
async function rmLater(dir) {
  try {
    await fsp.rm(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
  } catch {
    /* the boot clean-up takes it */
  }
}

/**
 * A Python process of the job (never on the event loop): its exit code and output.
 * @param {string[]} args
 * @param {{ timeoutMs: number, live?: LiveJob }} opts
 * @returns {Promise<{ code: number | null, stdout: string, stderr: string, timedOut: boolean }>}
 */
function runPy(args, opts) {
  return new Promise((done) => {
    let child;
    try {
      child = spawn(PYTHON, args, { cwd: PY_ROOT, windowsHide: true, env: { ...process.env, PYTHONUNBUFFERED: '1', PYTHONIOENCODING: 'utf-8' } });
    } catch (e) {
      done({ code: null, stdout: '', stderr: String(e), timedOut: false });
      return;
    }
    const live = opts.live;
    if (live) live.children.add(child);
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        child.kill();
      } catch {
        /* gone */
      }
    }, opts.timeoutMs);
    child.stdout.on('data', (d) => (stdout += String(d)));
    child.stderr.on('data', (d) => (stderr += String(d).slice(-20_000)));
    child.on('error', (e) => {
      stderr += String(e);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (live) live.children.delete(child);
      done({ code, stdout, stderr, timedOut });
    });
  });
}

/** @param {LiveJob | undefined} live */
function killChildren(live) {
  if (!live) return;
  for (const c of live.children) {
    try {
      c.kill();
    } catch {
      /* gone */
    }
  }
}

/** The worker's answer, or throws (a refusal answer is returned as is). */
async function call(/** @type {string} */ method, /** @type {any} */ params, /** @type {number} */ timeoutMs = 60_000) {
  const w = L().deps.worker;
  if (!w) throw new LinkJobError(503, 'unavailable', 'The app could not check the link right now');
  return w.call(method, params, timeoutMs);
}

// ---- events and results -------------------------------------------------------------

/** What a page sees of a link job (no paths). @param {any} rec */
export function linkJobOf(rec) {
  return {
    id: rec.id,
    op: rec.op,
    status: rec.status,
    stage: rec.stage || null,
    geometryId: rec.geometry_id || null,
    sourceVersion: rec.source_version,
    ahead: rec.status === 'queued' && rec.row_id ? queueAheadOf(rec.row_id) : null,
    createdAt: rec.created_at || null,
    startedAt: rec.started_at || null,
    finishedAt: rec.finished_at || null,
    error: rec.error ?? null,
    code: rec.code ?? null,
    result: rec.result || null,
    // The host's question while it waits (5.0); after "Save as new", the copies' outcome.
    choosing: rec.status === 'choosing' ? rec.choosing || null : null,
    saveAsNew: !!rec.save_as_new,
    geometryName: rec.geometry_name || null,
    oldGeometryId: rec.old_geometry_id || null,
    oldGeometryName: rec.old_geometry_name || null,
    copies: Array.isArray(rec.copies) ? rec.copies : null,
    seq: Number(rec.seq) || 0,
  };
}

/** @param {string} id @param {string} stage @param {string} [label] */
function setStage(id, stage, label) {
  updateLinkRecord(id, { stage }, { write: false });
  emitLinkEvent(id, { event: 'stage', stage, fraction: null, ...(label ? { label } : {}) });
}

/**
 * End a job's record (once): its status, error and result, and the end event.
 * @param {string} id @param {string} status @param {Record<string, any>} [fields]
 */
function finish(id, status, fields = {}) {
  const rec = readLinkRecord(id);
  if (!rec || !['queued', 'running', 'choosing'].includes(rec.status)) return rec;
  const now = updateLinkRecord(id, { ...fields, status, stage: null, finished_at: new Date().toISOString() });
  emitLinkEvent(id, {
    event: 'end',
    status,
    error: fields.error ?? null,
    code: fields.code ?? null,
    result: fields.result ?? null,
    // "Save as new": what each copy of a study's setup came to (the host's report).
    ...(now && Array.isArray(now.copies) ? { copies: now.copies } : {}),
  });
  L().aheads.delete(id);
  return now;
}

/**
 * LinkResult (5.1), with the plan's report when the update rewrote records.
 * @param {Record<string, any>} r
 */
function linkResult(r) {
  const rep = r.report || {};
  const match = rep.match || {};
  const out = rep.out_of_date || {};
  return {
    geometryId: r.geometryId,
    name: r.name,
    rev: r.rev,
    fromRev: r.fromRev ?? null,
    created: !!r.created,
    change: r.change,
    bodies: Number(r.bodies) || 0,
    faces: Number(r.faces) || 0,
    named: Number(r.named) || 0,
    match: {
      byName: Number(match.byName) || 0,
      byShape: Number(match.byShape) || 0,
      split: Number(match.split) || 0,
      merged: Number(match.merged) || 0,
      movedFar: Number(match.movedFar) || 0,
    },
    lost: Array.isArray(rep.lost) ? rep.lost : [],
    returned: Array.isArray(rep.returned) ? rep.returned : [],
    stillLost: Number(rep.still_lost) || 0,
    claimedTwice: Array.isArray(rep.claimed_twice) ? rep.claimed_twice : [],
    outOfDate: { meshes: Array.isArray(out.meshes) ? out.meshes : [], runs: Number(out.runs) || 0 },
    seconds: Number(r.seconds) || 0,
  };
}

/**
 * Name the faces and match them (proposal 5.4 step 7): <staging>/map.json from the live
 * face table to the new one (scripts/geometry-face-match.js linkFaceMap), or the identity
 * map when the shape is the same. A same-shape update keeps the live centre of mass,
 * which its own preview leaves out (the follow-up runs only after a shape change).
 * @param {string} dir the geometry folder @param {string} stage @param {boolean} sameShape
 */
async function writeFaceMap(dir, stage, sameShape) {
  const read = async (/** @type {string} */ p) => {
    try {
      return JSON.parse(await fsp.readFile(p, 'utf8'));
    } catch {
      return null;
    }
  };
  const live = (await read(join(dir, 'cad_preview.json'))) || {};
  const staged = join(stage, 'new', 'cad_preview.json');
  const next = (await read(staged)) || {};
  let doc;
  if (sameShape) {
    doc = { identity: true, body_map: Object.fromEntries((next.bodies || ['Body1']).map((/** @type {string} */ b) => [b, b])), report: {} };
    if (Array.isArray(live.center_of_mass) && !Array.isArray(next.center_of_mass)) {
      await fsp.writeFile(staged, JSON.stringify({ ...next, center_of_mass: live.center_of_mass, center_of_mass_kind: live.center_of_mass_kind }), 'utf8');
    }
  } else {
    doc = linkFaceMap(live, next);
  }
  await fsp.writeFile(join(stage, 'map.json'), JSON.stringify(doc), 'utf8');
  return doc;
}

// ---- the call --------------------------------------------------------------------------

/**
 * @typedef {{ rel: string, sha256: string | null, etag: string | null }} LinkFileIn
 * @typedef {{ projectId: string, plugin: string, studyId: string, shape: LinkFileIn & { format: string },
 *   faceNames: LinkFileIn | null, sourceVersion: number, basedOnRev: number | null, name: string }} LinkCall
 */

/** @param {any} f @param {string} what */
function fileIn(f, what) {
  if (!f || typeof f !== 'object' || Array.isArray(f)) throw new LinkJobError(400, 'bad_request', `${what} must be {rel, sha256} or {rel, etag}`);
  const rel = typeof f.rel === 'string' ? f.rel : '';
  if (!rel) throw new LinkJobError(400, 'bad_request', `${what}.rel is required`);
  const sha = f.sha256 === null || f.sha256 === undefined ? null : String(f.sha256);
  const etag = f.etag === null || f.etag === undefined ? null : String(f.etag);
  if (!!sha === !!etag) throw new LinkJobError(400, 'bad_request', `${what} needs exactly one of sha256 and etag`);
  if (sha && !HEX64.test(sha)) throw new LinkJobError(400, 'bad_request', `${what}.sha256 must be 64 hex digits`);
  if (etag && etag.length > 200) throw new LinkJobError(400, 'bad_request', `${what}.etag is not an etag`);
  return { rel, sha256: sha ? sha.toLowerCase() : null, etag };
}

/**
 * The body of POST /api/plugin-geometry/link, checked for its shapes (400 bad_request,
 * 400 unsupported_format).
 * @param {Record<string, any>} body
 * @returns {LinkCall}
 */
export function linkCallOf(body) {
  const projectId = String(body.project_id || '').trim();
  const plugin = String(body.plugin || '').trim();
  const studyId = String(body.study_id || '').trim();
  if (!projectId) throw new LinkJobError(400, 'bad_request', 'project_id required');
  if (!PLUGIN_KEY_RE.test(plugin) || /[. ]$/.test(plugin)) throw new LinkJobError(400, 'bad_request', 'invalid plugin key');
  if (!STUDY_ID_RE.test(studyId)) throw new LinkJobError(400, 'bad_request', 'invalid study id');
  const shapeRaw = body.shape;
  const shape = fileIn(shapeRaw, 'shape');
  const format = shapeRaw && typeof shapeRaw.format === 'string' ? shapeRaw.format : '';
  if (format !== 'brep') {
    throw new LinkJobError(400, 'unsupported_format', `This app reads the shape as 'brep' (an OCCT BREP, binary or text), not ${JSON.stringify(format)}.`, {
      formats: ['brep'],
    });
  }
  const faceNames = body.face_names === null || body.face_names === undefined ? null : fileIn(body.face_names, 'face_names');
  const sv = body.source_version;
  if (typeof sv !== 'number' || !Number.isSafeInteger(sv) || sv < 0) throw new LinkJobError(400, 'bad_request', 'source_version must be a whole number');
  const based = body.based_on_rev;
  if (based !== null && based !== undefined && (typeof based !== 'number' || !Number.isSafeInteger(based) || based < 0)) {
    throw new LinkJobError(400, 'bad_request', 'based_on_rev must be a whole number or null');
  }
  // eslint-disable-next-line no-control-regex
  const name = String(body.name === null || body.name === undefined ? '' : body.name).replace(/[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069]/g, '').trim();
  if (name.length > 120) throw new LinkJobError(400, 'bad_request', 'name is longer than 120 characters');
  return { projectId, plugin, studyId, shape: { ...shape, format }, faceNames, sourceVersion: sv, basedOnRev: based === null || based === undefined ? null : based, name };
}

/** R3 at the call and under the slot: may this design land on that state? */
function accepted(/** @type {number} */ sv, /** @type {number | null} */ based, /** @type {any} */ state) {
  if (!state) return true;
  const S = Number(state.source_version) || 0;
  const R = Number(state.rev) || 0;
  return sv > S || (sv === S && based === R);
}

/** The raw hashes equal the committed state's (the bytes are the committed design). */
function sameBytes(/** @type {any} */ state, /** @type {string} */ shapeSha, /** @type {string | null} */ namesSha) {
  return !!state && state.shape_sha256 === shapeSha && (state.names_file_sha256 || null) === (namesSha || null);
}

/** @param {any} answer */
function checkAnswer(answer) {
  if (!answer || answer.ok !== true) {
    const code = String((answer && answer.code) || 'unavailable');
    const status = { project_not_found: 404, study_not_found: 404, not_allowed: 403 }[code] || 503;
    throw new LinkJobError(status, code, String((answer && answer.error) || 'The app could not check the link right now'));
  }
  return answer;
}

/** The plugin_needed refusal for a geometry's unknown record kinds. */
function pluginNeeded(/** @type {any[]} */ unknown, /** @type {string} */ geometry, /** @type {string} */ study) {
  const first = unknown[0];
  const records = unknown.flatMap((u) => (u.records || []).map((r) => ({ kind: u.kind, key: u.key, study: r.study, studyId: r.study_id, name: r.name })));
  const message =
    unknown.length === 1 && first.bundled_off
      ? LINK_TEXT.pluginNeededOff(first.owner_name || first.owner, geometry, study)
      : LINK_TEXT.pluginNeeded(
          unknown.map((u) => u.key).join(', '),
          records.map((r) => `${r.study} \u203a ${r.name}`).join(', '),
          geometry,
        );
  return new LinkJobError(409, 'plugin_needed', message, { records });
}

/**
 * POST /api/plugin-geometry/link: accept or refuse, at the call. Answers
 * {status: 200, body: {ok, result}} for `none`, {status: 202, body: {ok, job_id,
 * geometry_id, created, queued}} for a job, or throws LinkJobError.
 * @param {LinkCall} c
 */
export async function acceptLink(c) {
  const d = L().deps;
  // 1. The plugin, the project, the study and its kind (one main-lane read).
  if (!d.pluginLoaded(c.plugin)) throw new LinkJobError(404, 'plugin_off', 'This plugin is not on');
  const pdir = projectDirOf(c.projectId);
  const check = checkAnswer(await call('geometry.link_check', { project_id: c.projectId, plugin: c.plugin, study_id: c.studyId }));
  const study = check.study;
  if (!study.available) throw new LinkJobError(404, 'plugin_off', 'This plugin is not on');
  if (study.read_only) throw new LinkJobError(409, 'read_only', 'This study was saved by a newer version of the plugin');
  if (!check.links_geometry) throw new LinkJobError(403, 'not_allowed', "This study's kind does not link a geometry (links_geometry)");
  const geom = check.geometry || null;
  const state = geom ? geom.state : null;
  // A queued job and a question waiting for its answer (5.0) follow the same rules.
  const queuedNow = studyRecords(c.projectId, c.plugin, c.studyId, ['queued', 'choosing']);
  // 2. The accept rule before any copy (it is applied again after the copy).
  const join0 = queuedNow.find((q) => c.sourceVersion === q.source_version && c.basedOnRev === q.based_on_rev);
  if (join0) return joined(join0);
  if (queuedNow.length && c.sourceVersion <= Math.max(...queuedNow.map((q) => Number(q.source_version) || 0))) {
    throw new LinkJobError(409, 'stale', LINK_TEXT.stale(study.title));
  }
  const maybeEqual = !!state && c.sourceVersion >= (Number(state.source_version) || 0);
  if (!queuedNow.length && !accepted(c.sourceVersion, c.basedOnRev, state) && !maybeEqual) {
    throw new LinkJobError(409, 'stale', LINK_TEXT.stale(study.title));
  }
  // 3. Room on the disk: the files three times over, plus the spare.
  const files = d.files;
  if (!files) throw new LinkJobError(503, 'unavailable', 'The app could not check the link right now');
  let sizes = 0;
  for (const f of [c.shape, c.faceNames]) {
    if (!f) continue;
    const info = await files.stat(c.projectId, c.plugin, f.rel);
    if (info) sizes += Number(info.size) || 0;
  }
  const free = await d.freeBytes(pdir);
  if (sizes * 3 + DISK_SPARE > free) {
    throw new LinkJobError(413, 'too_large', `There is not enough free disk space to link these files (${Math.ceil((sizes * 3 + DISK_SPARE) / MB)} MB needed, ${Math.floor(free / MB)} MB free).`, {
      needed: sizes * 3 + DISK_SPARE,
      free,
    });
  }
  // 4. The snapshot: the job's own input, under the plugin folder's lock.
  const jobId = newLinkJobId();
  const stage = stagingDirOf(c.projectId, jobId);
  let copied;
  try {
    copied = await files.snapshotFiles(
      c.projectId,
      c.plugin,
      c.studyId,
      [
        { name: 'shape', rel: c.shape.rel, sha256: c.shape.sha256, etag: c.shape.etag },
        ...(c.faceNames ? [{ name: 'face_names', rel: c.faceNames.rel, sha256: c.faceNames.sha256, etag: c.faceNames.etag }] : []),
      ],
      join(stage, 'in'),
    );
  } catch (e) {
    rmQuiet(stage);
    const err = /** @type {any} */ (e);
    if (err && typeof err.status === 'number' && err.code) throw new LinkJobError(err.status, err.code, err.message, err.extra || {});
    throw e;
  }
  const shapeSha = copied[0].sha256;
  const namesSha = c.faceNames ? copied[1].sha256 : null;
  try {
    return await afterSnapshot(c, { jobId, stage, shapeSha, namesSha, check });
  } catch (e) {
    rmQuiet(stage);
    throw e;
  }
}

/** @param {any} q a queued record (or a question still open) the call joins */
function joined(q) {
  if (q.status === 'choosing') {
    return { status: 202, body: { ok: true, job_id: q.id, geometry_id: q.geometry_id, created: false, queued: false, joined: true, choosing: q.choosing } };
  }
  return {
    status: 202,
    body: { ok: true, job_id: q.id, geometry_id: q.geometry_id, created: q.op === 'create', queued: q.op === 'update', joined: true },
  };
}

/**
 * The host's question (5.0) when a shape change lands on a geometry in use: one main-lane
 * read finds the simulation studies with saved setup (none: no question), what blocks an
 * overwrite (plugin_needed) and each copy (plugin_needed, or the geometry still updating),
 * and the name "Save as new" would give. Null when nothing uses the geometry.
 * @param {LinkCall} c @param {any} geom @param {any} study
 */
async function questionFor(c, geom, study) {
  const use = await call('geometry.usage', { project_id: c.projectId, geometry_id: geom.id });
  if (!use || use.ok !== true || !Array.isArray(use.studies) || !use.studies.length) return null;
  const dir = geometryDirOf(c.projectId, geom.id);
  const fenced = !!dir && geometryFenced(dir);
  const nv = await call('geometry.next_version', { project_id: c.projectId, plugin: c.plugin, study_id: c.studyId, base: c.name || study.title });
  const unknown = Array.isArray(use.unknown) ? use.unknown : [];
  const blocked = unknown.length ? pluginNeeded(unknown, geom.name, study.title) : null;
  return {
    geometry: { id: geom.id, name: geom.name },
    study: { id: c.studyId, title: study.title },
    new_name: String((nv && nv.name) || `${study.title} v2`),
    studies: use.studies.map((/** @type {any} */ st) => {
      const copy = fenced
        ? LINK_TEXT.stillUpdating(geom.name)
        : Array.isArray(st.unknown) && st.unknown.length
          ? pluginNeeded(st.unknown, geom.name, study.title).message
          : 'ok';
      // D36: only the study the geometry showed last starts checked.
      return { id: String(st.id), title: String(st.title), copy, checked: copy === 'ok' && st.id === use.last };
    }),
    overwrite: blocked ? { code: 'plugin_needed', message: blocked.message, records: blocked.extra.records } : 'ok',
    fenced,
  };
}

/**
 * The call after its copy: the accept rule again (synchronously, up to the record), the
 * `none` test, then a create or a queued update.
 * @param {LinkCall} c
 * @param {{ jobId: string, stage: string, shapeSha: string, namesSha: string | null, check: any }} s
 */
async function afterSnapshot(c, s) {
  const study = s.check.study;
  let geom = s.check.geometry || null;
  let state = geom ? geom.state : null;
  const active = () => studyRecords(c.projectId, c.plugin, c.studyId, ['queued', 'running']);
  // 5. `none` at the call: nothing of this study queued or running, no journal, no
  // pending recovery, and the bytes the committed design's.
  if (geom && !active().length && !geom.journal && !L().pending.has(pendingKey(c.projectId, geom.id)) && sameBytes(state, s.shapeSha, s.namesSha)) {
    const answer = await call('geometry.record_source', { project_id: c.projectId, geometry_id: geom.id, source_version: c.sourceVersion });
    if (answer && answer.ok) {
      rmQuiet(s.stage);
      // The design is the committed one again: a question still open about another one is moot.
      for (const q of studyRecords(c.projectId, c.plugin, c.studyId, 'choosing')) {
        if (c.sourceVersion > (Number(q.source_version) || 0)) supersede(q);
      }
      return {
        status: 200,
        body: {
          ok: true,
          result: linkResult({
            geometryId: geom.id,
            name: geom.name,
            rev: Number(state.rev) || 0,
            fromRev: Number(state.rev) || 0,
            change: 'none',
            bodies: state.n_solids,
            faces: state.n_faces,
          }),
        },
      };
    }
    // Refused (a journal appeared): a job decides, after the recovery.
  }
  // 6. Ask (5.0): the shape changed and a simulation study on the geometry has saved
  // setup. A names-only change, an unused geometry and a first link never ask.
  const question = geom && state && s.shapeSha !== state.shape_sha256 ? await questionFor(c, geom, study) : null;
  // An update with no question needs every record kind of its studies loaded (with the
  // question, a missing kind only blocks "Overwrite": "Save as new" rewrites no record).
  if (geom && !question) {
    const kinds = await call('geometry.check_kinds', { project_id: c.projectId, geometry_id: geom.id });
    if (kinds && Array.isArray(kinds.unknown) && kinds.unknown.length) throw pluginNeeded(kinds.unknown, geom.name, study.title);
  }
  // 7. Synchronously from here: the accept rule against what is queued, or asked, now.
  if (!s.check || !L().deps.pluginLoaded(c.plugin)) throw new LinkJobError(404, 'plugin_off', 'This plugin is not on');
  const queued = studyRecords(c.projectId, c.plugin, c.studyId, ['queued', 'choosing']);
  const same = queued.find((q) => c.sourceVersion === q.source_version && c.basedOnRev === q.based_on_rev);
  if (same) {
    rmQuiet(s.stage);
    return joined(same);
  }
  if (queued.some((q) => c.sourceVersion <= (Number(q.source_version) || 0))) throw new LinkJobError(409, 'stale', LINK_TEXT.stale(study.title));
  if (!queued.length && !accepted(c.sourceVersion, c.basedOnRev, state) && !(sameBytes(state, s.shapeSha, s.namesSha) && c.sourceVersion >= (Number(state.source_version) || 0))) {
    throw new LinkJobError(409, 'stale', LINK_TEXT.stale(study.title));
  }
  // A newer design replaces the queued one: its record ends first, then its row leaves.
  for (const q of queued) supersede(q);
  const op = geom ? 'update' : 'create';
  const geometryId = geom ? geom.id : `geom-${s.jobId.slice(-6)}${Math.floor(Math.random() * 0xffff).toString(16).padStart(4, '0')}`;
  const name = c.name || study.title;
  const geometryName = geom ? geom.name : name;
  writeJsonAtomic(join(s.stage, 'job.json'), {
    job: s.jobId,
    op,
    project_id: c.projectId,
    plugin: c.plugin,
    study_id: c.studyId,
    study_title: study.title,
    workspace: study.workspace || '',
    geometry_id: geometryId,
    source_version: c.sourceVersion,
    based_on_rev: c.basedOnRev,
    name,
    shape_sha256: s.shapeSha,
    names_file_sha256: s.namesSha,
    format: c.shape.format,
  });
  const rowName = LINK_TEXT.rowName(geometryName, study.title);
  const rec = createLinkRecord({
    id: s.jobId,
    op,
    project_id: c.projectId,
    plugin: c.plugin,
    study_id: c.studyId,
    study_title: study.title,
    workspace: study.workspace || '',
    geometry_id: geometryId,
    geometry_name: geometryName,
    name,
    source_version: c.sourceVersion,
    based_on_rev: c.basedOnRev,
    shape_sha256: s.shapeSha,
    names_file_sha256: s.namesSha,
    staging: stagingRelOf(s.jobId),
    row_name: rowName,
    ...(question ? { status: 'choosing', choosing: question } : {}),
  });
  if (question) {
    // No row and no slot: the user's answer decides (POST /api/plugin-geometry/choose).
    emitLinkEvent(rec.id, { event: 'choose', choosing: question });
    return { status: 202, body: { ok: true, job_id: rec.id, geometry_id: geometryId, created: false, queued: false, choosing: question } };
  }
  if (op === 'update') {
    enqueueUpdate(rec);
    return { status: 202, body: { ok: true, job_id: rec.id, geometry_id: geometryId, created: false, queued: true } };
  }
  emitLinkEvent(rec.id, { event: 'queued', ahead: 0 });
  startCreateWhenFree(c.projectId, c.plugin, c.studyId);
  return { status: 202, body: { ok: true, job_id: rec.id, geometry_id: geometryId, created: true, queued: false } };
}

/** An accepted overwrite joins the compute queue: its row, then `queued {ahead}`. @param {any} rec */
function enqueueUpdate(rec) {
  const q = enqueueGeometryJob({
    id: `q-${Date.now().toString(36)}${String(rec.id).slice(-4)}`,
    kind: 'geometry',
    project_id: rec.project_id,
    name: rec.row_name,
    job_id: rec.id,
    geometry: { plugin: rec.plugin, study_id: rec.study_id, geometry_id: rec.geometry_id },
  });
  if (!q.ok || !q.item) {
    finish(rec.id, 'failed', { error: 'The update could not be queued' });
    throw new Error('the update could not be queued');
  }
  updateLinkRecord(rec.id, { row_id: q.item.id });
  emitLinkEvent(rec.id, { event: 'queued', ahead: queueAheadOf(q.item.id) });
  scheduleComputeQueueKick(250);
}

/**
 * POST /api/plugin-geometry/choose (host-only; 5.0): the user's answer to the host's
 * question. Accepts only a `choosing` record of that project and (plugin, study), and
 * only study ids its question offered for a copy. `new` makes a create beside the old
 * geometry (no slot); `overwrite` queues the update (plugin_needed is checked again);
 * `cancel` ends the record `cancelled` and drops its staging.
 * @param {Record<string, any>} body
 */
export async function chooseLink(body) {
  const projectId = String(body.project_id || '').trim();
  const plugin = String(body.plugin || '').trim();
  const studyId = String(body.study_id || '').trim();
  const jobId = String(body.job_id || '').trim();
  const choice = String(body.choice || '');
  if (!projectId || !PLUGIN_KEY_RE.test(plugin) || !STUDY_ID_RE.test(studyId) || !LINK_JOB_RE.test(jobId)) {
    throw new LinkJobError(400, 'bad_request', 'project_id, plugin, study_id and job_id are required');
  }
  if (!['new', 'overwrite', 'cancel'].includes(choice)) throw new LinkJobError(400, 'bad_request', "choice must be 'new', 'overwrite' or 'cancel'");
  const copy = Array.isArray(body.copy) ? [...new Set(body.copy.map((/** @type {any} */ x) => String(x)))] : [];
  const rec0 = readLinkRecord(jobId);
  if (!rec0 || !sameStudy(rec0, projectId, plugin, studyId)) throw new LinkJobError(404, 'not_found', 'No such question in this study');
  if (rec0.status !== 'choosing') throw new LinkJobError(409, 'not_choosing', LINK_TEXT.answered);
  const q = rec0.choosing || {};
  const offered = new Map((Array.isArray(q.studies) ? q.studies : []).map((/** @type {any} */ st) => [String(st.id), st]));
  if (choice === 'new') {
    for (const id of copy) {
      const st = offered.get(id);
      if (!st) throw new LinkJobError(400, 'bad_request', 'The question did not offer that study');
      if (st.copy !== 'ok') throw new LinkJobError(409, 'not_allowed', String(st.copy));
    }
  }
  if (choice === 'overwrite') {
    // A plugin may have been turned on (or off) since the question was asked.
    const kinds = await call('geometry.check_kinds', { project_id: projectId, geometry_id: rec0.geometry_id });
    if (kinds && Array.isArray(kinds.unknown) && kinds.unknown.length) throw pluginNeeded(kinds.unknown, rec0.geometry_name, rec0.study_title);
  }
  // Synchronously from here: the record may have been answered or superseded meanwhile.
  const rec = readLinkRecord(jobId);
  if (!rec || rec.status !== 'choosing') throw new LinkJobError(409, 'not_choosing', LINK_TEXT.answered);
  if (choice !== 'cancel') {
    // "Save as new" of this study is under way: it unlinks the geometry asked about, so
    // neither answer can be acted on until it ends (the question stays open meanwhile).
    const adding = studyRecords(projectId, plugin, studyId, ['queued', 'running']).find((r) => r.op === 'create' && r.id !== rec.id);
    if (adding) throw new LinkJobError(409, 'busy', LINK_TEXT.adding(String(adding.geometry_name || adding.name || 'the new geometry')));
    // The geometry asked about is no longer this study's linked one (a "Save as new"
    // moved the link, or it was removed): the question is moot.
    if (!stillLinked(rec.project_id, rec.geometry_id)) {
      const error = LINK_TEXT.notLinked(rec.geometry_name, rec.study_title);
      finish(rec.id, 'stale', { error, code: 'stale' });
      rmQuiet(stagingDirOf(rec.project_id, rec.id));
      throw new LinkJobError(409, 'stale', error);
    }
  }
  if (choice === 'cancel') {
    finish(rec.id, 'cancelled', { error: LINK_TEXT.kept, code: 'cancelled' });
    rmQuiet(stagingDirOf(rec.project_id, rec.id));
    return { status: 200, body: { ok: true, job_id: rec.id, cancelled: true } };
  }
  if (choice === 'overwrite') {
    updateLinkRecord(rec.id, { status: 'queued', op: 'update', choice });
    emitLinkEvent(rec.id, { event: 'chosen', choice });
    enqueueUpdate(readLinkRecord(rec.id));
    return { status: 202, body: { ok: true, job_id: rec.id, geometry_id: rec.geometry_id, created: false, queued: true } };
  }
  const newId = `geom-${rec.id.slice(-6)}${Math.floor(Math.random() * 0xffff).toString(16).padStart(4, '0')}`;
  const jobPath = join(stagingDirOf(rec.project_id, rec.id), 'job.json');
  writeJsonAtomic(jobPath, { ...(readJson(jobPath) || {}), op: 'create', geometry_id: newId, save_as_new: true, old_geometry_id: rec.geometry_id });
  updateLinkRecord(rec.id, {
    status: 'queued',
    op: 'create',
    choice,
    save_as_new: true,
    old_geometry_id: rec.geometry_id,
    old_geometry_name: rec.geometry_name,
    geometry_id: newId,
    geometry_name: String(q.new_name || rec.name),
    copy,
  });
  emitLinkEvent(rec.id, { event: 'chosen', choice, geometryId: newId });
  emitLinkEvent(rec.id, { event: 'queued', ahead: 0 });
  startCreateWhenFree(rec.project_id, rec.plugin, rec.study_id);
  return { status: 202, body: { ok: true, job_id: rec.id, geometry_id: newId, created: true, queued: false } };
}

/** A deleted plugin study's question ends `cancelled` (5.19). @param {string} projectId @param {string} plugin @param {string} studyId */
export function cancelStudyQuestions(projectId, plugin, studyId) {
  for (const rec of studyRecords(projectId, plugin, studyId, 'choosing')) {
    finish(rec.id, 'cancelled', { error: LINK_TEXT.studyDeleted, code: 'cancelled' });
    rmQuiet(stagingDirOf(rec.project_id, rec.id));
  }
}

/** A queued job that a newer design replaced: its record ends, then its row and staging go. */
function supersede(/** @type {any} */ q) {
  finish(q.id, 'superseded', { error: 'A newer link of this study replaced it', code: 'superseded' });
  if (q.row_id) dropComputeRows([q.row_id], 'superseded', 'skipped');
  try {
    rmQuiet(stagingDirOf(q.project_id, q.id));
  } catch {
    /* gone */
  }
}

// ---- the queue's side ---------------------------------------------------------------

/**
 * A geometry row left the queue without being started: `removed` (the user, in the
 * Queue) cancels it; `failed` fails it; any other leave of a still queued record is
 * "Lost from the queue". Supersede and removal end the record first, so then nothing happens.
 * @param {any} row @param {string} reason @param {string} [error]
 */
export function onLinkQueueLeave(row, reason, error) {
  if (!row || row.kind !== 'geometry' || !row.job_id) return;
  const rec = readLinkRecord(row.job_id);
  if (!rec || rec.status !== 'queued') return;
  if (reason === 'removed') finish(rec.id, 'cancelled', { error: LINK_TEXT.cancelled, code: 'cancelled' });
  else if (reason === 'failed') finish(rec.id, 'failed', { error: error || 'Could not start', code: 'failed' });
  else finish(rec.id, 'failed', { error: LINK_TEXT.lostQueue, code: 'failed' });
  try {
    rmQuiet(stagingDirOf(rec.project_id, rec.id));
  } catch {
    /* gone */
  }
}

/** After every queue write: each queued update hears how many jobs are ahead, when that changed. */
export function onLinkQueueChange() {
  const s = L();
  for (const rec of listLinkRecords({ status: 'queued', filter: (r) => r.op === 'update' && !!r.row_id })) {
    const ahead = queueAheadOf(rec.row_id);
    if (ahead === null || ahead === undefined || s.aheads.get(rec.id) === ahead) continue;
    s.aheads.set(rec.id, ahead);
    emitLinkEvent(rec.id, { event: 'queued', ahead });
  }
}

/**
 * The queue starts an update. Synchronous, like startFoam: the slot claimed here, the
 * job's body started, {ok:true}; or {busy:true}; or final when its input is gone.
 * @param {any} row
 */
export function startGeometryUpdate(row) {
  const id = row && row.job_id ? String(row.job_id) : '';
  if (computeSlotHolder()) return { busy: true };
  const rec = id ? readLinkRecord(id) : null;
  if (!rec || rec.op !== 'update' || rec.status !== 'queued') return { missing: true };
  const rowName = String(row.name || rec.row_name || 'Geometry update');
  let jobOk;
  try {
    jobOk = statSync(join(stagingDirOf(rec.project_id, rec.id), 'job.json')).isFile();
  } catch {
    jobOk = false;
  }
  if (!jobOk) {
    const error = LINK_TEXT.lostInput(rowName);
    finish(rec.id, 'failed', { error, code: 'failed' });
    return { ok: false, final: true, error };
  }
  const key = studyKey(rec.project_id, rec.plugin, rec.study_id);
  const holder = L().locks.get(key);
  // A create of this study (a first link or "Save as new") holds the study lock with the
  // slot free: this row waits without holding up the rows of other projects behind it.
  if (holder && holder !== rec.id) return { deferred: true };
  const claimed = claimComputeSlot(
    'geometry',
    { project_id: rec.project_id, job_id: rec.id, name: rowName, plugin: rec.plugin, study_id: rec.study_id, geometry_id: rec.geometry_id },
    { phase: 'running' },
  );
  if (!claimed.ok) return { busy: true };
  const token = claimed.token;
  try {
    L().locks.set(key, rec.id);
    const live = { id: rec.id, projectId: rec.project_id, geometryId: rec.geometry_id, aborted: false, children: new Set(), phase: 'start' };
    L().live.set(rec.id, live);
    updateLinkRecord(rec.id, { status: 'running', started_at: new Date().toISOString() });
    emitLinkEvent(rec.id, { event: 'start' });
    void runUpdate(rec.id, live)
      .catch((e) => {
        console.warn(`[CFD link] ${rec.id}: the update failed`, e);
        finish(rec.id, 'failed', { error: 'The update failed. See the server log.', code: 'failed' });
      })
      .finally(() => {
        L().live.delete(rec.id);
        if (L().locks.get(key) === rec.id) L().locks.delete(key);
        releaseComputeSlot(token);
        startCreateWhenFree(rec.project_id, rec.plugin, rec.study_id);
      });
    return { ok: true };
  } catch (e) {
    L().live.delete(rec.id);
    if (L().locks.get(key) === rec.id) L().locks.delete(key);
    releaseComputeSlot(token);
    throw e;
  }
}

// ---- the preview -------------------------------------------------------------------------

/**
 * The job's preview process: the geometry files into <staging>/new and the report.
 * @returns {Promise<{ ok: boolean, report?: any, code?: string, error?: string }>}
 */
async function runPreviewOf(/** @type {any} */ rec, /** @type {LiveJob} */ live) {
  const stage = stagingDirOf(rec.project_id, rec.id);
  const out = join(stage, 'new');
  const reportPath = join(stage, 'preview.json');
  rmQuiet(out);
  try {
    unlinkSync(reportPath);
  } catch {
    /* none */
  }
  const args = ['--shape', join(stage, 'in', 'shape'), '--format', 'brep', '--out', out, '--report', reportPath, '--shape-sha256', rec.shape_sha256];
  if (rec.names_file_sha256) args.push('--names', join(stage, 'in', 'face_names'));
  const ran = await L().deps.runPreview(args, { timeoutMs: L().deps.timing.previewMs, live });
  const report = readJson(reportPath);
  if (report && report.ok === false) return { ok: false, code: String(report.code || 'preview_failed'), error: String(report.error || 'The shape was refused') };
  if (!report || report.ok !== true || ran.code !== 0) {
    const tail = String(ran.stderr || '').trim().split(/\r?\n/).filter(Boolean).slice(-1)[0] || '';
    return {
      ok: false,
      code: 'preview_failed',
      error: ran.timedOut ? 'The app could not mesh the shape in 15 minutes.' : `The app could not mesh the shape.${tail ? ' ' + tail.slice(0, 300) : ''}`,
    };
  }
  // The preview's stage events (LINK_STAGE lines; the report's timings): kept on the
  // record and logged, one row per term of the speed plan's table.
  if (report.timings && typeof report.timings === 'object') {
    updateLinkRecord(rec.id, { preview_timings: report.timings, display_budget: !!report.display_budget });
    console.log(`[CFD link] ${rec.id}: preview stages ${JSON.stringify(report.timings)}`);
  }
  return { ok: true, report };
}

// ---- the update (inside the slot) ------------------------------------------------------

/** @param {string} id @param {LiveJob} live */
async function runUpdate(id, live) {
  const t0 = L().deps.now();
  let rec = readLinkRecord(id);
  if (!rec) return;
  const ended = (/** @type {string} */ status, /** @type {Record<string, any>} */ fields = {}) => {
    finish(id, status, fields);
    rmQuiet(stagingDirOf(rec.project_id, rec.id));
  };
  setStage(id, 'reading');
  let dir = geometryDirOf(rec.project_id, rec.geometry_id);
  if (!dir || live.aborted) return ended('gone', { error: LINK_TEXT.removed, code: 'gone' });
  // A journal left: the recovery first, inside this claim.
  if (existsSync(join(dir, 'link', 'commit.json'))) {
    const rk = pendingKey(rec.project_id, rec.geometry_id);
    const pend = L().pending.get(rk) || { projectId: rec.project_id, geometryId: rec.geometry_id, name: rec.geometry_name, tries: 0, nextAt: 0 };
    const r = await recoverOne(pend);
    if (!r.ok) return ended('failed', { error: r.error || LINK_TEXT.fenced(rec.geometry_name), code: 'failed' });
    L().pending.delete(rk);
    dir = geometryDirOf(rec.project_id, rec.geometry_id);
    if (!dir) return ended('gone', { error: LINK_TEXT.removed, code: 'gone' });
  }
  let state = linkStateOf(dir);
  if (!state) return ended('gone', { error: LINK_TEXT.removed, code: 'gone' });
  // "Save as new" moved the link meanwhile: the overwrite of the old geometry is moot.
  if (!stillLinked(rec.project_id, rec.geometry_id)) return ended('stale', { error: LINK_TEXT.notLinked(rec.geometry_name, rec.study_title), code: 'stale' });
  // Equal bytes first, then R3 (a job queued behind another of the study may be stale now).
  const none = async () => {
    const answer = await call('geometry.record_source', { project_id: rec.project_id, geometry_id: rec.geometry_id, source_version: rec.source_version });
    if (!answer || !answer.ok) return ended('failed', { error: String((answer && answer.error) || 'The link could not be recorded'), code: 'failed' });
    const st = linkStateOf(dir) || state;
    return ended('done', {
      result: linkResult({ geometryId: rec.geometry_id, name: st.name || rec.geometry_name, rev: Number(st.rev), fromRev: Number(st.rev), change: 'none', bodies: st.n_solids, faces: st.n_faces, seconds: (L().deps.now() - t0) / 1000 }),
    });
  };
  if (sameBytes(state, rec.shape_sha256, rec.names_file_sha256) && rec.source_version >= (Number(state.source_version) || 0)) return none();
  if (!accepted(rec.source_version, rec.based_on_rev, state)) return ended('stale', { error: LINK_TEXT.stale(rec.study_title), code: 'stale' });
  // The preview, in its own process.
  setStage(id, 'meshing');
  live.phase = 'preview';
  const preview = await runPreviewOf(rec, live);
  if (live.aborted || !geometryDirOf(rec.project_id, rec.geometry_id)) return ended('gone', { error: LINK_TEXT.removed, code: 'gone' });
  if (!preview.ok) return ended('failed', { error: preview.error, code: preview.code });
  state = linkStateOf(dir) || state;
  const sameShape = rec.shape_sha256 === state.shape_sha256;
  if (sameShape && (preview.report.names_sha256 || null) === (state.names_sha256 || null)) return none();
  // Name the faces and match them to the live ones.
  setStage(id, 'matching');
  await writeFaceMap(dir, stagingDirOf(rec.project_id, rec.id), sameShape);
  // The commit.
  rec = readLinkRecord(id) || rec;
  const committed = await commitUpdate(rec, live, dir, Number(state.rev) || 0, sameShape);
  if (!committed.ok) {
    if (committed.keepStaging) {
      finish(id, committed.status, { error: committed.error, code: committed.code });
      return;
    }
    return ended(committed.status, { error: committed.error, code: committed.code });
  }
  const st = linkStateOf(dir) || {};
  const result = linkResult({
    geometryId: rec.geometry_id,
    name: st.name || rec.geometry_name,
    rev: Number(st.rev),
    fromRev: committed.fromRev,
    change: committed.change,
    bodies: preview.report.n_solids,
    faces: preview.report.n_faces,
    named: preview.report.named,
    report: committed.report,
    seconds: (L().deps.now() - t0) / 1000,
  });
  updateLinkRecord(id, { result });
  // The follow-ups, still inside the slot (stage finishing); then the record ends.
  setStage(id, 'finishing');
  live.phase = 'follow-ups';
  await runFollowUps(rec, live, dir, { create: false, rev: Number(st.rev), change: committed.change });
  ended('done', { result });
}

/** @param {string} change */
function movesFor(change) {
  return change === 'names' ? { out: NAME_FILES, in: NAME_FILES } : { out: SHAPE_FILES_OUT, in: SHAPE_FILES_IN };
}

/**
 * The swap, in one synchronous step: the journal at phase swap, each live file that
 * changes into <staging>/old, each staged file into place, the journal at phase apply.
 * On the first error every rename made so far is undone in reverse and the journal
 * goes: the folder is whole at the old rev. Returns {ok} | {ok:false, held} |
 * {ok:false, undoFailed} (the journal stays at swap: fenced).
 * @param {{ projectDir: string, geomDir: string, stage: string, job: string, fromRev: number, rev: number, change: string }} o
 */
export function swapOnce(o) {
  const plan = movesFor(o.change);
  const rel = (/** @type {string} */ p) => relative(o.projectDir, p).replace(/\\/g, '/');
  /** @type {Array<{ from: string, to: string }>} */
  const moves = [];
  for (const name of plan.out) {
    const live = join(o.geomDir, name);
    if (existsSync(live)) moves.push({ from: live, to: join(o.stage, 'old', name) });
  }
  for (const name of plan.in) {
    const staged = join(o.stage, 'new', name);
    if (existsSync(staged)) moves.push({ from: staged, to: join(o.geomDir, name) });
  }
  const journalPath = join(o.geomDir, 'link', 'commit.json');
  const journal = {
    job: o.job,
    from_rev: o.fromRev,
    rev: o.rev,
    change: o.change,
    staging: rel(o.stage),
    moves: moves.map((m) => ({ from: rel(m.from), to: rel(m.to) })),
    phase: 'swap',
  };
  mkdirSync(join(o.stage, 'old'), { recursive: true });
  writeJsonAtomic(journalPath, journal);
  /** @type {Array<{ from: string, to: string }>} */
  const done = [];
  try {
    moves.forEach((m, i) => {
      renameSync(m.from, m.to);
      done.push(m);
      hook('afterMove', i, m);
    });
    writeJsonAtomic(journalPath, { ...journal, phase: 'apply' });
    return { ok: true, moves: journal.moves };
  } catch (e) {
    let undoFailed = false;
    for (const m of done.slice().reverse()) {
      try {
        renameSync(m.to, m.from);
      } catch {
        undoFailed = true;
      }
    }
    if (undoFailed) return { ok: false, undoFailed: true, error: String(/** @type {any} */ (e) && /** @type {any} */ (e).code) };
    try {
      unlinkSync(journalPath);
    } catch {
      /* the next try writes it again */
    }
    return { ok: false, held: true, error: String(/** @type {any} */ (e) && /** @type {any} */ (e).code) };
  }
}

/**
 * Undo a swap by what exists: each planned move, in reverse, whose destination exists
 * and whose source does not, goes back. Safe to repeat. True when every move is back.
 * @param {string} projectDir @param {any} journal
 */
export function undoByWhatExists(projectDir, journal) {
  let whole = true;
  for (const m of (Array.isArray(journal && journal.moves) ? journal.moves : []).slice().reverse()) {
    const from = resolve(projectDir, m.from);
    const to = resolve(projectDir, m.to);
    // A move that never happened has its source still there: nothing to undo.
    if (existsSync(to) && !existsSync(from)) {
      try {
        renameSync(to, from);
      } catch {
        whole = false;
      }
    }
  }
  return whole;
}

/** @param {number} attempt */
function waitStep(attempt) {
  const t = L().deps.timing;
  return attempt < t.waitSteps.length ? t.waitSteps[attempt] : t.waitEvery;
}

/**
 * Plan, swap and apply, with the project's gate closed from the plan to the end of the
 * apply. Waits (stage `waiting`) while open requests or another program's handles stop
 * it, up to 10 minutes.
 * @returns {Promise<{ ok: boolean, change?: string, fromRev?: number, report?: any, status?: string, code?: string, error?: string, keepStaging?: boolean }>}
 */
async function commitUpdate(/** @type {any} */ rec, /** @type {LiveJob} */ live, /** @type {string} */ dir, /** @type {number} */ fromRev, /** @type {boolean} */ sameShape) {
  const d = L().deps;
  const pdir = projectDirOf(rec.project_id);
  const stage = stagingDirOf(rec.project_id, rec.id);
  const name = rec.geometry_name;
  const deadline = d.now() + d.timing.waitLoopMs;
  for (let attempt = 0; ; attempt += 1) {
    // 1. The geometry and its project are still there; R3 again.
    if (live.aborted || !geometryDirOf(rec.project_id, rec.geometry_id)) return { ok: false, status: 'gone', code: 'gone', error: LINK_TEXT.removed };
    const st = linkStateOf(dir);
    if (!st) return { ok: false, status: 'gone', code: 'gone', error: LINK_TEXT.removed };
    if (!stillLinked(rec.project_id, rec.geometry_id)) return { ok: false, status: 'stale', code: 'stale', error: LINK_TEXT.notLinked(name, rec.study_title) };
    if ((Number(st.rev) || 0) !== fromRev || !accepted(rec.source_version, rec.based_on_rev, st)) {
      return { ok: false, status: 'stale', code: 'stale', error: LINK_TEXT.stale(rec.study_title) };
    }
    setStage(rec.id, 'saving');
    live.phase = 'gate';
    // 2. Close the gate and drain it.
    const drained = await closeGate(rec.project_id, name);
    let held = false;
    if (drained) {
      let gateOpen = false;
      const open = () => {
        if (!gateOpen) {
          gateOpen = true;
          openGate(rec.project_id);
        }
      };
      try {
        // 3. Plan.
        live.phase = 'plan';
        const planned = await call('geometry.plan', {
          project_id: rec.project_id,
          geometry_id: rec.geometry_id,
          staging_rel: stagingRelOf(rec.id),
          from_rev: fromRev,
          same_shape: sameShape,
        });
        if (!planned || !planned.ok) {
          open();
          const code = String((planned && planned.code) || 'failed');
          if (code === 'plugin_needed') {
            const err = pluginNeeded((planned && planned.data) || [], name, rec.study_title);
            return { ok: false, status: 'failed', code, error: err.message };
          }
          if (code === 'gone') return { ok: false, status: 'gone', code, error: LINK_TEXT.removed };
          if (code === 'unlinked') return { ok: false, status: 'stale', code: 'stale', error: LINK_TEXT.notLinked(name, rec.study_title) };
          if (code === 'stale') return { ok: false, status: 'stale', code, error: LINK_TEXT.stale(rec.study_title) };
          return { ok: false, status: 'failed', code: 'failed', error: String((planned && planned.error) || 'The update could not be planned') };
        }
        // 4. Swap.
        live.phase = 'swap';
        const swapped = swapOnce({ projectDir: pdir, geomDir: dir, stage, job: rec.id, fromRev, rev: Number(planned.rev), change: String(planned.change) });
        if (!swapped.ok && swapped.undoFailed) {
          // 9. The undo failed: fenced until the job undoes it by what exists.
          open();
          const undone = await retryUndo(rec, live, pdir, dir, deadline);
          if (!undone.ok) return undone;
          held = true;
        } else if (!swapped.ok) {
          open();
          held = true;
        } else {
          // 5. Apply.
          live.phase = 'apply';
          const landed = await applyLanded(rec, dir);
          if (landed) {
            cleanUpCommit(dir, stage);
            open();
            return { ok: true, change: String(planned.change), fromRev, report: planned.report || null };
          }
          // 7. It did not land: fenced; the recovery finishes it. Fenced before the gate
          // opens, so no request that waited at the gate reads the half-updated folder.
          live.phase = 'fenced';
          open();
          addPending(rec.project_id, rec.geometry_id, name);
          return { ok: false, status: 'failed', code: 'failed', error: LINK_TEXT.fenced(name), keepStaging: true };
        }
      } catch (e) {
        open();
        throw e;
      }
    }
    // 8. Open requests, or a held file: wait with the folder whole, then try again.
    if (d.now() >= deadline) return { ok: false, status: 'busy', code: 'busy', error: LINK_TEXT.busy(name) };
    setStage(rec.id, 'waiting', LINK_TEXT.waiting(name));
    live.phase = held ? 'waiting-held' : 'waiting-open';
    await d.sleep(waitStep(attempt));
  }
}

/**
 * The apply, its timeout and its barrier: true when this job's state landed. An error
 * answer is retried twice (1 s, 4 s); after a timeout it is never sent again: the gate
 * stays closed until a barrier on the main lane answers, then link/state.json says.
 */
async function applyLanded(/** @type {any} */ rec, /** @type {string} */ dir) {
  const d = L().deps;
  const params = { project_id: rec.project_id, geometry_id: rec.geometry_id, staging_rel: stagingRelOf(rec.id) };
  for (let i = 0; ; i += 1) {
    const sent = call('geometry.apply', params, d.timing.applyMs + 60_000);
    /** @type {any} */
    let outcome;
    let timer = null;
    try {
      outcome = await Promise.race([
        sent.then((a) => ({ answer: a }), (e) => ({ error: e })),
        new Promise((r) => (timer = setTimeout(() => r({ timeout: true }), d.timing.applyMs))),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
    if (outcome.timeout) {
      sent.catch(() => {});
      try {
        await call('geometry.barrier', {}, 24 * 3600_000);
      } catch {
        /* the worker died: its apply is gone with it */
      }
      const st = linkStateOf(dir);
      return !!st && st.job_id === rec.id;
    }
    if (outcome.answer && outcome.answer.ok) return true;
    if (i >= d.timing.applyRetries.length) {
      const st = linkStateOf(dir);
      return !!st && st.job_id === rec.id;
    }
    await d.sleep(d.timing.applyRetries[i]);
  }
}

/** @param {string} dir @param {string} stage */
function cleanUpCommit(dir, stage) {
  try {
    unlinkSync(join(dir, 'link', 'commit.json'));
  } catch {
    /* gone */
  }
  rmQuiet(join(stage, 'old'));
}

/**
 * The undo failed (a file became held between its rename and its undo): the journal
 * stays at swap and the geometry is fenced; the job keeps the slot and retries the
 * undo by what exists on the backoff. Undone: {ok:true}, and the commit tries again;
 * not undone in time: the recovery takes over.
 * @returns {Promise<{ ok: boolean, status?: string, code?: string, error?: string, keepStaging?: boolean }>}
 */
async function retryUndo(/** @type {any} */ rec, /** @type {LiveJob} */ live, /** @type {string} */ pdir, /** @type {string} */ dir, /** @type {number} */ deadline) {
  const d = L().deps;
  const name = rec.geometry_name;
  live.phase = 'undo';
  for (let attempt = 0; ; attempt += 1) {
    const journal = journalOf(dir);
    if (!journal) return { ok: true };
    if (undoByWhatExists(pdir, journal)) {
      try {
        unlinkSync(join(dir, 'link', 'commit.json'));
      } catch {
        /* the recovery removes it */
      }
      return { ok: true };
    }
    if (live.aborted || d.now() >= deadline) {
      addPending(rec.project_id, rec.geometry_id, name);
      return { ok: false, status: 'failed', code: 'failed', error: LINK_TEXT.fenced(name), keepStaging: true };
    }
    setStage(rec.id, 'waiting', LINK_TEXT.waiting(name));
    await d.sleep(waitStep(attempt));
  }
}

// ---- the create (outside the slot) ---------------------------------------------------------

/** Start the oldest queued create of a study when its lock is free. */
function startCreateWhenFree(/** @type {string} */ projectId, /** @type {string} */ plugin, /** @type {string} */ studyId) {
  const key = studyKey(projectId, plugin, studyId);
  if (L().locks.has(key)) return;
  const next = studyRecords(projectId, plugin, studyId, 'queued')
    .filter((r) => r.op === 'create')
    .sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)))[0];
  if (!next) return;
  L().locks.set(key, next.id);
  const live = { id: next.id, projectId, geometryId: next.geometry_id, aborted: false, children: new Set(), phase: 'start' };
  L().live.set(next.id, live);
  updateLinkRecord(next.id, { status: 'running', started_at: new Date().toISOString() });
  emitLinkEvent(next.id, { event: 'start' });
  void runCreate(next.id, live)
    .catch((e) => {
      console.warn(`[CFD link] ${next.id}: the create failed`, e);
      finish(next.id, 'failed', { error: 'Linking the geometry failed. See the server log.', code: 'failed' });
      rmQuiet(stagingDirOf(projectId, next.id));
    })
    .finally(() => {
      L().live.delete(next.id);
      if (L().locks.get(key) === next.id) L().locks.delete(key);
      startCreateWhenFree(projectId, plugin, studyId);
      // An overwrite of this study waited in the queue for the lock.
      scheduleComputeQueueKick(250);
    });
}

/** Queued creates whose staging survived a restart start once the registry has loaded. */
export function resumeQueuedCreates() {
  const seen = new Set();
  for (const r of listLinkRecords({ status: 'queued', filter: (x) => x.op === 'create' })) {
    const k = studyKey(r.project_id, r.plugin, r.study_id);
    if (seen.has(k)) continue;
    seen.add(k);
    startCreateWhenFree(r.project_id, r.plugin, r.study_id);
  }
}

/** The project.json record of a linked geometry (refreshed by project.upsert_geometry). */
function geometryRecord(/** @type {any} */ rec, /** @type {string} */ dir, /** @type {any} */ state, /** @type {any} */ source) {
  return {
    id: rec.geometry_id,
    name: state.name || rec.geometry_name,
    original_filename: null,
    original_path: null,
    source_kind: 'plugin',
    length_unit: null,
    representation: 'step',
    tessellated: false,
    watertight: true,
    step_path: join(dir, 'source.step'),
    n_solids: state.n_solids || 1,
    n_faces: state.n_faces || null,
    body_offset: 0,
    imported_at: (source && source.linked_at) || state.synced_at || new Date().toISOString(),
    note: `Linked from ${rec.study_title}.`,
    source,
  };
}

/**
 * A create: a first link (or the next after a remove), or "Save as new" (5.0). Outside the
 * slot, under the study lock. The folder is built in staging with link/pending.json, so
 * the lookup, the tree and the repair skip it until its commit; it is renamed into
 * geometries/ under a free name; "Save as new" then copies the chosen studies' setup onto
 * it (the existing study copy keeping the labels, then the link's own map and rewrite on
 * the copies only); geometry.link_commit removes pending.json (the commit point) and marks
 * the old geometry unlinked. Nothing of the old geometry or its studies is written.
 * @param {string} id @param {LiveJob} live
 */
async function runCreate(id, live) {
  const t0 = L().deps.now();
  const rec = readLinkRecord(id);
  if (!rec) return;
  const stage = stagingDirOf(rec.project_id, rec.id);
  const ended = (/** @type {string} */ status, /** @type {Record<string, any>} */ fields = {}) => {
    finish(id, status, fields);
    rmQuiet(stage);
  };
  setStage(id, 'reading');
  let pdir;
  try {
    pdir = projectDirOf(rec.project_id);
  } catch {
    return ended('gone', { error: 'The project was removed', code: 'gone' });
  }
  if (!existsSync(join(pdir, 'project.json'))) return ended('gone', { error: 'The project was removed', code: 'gone' });
  // Under the study lock: the geometry linked to this study now.
  const again = await call('geometry.link_check', { project_id: rec.project_id, plugin: rec.plugin, study_id: rec.study_id });
  const linkedNow = again && again.ok && again.geometry ? again.geometry : null;
  if (linkedNow && !rec.save_as_new) {
    // A first link racing another tab's: this one becomes an update of that geometry.
    const geom = linkedNow;
    const rowName = LINK_TEXT.rowName(geom.name, rec.study_title);
    updateLinkRecord(id, { op: 'update', geometry_id: geom.id, geometry_name: geom.name, row_name: rowName, status: 'queued', started_at: null });
    const jobPath = join(stage, 'job.json');
    writeJsonAtomic(jobPath, { ...(readJson(jobPath) || {}), op: 'update', geometry_id: geom.id });
    const q = enqueueGeometryJob({ kind: 'geometry', project_id: rec.project_id, name: rowName, job_id: id, geometry: { plugin: rec.plugin, study_id: rec.study_id, geometry_id: geom.id } });
    if (q.ok && q.item) {
      updateLinkRecord(id, { row_id: q.item.id });
      emitLinkEvent(id, { event: 'queued', ahead: queueAheadOf(q.item.id) });
      scheduleComputeQueueKick(250);
    }
    return;
  }
  // "Save as new" leaves the geometry the study links now (the one asked about, or a
  // newer one a commit made meanwhile) as a plain one: its face table is the copy's source.
  const old = rec.save_as_new ? linkedNow || null : null;
  const oldId = old ? String(old.id) : rec.save_as_new ? String(rec.old_geometry_id || '') : '';
  const oldDir = oldId ? geometryDirOf(rec.project_id, oldId) : null;
  const oldState = oldDir ? linkStateOf(oldDir) : null;
  const oldName = String((old && old.name) || rec.old_geometry_name || '');
  // The version and the name ("<base> v<k>" from 2; k goes up past a name taken).
  const nv = await call('geometry.next_version', { project_id: rec.project_id, plugin: rec.plugin, study_id: rec.study_id, base: rec.name });
  const version = Number(nv && nv.version) > 0 ? Number(nv.version) : 1;
  const gname = String((nv && nv.name) || rec.name);
  updateLinkRecord(id, { geometry_name: gname });
  setStage(id, 'meshing');
  live.phase = 'preview';
  const preview = await runPreviewOf(rec, live);
  if (live.aborted) return ended('gone', { error: 'The project was removed', code: 'gone' });
  if (!preview.ok) return ended('failed', { error: preview.error, code: preview.code });
  setStage(id, 'saving');
  live.phase = 'build';
  // The whole folder in staging: id.json (with source), the files, link/state.json and
  // link/pending.json (hidden until the commit).
  const job = readJson(join(stage, 'job.json')) || {};
  const linkedAt = new Date().toISOString();
  const source = { type: 'plugin_study', plugin: rec.plugin, study_id: rec.study_id, workspace: rec.workspace || job.workspace || '', linked_at: linkedAt };
  const build = join(stage, 'geom');
  rmQuiet(build);
  mkdirSync(join(build, 'link'), { recursive: true });
  mkdirSync(join(build, 'simulations'), { recursive: true });
  writeJsonAtomic(join(build, 'id.json'), { id: rec.geometry_id, name: gname, original_filename: null, kind: 'geometry', source });
  for (const name of SHAPE_FILES_IN) {
    const from = join(stage, 'new', name);
    if (!existsSync(from)) continue;
    // The copies' map reads the new face table from staging: that one file stays there too.
    if (name === 'cad_preview.json' && rec.save_as_new) copyFileSync(from, join(build, name));
    else renameSync(from, join(build, name));
  }
  const state = {
    rev: 1,
    version,
    source_version: rec.source_version,
    name: gname,
    shape_sha256: rec.shape_sha256,
    names_file_sha256: rec.names_file_sha256 || null,
    names_sha256: preview.report.names_sha256 || null,
    n_solids: preview.report.n_solids,
    n_faces: preview.report.n_faces,
    bounds: preview.report.bounds || null,
    bodies: preview.report.bodies || [],
    synced_at: linkedAt,
    job_id: rec.id,
  };
  writeJsonAtomic(join(build, 'link', 'state.json'), state);
  writeJsonAtomic(join(build, 'link', 'pending.json'), { job_id: rec.id, at: linkedAt });
  // Into geometries/, under a folder name nobody took meanwhile.
  const root = geometriesRoot(pdir);
  mkdirSync(root, { recursive: true });
  const wanted = geometryFolderName(gname);
  let dest = '';
  for (let i = 0; i < 8; i += 1) {
    let n = 2;
    let folder = wanted;
    while (existsSync(join(root, folder))) folder = `${wanted}_${n++}`;
    dest = join(root, folder);
    try {
      renameSync(build, dest);
      break;
    } catch (e) {
      dest = '';
      const code = /** @type {any} */ (e) && /** @type {any} */ (e).code;
      if (!RETRY_CODES.has(code) && code !== 'EEXIST' && code !== 'ENOTEMPTY') throw e;
      await L().deps.sleep(50 * (i + 1));
    }
  }
  if (!dest) return ended('busy', { error: LINK_TEXT.busy(gname), code: 'busy' });
  /** Before the commit point anything left is removed: the copies' folders, then the hidden folder. */
  const dropAll = async (/** @type {string[]} */ simIds) => {
    for (const sim of simIds) await L().deps.dropStudy(rec.project_id, sim).catch(() => undefined);
    rmQuiet(dest);
  };
  // "Save as new": the chosen studies' setup onto the new geometry.
  /** @type {any[]} */
  const copies = [];
  const made = [];
  const wantCopy = rec.save_as_new && Array.isArray(rec.copy) ? rec.copy : [];
  if (wantCopy.length) {
    setStage(id, 'matching');
    live.phase = 'copy';
    const oldFenced = !oldDir || geometryFenced(oldDir);
    if (!oldFenced) await writeFaceMap(oldDir, stage, false);
    const titles = new Map(((rec.choosing && rec.choosing.studies) || []).map((/** @type {any} */ st) => [String(st.id), String(st.title)]));
    for (const sid of wantCopy) {
      const title = titles.get(String(sid)) || String(sid);
      if (live.aborted) break;
      if (oldFenced) {
        copies.push({ studyId: sid, title, ok: false, error: LINK_TEXT.stillUpdating(oldName || 'The geometry') });
        continue;
      }
      const one = await copyOneStudy(rec, { studyId: String(sid), title, newId: rec.geometry_id, newName: gname, oldId, oldRev: Number(oldState && oldState.rev) || 0 });
      if (one.newStudyId && one.ok) made.push(one.newStudyId);
      copies.push(one);
    }
  }
  if (live.aborted) {
    await dropAll(made);
    return ended('gone', { error: 'The project was removed', code: 'gone' });
  }
  // The commit: pending.json goes (the commit point), the old geometry is marked unlinked,
  // project.json is refreshed. A crash before it leaves a hidden folder the boot scan removes.
  setStage(id, 'saving');
  live.phase = 'commit';
  try {
    hook('beforeLinkCommit', id);
  } catch (e) {
    // A kill right before the commit call (gate:l2-choice): nothing more runs in this process.
    live.phase = 'killed';
    throw e;
  }
  const stopAfterPoint = HOOKS_ON && !!(/** @type {any} */ (globalThis)[Symbol.for('magnusim.linkTestHooks')] || {}).afterLinkCommitPoint;
  const committed = await call('geometry.link_commit', {
    project_id: rec.project_id,
    geometry_id: rec.geometry_id,
    old_id: oldId || '',
    job_id: rec.id,
    ...(stopAfterPoint ? { stop_after_commit_point: true } : {}),
  }).catch((e) => ({ ok: false, error: String((e && e.message) || e) }));
  if (stopAfterPoint) {
    live.phase = 'killed';
    throw new Error('test hook: stopped after the commit point');
  }
  if (!committed || committed.ok !== true) {
    await dropAll(made);
    return ended('failed', { error: String((committed && committed.error) || 'Linking the geometry failed'), code: 'failed' });
  }
  // A question of this study still open about the geometry it just left is moot now.
  if (oldId) {
    for (const q of studyRecords(rec.project_id, rec.plugin, rec.study_id, 'choosing')) {
      if (q.id === id || String(q.geometry_id) !== oldId) continue;
      finish(q.id, 'stale', { error: LINK_TEXT.notLinked(String(q.geometry_name || oldName), String(q.study_title || rec.study_title)), code: 'stale' });
      rmQuiet(stagingDirOf(q.project_id, q.id));
    }
  }
  // The copies' catalog rows, now that their geometry is shown (no other study is written).
  const rows = copies.filter((x) => x.ok && x.row).map((x) => x.row);
  if (rows.length) await L().deps.indexStudies(rec.project_id, rows).catch((e) => console.warn(`[CFD link] ${id}: the copies' catalog rows`, e));
  for (const x of copies) delete x.row;
  const result = linkResult({
    geometryId: rec.geometry_id,
    name: gname,
    rev: 1,
    fromRev: null,
    created: true,
    change: 'shape',
    bodies: preview.report.n_solids,
    faces: preview.report.n_faces,
    named: preview.report.named,
    seconds: (L().deps.now() - t0) / 1000,
  });
  updateLinkRecord(id, { result, copies: copies.length ? copies : null, old_geometry_id: oldId || null, old_geometry_name: oldName || null });
  // The study lock goes at the commit; the follow-ups run on, outside the slot.
  const key = studyKey(rec.project_id, rec.plugin, rec.study_id);
  if (L().locks.get(key) === id) L().locks.delete(key);
  setStage(id, 'finishing');
  live.phase = 'follow-ups';
  await runFollowUps({ ...rec, geometry_name: gname }, live, dest, { create: true, rev: 1, change: 'shape' });
  ended('done', { result });
}

/**
 * One "Save as new" copy (5.0): the study's settings onto the new geometry, keeping its
 * labels (w17), then geometry.plan and geometry.apply on that copy only, with the map from
 * the old geometry's live face table to the new one. A copy that fails is removed and
 * reported; the source study is only read.
 * @param {any} rec
 * @param {{ studyId: string, title: string, newId: string, newName: string, oldId: string, oldRev: number }} o
 * @returns {Promise<Record<string, any>>}
 */
async function copyOneStudy(rec, o) {
  const d = L().deps;
  /** @type {Record<string, any>} */
  const out = { studyId: o.studyId, title: o.title, ok: false };
  let made;
  try {
    made = await d.copyStudy(rec.project_id, { geometryId: o.newId, geometryName: o.newName, copyFrom: o.studyId });
  } catch (e) {
    made = { ok: false, error: String((e && /** @type {any} */ (e).message) || e) };
  }
  if (!made || !made.ok || !made.simId) return { ...out, error: String((made && made.error) || 'the study could not be made') };
  out.newStudyId = made.simId;
  out.newTitle = made.name || null;
  out.row = made.row || null;
  const fail = async (/** @type {string} */ why) => {
    await d.dropStudy(rec.project_id, made.simId).catch(() => undefined);
    return { ...out, newStudyId: null, error: why };
  };
  let planned;
  try {
    planned = await call('geometry.plan', {
      project_id: rec.project_id,
      geometry_id: o.newId,
      staging_rel: stagingRelOf(rec.id),
      from_rev: o.oldRev,
      same_shape: false,
      studies: [made.simId],
      rev: 1,
      map_from: o.oldId,
    });
  } catch (e) {
    planned = { ok: false, error: String((e && /** @type {any} */ (e).message) || e) };
  }
  if (!planned || planned.ok !== true) return fail(String((planned && planned.error) || 'its faces could not be matched'));
  let applied;
  try {
    applied = await call('geometry.apply', { project_id: rec.project_id, geometry_id: o.newId, staging_rel: stagingRelOf(rec.id), plan_file: 'plan-copy.json' }, d.timing.applyMs);
  } catch (e) {
    applied = { ok: false, error: String((e && /** @type {any} */ (e).message) || e) };
  }
  if (!applied || applied.ok !== true) return fail(String((applied && applied.error) || 'its records could not be written'));
  const rep = planned.report || {};
  return {
    ...out,
    ok: true,
    lost: Array.isArray(rep.lost) ? rep.lost : [],
    claimedTwice: Array.isArray(rep.claimed_twice) ? rep.claimed_twice : [],
    split: Array.isArray(rep.split) ? rep.split.length : 0,
  };
}

// ---- follow-ups ---------------------------------------------------------------------------

/**
 * The derived files after a commit: the centre of mass (merged into cad_preview.json)
 * and the thumbnail, each made in its own process into <staging>/tmp and renamed into
 * place in one synchronous step that first checks the folder is still there and not
 * removed (and, after a create, that no update has changed it since). They never make
 * a folder. Then project.json (an update's; a create refreshed it at its commit).
 */
async function runFollowUps(/** @type {any} */ rec, /** @type {LiveJob} */ live, /** @type {string} */ dir, /** @type {{ create: boolean, rev: number, change: string }} */ o) {
  const d = L().deps;
  const stage = stagingDirOf(rec.project_id, rec.id);
  const tmp = join(stage, 'tmp');
  mkdirSync(tmp, { recursive: true });
  const stillOurs = () => {
    if (live.aborted || !existsSync(dir) || existsSync(join(dir, 'link', 'removed.json'))) return false;
    if (!o.create) return true;
    if (existsSync(join(dir, 'link', 'commit.json'))) return false;
    const st = linkStateOf(dir);
    return !!st && Number(st.rev) === o.rev;
  };
  /** @param {string} from @param {string} to */
  const place = async (from, to) => {
    for (let i = 0; i < 8; i += 1) {
      if (!stillOurs()) return false;
      try {
        renameSync(from, to);
        return true;
      } catch (e) {
        const code = /** @type {any} */ (e) && /** @type {any} */ (e).code;
        if (code === 'ENOENT') return false;
        if (!RETRY_CODES.has(code)) return false;
        await d.sleep(50 * (i + 1));
      }
    }
    return false;
  };
  const com = async () => {
    if (o.change === 'names') return;
    const ran = await d.runCom(join(dir, 'source.bbrep'), { timeoutMs: d.timing.followMs, live });
    const line = String(ran.stdout || '')
      .split(/\r?\n/)
      .find((l) => l.startsWith('LINK_COM '));
    if (!line) return;
    let got;
    try {
      got = JSON.parse(line.slice('LINK_COM '.length));
    } catch {
      return;
    }
    if (!got || !Array.isArray(got.center_of_mass)) return;
    if (!stillOurs()) return;
    const meta = readJson(join(dir, 'cad_preview.json'));
    if (!meta) return;
    const out = join(tmp, 'cad_preview.json');
    writeFileSync(out, JSON.stringify({ ...meta, center_of_mass: got.center_of_mass, center_of_mass_kind: got.center_of_mass_kind }), 'utf8');
    await place(out, join(dir, 'cad_preview.json'));
  };
  const thumb = async () => {
    if (o.change === 'names') return;
    const out = join(tmp, 'thumb.png');
    const ran = await d.renderThumb(['--vtp', join(dir, 'cad_faces.vtp'), '--edges', join(dir, 'cad_edges.vtp'), '--out', out], {
      timeoutMs: d.timing.followMs,
      live,
    });
    if (ran.code !== 0 || !existsSync(out)) return;
    await place(out, join(dir, 'thumb.png'));
  };
  const projectJson = async () => {
    if (o.create || !stillOurs()) return;
    const st = linkStateOf(dir);
    const id = readJson(join(dir, 'id.json')) || {};
    if (!st) return;
    await call('project.upsert_geometry', { project_id: rec.project_id, record: geometryRecord(rec, dir, st, id.source || null) }).catch(() => {});
  };
  /** @type {Record<string, number>} */
  const took = {};
  const timed = (/** @type {string} */ name, /** @type {() => Promise<void>} */ fn) => async () => {
    const t0 = Date.now();
    try {
      await fn();
    } finally {
      took[name] = (Date.now() - t0) / 1000;
    }
  };
  await Promise.all(
    [timed('center_of_mass', com)(), timed('thumbnail', thumb)(), timed('project_json', projectJson)()].map((p) =>
      p.catch((e) => console.warn(`[CFD link] ${rec.id}: a follow-up failed`, e)),
    ),
  );
  updateLinkRecord(rec.id, { follow_timings: took });
}

// ---- removal ----------------------------------------------------------------------------

/**
 * A geometry is about to be removed (w16 removeGeometry, before its folder goes): a
 * linked one is marked removed first (no follow-up or repair brings it back); its
 * queued update ends `gone` and leaves the queue; a running one before its commit is
 * cancelled; a fenced one's recovery is dropped.
 * @param {string} projectId @param {string} geometryId @param {string} dir
 */
export function onGeometryRemove(projectId, geometryId, dir) {
  if (dir && isLinkedGeometryDir(dir)) {
    try {
      writeFileSync(join(dir, 'link', 'removed.json'), JSON.stringify({ at: new Date().toISOString() }), 'utf8');
    } catch {
      /* the folder is going anyway */
    }
  }
  // Its queued or running jobs, and a question about it (5.0), end `gone`.
  for (const rec of listLinkRecords({
    status: ['queued', 'running', 'choosing'],
    filter: (r) => r.geometry_id === geometryId && sameProjectFolder(r.project_id, projectId),
  })) {
    const live = L().live.get(rec.id);
    if (live) {
      live.aborted = true;
      killChildren(live);
      continue;
    }
    finish(rec.id, 'gone', { error: LINK_TEXT.removed, code: 'gone' });
    if (rec.row_id) dropComputeRows([rec.row_id], 'gone', 'skipped');
    try {
      rmQuiet(stagingDirOf(rec.project_id, rec.id));
    } catch {
      /* gone */
    }
  }
  const pk = pendingKey(projectId, geometryId);
  const pend = L().pending.get(pk);
  if (pend) {
    L().pending.delete(pk);
    const j = dir ? journalOf(dir) : null;
    if (j && j.staging) rmQuiet(resolve(projectDirOf(projectId), String(j.staging)));
  }
}

// ---- recovery -----------------------------------------------------------------------------

/** @param {string} projectId @param {string} geometryId */
function pendingKey(projectId, geometryId) {
  return `${gateKey(projectId)}|${geometryId}`;
}

/** @param {string} projectId @param {string} geometryId @param {string} name */
function addPending(projectId, geometryId, name) {
  const key = pendingKey(projectId, geometryId);
  if (!L().pending.has(key)) L().pending.set(key, { projectId, geometryId, name, tries: 0, nextAt: 0 });
  armRecoveryTimer();
}

/** The geometries waiting for their recovery (tests and the tree read it). */
export function pendingRecoveries() {
  return [...L().pending.values()].map((p) => ({ ...p }));
}

function armRecoveryTimer() {
  const s = L();
  if (s.timer) clearTimeout(s.timer);
  s.timer = null;
  const due = [...s.pending.values()].map((p) => p.nextAt);
  if (!due.length) return;
  const wait = Math.max(0, Math.min(...due) - s.deps.now());
  s.timer = setTimeout(() => {
    s.timer = null;
    scheduleComputeQueueKick(0);
  }, wait + 50);
  if (typeof s.timer.unref === 'function') s.timer.unref();
}

/**
 * The queue's runFirst: with a recovery due and the slot free, claim the slot
 * ("Finish updating <Geometry>"), start it, and answer true; the kick then stops.
 */
export function linkRunFirst() {
  const s = L();
  if (s.recovering || computeSlotHolder()) return false;
  const now = s.deps.now();
  const next = [...s.pending.entries()].filter(([, p]) => p.nextAt <= now).sort((a, b) => a[1].nextAt - b[1].nextAt)[0];
  if (!next) return false;
  const [key, pend] = next;
  const claimed = claimComputeSlot('geometry', { project_id: pend.projectId, name: LINK_TEXT.finishName(pend.name), geometry_id: pend.geometryId }, { phase: 'running' });
  if (!claimed.ok) return false;
  s.recovering = true;
  void recoverOne(pend)
    .then((r) => {
      if (r.ok) tellFenceEnded(pend);
      if (r.ok || r.final) s.pending.delete(key);
      else {
        pend.tries += 1;
        const back = s.deps.timing.recoveryBackoff;
        pend.nextAt = s.deps.now() + (pend.tries - 1 < back.length ? back[pend.tries - 1] : s.deps.timing.recoveryEvery);
      }
    })
    .catch((e) => {
      console.warn('[CFD link] recovery failed', e);
      pend.tries += 1;
      pend.nextAt = s.deps.now() + s.deps.timing.recoveryEvery;
    })
    .finally(() => {
      s.recovering = false;
      armRecoveryTimer();
      releaseComputeSlot(claimed.token);
    });
  return true;
}

/**
 * The recovery finished or undid a geometry's update, so its fence is gone: its study's
 * link stream hears `recovered` (on the newest record of that geometry), and a page that
 * shows "Couldn't finish updating" reads the tree again and loads the geometry (5.16).
 * @param {Pending} pend
 */
function tellFenceEnded(pend) {
  const rec = listLinkRecords({ filter: (r) => r.geometry_id === pend.geometryId && sameProjectFolder(r.project_id, pend.projectId) })[0];
  if (rec) emitLinkEvent(rec.id, { event: 'recovered', geometry_id: pend.geometryId });
}

/**
 * Finish or undo one geometry's commit from its journal (inside a slot claim):
 * the apply landed \-> clean up; phase swap \-> undo by what exists; phase apply \-> the
 * apply again from plan.json, with the gate closed; staging gone \-> stays fenced.
 * @param {Pending} pend
 * @returns {Promise<{ ok: boolean, final?: boolean, error?: string }>}
 */
export async function recoverOne(pend) {
  const pdir = projectDirOf(pend.projectId);
  const dir = geometryDirOf(pend.projectId, pend.geometryId);
  if (!dir) return { ok: true, final: true };
  const journal = journalOf(dir);
  if (!journal) return { ok: true, final: true };
  if (journal.job && L().live.has(String(journal.job))) return { ok: false, error: 'its update is still running' };
  const stage = journal.staging ? resolve(pdir, String(journal.staging)) : '';
  const state = linkStateOf(dir);
  if (state && journal.job && state.job_id === journal.job) {
    cleanUpCommit(dir, stage || join(pdir, STAGING, 'none'));
    if (stage) await rmLater(stage);
    return { ok: true };
  }
  if (journal.phase === 'swap') {
    if (!undoByWhatExists(pdir, journal)) return { ok: false, error: `Couldn't undo the update of ${pend.name} yet` };
    try {
      unlinkSync(join(dir, 'link', 'commit.json'));
    } catch {
      /* gone */
    }
    if (stage) await rmLater(stage);
    return { ok: true };
  }
  if (!stage || !existsSync(join(stage, 'plan.json'))) {
    const src = (readJson(join(dir, 'id.json')) || {}).source || {};
    return { ok: false, final: true, error: LINK_TEXT.fencedNoInput(pend.name, String(src.study_id || 'its study')) };
  }
  const drained = await closeGate(pend.projectId, pend.name);
  if (!drained) return { ok: false, error: 'requests were still open' };
  try {
    const landed = await applyLanded({ id: String(journal.job), project_id: pend.projectId, geometry_id: pend.geometryId }, dir);
    if (!landed) return { ok: false, error: LINK_TEXT.fenced(pend.name) };
    cleanUpCommit(dir, stage);
  } finally {
    openGate(pend.projectId);
  }
  await rmLater(stage);
  return { ok: true };
}

/** Project folders under the projects root (those with a project.json). */
function projectFolders() {
  try {
    return readdirSync(PROJECTS_ROOT, { withFileTypes: true })
      .filter((e) => e.isDirectory() && !e.name.startsWith('.') && existsSync(join(PROJECTS_ROOT, e.name, 'project.json')))
      .map((e) => e.name);
  } catch {
    return [];
  }
}

/**
 * Once per process (registerLiveRoutes): the records left by the last server, the
 * geometry rows without a record, the journals no live job owns (to the recovery list)
 * and the staging folders nothing needs. Stats files only: no Python, no spawn.
 */
export function linkBootOnce() {
  const s = L();
  if (s.bootPid === process.pid) return false;
  s.bootPid = process.pid;
  try {
    reconcileLinkJobs();
  } catch (e) {
    console.warn('[CFD link] boot reconcile failed', e);
  }
  try {
    scanLinkJournals();
  } catch (e) {
    console.warn('[CFD link] boot scan failed', e);
  }
  return true;
}

/** The stored records and the stored queue, after a restart. */
export function reconcileLinkJobs() {
  const rows = (snapshotComputeQueue().items || []).filter((r) => r && r.kind === 'geometry');
  const rowJobs = new Set(rows.map((r) => r.job_id));
  for (const rec of listLinkRecords({ status: ['queued', 'running', 'choosing'] })) {
    if (L().live.has(rec.id)) continue;
    let staged;
    try {
      staged = statSync(join(stagingDirOf(rec.project_id, rec.id), 'job.json')).isFile();
    } catch {
      staged = false;
    }
    if (rec.status === 'running') finish(rec.id, 'failed', { error: LINK_TEXT.restart, code: 'failed' });
    // A question with its staging waits for its answer across a restart (5.0, 5.2).
    else if (rec.status === 'choosing') {
      if (!staged) finish(rec.id, 'failed', { error: LINK_TEXT.lostQueue, code: 'failed' });
    } else if (rec.op === 'update' && (!rowJobs.has(rec.id) || !staged)) finish(rec.id, 'failed', { error: LINK_TEXT.lostQueue, code: 'failed' });
    else if (rec.op === 'create' && !staged) finish(rec.id, 'failed', { error: LINK_TEXT.lostQueue, code: 'failed' });
  }
  const stale = rows.filter((row) => {
    const rec = readLinkRecord(row.job_id);
    return !rec || rec.status !== 'queued';
  });
  if (stale.length) dropComputeRows(stale.map((r) => r.id), LINK_TEXT.lostQueue, 'dropped');
}

/**
 * A hidden folder of a create that never committed: its studies' folders and catalog rows
 * (w17 dropGeometryStudies), then the folder. Asynchronous, after the boot scan.
 * @param {string} projectId @param {string} geometryId @param {string} dir
 */
async function dropPendingGeometry(projectId, geometryId, dir) {
  try {
    const w17 = await import('../w17-simulation.js');
    let proj = null;
    try {
      proj = JSON.parse(readFileSync(join(projectDirOf(projectId), 'project.json'), 'utf8').replace(/^\ufeff/, ''));
    } catch {
      proj = null;
    }
    w17.dropGeometryStudies(projectId, proj, geometryId);
  } catch (e) {
    console.warn(`[CFD link] ${geometryId}: dropping a pending geometry's studies failed`, e);
  }
  await rmLater(dir);
}

/**
 * The journals no live job owns go to the recovery list; staging folders nothing needs
 * (no queued record, no journal) are removed. linkBootOnce runs it once per process.
 */
export function scanLinkJournals() {
  for (const pid of projectFolders()) {
    const pdir = join(PROJECTS_ROOT, pid);
    const keep = new Set();
    for (const g of walkGeometries(pdir)) {
      // A create that never committed (a crash before geometry.link_commit): its copied
      // studies and its hidden folder go; the geometry it would have replaced is untouched.
      const pend = readJson(join(String(g.dir), 'link', 'pending.json'));
      if (pend || existsSync(join(String(g.dir), 'link', 'pending.json'))) {
        const owner = pend && pend.job_id ? String(pend.job_id) : '';
        if (!owner || !L().live.has(owner)) void dropPendingGeometry(pid, String(g.id), String(g.dir));
        continue;
      }
      const j = journalOf(String(g.dir));
      if (!j && !existsSync(join(String(g.dir), 'link', 'commit.json'))) continue;
      if (j && j.job && L().live.has(String(j.job))) continue;
      if (j && j.staging) keep.add(resolve(pdir, String(j.staging)).toLowerCase());
      addPending(pid, String(g.id), String((linkStateOf(String(g.dir)) || {}).name || g.name || 'the geometry'));
    }
    const root = join(pdir, STAGING);
    let names;
    try {
      names = readdirSync(root).filter((n) => n.startsWith('link-'));
    } catch {
      names = [];
    }
    for (const n of names) {
      const dir = join(root, n);
      if (keep.has(dir.toLowerCase())) continue;
      const rec = readLinkRecord(n.slice('link-'.length));
      if (rec && (rec.status === 'queued' || rec.status === 'choosing')) continue;
      void rmLater(dir);
    }
  }
}

// ---- reads for the routes ---------------------------------------------------------------

/**
 * LinkedGeometry (5.1) of a study, or null: from the main-lane check and the records.
 * @param {string} projectId @param {string} plugin @param {string} studyId
 */
export async function linkedGeometryOf(projectId, plugin, studyId) {
  const check = checkAnswer(await call('geometry.link_check', { project_id: projectId, plugin, study_id: studyId }));
  const geom = check.geometry;
  if (!geom) return null;
  const st = geom.state || {};
  const recs = studyRecords(projectId, plugin, studyId, ['queued', 'running']).filter((r) => r.op === 'update');
  const fenced = !!geom.journal && !(geom.journal.job && L().live.has(String(geom.journal.job)));
  const state = fenced ? 'failed' : recs.some((r) => r.status === 'running') ? 'updating' : recs.length ? 'queued' : 'ok';
  return {
    geometryId: geom.id,
    name: geom.name,
    rev: Number(st.rev) || 0,
    sourceVersion: Number(st.source_version) || 0,
    shapeSha256: st.shape_sha256 || '',
    namesSha256: st.names_sha256 || null,
    syncedAt: st.synced_at || '',
    state,
    error: fenced ? LINK_TEXT.fenced(geom.name) : null,
    lostFaces: Number(geom.lost_faces) || 0,
  };
}

/** The records of a study (newest first, 50 at most). */
export function studyLinkJobs(/** @type {string} */ projectId, /** @type {string} */ plugin, /** @type {string} */ studyId) {
  return listLinkRecords({ filter: (r) => sameStudy(r, projectId, plugin, studyId) }).slice(0, 50);
}

