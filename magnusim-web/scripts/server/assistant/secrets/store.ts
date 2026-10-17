/**
 * The provider keys, write-only (Foundation spec 3.5–3.7).
 *
 *   <home>/secrets/master.json  the master key as its protector keeps it (protector.ts)
 *   <home>/secrets/keys.json    { version, master_id, keys: { <slot>: {iv, tag, ct, last4, set_at, origin?} } }
 *
 * A page can save a key, remove it, and see whether one is set (with its last 4 characters
 * when it is at least 16 long). No route reads a key: only the provider adapters borrow
 * one, through withKey(), for one request. A key is never put in process.env (the worker,
 * jobs and plugin services inherit it, and the provider libraries read their keys from it)
 * and never kept decrypted: the master key is cached in memory, each provider key is
 * opened per use and dropped.
 *
 * The files are the truth. Two copies of Magnusim run by one account share them, so the
 * store reads them again for every status, use, save and removal, and a save or removal
 * starts from what is on disk (a save reads them once more after the key helper runs,
 * just before it writes): a key removed in one copy is gone in the other, and is never
 * written back. A master key is created only where none exists (a hard link to a
 * finished file, which fails when another copy made one first; that one is then used),
 * and the cached master is dropped when master.json changes.
 *
 * Helper runs per server lifetime: none at boot, at import or for status(); one protect
 * on the first key save; one unwrap of the master (single-flight), again only after an
 * unwrap failed or another copy made a new master.
 */
import { randomBytes } from 'node:crypto';
import { chmod, link, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { ensurePrivateDir, readJsonFile, writeFileAtomic, type JsonRead } from '../files.ts';
import { secretsDir } from '../home.ts';
import { alog } from '../log.ts';
import { registerSecretForRedaction } from '../redact.ts';
import { isLoopbackHost, serverOrigin } from '../settings.ts';
import { assistantState } from '../state.ts';
import { ProviderError, type ProviderId } from '../types.ts';
import { masterId, open, seal, type Sealed } from './envelope.ts';
import { pickProtector, ProtectorError, type MasterDoc, type PickedProtector, type Protector } from './protector.ts';

export type KeySlot = ProviderId;
export const KEY_SLOTS: readonly KeySlot[] = Object.freeze(['anthropic', 'openai', 'openai_compatible']);

export interface KeyStatus {
  set: boolean;
  last4: string | null;
  set_at: string | null;
  state: 'none' | 'ok' | 'unreadable';
  /** A saved server token (openai_compatible) only: the server it is for (null: none recorded). */
  origin?: string | null;
}
export interface StorageStatus { kind: 'dpapi' | 'file' | 'unavailable'; reason: 'blocked' | 'timeout' | 'failed' | null; note: string }
export interface SecretStore {
  storage(): StorageStatus;
  status(): Record<KeySlot, KeyStatus>;
  setKey(slot: KeySlot, key: string, o?: SetKeyOptions): Promise<{ warning?: string }>;
  removeKey(slot: KeySlot): Promise<void>;
  /** providers/index.ts only. Registers the plaintext for redaction on every decrypt, then lends it to `use`. */
  withKey<T>(slot: KeySlot, use: (key: string) => Promise<T>): Promise<T>;
}

export interface SetKeyOptions {
  /** openai_compatible: the server address the token is saved for (the adapters send it nowhere else). */
  server?: string;
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
  /** openai_compatible: the server (URL origin) the token was saved for. */
  origin?: string | null;
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
  // A save is tried again only after RETRY_AFTER_MS.
  timeout: 'Encrypting the key took too long. Try again in a minute.',
  failed: "Magnusim couldn't encrypt the key on this PC. Try again in a minute.",
});

/** The storage note while the helper is blocked and a server token is saved (it can't be unlocked either). */
export const TOKEN_BLOCKED_NOTE =
  "Windows blocked the helper Magnusim uses to encrypt keys, so keys can't be saved or unlocked on this PC. A local server works only without a token: remove the saved one.";

/** What a use of the saved server token answers while the helper is blocked. */
export const TOKEN_BLOCKED_TEXT =
  "Windows blocked the helper Magnusim uses to encrypt keys, so the saved server token can't be unlocked. Remove the token in Settings → Assistant to use the server without one.";

/** Unlocking the saved master key failed (not blocked): the next use or save tries again at once. */
export const UNLOCK_NOTES = Object.freeze({
  timeout: 'Unlocking the saved key took too long. Try again.',
  failed: "Magnusim couldn't unlock the saved key on this PC. Try again.",
});

export const SET_ASIDE_NOTICE = 'Your saved keys could not be read and were set aside. Enter them again.';

/** After a helper timeout or failure while saving, the next save tries again after this long. */
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

/** The warning for a token saved for a server off this PC whose address is plain http. */
function plainHttpWarning(origin: string | null): string | undefined {
  if (!origin) return undefined;
  const u = new URL(origin);
  if (u.protocol !== 'http:' || isLoopbackHost(u.hostname)) return undefined;
  return `${origin} is not on this PC and its address starts with http://, so the token travels to it unencrypted.`;
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
    const entry: KeyEntry = {
      iv: e.iv,
      tag: e.tag,
      ct: e.ct,
      last4: typeof e.last4 === 'string' ? e.last4 : null,
      set_at: typeof e.set_at === 'string' ? e.set_at : '',
    };
    if (slot === 'openai_compatible') entry.origin = typeof e.origin === 'string' ? e.origin : null;
    doc.keys[slot] = entry;
  }
  return doc;
}

function sameEntry(a: KeyEntry | undefined, b: KeyEntry | undefined): boolean {
  if (!a || !b) return a === b;
  return a.iv === b.iv && a.tag === b.tag && a.ct === b.ct && (a.origin ?? null) === (b.origin ?? null);
}

function isMasterDoc(v: unknown): v is MasterDoc {
  return isRecord(v) && (v.protector === 'dpapi' || v.protector === 'file');
}

/** master.json as read, as comparable text (null: none, or not a master). */
function masterText(r: JsonRead): string | null {
  return r.state === 'ok' && isMasterDoc(r.value) ? JSON.stringify(r.value) : null;
}

const codeOf = (err: unknown) => String((err as { code?: unknown } | null)?.code || '');

const keptChanging = () =>
  new KeyError(500, 'write_failed', 'The key could not be saved: another copy of Magnusim kept changing the key files. Try again.');

function writeReason(err: unknown): string {
  const code = codeOf(err);
  if (code === 'ENOSPC') return 'the disk is full.';
  if (code === 'EPERM' || code === 'EACCES' || code === 'EBUSY') return 'the file is in use or not writable. Try again.';
  if (code === 'EROFS') return 'the folder is read-only.';
  return code ? `${code}.` : 'an unexpected error.';
}

/**
 * Writes `text` to `path` only if no file is there (true; false when one is), and whole:
 * a hard link to a finished temp file, which fails if the file exists. Where hard links
 * don't work, a check and then the atomic replace.
 */
async function createExclusive(path: string, text: string): Promise<boolean> {
  await ensurePrivateDir(dirname(path));
  const tmp = `${path}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
  await writeFile(tmp, text, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
  try {
    if (process.platform !== 'win32') await chmod(tmp, 0o600);
    await link(tmp, path);
    return true;
  } catch (err) {
    if (codeOf(err) === 'EEXIST') return false;
    if ((await readJsonFile(path)).state !== 'missing') return false;
    await writeFileAtomic(path, text, { mode: 0o600 });
    return true;
  } finally {
    await unlink(tmp).catch(() => {});
  }
}

/** The one unwrap in flight, with the master.json text it unwraps. */
type Unwrap = Promise<Buffer> & { doc?: string };

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
  /** master.json as last read or written (masterText()), to see another copy replace it. */
  private masterJson: string | null = null;
  private loaded = false;
  /** Reads started, and the newest one applied: an older read never undoes a newer one. */
  private reads = 0;
  private applied = 0;
  /** This store's own writes: a read that began before one is dropped. */
  private writes = 0;
  private queue: Promise<unknown> = Promise.resolve();
  /** Slots whose sealed key failed to open with the right master. */
  private unreadable = new Set<KeySlot>();
  /** This account can't unlock master.json as it is. */
  private locked = false;
  /** keys.json was sealed under another master than master.json's. */
  private mismatch = false;
  /** A blocked helper (until restart), or a failed save (for RETRY_AFTER_MS). */
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

  /**
   * Reads master.json and keys.json again (no decrypting, no helper): another copy of
   * Magnusim may have saved or removed a key. Once read, a read that fails keeps what was
   * read before.
   */
  async load(): Promise<void> {
    try {
      await this.read();
    } catch (err) {
      if (!this.loaded) throw err;
      alog('warn', 'the key files could not be read again; using what was read before', { error: codeOf(err) || String(err) });
    }
  }

  /** The read a save or removal starts from: one that fails refuses it. */
  private async reread(what: 'saved' | 'removed'): Promise<void> {
    try {
      await this.read();
    } catch (err) {
      throw new KeyError(500, 'write_failed', `The key could not be ${what}: ${writeReason(err)}`);
    }
  }

  private async setAsideFile(path: string): Promise<void> {
    await rename(path, `${path}.bad-${Date.now()}`).catch(() => {});
  }

  private async read(): Promise<void> {
    const seq = ++this.reads;
    const writes = this.writes;
    const k = await readJsonFile(this.keysPath);
    if (k.state === 'bad') {
      alog('warn', 'keys.json could not be read; set aside');
      await this.setAsideFile(this.keysPath);
      this.setAside = true;
    }
    const m = await readJsonFile(this.masterPath);
    if (m.state === 'bad' || (m.state === 'ok' && !isMasterDoc(m.value))) {
      alog('warn', 'master.json could not be read; set aside');
      await this.setAsideFile(this.masterPath);
    }
    // A newer read, or a write of this store's since this read began, holds newer files.
    if (seq < this.applied || writes !== this.writes) return;
    this.applied = seq;
    this.apply(normalizeKeys(k.state === 'ok' ? k.value : null), m.state === 'ok' && isMasterDoc(m.value) ? m.value : null, masterText(m));
  }

  private apply(keys: KeysDoc, doc: MasterDoc | null, json: string | null): void {
    const first = !this.loaded;
    this.loaded = true;
    if (json !== this.masterJson) {
      // Another copy made or replaced the master: the one cached here is not it.
      if (!first) {
        const s = assistantState().secrets;
        s.master = null;
        s.masterId = null;
      }
      this.masterDoc = doc;
      this.masterJson = json;
      this.locked = false;
      this.mismatch = false;
    }
    const before = this.keys;
    this.keys = keys;
    if (first) return;
    if (keys.master_id !== before.master_id) this.mismatch = false;
    // Another copy saved or removed these: they are new here too (running turns on them stop).
    const changed = KEY_SLOTS.filter((slot) => !sameEntry(before.keys[slot], keys.keys[slot]));
    for (const slot of changed) this.unreadable.delete(slot);
    for (const slot of changed) this.changed(slot);
  }

  /** Every slot is unreadable: no master for the saved keys, one this account can't unlock, or keys of another master. */
  private get allUnreadable(): boolean {
    return !this.masterDoc || this.locked || this.mismatch;
  }

  storage(): StorageStatus {
    const blocked = (): StorageStatus => ({
      kind: 'unavailable',
      reason: 'blocked',
      note: this.keys.keys.openai_compatible ? TOKEN_BLOCKED_NOTE : STORAGE_NOTES.blocked,
    });
    if (this.protector.knownUnavailable) return blocked();
    const f = this.failure;
    if (f?.reason === 'blocked') return blocked();
    if (f && this.now() - f.at < RETRY_AFTER_MS) return { kind: 'unavailable', reason: f.reason, note: STORAGE_NOTES[f.reason] };
    return { kind: this.protector.kind, reason: null, note: STORAGE_NOTES[this.protector.kind] };
  }

  status(): Record<KeySlot, KeyStatus> {
    const out = {} as Record<KeySlot, KeyStatus>;
    for (const slot of KEY_SLOTS) {
      const e = this.keys.keys[slot];
      out[slot] = e
        ? {
            set: true,
            last4: e.last4,
            set_at: e.set_at || null,
            state: this.allUnreadable || this.unreadable.has(slot) ? 'unreadable' : 'ok',
            ...(slot === 'openai_compatible' ? { origin: e.origin ?? null } : {}),
          }
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

  /** The storage refusal; a use of the server token while the helper is blocked says what to do about it. */
  private unavailable(slot?: KeySlot): KeyError {
    const st = this.storage();
    return new KeyError(409, 'storage_unavailable', slot === 'openai_compatible' && st.reason === 'blocked' ? TOKEN_BLOCKED_TEXT : st.note);
  }

  /** Logs a helper failure; a blocked helper is kept until restart, a failed save (protect) for RETRY_AFTER_MS. */
  private recordFailure(err: unknown, op: 'protect' | 'unprotect'): 'blocked' | 'timeout' | 'failed' {
    const code = err instanceof ProtectorError ? err.code : 'failed';
    const reason = code === 'blocked' || code === 'timeout' ? code : 'failed';
    if (reason === 'blocked' || op === 'protect') this.failure = { reason, at: this.now() };
    alog('warn', 'the key protector failed', { op, code: reason, detail: err instanceof ProtectorError ? err.detail : String(err) });
    return reason;
  }

  /**
   * A new master key, protected and written (one helper run). With none on disk
   * (`replace` null) it is created only if there is still none: another copy of Magnusim
   * may have made one meanwhile, and that one is then used. One this account can't
   * unlock (`replace`: its text) is replaced only if it is still there.
   */
  private async createMaster(replace: string | null, depth: number): Promise<{ master: Buffer; id: string }> {
    if (depth > 2) throw keptChanging();
    const master = randomBytes(32);
    let doc: MasterDoc;
    try {
      doc = await this.protector.protect(master);
    } catch (err) {
      this.recordFailure(err, 'protect');
      throw this.unavailable();
    }
    this.failure = null;
    const text = `${JSON.stringify(doc, null, 2)}\n`;
    let written: boolean;
    try {
      if (replace === null) written = await createExclusive(this.masterPath, text);
      else {
        written = masterText(await readJsonFile(this.masterPath)) === replace;
        if (written) await writeFileAtomic(this.masterPath, text, { mode: 0o600 });
      }
    } catch (err) {
      throw new KeyError(500, 'write_failed', `The key could not be saved: ${writeReason(err)}`);
    }
    if (!written) {
      // Another copy wrote a master first: that one is used.
      master.fill(0);
      await this.reread('saved');
      return this.master(true, depth + 1) as Promise<{ master: Buffer; id: string }>;
    }
    this.writes += 1;
    this.masterDoc = doc;
    this.masterJson = JSON.stringify(doc);
    this.locked = false;
    this.mismatch = false;
    const s = assistantState().secrets;
    s.master = master;
    s.masterId = masterId(master);
    return { master, id: s.masterId };
  }

  /**
   * The master key of master.json as last read: cached, else unwrapped once (however many
   * callers wait), else, for a save, a new one. Null when it can't be had for a use (no
   * master, or not on this account).
   */
  private async master(forSave: boolean, depth = 0): Promise<{ master: Buffer; id: string } | null> {
    const s = assistantState().secrets;
    if (s.master && s.masterId) return { master: s.master, id: s.masterId };
    const doc = this.masterDoc;
    const json = this.masterJson;
    if (!doc || !json) return forSave ? this.createMaster(null, depth) : null;
    if (this.locked) return forSave ? this.createMaster(json, depth) : null;
    let p = s.unwrap as Unwrap | null;
    if (!p || p.doc !== json) {
      const started: Unwrap = Object.assign(this.protector.unprotect(doc), { doc: json });
      s.unwrap = started;
      const done = () => {
        if (s.unwrap === started) s.unwrap = null;
      };
      void started.then(done, done);
      p = started;
    }
    let master: Buffer;
    try {
      master = await p;
    } catch (err) {
      if (err instanceof ProtectorError && err.code === 'cant_unlock') {
        alog('warn', "the saved master key can't be unlocked on this account; saved keys are unreadable", { detail: err.detail });
        if (this.masterJson === json) this.locked = true;
        return forSave ? this.createMaster(json, depth) : null;
      }
      const reason = this.recordFailure(err, 'unprotect');
      throw reason === 'blocked' ? this.unavailable() : new KeyError(409, 'storage_unavailable', UNLOCK_NOTES[reason]);
    }
    this.failure = null;
    // master.json changed while it was unwrapped: this master is for this call only.
    if (this.masterJson !== json) return { master, id: masterId(master) };
    if (!s.master) {
      s.master = master;
      s.masterId = masterId(master);
    }
    return { master: s.master, id: s.masterId as string };
  }

  setKey(slot: KeySlot, key: string, o: SetKeyOptions = {}): Promise<{ warning?: string }> {
    if (!isKeySlot(slot)) return Promise.reject(new KeyError(400, 'bad_provider', 'Unknown provider.'));
    let checked: { key: string; warning?: string };
    try {
      checked = checkKey(slot, key);
    } catch (err) {
      return Promise.reject(err);
    }
    // From here on any text that holds it is scrubbed (logs, error answers).
    registerSecretForRedaction(checked.key);
    // A server token is for the server it is saved for, and goes nowhere else.
    const origin = slot === 'openai_compatible' ? serverOrigin(o.server) : null;
    const warning = checked.warning ?? plainHttpWarning(origin);
    return this.enqueue(async () => {
      await this.reread('saved');
      if (this.storage().kind === 'unavailable') throw this.unavailable();
      let m = await this.master(true);
      // The helper may have run for seconds, and another copy saved or removed a key (or
      // replaced master.json) meanwhile: the save starts from the files as they are now,
      // sealed under the master of master.json as it is now.
      for (let tries = 1; ; tries += 1) {
        if (!m) throw this.unavailable();
        await this.reread('saved');
        // The cached master is dropped when master.json changes: still cached, it is this one.
        if (assistantState().secrets.masterId === m.id) break;
        if (tries > 2) throw keptChanging();
        m = await this.master(true);
      }
      // Keys sealed under another master can't be opened again: they go.
      const kept = this.keys.master_id === m.id ? this.keys.keys : {};
      const entry: KeyEntry = {
        ...seal(m.master, slot, checked.key),
        last4: checked.key.length >= 16 ? checked.key.slice(-4) : null,
        set_at: new Date(this.now()).toISOString(),
        ...(slot === 'openai_compatible' ? { origin } : {}),
      };
      const next: KeysDoc = { version: 1, master_id: m.id, keys: { ...kept, [slot]: entry } };
      try {
        await writeFileAtomic(this.keysPath, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
      } catch (err) {
        throw new KeyError(500, 'write_failed', `The key could not be saved: ${writeReason(err)}`);
      }
      this.writes += 1;
      if (this.keys.master_id !== m.id) this.unreadable.clear();
      this.mismatch = false;
      this.keys = next;
      this.unreadable.delete(slot);
      this.setAside = false;
      this.changed(slot);
      return warning ? { warning } : {};
    });
  }

  removeKey(slot: KeySlot): Promise<void> {
    if (!isKeySlot(slot)) return Promise.reject(new KeyError(400, 'bad_provider', 'Unknown provider.'));
    return this.enqueue(async () => {
      await this.reread('removed');
      if (this.keys.keys[slot]) {
        const keys = { ...this.keys.keys };
        delete keys[slot];
        const next: KeysDoc = { version: 1, master_id: this.keys.master_id, keys };
        try {
          await writeFileAtomic(this.keysPath, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
        } catch (err) {
          throw new KeyError(500, 'write_failed', `The key could not be removed: ${writeReason(err)}`);
        }
        this.writes += 1;
        this.keys = next;
      }
      this.unreadable.delete(slot);
      this.changed(slot);
    });
  }

  async withKey<T>(slot: KeySlot, use: (key: string) => Promise<T>): Promise<T> {
    if (!isKeySlot(slot)) throw new ProviderError('no_key', 'Unknown provider.');
    await this.load();
    const keys = this.keys;
    const entry = keys.keys[slot];
    if (!entry) throw new ProviderError('no_key', 'No key is saved for this provider. Add one in Settings → Assistant.');
    const f = this.failure;
    if (this.protector.knownUnavailable || (f && f.reason === 'blocked')) throw this.unavailable(slot);
    const unreadable = () =>
      new ProviderError('no_key', "The saved key can't be decrypted on this account. Enter it again in Settings → Assistant.");
    let m: { master: Buffer; id: string } | null;
    try {
      m = await this.master(false);
    } catch (err) {
      throw err instanceof KeyError && this.storage().reason === 'blocked' ? this.unavailable(slot) : err;
    }
    if (!m) throw unreadable();
    if (keys.master_id !== m.id) {
      // The files were read just now, and this is master.json's master: the keys are another's.
      if (this.keys.master_id === keys.master_id) this.mismatch = true;
      throw unreadable();
    }
    let key: string;
    try {
      key = open(m.master, slot, entry);
    } catch {
      if (sameEntry(this.keys.keys[slot], entry)) this.unreadable.add(slot);
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
