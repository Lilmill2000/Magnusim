/**
 * The provider keys, write-only (Foundation spec 3.5–3.7).
 *
 *   <home>/secrets/master.json  the master key as its protector keeps it (protector.ts)
 *   <home>/secrets/keys.json    { version, master_id, keys: { <slot>: {iv, tag, ct, last4, set_at} } }
 *
 * A page can save a key, remove it, and see whether one is set (with its last 4 characters
 * when it is at least 16 long). No route reads a key: only the provider adapters borrow
 * one, through withKey(), for one request. A key is never put in process.env (the worker,
 * jobs and plugin services inherit it, and the provider libraries read their keys from it)
 * and never kept decrypted: the master key is cached in memory, each provider key is
 * opened per use and dropped.
 *
 * Helper runs per server lifetime: none at boot, at import or for status(); one protect
 * on the first key save; at most one unwrap of the master (single-flight).
 */
import { randomBytes } from 'node:crypto';
import { rename } from 'node:fs/promises';
import { join } from 'node:path';
import { readJsonFile, writeFileAtomic } from '../files.ts';
import { secretsDir } from '../home.ts';
import { alog } from '../log.ts';
import { registerSecretForRedaction } from '../redact.ts';
import { assistantState } from '../state.ts';
import { ProviderError, type ProviderId } from '../types.ts';
import { masterId, open, seal, type Sealed } from './envelope.ts';
import { pickProtector, ProtectorError, type MasterDoc, type PickedProtector, type Protector } from './protector.ts';

export type KeySlot = ProviderId;
export const KEY_SLOTS: readonly KeySlot[] = Object.freeze(['anthropic', 'openai', 'openai_compatible']);

export interface KeyStatus { set: boolean; last4: string | null; set_at: string | null; state: 'none' | 'ok' | 'unreadable' }
export interface StorageStatus { kind: 'dpapi' | 'file' | 'unavailable'; reason: 'blocked' | 'timeout' | 'failed' | null; note: string }
export interface SecretStore {
  storage(): StorageStatus;
  status(): Record<KeySlot, KeyStatus>;
  setKey(slot: KeySlot, key: string): Promise<{ warning?: string }>;
  removeKey(slot: KeySlot): Promise<void>;
  /** providers/index.ts only. Registers the plaintext for redaction on every decrypt, then lends it to `use`. */
  withKey<T>(slot: KeySlot, use: (key: string) => Promise<T>): Promise<T>;
}

export type KeyErrorCode = 'bad_provider' | 'invalid_key' | 'storage_unavailable' | 'write_failed';

/** A refused save or removal: the route answers `status` with `{code, error}`. Never holds the key. */
export class KeyError extends Error {
  status: 400 | 409 | 500;
  code: KeyErrorCode;
  constructor(status: 400 | 409 | 500, code: KeyErrorCode, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

interface KeyEntry extends Sealed {
  last4: string | null;
  set_at: string;
}
interface KeysDoc {
  version: 1;
  master_id: string | null;
  keys: Partial<Record<KeySlot, KeyEntry>>;
}

export const STORAGE_NOTES = Object.freeze({
  dpapi: 'Encrypted for your Windows account.',
  file: 'Kept in a file only your user account can read; it is not encrypted by the operating system.',
  blocked: "Windows blocked the helper Magnusim uses to encrypt keys, so keys can't be saved on this PC. A local server still works.",
  timeout: 'Encrypting the key took too long. Try again.',
  failed: "Magnusim couldn't encrypt the key on this PC. Try again.",
});

export const SET_ASIDE_NOTICE = 'Your saved keys could not be read and were set aside. Enter them again.';

/** After a helper timeout or failure, the next save tries again after this long. */
export const RETRY_AFTER_MS = 60_000;

const CLOUD_KEY = /^[!-~]{8,512}$/;
const SERVER_TOKEN = /^[!-~]{1,512}$/;
const USUAL_PREFIX: Partial<Record<KeySlot, { prefix: string; label: string }>> = {
  anthropic: { prefix: 'sk-ant-', label: 'Anthropic' },
  openai: { prefix: 'sk-', label: 'OpenAI' },
};

export function isKeySlot(v: unknown): v is KeySlot {
  return typeof v === 'string' && (KEY_SLOTS as readonly string[]).includes(v);
}

/** The key as saved (trimmed), or a KeyError that never repeats it. */
export function checkKey(slot: KeySlot, key: unknown): { key: string; warning?: string } {
  const k = typeof key === 'string' ? key.trim() : '';
  if (slot === 'openai_compatible') {
    if (!SERVER_TOKEN.test(k)) throw new KeyError(400, 'invalid_key', 'A server token is 1 to 512 characters, with no spaces.');
    return { key: k };
  }
  if (!CLOUD_KEY.test(k)) throw new KeyError(400, 'invalid_key', 'Paste the whole key: 8 to 512 characters, with no spaces.');
  const usual = USUAL_PREFIX[slot];
  if (usual && !k.startsWith(usual.prefix)) {
    return { key: k, warning: `This doesn't look like an ${usual.label} key (they start with ${usual.prefix}). It was saved anyway.` };
  }
  return { key: k };
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

function normalizeKeys(raw: unknown): KeysDoc {
  const doc: KeysDoc = { version: 1, master_id: null, keys: {} };
  if (!isRecord(raw)) return doc;
  doc.master_id = typeof raw.master_id === 'string' ? raw.master_id : null;
  if (!isRecord(raw.keys)) return doc;
  for (const slot of KEY_SLOTS) {
    const e = raw.keys[slot];
    if (!isRecord(e) || typeof e.iv !== 'string' || typeof e.tag !== 'string' || typeof e.ct !== 'string') continue;
    doc.keys[slot] = {
      iv: e.iv,
      tag: e.tag,
      ct: e.ct,
      last4: typeof e.last4 === 'string' ? e.last4 : null,
      set_at: typeof e.set_at === 'string' ? e.set_at : '',
    };
  }
  return doc;
}

function isMasterDoc(v: unknown): v is MasterDoc {
  return isRecord(v) && (v.protector === 'dpapi' || v.protector === 'file');
}

function writeReason(err: unknown): string {
  const code = String((err as { code?: unknown } | null)?.code || '');
  if (code === 'ENOSPC') return 'the disk is full.';
  if (code === 'EPERM' || code === 'EACCES' || code === 'EBUSY') return 'the file is in use or not writable. Try again.';
  if (code === 'EROFS') return 'the folder is read-only.';
  return code ? `${code}.` : 'an unexpected error.';
}

export interface StoreOptions {
  dir: string;
  picked: PickedProtector;
  /** Milliseconds now (tests move it past the retry wait). */
  now?: () => number;
}

class Store implements SecretStore {
  readonly dir: string;
  readonly protector: Protector;
  /** The test switch in use, or null (status reports it). */
  readonly testProtector: string | null;
  private readonly now: () => number;
  private readonly masterPath: string;
  private readonly keysPath: string;
  private keys: KeysDoc = { version: 1, master_id: null, keys: {} };
  private masterDoc: MasterDoc | null = null;
  private loading: Promise<void> | null = null;
  private queue: Promise<unknown> = Promise.resolve();
  /** Slots whose sealed key failed to open with the right master. */
  private unreadable = new Set<KeySlot>();
  /** The master can't be unlocked, or the keys were sealed under another master: every slot is unreadable. */
  private allUnreadable = false;
  private failure: { reason: 'blocked' | 'timeout' | 'failed'; at: number } | null = null;
  private setAside = false;
  private listeners = new Set<(slot: KeySlot) => void>();

  constructor(o: StoreOptions) {
    this.dir = o.dir;
    this.protector = o.picked.protector;
    this.testProtector = o.picked.test;
    this.now = o.now ?? Date.now;
    this.masterPath = join(o.dir, 'master.json');
    this.keysPath = join(o.dir, 'keys.json');
  }

  /** Reads master.json and keys.json once (no decrypting, no helper). */
  load(): Promise<void> {
    if (!this.loading) {
      this.loading = this.readFiles().catch((err) => {
        this.loading = null;
        throw err;
      });
    }
    return this.loading;
  }

  private async setAsideFile(path: string): Promise<void> {
    await rename(path, `${path}.bad-${Date.now()}`).catch(() => {});
  }

  private async readFiles(): Promise<void> {
    const k = await readJsonFile(this.keysPath);
    if (k.state === 'bad') {
      alog('warn', 'keys.json could not be read; set aside');
      await this.setAsideFile(this.keysPath);
      this.setAside = true;
    }
    this.keys = normalizeKeys(k.state === 'ok' ? k.value : null);
    const m = await readJsonFile(this.masterPath);
    if (m.state === 'bad' || (m.state === 'ok' && !isMasterDoc(m.value))) {
      alog('warn', 'master.json could not be read; set aside');
      await this.setAsideFile(this.masterPath);
    }
    this.masterDoc = m.state === 'ok' && isMasterDoc(m.value) ? m.value : null;
    if (!this.masterDoc && Object.keys(this.keys.keys).length) this.allUnreadable = true;
  }

  storage(): StorageStatus {
    if (this.protector.knownUnavailable) return { kind: 'unavailable', reason: 'blocked', note: STORAGE_NOTES.blocked };
    const f = this.failure;
    if (f && (f.reason === 'blocked' || this.now() - f.at < RETRY_AFTER_MS)) {
      return { kind: 'unavailable', reason: f.reason, note: STORAGE_NOTES[f.reason] };
    }
    return { kind: this.protector.kind, reason: null, note: STORAGE_NOTES[this.protector.kind] };
  }

  status(): Record<KeySlot, KeyStatus> {
    const out = {} as Record<KeySlot, KeyStatus>;
    for (const slot of KEY_SLOTS) {
      const e = this.keys.keys[slot];
      out[slot] = e
        ? { set: true, last4: e.last4, set_at: e.set_at || null, state: this.allUnreadable || this.unreadable.has(slot) ? 'unreadable' : 'ok' }
        : { set: false, last4: null, set_at: null, state: 'none' };
    }
    return out;
  }

  /** The keys file could not be read and was set aside (Settings says so once per run). */
  notice(): string | null {
    return this.setAside ? SET_ASIDE_NOTICE : null;
  }

  /** Called with the slot after a key is saved or removed (running turns on it stop). */
  onKeyChanged(fn: (slot: KeySlot) => void): () => void {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  }

  private changed(slot: KeySlot): void {
    for (const fn of [...this.listeners]) {
      try {
        fn(slot);
      } catch (err) {
        alog('error', 'a key-change listener failed', { error: err instanceof Error ? err.message : String(err) });
      }
    }
  }

  private enqueue<T>(op: () => Promise<T>): Promise<T> {
    const run = this.queue.then(op, op);
    this.queue = run.catch(() => {});
    return run;
  }

  private unavailable(): KeyError {
    return new KeyError(409, 'storage_unavailable', this.storage().note);
  }

  private recordFailure(err: unknown): void {
    const code = err instanceof ProtectorError ? err.code : 'failed';
    const reason = code === 'blocked' || code === 'timeout' ? code : 'failed';
    this.failure = { reason, at: this.now() };
    alog('warn', 'the key protector failed', { code: reason, detail: err instanceof ProtectorError ? err.detail : String(err) });
  }

  /** A new master key, protected and written (one helper run). */
  private async createMaster(): Promise<{ master: Buffer; id: string }> {
    const master = randomBytes(32);
    let doc: MasterDoc;
    try {
      doc = await this.protector.protect(master);
    } catch (err) {
      this.recordFailure(err);
      throw this.unavailable();
    }
    this.failure = null;
    try {
      await writeFileAtomic(this.masterPath, `${JSON.stringify(doc, null, 2)}\n`, { mode: 0o600 });
    } catch (err) {
      throw new KeyError(500, 'write_failed', `The key could not be saved: ${writeReason(err)}`);
    }
    this.masterDoc = doc;
    const s = assistantState().secrets;
    s.master = master;
    s.masterId = masterId(master);
    return { master, id: s.masterId };
  }

  /**
   * The master key: cached, else unwrapped once (however many callers wait), else, for a
   * save, a new one. Null when it can't be had for a use (no master, or not on this account).
   */
  private async master(forSave: boolean): Promise<{ master: Buffer; id: string } | null> {
    const s = assistantState().secrets;
    if (s.master && s.masterId) return { master: s.master, id: s.masterId };
    const doc = this.masterDoc;
    if (!doc || this.allUnreadable) return forSave ? this.createMaster() : null;
    if (!s.unwrap) {
      const p = this.protector.unprotect(doc);
      s.unwrap = p;
      void p.then(
        () => {
          if (s.unwrap === p) s.unwrap = null;
        },
        () => {
          if (s.unwrap === p) s.unwrap = null;
        },
      );
    }
    let master: Buffer;
    try {
      master = await s.unwrap;
    } catch (err) {
      if (err instanceof ProtectorError && err.code === 'cant_unlock') {
        alog('warn', "the saved master key can't be unlocked on this account; saved keys are unreadable", { detail: err.detail });
        this.allUnreadable = true;
        return forSave ? this.createMaster() : null;
      }
      this.recordFailure(err);
      throw this.unavailable();
    }
    this.failure = null;
    if (!s.master) {
      s.master = master;
      s.masterId = masterId(master);
    }
    return { master: s.master, id: s.masterId as string };
  }

  setKey(slot: KeySlot, key: string): Promise<{ warning?: string }> {
    if (!isKeySlot(slot)) return Promise.reject(new KeyError(400, 'bad_provider', 'Unknown provider.'));
    let checked: { key: string; warning?: string };
    try {
      checked = checkKey(slot, key);
    } catch (err) {
      return Promise.reject(err);
    }
    // From here on any text that holds it is scrubbed (logs, error answers).
    registerSecretForRedaction(checked.key);
    return this.enqueue(async () => {
      await this.load();
      if (this.storage().kind === 'unavailable') throw this.unavailable();
      const m = await this.master(true);
      if (!m) throw this.unavailable();
      // Keys sealed under another master can't be opened again: they go.
      const kept = this.keys.master_id === m.id ? this.keys.keys : {};
      const entry: KeyEntry = {
        ...seal(m.master, slot, checked.key),
        last4: checked.key.length >= 16 ? checked.key.slice(-4) : null,
        set_at: new Date(this.now()).toISOString(),
      };
      const next: KeysDoc = { version: 1, master_id: m.id, keys: { ...kept, [slot]: entry } };
      try {
        await writeFileAtomic(this.keysPath, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
      } catch (err) {
        throw new KeyError(500, 'write_failed', `The key could not be saved: ${writeReason(err)}`);
      }
      if (this.keys.master_id !== m.id) {
        this.unreadable.clear();
        this.allUnreadable = false;
      }
      this.keys = next;
      this.unreadable.delete(slot);
      this.setAside = false;
      this.changed(slot);
      return checked.warning ? { warning: checked.warning } : {};
    });
  }

  removeKey(slot: KeySlot): Promise<void> {
    if (!isKeySlot(slot)) return Promise.reject(new KeyError(400, 'bad_provider', 'Unknown provider.'));
    return this.enqueue(async () => {
      await this.load();
      if (this.keys.keys[slot]) {
        const keys = { ...this.keys.keys };
        delete keys[slot];
        const next: KeysDoc = { version: 1, master_id: this.keys.master_id, keys };
        try {
          await writeFileAtomic(this.keysPath, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
        } catch (err) {
          throw new KeyError(500, 'write_failed', `The key could not be removed: ${writeReason(err)}`);
        }
        this.keys = next;
      }
      this.unreadable.delete(slot);
      this.changed(slot);
    });
  }

  async withKey<T>(slot: KeySlot, use: (key: string) => Promise<T>): Promise<T> {
    if (!isKeySlot(slot)) throw new ProviderError('no_key', 'Unknown provider.');
    await this.load();
    const entry = this.keys.keys[slot];
    if (!entry) throw new ProviderError('no_key', 'No key is saved for this provider. Add one in Settings → Assistant.');
    const f = this.failure;
    if (this.protector.knownUnavailable || (f && f.reason === 'blocked')) throw this.unavailable();
    const unreadable = () =>
      new ProviderError('no_key', "The saved key can't be decrypted on this account. Enter it again in Settings → Assistant.");
    const m = await this.master(false);
    if (!m) throw unreadable();
    if (this.keys.master_id !== m.id) {
      this.allUnreadable = true;
      throw unreadable();
    }
    let key: string;
    try {
      key = open(m.master, slot, entry);
    } catch {
      this.unreadable.add(slot);
      alog('warn', "a saved key can't be decrypted", { slot });
      throw unreadable();
    }
    registerSecretForRedaction(key);
    return use(key);
  }
}

export type { Store };

export function createSecretStore(o: StoreOptions): Store {
  return new Store(o);
}

/** This server's store (the protector picked once, at first use). */
export function secretStore(): Store {
  const s = assistantState().secrets;
  if (!s.store) s.store = new Store({ dir: secretsDir(), picked: pickProtector() });
  return s.store as Store;
}
