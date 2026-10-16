/**
 * The master key in a file only this account can read (Foundation spec 3.4): master.json
 * is 0600 in a 0700 folder, as Electron keeps it on Linux without a keyring ("basic
 * text"). Settings says plainly that the operating system does not encrypt it. No
 * libsecret or Keychain yet.
 */
import { ProtectorError, type MasterDoc, type Protector } from './protector.ts';

export function fileProtector(): Protector {
  return {
    kind: 'file',
    knownUnavailable: null,
    async protect(master: Buffer): Promise<MasterDoc> {
      return { version: 1, protector: 'file', key: master.toString('base64'), created_at: new Date().toISOString() };
    },
    async unprotect(doc: MasterDoc): Promise<Buffer> {
      if (doc.protector !== 'file' || typeof doc.key !== 'string') throw new ProtectorError('cant_unlock', 'the master key was kept another way');
      const key = Buffer.from(doc.key, 'base64');
      if (key.length !== 32) throw new ProtectorError('cant_unlock', 'the master key file is damaged');
      return key;
    },
  };
}
