// Files in and out of the Part (docs/p2p3-plan.md §3.7): store is create-only
// and content-addressed (an identical file is reused, never rewritten), with
// progress and stop; host refusals in words; read in ranges with the checksum
// checked; the picker, the drop hint and the download as the user meets them.
// SPDX-License-Identifier: GPL-3.0-or-later
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createFileTransfer, filesFor, READ_CHUNK, sha256Of } from '../../src/files/transfer';
import { formatBytes, plainFileReason, sizeProblem } from '../../src/files/words';
import { createStateStore } from '../../src/lib/store';
import type { AppServices } from '../../src/types/app';
import type { StoredFileRef } from '../../src/types/doc';
import type { WsFilesApi } from '../../src/types/docstore';
import { FakeFiles, FakeFolder } from '../doc/fake-files';

afterEach(() => {
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

const bytes = (n: number, v = 1) => new Uint8Array(n).fill(v).buffer;

describe('store', () => {
  it('writes create-only with the checksum, reports progress, and reuses an identical file', async () => {
    const fake = new FakeFiles();
    const seen: unknown[] = [];
    const write = vi.spyOn(fake, 'write');
    const t = createFileTransfer({ files: fake });
    const data = bytes(100);
    const sha = await sha256Of(data);
    const first = await t.storeNew('studies/s/imports/x/source.step', data, { onProgress: (p) => seen.push(p.stage) });
    expect(first).toEqual({ ref: { rel: 'studies/s/imports/x/source.step', size: 100, sha256: sha }, created: true });
    expect(write.mock.calls[0][2]).toMatchObject({ ifMatch: null, sha256: sha });
    const again = await t.storeNew('studies/s/imports/x/source.step', data);
    expect(again.created).toBe(false);
    expect(write).toHaveBeenCalledTimes(1);
  });

  it("says the host's refusal in words", async () => {
    const fake = new FakeFiles();
    fake.failNext.push({ code: 'quota', message: 'quota exceeded' });
    const t = createFileTransfer({ files: fake });
    await expect(t.store('studies/s/a.step', bytes(4))).rejects.toThrow("Not stored: the project's CAD files are at their 4096 MB limit");
    fake.failNext.push({ code: 'disk_full', message: 'ENOSPC' });
    await expect(t.store('studies/s/b.step', bytes(4))).rejects.toThrow('Not stored: the disk is full');
    expect(plainFileReason(Object.assign(new Error('x'), { code: 'plugin_off' }))).toBe('Magnusim CAD was turned off');
  });

  it('a 1.1 host (no ws.files) says it cannot store', async () => {
    const t = createFileTransfer({ files: null });
    expect(t.available).toBe(false);
    await expect(t.store('a', bytes(1))).rejects.toThrow('Not stored: this Magnusim cannot store CAD files (it needs host API 1.2)');
  });

  it('a stop before the write writes nothing', async () => {
    const fake = new FakeFiles();
    const t = createFileTransfer({ files: fake });
    const ctl = new AbortController();
    ctl.abort();
    await expect(t.store('a', bytes(1), { signal: ctl.signal })).rejects.toMatchObject({ name: 'AbortError' });
    expect(fake.writes).toHaveLength(0);
  });
});

describe('read', () => {
  it('reads in 16 MB ranges with progress and checks the checksum', async () => {
    const folder = new FakeFolder();
    // The host's ranges (the shared fake returns whole files).
    class Ranged extends FakeFiles {
      override async read(rel: string, o: { offset?: number; length?: number; ifMatch?: string } = {}) {
        const all = await super.read(rel, o);
        if (!all) return null;
        const start = o.offset ?? 0;
        return all.slice(start, o.length != null ? start + o.length : undefined);
      }
    }
    const fake = new Ranged(folder);
    const size = READ_CHUNK + 10;
    folder.put('big.brep', new Uint8Array(size).fill(3));
    const reads = vi.spyOn(fake, 'read');
    const t = createFileTransfer({ files: fake });
    const ref: StoredFileRef = { rel: 'big.brep', size, sha256: await sha256Of(new Uint8Array(size).fill(3).buffer) };
    const done: number[] = [];
    const buf = await t.read(ref, { onProgress: (p) => done.push(p.done!) });
    expect(buf!.byteLength).toBe(size);
    expect(reads.mock.calls.map((c) => c[1])).toEqual([
      { offset: 0, length: READ_CHUNK, ifMatch: folder.info('big.brep')!.etag },
      { offset: READ_CHUNK, length: 10, ifMatch: folder.info('big.brep')!.etag },
    ]);
    expect(done).toEqual([READ_CHUNK, size]);
    await expect(t.read({ ...ref, sha256: '00'.repeat(32) })).rejects.toThrow('the stored file big.brep changed (its checksum is not the one the Part recorded)');
    expect(await t.read('missing.brep')).toBeNull();
  });
});

describe('the picker, the drop hint and the download', () => {
  it('pick opens a hidden STEP file input and gives the chosen file; cancel gives null', async () => {
    const t = createFileTransfer({ files: new FakeFiles(), document });
    const click = vi.spyOn(HTMLInputElement.prototype, 'click').mockImplementation(() => {});
    const p = t.pick(['.step', '.stp']);
    const input = document.querySelector<HTMLInputElement>('[data-cad-file-input]')!;
    expect(input.type).toBe('file');
    expect(input.accept).toBe('.step,.stp');
    expect(click).toHaveBeenCalledTimes(1);
    const file = new File(['x'], 'a.step');
    Object.defineProperty(input, 'files', { value: [file] });
    input.dispatchEvent(new Event('change'));
    expect(await p).toBe(file);
    expect(document.querySelector('[data-cad-file-input]')).toBeNull();
    const q = t.pick(['.step']);
    document.querySelector('[data-cad-file-input]')!.dispatchEvent(new Event('cancel'));
    expect(await q).toBeNull();
  });

  it('dragging files over the frame shows the hint; a drop hands over the file', () => {
    const t = createFileTransfer({ files: new FakeFiles(), document });
    const got: string[] = [];
    const off = t.onDrop(['.step', '.stp'], (f) => got.push(f.name));
    const hint = document.querySelector<HTMLElement>('[data-cad-drop-hint]')!;
    expect(hint.hidden).toBe(true);
    const file = new File(['x'], 'part.stp');
    const dt = { types: ['Files'], files: [file], dropEffect: 'none' };
    const ev = (type: string) => Object.assign(new Event(type, { cancelable: true, bubbles: true }), { dataTransfer: dt });
    document.dispatchEvent(ev('dragenter'));
    expect(hint.hidden).toBe(false);
    expect(hint.textContent).toBe('Drop a STEP file (.step, .stp) to import it');
    const drop = ev('drop');
    document.dispatchEvent(drop);
    expect(drop.defaultPrevented).toBe(true);
    expect(hint.hidden).toBe(true);
    expect(got).toEqual(['part.stp']);
    off();
    expect(document.querySelector('[data-cad-drop-hint]')).toBeNull();
  });

  it('download hands a blob URL to an <a download> and revokes it later', () => {
    vi.useFakeTimers();
    try {
      const t = createFileTransfer({ files: null, document });
      (URL as unknown as { createObjectURL: unknown }).createObjectURL ??= () => '';
      (URL as unknown as { revokeObjectURL: unknown }).revokeObjectURL ??= () => {};
      const create = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:abc');
      const revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
      const names: string[] = [];
      vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
        names.push(`${this.download} ${this.href}`);
      });
      t.download(new TextEncoder().encode('ISO-10303-21;').buffer, 'Part 1.step', 'model/step');
      expect(names).toEqual(['Part 1.step blob:abc']);
      expect((create.mock.calls[0][0] as Blob).type).toBe('model/step');
      expect(revoke).not.toHaveBeenCalled();
      vi.advanceTimersByTime(60_000);
      expect(revoke).toHaveBeenCalledWith('blob:abc');
      expect(document.querySelector('a[download]')).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('one transfer per app, published as services.apis.files', () => {
    const services = { bridge: { files: new FakeFiles() as WsFilesApi }, apis: createStateStore({ sketch: null, solver: null, files: null }) } as unknown as AppServices;
    const a = filesFor(services);
    expect(filesFor(services)).toBe(a);
    expect(services.apis.get().files).toBe(a);
  });
});

describe('words', () => {
  it('sizes and the size rule', () => {
    expect(formatBytes(29916)).toBe('29.2 KB');
    expect(formatBytes(118 * 1024 * 1024)).toBe('118 MB');
    expect(sizeProblem(512 * 1024 * 1024)).toBeNull();
    expect(sizeProblem(600 * 1024 * 1024)).toBe('This STEP is 600 MB. Parts can store files up to 512 MB.');
  });
});
