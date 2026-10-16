/**
 * Sealing provider keys with the master key (Foundation spec 3.2): AES-256-GCM, a fresh
 * 12-byte IV per seal, and the slot and master bound in as additional data
 * (`magnusim-assistant-key:v1:<slot>:<master_id>`), so a sealed key copied to another slot
 * or kept under another master never opens.
 */
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

export interface Sealed {
  iv: string;
  tag: string;
  ct: string;
}

/** A short public name for a master key (16 hex), stored beside the keys it sealed. */
export function masterId(master: Buffer): string {
  return createHash('sha256').update('magnusim-assistant-master-id:v1:').update(master).digest('hex').slice(0, 16);
}

function aad(slot: string, id: string): Buffer {
  return Buffer.from(`magnusim-assistant-key:v1:${slot}:${id}`, 'utf8');
}

function checkMaster(master: Buffer): void {
  if (!Buffer.isBuffer(master) || master.length !== 32) throw new Error('the master key must be 32 bytes');
}

export function seal(master: Buffer, slot: string, plaintext: string): Sealed {
  checkMaster(master);
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', master, iv);
  cipher.setAAD(aad(slot, masterId(master)));
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return { iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), ct: ct.toString('base64') };
}

/** The plaintext, or a throw when anything (slot, master, IV, tag, ciphertext) differs. */
export function open(master: Buffer, slot: string, sealed: Sealed): string {
  checkMaster(master);
  const iv = Buffer.from(String(sealed.iv || ''), 'base64');
  const tag = Buffer.from(String(sealed.tag || ''), 'base64');
  if (iv.length !== 12 || tag.length !== 16) throw new Error('the sealed key is damaged');
  const decipher = createDecipheriv('aes-256-gcm', master, iv, { authTagLength: 16 });
  decipher.setAAD(aad(slot, masterId(master)));
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(Buffer.from(String(sealed.ct || ''), 'base64')), decipher.final()]).toString('utf8');
}
