/**
 * The CAD edition's worker: the worker calls Magnusim CAD makes, answered in
 * JavaScript, with no Python process (index.ts uses it in place of getWorker()
 * when MAGNUSIM_EDITION=cad).
 *
 * It answers the registry (scripts/generated/cad-edition-registry.json), project.json
 * writes, and a plugin's studies and JSON files (./studies.ts). Any other method is
 * Magnusim's (meshing, solving, results, geometry import and links): it is refused at
 * once with a code of its own, never retried as a worker that died.
 */
import { EventEmitter } from 'node:events';
import { readFileSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';
import { RpcError, type WorkerPort } from '../worker.ts';
import { pluginsList, registryDescribe } from './registry.js';
import { atomicWriteText, pyJson, studyMethods } from './studies.ts';

/** A method that is Magnusim's, not Magnusim CAD's: its RPC code, and the reason routes pass on. */
export const NOT_IN_EDITION = -32601;
export const NOT_IN_EDITION_REASON = 'not_in_cad_edition';

/** The refusal of a method Magnusim CAD does not have, naming it (routes answer it with its reason). */
export class CadEditionRefusal extends RpcError {
  readonly method: string;
  constructor(method: string) {
    super(NOT_IN_EDITION, `${method} is not in Magnusim CAD`, { code: NOT_IN_EDITION_REASON, method, edition: 'cad' });
    this.name = 'CadEditionRefusal';
    this.method = method;
  }
}
const MIGRATION_MARKER = 'siblings_migrated';
const REGISTRY_CHANGES = new Set(['registry.reload']);

type P = Record<string, unknown>;

/** Python's web_writes.now_iso(): UTC, whole seconds, "Z". */
function nowIsoZ(): string {
  return `${new Date().toISOString().slice(0, 19)}Z`;
}

function readDict(path: string): Record<string, unknown> {
  try {
    const doc = JSON.parse(readFileSync(path, 'utf8'));
    return doc && typeof doc === 'object' && !Array.isArray(doc) ? doc : {};
  } catch {
    return {};
  }
}

/** web_writes.write_project: save project.json; only a new project (create) has none yet. */
function writeProject(p: P): Record<string, unknown> {
  const dir = String(p.project_dir ?? '');
  const isDict = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
  // As the worker method takes it: doc, else body, else the call's other params.
  const { project_dir: _dir, doc: _doc, body: _body, create: _create, ...extra } = p;
  const doc = isDict(p.doc) ? p.doc : isDict(p.body) ? p.body : extra;
  const path = join(dir, 'project.json');
  const there = (q: string, dirWanted: boolean) => {
    try {
      const st = statSync(q);
      return dirWanted ? st.isDirectory() : st.isFile();
    } catch {
      return false;
    }
  };
  if (!(p.create ? there(dir, true) : there(path, false))) {
    throw new RpcError(-32000, `project not found: ${basename(dir)} (deleted)`);
  }
  const body: Record<string, unknown> = { ...(doc as Record<string, unknown>) };
  if (!body.id) body.id = basename(dir);
  body.updated_at = body.updated_at || nowIsoZ();
  body.persistence = 'filesystem';
  const marker = readDict(path)[MIGRATION_MARKER];
  if (marker !== undefined && marker !== null) body[MIGRATION_MARKER] = marker;
  // Beside it, then renamed over it, retried while another writer or a reader holds it
  // (both apps may share one projects folder): never a half-written project.json.
  atomicWriteText(path, pyJson(body), { prefix: 'project.json.', makeDirs: false });
  return body;
}

const methods: Record<string, (p: P) => unknown> = {
  'worker.ping': () => ({ ok: true, worker: 'cad-edition' }),
  'registry.describe': () => registryDescribe(),
  'registry.reload': () => registryDescribe(),
  'registry.describe_kind': (p) => {
    const doc = registryDescribe() as Record<string, unknown>;
    const kind = String(p.kind ?? '');
    if (!(kind in doc)) throw new RpcError(-32602, `unknown registry kind: ${kind}`);
    return { kind, items: doc[kind] };
  },
  'registry.describe_key': (p) => {
    const items = (methods['registry.describe_kind'](p) as { items: unknown[] }).items;
    const hit = items.find((r) => (r as { key?: unknown })?.key === String(p.key ?? ''));
    if (!hit) throw new RpcError(-32602, `unknown ${String(p.kind ?? '')} key: ${String(p.key ?? '')}`);
    return hit;
  },
  'plugins.list': () => pluginsList(),
  'project.write_project': writeProject,
  ...studyMethods,
};

export function cadEditionMethods(): string[] {
  return Object.keys(methods).sort();
}

/** The WorkerClient calls the server makes (start, stop, call, events), with no process. */
export class CadEditionWorker extends EventEmitter implements WorkerPort {
  private stopped = false;

  start(): void {
    this.stopped = false;
  }

  stop(): void {
    this.stopped = true;
  }

  get alive(): boolean {
    return !this.stopped;
  }

  get unavailable(): boolean {
    return false;
  }

  async call(method: string, params: unknown = {}, _timeoutMs?: number): Promise<unknown> {
    const fn = methods[method];
    if (!fn) throw new CadEditionRefusal(method);
    const p = params && typeof params === 'object' && !Array.isArray(params) ? (params as P) : {};
    const out = fn(p);
    if (REGISTRY_CHANGES.has(method)) this.emit('registry-changed');
    return out;
  }
}
