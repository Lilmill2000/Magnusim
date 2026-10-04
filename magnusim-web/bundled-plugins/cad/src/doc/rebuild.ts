// The rebuild engine: runs the feature history over the KernelAdapter.
// - Each feature is a pure function of the bodies before it and its resolved
//   values. Results are cached by canonical feature JSON + resolved values +
//   input body keys, so an edit rebuilds from the first changed feature.
// - The rollback bar is where the rebuild stops.
// - A failed feature is a no-op marked red; later features still try (Onshape).
// - A feature the kernel stopped (watchdog, crash, trap, out of memory) is
//   skipped until it is edited or retried, so a respawn never loops.
// - After a respawn every shape id died: caches are dropped and the whole
//   history rebuilds from the document, transparently.
// - P2/P3: a feature's cache key also holds the keys of its parent features
//   (an extrude rebuilds when its sketch changes), the bodies it uses come from
//   its type's `uses` hook, and each feature may publish an output (a sketch's
//   regions) that later features read and RebuildState shows.
// Owner: DOC-CORE.
// SPDX-License-Identifier: GPL-3.0-or-later
import type { BodyId, CadDoc, CadView, Feature, FeatureAction, FeatureId, FeatureStatus } from '../types/doc';
import type { BodyProps, BuildContext, BuiltBody, EndBodies, FeatureBuildResult, FeatureFiles, FeatureOutput, FeatureRegistry } from '../types/doc-service';
import type { BodyInfo, KernelAdapter, KernelCallError, TessPayload } from '../types/kernel';
import type { BBox, ShapeId } from '../types/kernel-protocol';
import type { SketchSolverClient } from '../types/sketch';
import { LARGE_PART_FACES } from '../kernel/timeouts';
import { canonicalJson, hashString } from './canonical';
import { storedBodyName } from './features/body-ids';
import { featureUses } from './features/hooks';
import { removedFeatureMessage } from './features/removed';
import { DEFAULT_BODY_COLOR } from './schema';
import { createUnitsService } from './units';

/** Bodies with at most this many faces are measured with every rebuild; larger ones on request. */
export const EAGER_PROPS_MAX_FACES = LARGE_PART_FACES;
/** Cache entries kept beyond the ones the latest rebuild used (undo/redo hits them). */
export const CACHE_SPARE_ENTRIES = 200;
/** Respawns without a finished rebuild before the engine stops rebuilding by itself. */
export const MAX_RESPAWNS_IN_A_ROW = 3;

const NAME_TOKEN = '\u0000name\u0000';

interface CacheEntry {
  /** Messages keep the feature's name as a token (a rename must not rebuild). */
  result: FeatureBuildResult;
  shapes: ShapeId[];
  ms: number;
  lastUsed: number;
}

interface HeldBody extends BuiltBody {
  /** Geometry key: changes exactly when the body's geometry does. */
  key: string;
  /** Name and colour the feature gave a body that has no BodyDef (split pieces). */
  name?: string;
  color?: string;
}

export interface RebuildInput {
  doc: CadDoc;
  view: CadView;
}

export interface RebuildOutput {
  features: Record<FeatureId, FeatureStatus>;
  bodies: BodyInfo[];
  /** Outputs of the features built (by feature id). */
  outputs: Record<FeatureId, FeatureOutput>;
  ms: number;
  failed: FeatureId[];
  /** A whole-rebuild failure (kernel down). */
  message: string | null;
}

export interface RebuildEngineOptions {
  kernel: KernelAdapter;
  registry: FeatureRegistry;
  /** The Part's stored files (BuildContext.files); null/absent without ws.files. */
  files?: FeatureFiles | null;
  /** The sketch solver when it runs (BuildContext.solver). */
  solver?: () => SketchSolverClient | null;
  /** A rebuild started (the status goes to running). */
  onStart?(): void;
  /** A rebuild finished (not called for rebuilds replaced by a newer request or cut short by a respawn). */
  onResult(out: RebuildOutput, input: RebuildInput): void;
  /** The kernel was respawned (every shape id died); a rebuild follows. */
  onRespawn?(reason: string): void;
  eagerPropsMaxFaces?: number;
}

function template(msg: string, name: string): string {
  return name ? msg.split(name).join(NAME_TOKEN) : msg;
}
function untemplate(msg: string, name: string): string {
  return msg.split(NAME_TOKEN).join(name);
}

/** The error ended the worker (it is being respawned because of this call). */
function stopsKernel(e: KernelCallError): boolean {
  return e.kind === 'watchdog' || e.kind === 'trap' || e.kind === 'crash' || !!e.oom;
}

/**
 * The kernel's own refusal in plain words: a bare OCCT exception
 * ("BRepPrimAPI_MakeBox: Standard_DomainError") says nothing to a user, so it
 * becomes "the geometry kernel could not build it (Standard_DomainError)".
 * Messages with words in them pass through.
 */
export function plainKernelMessage(msg: string): string {
  const parts = msg.split(/:\s*/).map((p) => p.trim()).filter(Boolean);
  if (parts.length && parts.every((p) => /^[A-Za-z][A-Za-z0-9]*_[A-Za-z0-9_]+$/.test(p))) return `the geometry kernel could not build it (${parts[parts.length - 1]})`;
  return msg;
}

function stoppedMessage(f: Feature, e: KernelCallError): string {
  if (e.kind === 'watchdog') return `${f.name} was stopped after ${(e.seconds ?? 0).toFixed(1)} s`;
  if (e.oom) return `${f.name} ran out of memory: ${e.message}`;
  return `${f.name} stopped the kernel: ${e.message}`;
}

function tessOf(buffers: Record<string, ArrayBuffer>): TessPayload {
  const f32 = (n: string) => new Float32Array(buffers[n] ?? new ArrayBuffer(0));
  const u32 = (n: string) => new Uint32Array(buffers[n] ?? new ArrayBuffer(0));
  return {
    positions: f32('positions'),
    normals: f32('normals'),
    indices: u32('indices'),
    faceRanges: u32('face_ranges'),
    edgePositions: f32('edge_positions'),
    edgeRanges: u32('edge_ranges'),
    edgeFlags: buffers.edge_flags ? new Uint8Array(buffers.edge_flags) : null,
  };
}

function bboxOfPositions(p: Float32Array): BBox {
  if (p.length < 3) return [0, 0, 0, 0, 0, 0];
  const b: BBox = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
  for (let i = 0; i + 2 < p.length; i += 3) {
    for (let k = 0; k < 3; k++) {
      const v = p[i + k];
      if (v < b[k]) b[k] = v;
      if (v > b[k + 3]) b[k + 3] = v;
    }
  }
  return b;
}

export class RebuildEngine {
  private epoch = 0;
  private seq = 0;
  private running = false;
  private pending: RebuildInput | null = null;
  private last: RebuildInput | null = null;
  private disposed = false;
  private readonly cache = new Map<string, CacheEntry>();
  private readonly tess = new Map<ShapeId, TessPayload>();
  private readonly props = new Map<ShapeId, BodyProps>();
  private readonly bboxes = new Map<ShapeId, { bbox: BBox; faces: number }>();
  /** Feature cache keys the kernel stopped on, with the message; by feature id for Retry. */
  private readonly stopped = new Map<string, { feature: FeatureId; message: string }>();
  private respawnsInARow = 0;
  private idle: Promise<void> = Promise.resolve();
  private idleResolve: (() => void) | null = null;
  private latestBodies: BodyInfo[] = [];
  private readonly offRespawn: () => void;

  constructor(private readonly opts: RebuildEngineOptions) {
    this.offRespawn = opts.kernel.onRespawn((reason) => {
      // Every shape id died with the old worker: forget them all and rebuild.
      this.epoch++;
      this.cache.clear();
      this.tess.clear();
      this.props.clear();
      this.bboxes.clear();
      this.latestBodies = [];
      this.opts.onRespawn?.(reason);
      this.respawnsInARow++;
      const input = this.pending ?? this.last;
      if (!input || this.disposed) return;
      if (this.respawnsInARow > MAX_RESPAWNS_IN_A_ROW) {
        // Something keeps stopping the kernel: stop rebuilding by ourselves (no loop).
        this.pending = null;
        const features: Record<FeatureId, FeatureStatus> = {};
        for (const f of input.doc.features) features[f.id] = { state: 'pending' };
        this.opts.onResult({ features, bodies: [], outputs: {}, ms: 0, failed: [], message: `The kernel stopped ${this.respawnsInARow} times in a row while rebuilding (${reason}). Edit the part or reload it to try again.` }, input);
        return;
      }
      this.pending = input;
      void this.pump();
    });
  }

  /** Rebuild this document/view (coalesced: only the newest request runs). */
  request(input: RebuildInput): void {
    if (this.disposed) return;
    this.respawnsInARow = 0;
    this.pending = input;
    void this.pump();
  }

  /** Resolves when no rebuild is running or queued (tests, flush). */
  whenIdle(): Promise<void> {
    return this.idle;
  }

  /**
   * LINK: the bodies at the END of the history (the rollback bar ignored: the
   * project's geometry is the finished part), built from `doc` through the same
   * cache, without tessellation and without telling the page (the view keeps what
   * it shows). Runs when no rebuild runs, and holds the next one until it is done.
   * Rejects when the kernel is not running or stopped on the way.
   */
  async bodiesAtEnd(doc: CadDoc, view: CadView): Promise<EndBodies> {
    while (this.running) await this.idle;
    if (this.disposed) throw new Error('the part was closed');
    this.running = true;
    this.idle = new Promise<void>((r) => (this.idleResolve = r));
    let got: EndBodies | null = null;
    let message: string | null = null;
    try {
      const out = await this.build({ doc, view: { ...view, rollback: null } }, (bodies, failed) => {
        got = {
          failed: failed.map((id) => doc.features.find((f) => f.id === id)?.name ?? id),
          bodies: bodies.map((b) => ({
            id: b.id,
            shape: b.shape,
            valid: b.valid,
            feature: b.feature,
            names: b.names,
            name: doc.bodies[b.id]?.name ?? b.name ?? 'Body',
            color: doc.bodies[b.id]?.color ?? b.color ?? DEFAULT_BODY_COLOR,
          })),
        };
      });
      if (out?.message) message = out.message;
    } finally {
      this.running = false;
      const r = this.idleResolve;
      this.idleResolve = null;
      r?.();
      if (this.pending && !this.disposed) void this.pump();
    }
    if (!got) throw new Error(message ?? 'the kernel stopped while the part was rebuilt');
    return got;
  }

  /** Build again a feature the kernel stopped. */
  retry(feature: FeatureId): boolean {
    let hit = false;
    for (const [k, v] of this.stopped) {
      if (v.feature === feature) {
        this.stopped.delete(k);
        hit = true;
      }
    }
    if (hit && this.last) this.request(this.last);
    return hit;
  }

  /** Exact properties of a body of the latest rebuild (cached per shape). */
  async measure(id: BodyId): Promise<BodyProps> {
    const body = this.latestBodies.find((b) => b.id === id);
    if (!body) throw new Error('That body is not in the part at the rollback position');
    return this.propsOf(body.shape, this.epoch);
  }

  dispose(): void {
    this.disposed = true;
    this.offRespawn();
    this.pending = null;
  }

  private async pump(): Promise<void> {
    if (this.running || this.disposed) return;
    this.running = true;
    this.idle = new Promise<void>((r) => (this.idleResolve = r));
    try {
      while (this.pending && !this.disposed) {
        const input = this.pending;
        this.pending = null;
        this.last = input;
        this.opts.onStart?.();
        const out = await this.build(input).catch((e: unknown): RebuildOutput => ({ features: {}, bodies: [], outputs: {}, ms: 0, failed: [], message: `The rebuild failed: ${e instanceof Error ? e.message : String(e)}` }));
        if (out && !this.disposed) {
          if (!out.message) this.respawnsInARow = 0;
          this.opts.onResult(out, input);
          if (!this.pending && !out.message) {
            // Idle: recycle an oversized worker (onRespawn queues the rebuild).
            await this.opts.kernel.recycleIfLarge().catch(() => false);
          }
        }
      }
    } finally {
      this.running = false;
      const r = this.idleResolve;
      this.idleResolve = null;
      r?.();
    }
  }

  private async release(ids: ShapeId[], epoch: number): Promise<void> {
    if (!ids.length || epoch !== this.epoch) return;
    for (const id of ids) {
      this.tess.delete(id);
      this.props.delete(id);
      this.bboxes.delete(id);
    }
    await this.opts.kernel.call('release', { ids }).catch(() => {});
  }

  private async propsOf(shape: ShapeId, epoch: number): Promise<BodyProps> {
    const hit = this.props.get(shape);
    if (hit) return hit;
    // volume/area/exact bbox are opt-in on the facade (bbox_mode is the older spelling, kept for older builds).
    const r = await this.opts.kernel.call('props', { id: shape, volume: true, area: true, bbox: 'exact', bbox_mode: 'optimal' });
    const p = r.result;
    const bbox: BBox = p.bbox ?? [0, 0, 0, 0, 0, 0];
    const props: BodyProps = { volume: p.volume ?? 0, area: p.area ?? 0, centroid: p.centroid ?? null, bbox, faces: p.faces, edges: p.edges, solids: p.solids };
    if (epoch === this.epoch) {
      this.props.set(shape, props);
      if (!this.bboxes.has(shape)) this.bboxes.set(shape, { bbox, faces: p.faces });
    }
    return props;
  }

  /** Counts and the fast bounding box: cheap even on a large part (0.1 s on 11,776 faces). */
  private async fastOf(shape: ShapeId, epoch: number): Promise<{ bbox: BBox; faces: number }> {
    const hit = this.bboxes.get(shape);
    if (hit) return hit;
    // The fast box encloses the body (padded by tolerances): right for touch tests.
    const r = await this.opts.kernel.call('props', { id: shape, bbox: 'fast', bbox_mode: 'fast' });
    const info = { bbox: r.result.bbox ?? ([0, 0, 0, 0, 0, 0] as BBox), faces: r.result.faces };
    if (epoch === this.epoch) this.bboxes.set(shape, info);
    return info;
  }

  /**
   * null when the build was replaced by a newer request or cut short by a respawn.
   * With `exportTo` (bodiesAtEnd): the features only, never replaced by a newer
   * request; the bodies at the end go to exportTo, and it returns null.
   */
  private async build(input: RebuildInput, exportTo?: (bodies: HeldBody[], failed: FeatureId[]) => void): Promise<RebuildOutput | null> {
    const t0 = performance.now();
    const { doc, view } = input;
    const kernel = this.opts.kernel;
    const statuses: Record<FeatureId, FeatureStatus> = {};
    for (const f of doc.features) statuses[f.id] = { state: 'pending' };

    const ks = kernel.status.get();
    if (ks.state === 'failed' || ks.state === 'closed') {
      return { features: statuses, bodies: [], outputs: {}, ms: 0, failed: [], message: `The kernel is not running${ks.message ? `: ${ks.message}` : ''}` };
    }
    try {
      await kernel.start();
    } catch (e) {
      return { features: statuses, bodies: [], outputs: {}, ms: 0, failed: [], message: `The kernel is not running: ${e instanceof Error ? e.message : String(e)}` };
    }

    const epoch = this.epoch;
    const seq = ++this.seq;
    const units = createUnitsService(
      () => doc.units,
      () => doc.params,
    );
    const bodies = new Map<BodyId, HeldBody>();
    const used = new Set<string>();
    const failed: FeatureId[] = [];
    const rollback = view.rollback ?? doc.features.length;
    // A split piece never renamed has no stored name: the derived-name rule gives it ("flange (2)").
    const bodyName = (id: BodyId) => storedBodyName(doc, id) ?? 'a deleted body';
    const featureName = (id: FeatureId) => doc.features.find((g) => g.id === id)?.name ?? 'a deleted feature';
    /** Outputs of the features built so far (a sketch's regions), and each built feature's cache key. */
    const outputs = new Map<FeatureId, FeatureOutput>();
    const featureKeys = new Map<FeatureId, string>();

    for (let i = 0; i < doc.features.length; i++) {
      const f = doc.features[i];
      if (i >= rollback) {
        statuses[f.id] = { state: 'rolled-back' };
        continue;
      }
      // Bodies that exist just before this feature (the panel offers Join / Cut / Intersect only then).
      const before = bodies.size;
      if (f.suppressed) {
        statuses[f.id] = { bodiesBefore: before, state: 'suppressed' };
        continue;
      }
      const def = this.opts.registry.get(f.type);
      if (!def) {
        // A removed type (Box, Cylinder) says so; the row stays, with Delete (SD pass).
        statuses[f.id] = { bodiesBefore: before, state: 'error', message: removedFeatureMessage(f) ?? `${f.name}: this version of Magnusim CAD cannot build "${f.type}" features` };
        failed.push(f.id);
        continue;
      }
      const res = def.resolve(f, units);
      if (!res.ok) {
        statuses[f.id] = { bodiesBefore: before, state: 'error', message: `${f.name}: ${res.message}` };
        failed.push(f.id);
        continue;
      }

      // Cache key: the feature (without its name and suppression), its values, its input
      // bodies, and its parent features' keys (an extrude rebuilds when its sketch changes).
      const uses = featureUses(this.opts.registry, f);
      const inputIds = uses === 'all' ? [...bodies.keys()] : uses;
      const parents = def.parents(f);
      const { name: _n, suppressed: _s, ...shape } = f;
      const key = canonicalJson({
        f: shape,
        v: res.values,
        in: inputIds.map((id) => [id, bodies.get(id)?.key ?? null]),
        ...(parents.length ? { p: parents.map((id) => [id, featureKeys.get(id) ?? null]) } : {}),
        // A sketch built while the solver was not running shows its stored shape with a
        // warning: once the solver runs, the key differs, so it re-solves (P3 integration).
        ...(def.isolateWhileEditing && !this.opts.solver?.() ? { nosolver: true } : {}),
      });
      featureKeys.set(f.id, key);

      const stop = this.stopped.get(key);
      if (stop) {
        statuses[f.id] = { bodiesBefore: before, state: 'error', message: untemplate(stop.message, f.name), actions: ['retry'] };
        failed.push(f.id);
        continue;
      }

      let entry = this.cache.get(key);
      if (!entry) {
        // A newer document is waiting: stop here (finished features stay cached).
        if (this.pending && !exportTo) return null;
        const ctx: BuildContext = {
          kernel,
          units,
          bodies: new Map([...bodies].map(([id, b]) => [id, { id: b.id, shape: b.shape, valid: b.valid, feature: b.feature, names: b.names }])),
          doc,
          bodyName,
          featureName,
          bbox: async (s) => (await this.fastOf(s, epoch)).bbox,
          faces: async (s) => (await this.fastOf(s, epoch)).faces,
          release: (ids) => this.release(ids, epoch),
          outputs: new Map(outputs),
          files: this.opts.files ?? null,
          solver: this.opts.solver?.() ?? null,
        };
        const tf = performance.now();
        let result: FeatureBuildResult;
        try {
          result = await def.build(f, res.values, ctx);
        } catch (err) {
          const e = err as KernelCallError;
          if (stopsKernel(e)) {
            // This feature stopped the kernel (it is being respawned): skip it
            // until it is edited or retried, whatever the respawn timing, so
            // the rebuild after the respawn cannot stop it again (no loop).
            this.stopped.set(key, { feature: f.id, message: template(stoppedMessage(f, e), f.name) });
            return null;
          }
          if (epoch !== this.epoch || e.kind === 'restarted') return null;
          if (e.kind === 'boot') return { features: statuses, bodies: [], outputs: {}, ms: 0, failed: [], message: `The kernel is not running: ${e.message}` };
          result = { ok: false, message: `${f.name} failed: ${plainKernelMessage(e instanceof Error ? e.message : String(e))}` };
        }
        if (epoch !== this.epoch) return null;
        const templated: FeatureBuildResult = result.ok
          ? result.warning
            ? { ...result, warning: template(result.warning, f.name) }
            : result
          : { ...result, message: template(result.message, f.name) };
        entry = { result: templated, shapes: result.ok ? result.bodies.map((b) => b.shape) : [], ms: performance.now() - tf, lastUsed: seq };
        this.cache.set(key, entry);
      }
      entry.lastUsed = seq;
      used.add(key);

      const r = entry.result;
      if (r.ok) {
        for (const b of r.bodies) {
          // A body a later feature changes keeps the default name and colour it was given (a split piece).
          const was = bodies.get(b.id);
          bodies.set(b.id, { id: b.id, shape: b.shape, valid: b.valid, feature: f.id, names: b.names ?? null, name: b.name ?? was?.name, color: b.color ?? was?.color, key: hashString(`${key}#${b.id}`) });
        }
        for (const id of r.removed) bodies.delete(id);
        if (r.output) outputs.set(f.id, r.output);
        statuses[f.id] = r.warning ? { bodiesBefore: before, state: 'warning', message: untemplate(r.warning, f.name), ms: entry.ms } : { bodiesBefore: before, state: 'ok', ms: entry.ms };
      } else {
        if (r.output) outputs.set(f.id, r.output);
        const st: FeatureStatus = { bodiesBefore: before, state: 'error', message: untemplate(r.message, f.name), ms: entry.ms };
        if (r.actions?.length) st.actions = [...r.actions] as FeatureAction[];
        statuses[f.id] = st;
        failed.push(f.id);
      }
    }

    if (exportTo) {
      if (epoch !== this.epoch) return null;
      exportTo([...bodies.values()], failed);
      return null;
    }

    // The bodies at the rollback bar: tessellation and (small parts) exact properties.
    const hidden = new Set(view.hiddenBodies);
    const out: BodyInfo[] = [];
    for (const b of bodies.values()) {
      let t = this.tess.get(b.shape);
      const tessStop = this.stopped.get(`tess:${b.key}`);
      if (tessStop) {
        statuses[b.feature] = { ...statuses[b.feature], state: statuses[b.feature]?.state === 'error' ? 'error' : 'warning', message: tessStop.message, actions: ['retry'] };
      } else if (!t) {
        try {
          const r = await kernel.call('tessellate', { id: b.shape });
          t = tessOf(r.buffers);
        } catch (err) {
          const e = err as KernelCallError;
          if (stopsKernel(e)) {
            this.stopped.set(`tess:${b.key}`, { feature: b.feature, message: `${bodyName(b.id)} could not be displayed: ${e.message}` });
            return null;
          }
          if (epoch !== this.epoch || e.kind === 'restarted') return null;
          t = undefined;
        }
        if (epoch !== this.epoch) return null;
        if (t) this.tess.set(b.shape, t);
      }
      const faces = t ? t.faceRanges.length / 2 : 0;
      let props = this.props.get(b.shape) ?? null;
      if (!props && t && faces <= (this.opts.eagerPropsMaxFaces ?? EAGER_PROPS_MAX_FACES) && !this.stopped.has(`props:${b.key}`)) {
        try {
          props = await this.propsOf(b.shape, epoch);
        } catch (err) {
          const e = err as KernelCallError;
          if (stopsKernel(e)) {
            // Measured on request instead (DocService.measure, long timeout).
            this.stopped.set(`props:${b.key}`, { feature: b.feature, message: e.message });
            return null;
          }
          if (epoch !== this.epoch || e.kind === 'restarted') return null;
          props = null;
        }
      }
      const def = doc.bodies[b.id];
      out.push({
        id: b.id,
        name: def?.name ?? b.name ?? 'Body',
        color: def?.color ?? b.color ?? DEFAULT_BODY_COLOR,
        feature: b.feature,
        shape: b.shape,
        valid: b.valid,
        faces: props?.faces ?? faces,
        edges: props?.edges ?? (t ? t.edgeRanges.length / 2 : 0),
        bbox: props?.bbox ?? (t ? bboxOfPositions(t.positions) : [0, 0, 0, 0, 0, 0]),
        volume: props?.volume ?? null,
        area: props?.area ?? null,
        solids: props?.solids ?? null,
        visible: !hidden.has(b.id),
        tessKey: b.key,
        tess: t ?? null,
        names: b.names,
      });
    }
    if (epoch !== this.epoch) return null;

    // Forget cache entries the latest rebuilds did not use, oldest first.
    const spare = [...this.cache.entries()].filter(([k]) => !used.has(k)).sort((a, b) => a[1].lastUsed - b[1].lastUsed);
    const drop = spare.slice(0, Math.max(0, spare.length - CACHE_SPARE_ENTRIES));
    const inUse = new Set(out.map((b) => b.shape));
    const freed: ShapeId[] = [];
    for (const [k, e] of drop) {
      this.cache.delete(k);
      for (const s of e.shapes) if (!inUse.has(s)) freed.push(s);
    }
    await this.release(freed, epoch);

    this.latestBodies = out;
    return { features: statuses, bodies: out, outputs: Object.fromEntries(outputs), ms: performance.now() - t0, failed, message: null };
  }
}
