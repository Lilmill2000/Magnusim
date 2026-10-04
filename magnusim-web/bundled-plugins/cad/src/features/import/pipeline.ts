// The STEP import pipeline (proposal §4.9, docs/p2p3-plan.md §1.2, §2.1-2.3):
//   hash -> upload the source (ws.files, content-addressed) -> read (kernel
//   import_step, with diagnostics of the shapes as read) -> heal (ShapeFix at
//   the tolerance, sewing when asked) -> write the healed shapes as one BREP
//   (BinTools) -> store the BREP.
// Files up to 50 MB are read without healing, so the panel can show the
// problems before and after, and the shapes as read stay alive for Heal all
// again; larger files heal while they are read (no second copy in a 1.2 GB
// heap) and Heal all reads the stored source again.
// The Imported feature then rebuilds from the stored BREP only (never the STEP,
// never healing again): src/features/import/feature.ts.
// Owner: P2-FEATURES.
// SPDX-License-Identifier: GPL-3.0-or-later
import { newId } from '../../lib/ids';
import type { BodyId, ImportDiagnosticsSummary, ImportFeature } from '../../types/doc';
import type { KernelAdapter } from '../../types/kernel';
import type { ImportedShape, ShapeDiagnostics, ShapeId } from '../../types/kernel-protocol';
import { importFolder, type TransferProgress } from '../../types/files';
import type { CadFileTransfer } from '../../files/transfer';
import { abortError } from '../../files/words';

/** Above this the STEP heals while it is read (docs/p2p3-plan.md §2.1). */
export const LARGE_STEP_BYTES = 50 * 1024 * 1024;
/** ShapeFix precision and max tolerance by default (mm). */
export const DEFAULT_HEAL_TOLERANCE = 0.001;

export type ImportStage = TransferProgress['stage'];

export interface StageProgress {
  stage: ImportStage;
  done?: number;
  total?: number;
  /** performance.now() when the stage began (the panel counts seconds from it). */
  since: number;
}

export interface PipelineDeps {
  kernel: KernelAdapter;
  files: CadFileTransfer;
  studyId: string;
}

/** One problem as the panel lists it. */
export interface ProblemRow {
  body: string;
  status: string;
  where: string;
}

/** What one read + heal gave (shapes alive in the kernel until released). */
export interface HealOutcome {
  /** Shapes as read, kept for Heal all (null: healed while reading, or released). */
  raw: ShapeId[] | null;
  /** The healed shapes, one per body, in order. */
  healed: (ImportedShape & { valid: boolean; reason?: string })[];
  unit: string | null;
  before: ShapeDiagnostics | null;
  after: ShapeDiagnostics | null;
  fixed: number;
  sewn: number;
  freeEdges: number;
  /** Faces of the file that were in no solid (open shells, loose faces), as read. */
  looseFaces: number;
  /** Healed while reading (a large file): there is no "before". */
  healedOnRead: boolean;
  /** The shapes as read (names and colours for Heal all again). */
  read: ImportedShape[];
}

/** What the Imported feature stores, plus what only this session knows. */
export interface ImportOutcome {
  source: ImportFeature['source'];
  brep: ImportFeature['brep'];
  heal: ImportFeature['heal'];
  items: ImportFeature['items'];
  diagnostics: ImportDiagnosticsSummary;
  /** Problems found (first 40 per shape): before healing and what is left. */
  problemsBefore: ProblemRow[];
  problemsAfter: ProblemRow[];
  looseFaces: number;
  healedOnRead: boolean;
  /** Shapes as read, alive for Heal all (released when the panel closes), and what they are. */
  raw: ShapeId[] | null;
  rawShapes: ImportedShape[];
  /** Files this run wrote (a discarded new import deletes them). */
  created: string[];
  /**
   * Faces of each healed shape, by item index, as the kernel counted them: the panel's Faces column
   * shows them as soon as the diagnostics do, before the rebuild has made the bodies (L3 review
   * polish 5: the Vortex's cell read "…" meanwhile).
   */
  faceCounts?: (number | null)[];
}

const check = (signal: AbortSignal | undefined) => {
  if (signal?.aborted) throw abortError();
};

/** "#rrggbb" from sRGB 0..1, or null. */
export function hexColor(c: readonly number[] | null | undefined): string | null {
  if (!c || c.length < 3 || !c.every((v) => typeof v === 'number' && Number.isFinite(v))) return null;
  const h = (v: number) =>
    Math.round(Math.max(0, Math.min(1, v)) * 255)
      .toString(16)
      .padStart(2, '0');
  return `#${h(c[0])}${h(c[1])}${h(c[2])}`;
}

/** Part of a stored BREP's name: the tolerance and whether faces were knit ("0.001", "0.01-knit"). */
export function healKey(tolerance: number, sew: boolean): string {
  const t = String(Number(tolerance.toPrecision(6))).replace(/[^0-9a-z.e-]/gi, '_');
  return sew ? `${t}-knit` : t;
}

/** The problem rows of a diagnostics block, with the body names of `names` (by shape id). */
export function problemRows(d: ShapeDiagnostics | null, names: ReadonlyMap<ShapeId, string>): ProblemRow[] {
  if (!d) return [];
  const out: ProblemRow[] = [];
  for (const s of d.shapes) {
    const body = names.get(s.id) ?? 'Body';
    for (const p of s.problems) {
      const where = `${p.type} ${p.index + 1}${p.in ? ` of ${p.in.type} ${p.in.index + 1}` : ''}`;
      out.push({ body, status: p.status, where });
    }
    const listed = s.problems.length;
    if (s.problem_total > listed) out.push({ body, status: `${s.problem_total - listed} more`, where: '' });
  }
  return out;
}

async function withRelease<T>(kernel: KernelAdapter, ids: () => ShapeId[], fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    const gone = ids();
    if (gone.length) await kernel.call('release', { ids: gone }).catch(() => {});
    throw err;
  }
}

/**
 * Read a STEP and heal it. `bytes` is transferred to the kernel (detached).
 * On failure or abort every shape made here is released.
 */
export async function readAndHeal(
  deps: Pick<PipelineDeps, 'kernel'>,
  input: { bytes: ArrayBuffer; fileName: string; tolerance: number; sew: boolean; large: boolean },
  signal: AbortSignal | undefined,
  onStage: (p: StageProgress) => void,
): Promise<HealOutcome> {
  const { kernel } = deps;
  let made: ShapeId[] = [];
  return withRelease(
    kernel,
    () => made,
    async () => {
      check(signal);
      onStage({ stage: 'reading', since: performance.now() });
      // The signal reaches the kernel call: Cancel stops the read itself (the worker restarts), not only what follows it.
      const read = await kernel.call('import_step', { name: input.fileName, heal: input.large, tol: input.tolerance, diagnose: true }, { bytes: input.bytes, signal });
      made = read.result.shapes.map((s) => s.id);
      check(signal);
      const shapes = read.result.shapes;
      const loose = (list: { type: string; faces?: number }[]) => list.filter((s) => s.type !== 'solid').reduce((n, s) => n + (s.faces ?? 0), 0);
      if (input.large && !input.sew) {
        // Healed in the same call: these are the bodies.
        const diag = read.result.diagnostics ?? null;
        const validity = new Map((diag?.shapes ?? []).map((s) => [s.id, s.valid] as const));
        const healed = [];
        for (const s of shapes) {
          let valid = validity.get(s.id);
          let reason: string | undefined;
          if (valid === undefined) {
            const c = await kernel.call('check', { id: s.id }, { signal });
            valid = c.result.valid;
            reason = c.result.reason;
            check(signal);
          }
          healed.push({ ...s, valid, ...(reason ? { reason } : {}) });
        }
        return { raw: null, healed, unit: read.result.unit ?? null, before: null, after: diag, fixed: 0, sewn: 0, freeEdges: (diag?.shapes ?? []).reduce((n, s) => n + s.free_edges, 0), looseFaces: loose(shapes), healedOnRead: true, read: shapes };
      }
      onStage({ stage: 'healing', since: performance.now() });
      const raw = made.slice();
      const h = await kernel.call('heal', { ids: raw, tol: input.tolerance, sew: input.sew, diagnose: true }, { signal });
      made = [...raw, ...h.result.shapes.map((s) => s.id)];
      check(signal);
      const byId = new Map(shapes.map((s) => [s.id, s] as const));
      const healed = h.result.shapes.map((s) => {
        const from = byId.get(s.from);
        return { ...s, name: s.name || from?.name || input.fileName, color: s.color ?? from?.color ?? null };
      });
      return {
        // A large file read raw (to knit it) is not kept: Heal all reads the source again.
        raw: input.large ? null : raw,
        healed,
        unit: read.result.unit ?? null,
        before: read.result.diagnostics ?? null,
        after: h.result.diagnostics ?? null,
        fixed: h.result.fixed,
        sewn: h.result.sewn,
        freeEdges: h.result.free_edges,
        looseFaces: loose(shapes),
        healedOnRead: false,
        read: shapes,
      };
    },
  ).then(async (out) => {
    if (out.raw === null && !out.healedOnRead) {
      // Raw shapes of a large file: not kept.
      const raws = made.filter((id) => !out.healed.some((s) => s.id === id));
      if (raws.length) await kernel.call('release', { ids: raws }).catch(() => {});
    }
    return out;
  });
}

/** Heal shapes read earlier (alive in the kernel) again. Releases what it made on failure. */
export async function healAgain(deps: Pick<PipelineDeps, 'kernel'>, raw: ShapeId[], names: ReadonlyMap<ShapeId, ImportedShape>, tolerance: number, sew: boolean, signal: AbortSignal | undefined, onStage: (p: StageProgress) => void): Promise<HealOutcome> {
  const { kernel } = deps;
  let made: ShapeId[] = [];
  return withRelease(
    kernel,
    () => made,
    async () => {
      onStage({ stage: 'healing', since: performance.now() });
      const h = await kernel.call('heal', { ids: raw, tol: tolerance, sew, diagnose: true }, { signal });
      made = h.result.shapes.map((s) => s.id);
      check(signal);
      const healed = h.result.shapes.map((s) => {
        const from = names.get(s.from);
        return { ...s, name: s.name || from?.name || 'Body', color: s.color ?? from?.color ?? null };
      });
      // "Before" is the first read's (the caller keeps it): the raw shapes did not change.
      return { raw, healed, unit: null, before: null, after: h.result.diagnostics ?? null, fixed: h.result.fixed, sewn: h.result.sewn, freeEdges: h.result.free_edges, looseFaces: 0, healedOnRead: false, read: [...names.values()] };
    },
  );
}

/** Write the healed shapes as one BREP and store it beside the source. Returns the stored ref, its bytes and whether it was written now. */
export async function storeBrep(
  deps: PipelineDeps,
  ids: ShapeId[],
  sha256Source: string,
  key: string,
  signal: AbortSignal | undefined,
  onStage: (p: StageProgress) => void,
): Promise<{ brep: ImportFeature['brep']; bytes: ArrayBuffer; created: boolean }> {
  onStage({ stage: 'writing', since: performance.now() });
  const w = await deps.kernel.call('brep_write', { ids }, { signal });
  check(signal);
  const bytes = w.buffers.brep;
  if (!bytes || !bytes.byteLength) throw new Error('the kernel wrote an empty BREP');
  const sha = await deps.files.sha256(bytes);
  const rel = `${importFolder(deps.studyId, sha256Source)}/healed-${key}-${sha.slice(0, 12)}.brep`;
  const since = performance.now();
  onStage({ stage: 'storing', done: 0, total: bytes.byteLength, since });
  // Stored as a Blob: its chunks reach the host page by reference. As ArrayBuffer chunks each 16 MB
  // was copied across to the host page and held its main thread ~160 ms (the 113 MB part's 68 MB BREP
  // froze the host's header for seconds). The Blob is a copy: `bytes` stays whole for the rebuild.
  const stored = await deps.files.storeNew(rel, new Blob([bytes]), { signal, sha256: sha, onProgress: (p) => onStage({ stage: 'storing', done: p.done, total: p.total, since }) });
  return { brep: { ...stored.ref, occt: w.result.occt }, bytes, created: stored.created };
}

/** The feature's items from healed shapes, keeping the body ids of `previous` by position. */
export function itemsOf(healed: HealOutcome['healed'], previous: readonly { body: BodyId }[] = []): ImportFeature['items'] {
  return healed.map((s, index) => ({
    body: previous[index]?.body ?? newId('b'),
    index,
    stepName: s.name || 'Body',
    stepColor: hexColor(s.color),
    kind: s.type === 'solid' ? 'solid' : 'shell',
    valid: s.valid,
    ...(s.valid || !s.reason ? {} : { reason: s.reason }),
  }));
}

/** The stored summary of a heal. */
export function summaryOf(h: HealOutcome): ImportDiagnosticsSummary {
  const after = h.after?.total ?? h.healed.filter((s) => !s.valid).length;
  const out: ImportDiagnosticsSummary = { problemsBefore: h.before?.total ?? after, problemsAfter: after, fixed: h.fixed };
  if (h.sewn) out.sewn = h.sewn;
  if (h.freeEdges) out.freeEdges = h.freeEdges;
  if (h.healedOnRead) out.healedOnRead = true;
  return out;
}

/** The whole import of one file: hash, upload, read, heal, write and store the BREP. */
export async function runImport(
  deps: PipelineDeps,
  file: Blob & { name?: string },
  opts: { fileName: string; tolerance: number; sew: boolean; signal?: AbortSignal; onStage(p: StageProgress): void },
): Promise<{ outcome: ImportOutcome; brepBytes: ArrayBuffer }> {
  const { signal, onStage } = opts;
  const created: string[] = [];
  try {
    onStage({ stage: 'hashing', since: performance.now() });
    const bytes = await file.arrayBuffer();
    check(signal);
    const sha = await deps.files.sha256(bytes);
    check(signal);
    const folder = importFolder(deps.studyId, sha);
    const since = performance.now();
    onStage({ stage: 'uploading', done: 0, total: file.size, since });
    const up = await deps.files.storeNew(`${folder}/source.step`, file, { signal, sha256: sha, onProgress: (p) => onStage({ stage: 'uploading', done: p.done, total: p.total, since }) });
    if (up.created) created.push(up.ref.rel);
    check(signal);
    const large = file.size > LARGE_STEP_BYTES;
    const h = await readAndHeal(deps, { bytes, fileName: opts.fileName, tolerance: opts.tolerance, sew: opts.sew, large }, signal, onStage);
    const healedIds = h.healed.map((s) => s.id);
    try {
      const stored = await storeBrep(deps, healedIds, sha, healKey(opts.tolerance, opts.sew), signal, onStage);
      if (stored.created) created.push(stored.brep.rel);
      const names = new Map<ShapeId, string>(h.healed.map((s) => [s.id, s.name || 'Body']));
      const rawNames = new Map<ShapeId, string>();
      (h.raw ?? []).forEach((id, i) => rawNames.set(id, h.healed[i]?.name ?? 'Body'));
      const outcome: ImportOutcome = {
        source: { ...up.ref, fileName: opts.fileName, unit: h.unit },
        brep: stored.brep,
        heal: { tolerance: opts.tolerance, sew: opts.sew },
        items: itemsOf(h.healed),
        diagnostics: summaryOf(h),
        problemsBefore: problemRows(h.before, rawNames),
        problemsAfter: problemRows(h.after, names),
        looseFaces: h.looseFaces,
        healedOnRead: h.healedOnRead,
        raw: h.raw,
        rawShapes: h.read,
        created,
        faceCounts: h.healed.map((x) => (typeof x.faces === 'number' ? x.faces : null)),
      };
      return { outcome, brepBytes: stored.bytes };
    } finally {
      // The build makes its own shapes from the stored BREP.
      await deps.kernel.call('release', { ids: healedIds }).catch(() => {});
      if (signal?.aborted && h.raw) await deps.kernel.call('release', { ids: h.raw }).catch(() => {});
    }
  } catch (err) {
    if (created.length) await deps.files.remove(created);
    throw err;
  }
}
