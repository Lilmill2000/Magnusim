// The person's files in the dock (core host tools spec 13.1): what a file is to the dock, the
// limits said before anything is sent, and the upload (the window's link, once more with a fresh
// one when the server no longer takes it; the server's words, or a plain line when it didn't
// answer).
import { describe, expect, it, vi } from 'vitest';
import { AssistantApiError, RemoteError } from '../api';
import { checkFiles, FILE_LIMITS, kindOf, uploadFile, type UploadSend } from './attachments';

const relay = vi.hoisted(() => ({ avoided: [] as Array<string | null> }));
vi.mock('../relay', () => ({
  withAssistantLink: async (use: (link: string | null) => Promise<unknown>, avoid: string | null = null) => {
    relay.avoided.push(avoid);
    return use(avoid ? 'L2' : 'L1');
  },
}));

const file = (name: string, size = 10, type = '') => {
  const f = new File([new Uint8Array(1)], name, { type });
  Object.defineProperty(f, 'size', { value: size });
  return f;
};

describe('kindOf and checkFiles', () => {
  it('geometry by its extension (any case), pictures by extension or type, anything else refused', () => {
    expect(['a.step', 'b.STP', 'c.iges', 'd.igs', 'e.brep', 'f.brp', 'g.stl', 'h.OBJ', 'i.ply'].map((n) => kindOf(file(n)))).toEqual(Array(9).fill('geometry'));
    expect([file('a.png'), file('b.JPG'), file('c.webp'), file('clip', 1, 'image/png')].map(kindOf)).toEqual(['picture', 'picture', 'picture', 'picture']);
    expect(['plugin.zip', 'notes.txt', 'model.step.exe', 'step'].map((n) => kindOf(file(n)))).toEqual(['other', 'other', 'other', 'other']);
  });

  it('at most 4 per message and 500 MB each, said once each', () => {
    expect(FILE_LIMITS).toEqual({ count: 4, bytes: 500 * 1024 * 1024 });
    const r = checkFiles(2, [file('a.stl'), file('big.step', FILE_LIMITS.bytes + 1), file('b.stl'), file('c.stl'), file('d.stl'), file('x.zip')]);
    expect(r.accepted.map((f) => f.name)).toEqual(['a.stl', 'b.stl']);
    expect(r.errors).toEqual([
      'big.step is larger than 500 MB. Import it with + Add geometry.',
      'At most 4 files per message.',
      'Only pictures and geometry files (STEP, IGES, BREP, STL, OBJ, PLY) can be attached.',
    ]);
    expect(checkFiles(0, [file('edge.step', FILE_LIMITS.bytes)]).accepted).toHaveLength(1);
  });
});

describe('uploadFile', () => {
  const ac = () => new AbortController().signal;
  it("sends with this window's link; the server's id, name and size", async () => {
    relay.avoided = [];
    const send = vi.fn<UploadSend>(async () => ({ status: 200, body: { ok: true, attachment_id: 'att-0123456789abcdef', name: 'part.step', bytes: 99 } }));
    await expect(uploadFile(file('C:/x/part.step'), () => undefined, ac(), send)).resolves.toEqual({ id: 'att-0123456789abcdef', name: 'part.step', bytes: 99 });
    expect(send.mock.calls[0][1]).toBe('L1');
  });

  it('a stale link: once more with a fresh one, never a third time', async () => {
    relay.avoided = [];
    const send = vi.fn<UploadSend>(async () => ({ status: 409, body: { ok: false, code: 'no_channel', error: 'This window lost its connection to Magnusim. Try again.' } }));
    await expect(uploadFile(file('a.stl'), () => undefined, ac(), send)).rejects.toThrow('This window lost its connection to Magnusim. Try again.');
    expect(send.mock.calls.map((c) => c[1])).toEqual(['L1', 'L2']);
    expect(relay.avoided).toEqual([null, 'L1']);
  });

  it("a refusal carries the server's words and code; no answer says so plainly; remote is the remote error", async () => {
    const refused = uploadFile(file('a.stl'), () => undefined, ac(), async () => ({ status: 413, body: { ok: false, code: 'too_large', error: 'a.stl is larger than 500 MB. Import it with + Add geometry.' } }));
    await expect(refused).rejects.toBeInstanceOf(AssistantApiError);
    await expect(refused).rejects.toMatchObject({ status: 413, code: 'too_large', message: 'a.stl is larger than 500 MB. Import it with + Add geometry.' });
    await expect(uploadFile(file('a.stl'), () => undefined, ac(), async () => ({ status: 0, body: {} }))).rejects.toThrow("a.stl didn't reach Magnusim's server. Attach it again.");
    await expect(uploadFile(file('a.stl'), () => undefined, ac(), async () => ({ status: 403, body: { reason: 'remote' } }))).rejects.toBeInstanceOf(RemoteError);
  });
});
