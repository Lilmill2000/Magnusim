/**
 * The person's files for a message (core host tools spec 13.1): geometry files, and drawings
 * while the dock offers them (drawings.ts), attached in the dock beside the pictures (Attach,
 * paste or a drop), each uploaded at once to POST /api/assistant/attachments with this tab's live
 * relay link, then named in the turn by its attachment_id. The AI imports one only by that id: a
 * geometry file into the project open here, a drawing in a workspace that imports drawings.
 *
 * - kindOf(file): a picture (pictures.ts takes it), a geometry file (STEP, IGES, BREP, STL, OBJ,
 *   PLY by its extension), a drawing (SVG, DXF; an image/svg+xml file is a drawing, never a
 *   picture) or anything else (refused with onlyFiles). While the dock offers no drawings a
 *   drawing is anything else too, refused before it is uploaded.
 * - acceptAll() / acceptFiles(): the file input's accept list, drawings in it only while offered.
 * - checkFiles(): at most 4 per message, 500 MB each (a drawing 20 MB), said plainly before
 *   anything is sent.
 * - uploadFile(): the raw bytes (XMLHttpRequest, for the progress), once more with a fresh link
 *   when the server no longer takes this one. A drawing is only uploaded: its markup never
 *   reaches the page's DOM.
 */
import { AssistantApiError, RemoteError, REMOTE_TEXT } from '../api';
import { withAssistantLink } from '../relay';
import { AT_MOST_FOUR_FILES, drawingTooLarge, fileTooLarge, onlyFiles, uploadLost } from './copy';
import { drawingsOffered } from './drawings';

export const FILE_LIMITS = Object.freeze({ count: 4, bytes: 500 * 1024 * 1024, drawingBytes: 20 * 1024 * 1024 });
export const ATTACHMENTS_PATH = '/api/assistant/attachments';
export const GEOMETRY_EXTENSIONS = Object.freeze(['.step', '.stp', '.iges', '.igs', '.brep', '.brp', '.stl', '.obj', '.ply']);
export const DRAWING_EXTENSIONS = Object.freeze(['.svg', '.dxf']);
const PICTURE_EXTENSIONS = Object.freeze(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp']);
/** The files' part of the accept list: geometry files, and drawings while the dock offers them. */
const fileExtensions = (): readonly string[] => (drawingsOffered() ? [...GEOMETRY_EXTENSIONS, ...DRAWING_EXTENSIONS] : GEOMETRY_EXTENSIONS);
/** The file input's accept list: pictures and the files (a coding agent that takes no pictures: the files only, acceptFiles). */
export const acceptAll = (): string => ['image/png', 'image/jpeg', 'image/webp', ...fileExtensions()].join(',');
export const acceptFiles = (): string => fileExtensions().join(',');

export type FileKind = 'picture' | 'geometry' | 'drawing' | 'other';

const extOf = (name: string): string => {
  const m = /(\.[A-Za-z0-9]{1,5})$/.exec(name || '');
  return m ? m[1].toLowerCase() : '';
};

/**
 * What a file is to the dock, by its extension (a picture also by its type; an SVG by either is a
 * drawing, never a picture, and anything else while the dock offers no drawings).
 */
export function kindOf(file: { name: string; type?: string }): FileKind {
  const ext = extOf(file.name);
  if (GEOMETRY_EXTENSIONS.includes(ext)) return 'geometry';
  if (DRAWING_EXTENSIONS.includes(ext) || file.type === 'image/svg+xml') return drawingsOffered() ? 'drawing' : 'other';
  if (PICTURE_EXTENSIONS.includes(ext) || /^image\//.test(file.type || '')) return 'picture';
  return 'other';
}

/** A file in the composer: uploading (its progress 0..1), or uploaded (its attachment id). */
export interface AttachedFile {
  /** This chip's own key (two files may share a name). */
  key: string;
  name: string;
  bytes: number;
  kind: 'geometry' | 'drawing';
  state: 'uploading' | 'ready';
  progress: number;
  id: string | null;
}

/**
 * Which of `files` (geometry files and drawings) may be added beside the `have` already there:
 * past the fourth, or over its kind's size (500 MB, a drawing 20 MB), each is refused with its line.
 */
export function checkFiles(have: number, files: readonly File[]): { accepted: File[]; errors: string[] } {
  const accepted: File[] = [];
  const errors: string[] = [];
  for (const f of files) {
    const kind = kindOf(f);
    if (kind !== 'geometry' && kind !== 'drawing') {
      const only = onlyFiles(drawingsOffered());
      if (!errors.includes(only)) errors.push(only);
      continue;
    }
    const drawing = kind === 'drawing';
    if (f.size > (drawing ? FILE_LIMITS.drawingBytes : FILE_LIMITS.bytes)) {
      errors.push(drawing ? drawingTooLarge(f.name) : fileTooLarge(f.name));
      continue;
    }
    if (have + accepted.length >= FILE_LIMITS.count) {
      if (!errors.includes(AT_MOST_FOUR_FILES)) errors.push(AT_MOST_FOUR_FILES);
      continue;
    }
    accepted.push(f);
  }
  return { accepted, errors };
}

/** The browser call uploadFile makes (tests hand in their own). */
export type UploadSend = (file: File, link: string | null, onProgress: (fraction: number) => void, signal: AbortSignal) => Promise<{ status: number; body: Record<string, unknown> }>;

/** XMLHttpRequest: fetch has no upload progress. */
export const xhrSend: UploadSend = (file, link, onProgress, signal) =>
  new Promise((resolve, reject) => {
    const x = new XMLHttpRequest();
    x.open('POST', `${ATTACHMENTS_PATH}?name=${encodeURIComponent(file.name)}`);
    x.setRequestHeader('Content-Type', 'application/octet-stream');
    if (link) x.setRequestHeader('x-magnusim-link', link);
    x.upload.onprogress = (e) => {
      if (e.lengthComputable && e.total > 0) onProgress(Math.min(1, e.loaded / e.total));
    };
    x.onload = () => {
      let body: Record<string, unknown> = {};
      try {
        body = JSON.parse(x.responseText || '{}') as Record<string, unknown>;
      } catch {
        body = {};
      }
      resolve({ status: x.status, body });
    };
    x.onerror = () => resolve({ status: 0, body: {} });
    x.onabort = () => reject(new DOMException('Aborted', 'AbortError'));
    signal.addEventListener('abort', () => x.abort(), { once: true });
    x.send(file);
  });

/**
 * Uploads one file from this window: its attachment id, name and size as the server kept them.
 * A refusal throws an AssistantApiError with the server's words (or uploadLost when it didn't
 * answer); a link the server no longer takes is replaced once.
 */
export async function uploadFile(file: File, onProgress: (fraction: number) => void, signal: AbortSignal, send: UploadSend = xhrSend): Promise<{ id: string; name: string; bytes: number }> {
  let avoid: string | null = null;
  for (let attempt = 0; ; attempt += 1) {
    let used: string | null = null;
    const r = await withAssistantLink(async (link) => {
      used = link;
      return send(file, link, onProgress, signal);
    }, avoid);
    const b = r.body;
    if (r.status === 200 && typeof b.attachment_id === 'string') {
      return { id: b.attachment_id, name: typeof b.name === 'string' ? b.name : file.name, bytes: typeof b.bytes === 'number' ? b.bytes : file.size };
    }
    if (r.status === 409 && b.code === 'no_channel' && attempt === 0 && used) {
      avoid = used;
      continue;
    }
    if (r.status === 403 && b.reason === 'remote') throw new RemoteError(403, b, REMOTE_TEXT);
    const text = typeof b.error === 'string' && b.error ? b.error : uploadLost(file.name);
    throw new AssistantApiError(r.status, b, text);
  }
}
