/**
 * What keeps the master key (Foundation spec 3.3, 3.4, 3.8). The provider keys are
 * sealed in Node with a 32-byte master key (envelope.ts); a protector keeps that master:
 *
 * - Windows: DPAPI for this Windows account, through Windows PowerShell 5.1 (dpapi.ts).
 *   There is no plaintext fallback: when Windows blocks the helper, keys can't be saved.
 * - Other systems: a 0600 file in a 0700 folder (file.ts), and Settings says so.
 *
 * MAGNUSIM_TEST_ASSISTANT_PROTECTOR=blocked|timeout|slow:<ms>|file puts a stand-in in
 * its place for tests, and only together with MAGNUSIM_TEST_ASSISTANT=1 and a test home
 * (MAGNUSIM_ASSISTANT_HOME or MAGNUSIM_LOCAL_JSON): otherwise it is ignored with a warning,
 * so stray variables (a shell left set up for tests that then starts the app) can never
 * put the Windows master key of this PC's real folder in a plain file. No stand-in stores
 * keys in plain text (`file` and `slow:` keep the master as the file protector does). The
 * store picks once, at its first use.
 */
import { assistantHomeIsOverridden } from '../home.ts';
import { alog } from '../log.ts';
import { dpapiProtector } from './dpapi.ts';
import { fileProtector } from './file.ts';

export type ProtectorKind = 'dpapi' | 'file';
export type ProtectorErrorCode = 'cant_unlock' | 'blocked' | 'timeout' | 'failed';

/** master.json: the master key as its protector keeps it. */
export interface MasterDoc {
  version: 1;
  protector: ProtectorKind;
  /** DPAPI: the protected master, base64. */
  blob?: string;
  /** File: the master itself, base64 (the file is the protection). */
  key?: string;
  created_at: string;
}

export interface Protector {
  readonly kind: ProtectorKind;
  /** A reason keys can't be stored that is known without trying (a test stand-in only). */
  readonly knownUnavailable: 'blocked' | null;
  protect(master: Buffer): Promise<MasterDoc>;
  unprotect(doc: MasterDoc): Promise<Buffer>;
}

export class ProtectorError extends Error {
  code: ProtectorErrorCode;
  /** The helper's first error line, redacted. */
  detail: string;
  constructor(code: ProtectorErrorCode, detail = '') {
    super(`key protection ${code}${detail ? `: ${detail}` : ''}`);
    this.code = code;
    this.detail = detail;
  }
}

export interface PickedProtector {
  protector: Protector;
  /** The test switch in use (status reports it), or null. */
  test: string | null;
}

export interface PickOptions {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  makeDpapi?: () => Protector;
  makeFile?: () => Protector;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function failing(kind: ProtectorKind, code: 'blocked' | 'timeout'): Protector {
  const fail = async (): Promise<never> => {
    throw new ProtectorError(code, `test switch ${code}`);
  };
  return { kind, knownUnavailable: code === 'blocked' ? 'blocked' : null, protect: fail, unprotect: fail };
}

function slow(inner: Protector, ms: number): Protector {
  return {
    kind: inner.kind,
    knownUnavailable: null,
    protect: async (master) => {
      await sleep(ms);
      return inner.protect(master);
    },
    unprotect: async (doc) => {
      await sleep(ms);
      return inner.unprotect(doc);
    },
  };
}

export function pickProtector(o: PickOptions = {}): PickedProtector {
  const env = o.env ?? process.env;
  const platform = o.platform ?? process.platform;
  const makeFile = o.makeFile ?? (() => fileProtector());
  const makeDpapi = o.makeDpapi ?? (() => dpapiProtector());
  const native = (): Protector => (platform === 'win32' ? makeDpapi() : makeFile());
  const raw = String(env.MAGNUSIM_TEST_ASSISTANT_PROTECTOR || '').trim();
  if (!raw) return { protector: native(), test: null };
  if (env.MAGNUSIM_TEST_ASSISTANT !== '1') {
    alog('warn', 'MAGNUSIM_TEST_ASSISTANT_PROTECTOR is ignored without MAGNUSIM_TEST_ASSISTANT=1');
    return { protector: native(), test: null };
  }
  if (!assistantHomeIsOverridden({ env })) {
    alog('warn', 'MAGNUSIM_TEST_ASSISTANT_PROTECTOR is ignored outside a test home (MAGNUSIM_ASSISTANT_HOME or MAGNUSIM_LOCAL_JSON)');
    return { protector: native(), test: null };
  }
  const nativeKind: ProtectorKind = platform === 'win32' ? 'dpapi' : 'file';
  if (raw === 'blocked' || raw === 'timeout') return { protector: failing(nativeKind, raw), test: raw };
  if (raw === 'file') return { protector: makeFile(), test: raw };
  const m = /^slow:(\d{1,6})$/.exec(raw);
  if (m) return { protector: slow(makeFile(), Number(m[1])), test: raw };
  alog('warn', 'MAGNUSIM_TEST_ASSISTANT_PROTECTOR has an unknown value and is ignored', { value: raw.slice(0, 40) });
  return { protector: native(), test: null };
}
