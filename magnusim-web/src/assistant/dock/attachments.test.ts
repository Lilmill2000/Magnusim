// The person's files in the dock (core host tools spec 13.1): what a file is to the dock (a
// drawing too while the dock offers drawings, else any other file), the accept list, the limits
// said before anything is sent, and the upload (the window's link, once more with a fresh one when
// the server no longer takes it; the server's words, or a plain line when it didn't answer). The
// drawing cases run with drawings on and off whatever ships (drawings.ts).
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AssistantApiError, RemoteError } from '../api';
import { acceptAll, acceptFiles, checkFiles, FILE_LIMITS, kindOf, uploadFile, type UploadSend } from './attachments';
import { DRAWINGS_OFFERED, drawingsOffered, setDrawingsOfferedForTests } from './drawings';

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

const DRAWINGS = () => [file('plate.svg', 10, 'image/svg+xml'), file('PLATE.SVG'), file('flange.dxf'), file('flange.DXF', 10, 'image/vnd.dxf'), file('clip', 1, 'image/svg+xml')];
const ONLY_FILES_WITH_DRAWINGS = 'Only pictures, geometry files (STEP, IGES, BREP, STL, OBJ, PLY) and drawings (SVG, DXF) can be attached.';
const ONLY_FILES_NO_DRAWINGS = 'Only pictures and geometry files (STEP, IGES, BREP, STL, OBJ, PLY) can be attached.';
const GEOMETRY_ACCEPT = '.step,.stp,.iges,.igs,.brep,.brp,.stl,.obj,.ply';

afterEach(() => setDrawingsOfferedForTests(null));

describe('drawings offered (drawings.ts)', () => {
  it("ships on, since the CAD Part imports drawings (Import SVG/DXF, the sketch tool's import row): turning it off is a change made on purpose", () => {
    expect(DRAWINGS_OFFERED).toBe(true);
    expect(drawingsOffered()).toBe(DRAWINGS_OFFERED);
    setDrawingsOfferedForTests(false);
    expect(drawingsOffered()).toBe(false);
    setDrawingsOfferedForTests(null);
    expect(drawingsOffered()).toBe(DRAWINGS_OFFERED);
  });
});

describe('kindOf and checkFiles', () => {
  for (const on of [true, false]) {
    it(`geometry by its extension (any case), pictures by extension or type, anything else refused, whether drawings are offered or not (${on ? 'on' : 'off'})`, () => {
      setDrawingsOfferedForTests(on);
      expect(['a.step', 'b.STP', 'c.iges', 'd.igs', 'e.brep', 'f.brp', 'g.stl', 'h.OBJ', 'i.ply'].map((n) => kindOf(file(n)))).toEqual(Array(9).fill('geometry'));
      expect([file('a.png'), file('b.JPG'), file('c.webp'), file('clip', 1, 'image/png')].map(kindOf)).toEqual(['picture', 'picture', 'picture', 'picture']);
      expect(['plugin.zip', 'notes.txt', 'model.step.exe', 'step', 'plate.svgz', 'part.dwg'].map((n) => kindOf(file(n)))).toEqual(Array(6).fill('other'));
    });
  }

  it('drawings offered: drawings by extension or the SVG type, never a picture', () => {
    setDrawingsOfferedForTests(true);
    // An SVG is a drawing, never a picture, though its type says image/.
    expect(DRAWINGS().map(kindOf)).toEqual(Array(5).fill('drawing'));
  });

  it('drawings not offered: an .svg and a .dxf by extension, and an image/svg+xml file, are any other file (never a picture)', () => {
    setDrawingsOfferedForTests(false);
    expect(DRAWINGS().map(kindOf)).toEqual(Array(5).fill('other'));
  });

  it('the accept list: pictures and geometry files, drawings only while offered; a coding agent that takes no pictures gets the files only', () => {
    setDrawingsOfferedForTests(true);
    expect([acceptAll(), acceptFiles()]).toEqual([`image/png,image/jpeg,image/webp,${GEOMETRY_ACCEPT},.svg,.dxf`, `${GEOMETRY_ACCEPT},.svg,.dxf`]);
    setDrawingsOfferedForTests(false);
    expect([acceptAll(), acceptFiles()]).toEqual([`image/png,image/jpeg,image/webp,${GEOMETRY_ACCEPT}`, GEOMETRY_ACCEPT]);
    expect(acceptAll()).not.toMatch(/svg|dxf/);
  });

  it('drawings not offered: an .svg, a .dxf and an image/svg+xml file are refused with the words that name pictures and geometry files only; geometry beside them is taken', () => {
    setDrawingsOfferedForTests(false);
    const r = checkFiles(0, [...DRAWINGS(), file('a.stl'), file('b.step', FILE_LIMITS.drawingBytes + 1)]);
    expect(r.accepted.map((f) => f.name)).toEqual(['a.stl', 'b.step']);
    expect(r.errors).toEqual([ONLY_FILES_NO_DRAWINGS]);
    // Over 20 MB too: refused as any other file, never by a drawing's cap.
    expect(checkFiles(0, [file('poster.svg', FILE_LIMITS.drawingBytes + 1, 'image/svg+xml')]).errors).toEqual([ONLY_FILES_NO_DRAWINGS]);
  });

  for (const on of [true, false]) {
    it(`at most 4 per message and 500 MB each, said once each; another type in the words of what is offered (drawings ${on ? 'on' : 'off'})`, () => {
      setDrawingsOfferedForTests(on);
      expect(FILE_LIMITS).toEqual({ count: 4, bytes: 500 * 1024 * 1024, drawingBytes: 20 * 1024 * 1024 });
      const r = checkFiles(2, [file('a.stl'), file('big.step', FILE_LIMITS.bytes + 1), file('b.stl'), file('c.stl'), file('d.stl'), file('x.zip')]);
      expect(r.accepted.map((f) => f.name)).toEqual(['a.stl', 'b.stl']);
      expect(r.errors).toEqual(['big.step is larger than 500 MB. Import it with + Add geometry.', 'At most 4 files per message.', on ? ONLY_FILES_WITH_DRAWINGS : ONLY_FILES_NO_DRAWINGS]);
      expect(checkFiles(0, [file('edge.step', FILE_LIMITS.bytes)]).accepted).toHaveLength(1);
    });
  }

  it('a drawing 20 MB, in its own words (drawings offered)', () => {
    setDrawingsOfferedForTests(true);
    // A drawing has its own cap and words; a geometry file of that size is fine.
    const d = checkFiles(0, [file('poster.svg', FILE_LIMITS.drawingBytes + 1, 'image/svg+xml'), file('edge.dxf', FILE_LIMITS.drawingBytes), file('mid.step', FILE_LIMITS.drawingBytes + 1)]);
    expect(d.accepted.map((f) => f.name)).toEqual(['edge.dxf', 'mid.step']);
    expect(d.errors).toEqual(['poster.svg is larger than 20 MB, the limit for a drawing.']);
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
