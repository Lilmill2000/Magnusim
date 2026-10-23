/**
 * Chain grants (core host tools spec C3, §7.2): one compute card may cover a declared chain,
 * so "mesh then run" asks the person once.
 *
 * - A compute call that names a `chain` of job ids (its tool has chainKey) shows one card; on
 *   Allow the runner grants its owner (the turn, or `mcp:<connection>` for another app) the
 *   chained ids other than the call's own: at most CHAIN_MAX.
 * - A later compute call of the same owner whose chainKey is in the set consumes it (each id
 *   once) and runs without a card; the turn's log says so. Never covered: a call that escalates
 *   to destructive, an id not in the set, another owner's call.
 * - A grant ends with its owner: the turn's end (turns.ts) or its Stop, or an MCP connection's
 *   close. As a net, an owner's grants also go GRANT_MAX_MS after they were made, and the
 *   oldest owner goes past OWNERS_MAX.
 *
 * It also keeps, per owner, the jobs its calls started (job id and label): the turn's end note
 * names what still runs (§8.3).
 *
 * On assistantState(), so a Vite re-import of this module shares one store.
 */
import { assistantState } from './state.ts';

/** The most job ids one card may cover. */
export const CHAIN_MAX = 4;
/** The longest a grant lives when its owner's end is never heard (a turn's hard limit is shorter). */
export const GRANT_MAX_MS = 6 * 60 * 60_000;
const OWNERS_MAX = 500;
const JOBS_MAX = 50;

export interface StartedJob {
  job: string;
  label: string;
}

interface OwnerEntry {
  jobs: Map<string, { label: string; at: number }>;
  started: StartedJob[];
  at: number;
}

export interface ChainGrants {
  /** The owner may run each of `jobs` once without a card (each ≤ 100 characters; at most CHAIN_MAX kept). `label`: what the card called each. */
  grant(owner: string, jobs: readonly string[], labels?: Readonly<Record<string, string>>): void;
  /** Uses the owner's grant of `job`: its label (the job id when none) when it had one, else null. */
  consume(owner: string, job: string): string | null;
  /** Whether the owner holds a grant of `job` now (consumes nothing). */
  holds(owner: string, job: string): boolean;
  /** A job the owner's call started (for the end note). */
  started(owner: string, job: StartedJob): void;
  /** The jobs the owner's calls started, oldest first. */
  startedBy(owner: string): StartedJob[];
  /** The owner ended (its turn ended or was stopped, its connection closed): its grants and jobs go. */
  end(owner: string): void;
}

export interface GrantsOptions {
  now?: () => number;
}

const cleanJob = (v: unknown): string | null => (typeof v === 'string' && v.length > 0 && v.length <= 100 ? v : null);

/** A store of its own (tests); the server's is grants(). */
export function createGrants(o: GrantsOptions = {}): ChainGrants {
  const now = o.now ?? Date.now;
  const owners = new Map<string, OwnerEntry>();
  const live = (owner: string): OwnerEntry | null => {
    const e = owners.get(owner);
    if (!e) return null;
    if (now() - e.at > GRANT_MAX_MS) {
      owners.delete(owner);
      return null;
    }
    return e;
  };
  const entry = (owner: string): OwnerEntry => {
    let e = live(owner);
    if (!e) {
      e = { jobs: new Map(), started: [], at: now() };
      owners.set(owner, e);
      while (owners.size > OWNERS_MAX) owners.delete(owners.keys().next().value as string);
    }
    return e;
  };
  return {
    grant(owner, jobs, labels = {}) {
      if (!owner) return;
      const ids = [...new Set(jobs.map(cleanJob).filter((x): x is string => x !== null))].slice(0, CHAIN_MAX);
      if (!ids.length) return;
      const e = entry(owner);
      e.at = now();
      for (const id of ids) e.jobs.set(id, { label: typeof labels[id] === 'string' && labels[id] ? labels[id] : id, at: now() });
    },
    consume(owner, job) {
      const e = owner ? live(owner) : null;
      const g = e?.jobs.get(job);
      if (!e || !g) return null;
      e.jobs.delete(job);
      return g.label;
    },
    holds(owner, job) {
      return !!(owner && live(owner)?.jobs.has(job));
    },
    started(owner, job) {
      const id = cleanJob(job?.job);
      if (!owner || !id) return;
      const e = entry(owner);
      if (e.started.some((s) => s.job === id)) return;
      e.started.push({ job: id, label: typeof job.label === 'string' && job.label ? job.label : id });
      if (e.started.length > JOBS_MAX) e.started.shift();
    },
    startedBy(owner) {
      return [...(live(owner)?.started ?? [])];
    },
    end(owner) {
      owners.delete(owner);
    },
  };
}

/** The server's store (assistantState().grants), made at its first use. */
export function grants(): ChainGrants {
  const s = assistantState();
  s.grants ??= createGrants();
  return s.grants as ChainGrants;
}
