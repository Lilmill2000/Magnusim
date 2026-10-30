// A drawing file's bytes as a Drawing (common.ts): refused past 20 MiB (the host's drawing cap)
// and when it is a binary DXF; told apart by its name (.svg, .dxf), else by its first bytes; the
// text decoded (UTF-8, or UTF-16 with its byte-order mark), then svg.ts or dxf.ts reads it. Both
// the person's Import SVG/DXF and the Assistant's import row start here.
// SPDX-License-Identifier: GPL-3.0-or-later
import { DRAWING_MAX_BYTES, DrawingRefused, type Drawing } from './common';
import { readDxf } from './dxf';
import { readSvg } from './svg';

export { DRAWING_MAX_BYTES, DrawingRefused, IMPORT_MAX_LOAD, importIntoDraft, planImport, previewSegments, summaryWords, type Drawing, type ImportOptions, type ImportPlan, type ImportSummary } from './common';

/** The file picker's accept list. */
export const DRAWING_ACCEPT = ['.svg', '.dxf'];

const BINARY_DXF = 'AutoCAD Binary DXF';

/** Why a file past the cap is refused. */
export const tooLarge = (name: string) => `${name} is larger than 20 MB, the most a drawing can be`;

/** The text of a drawing's bytes. */
function textOf(bytes: Uint8Array): string {
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder('utf-16le').decode(bytes.subarray(2));
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder('utf-16be').decode(bytes.subarray(2));
  const t = new TextDecoder('utf-8').decode(bytes);
  return t.charCodeAt(0) === 0xfeff ? t.slice(1) : t;
}

/** Read a drawing file (name and bytes): an SVG or an ASCII DXF, or DrawingRefused saying why not. */
export function readDrawing(name: string, data: Uint8Array | ArrayBuffer): Drawing {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  if (bytes.byteLength > DRAWING_MAX_BYTES) throw new DrawingRefused(tooLarge(name));
  if (!bytes.byteLength) throw new DrawingRefused(`${name} is empty`);
  const head = String.fromCharCode(...bytes.subarray(0, Math.min(64, bytes.byteLength)));
  if (head.startsWith(BINARY_DXF)) throw new DrawingRefused(`${name} is a binary DXF: save it as an ASCII DXF (R12 or later) and import that`);
  const ext = /\.([a-z0-9]+)$/i.exec(name)?.[1]?.toLowerCase() ?? '';
  const text = textOf(bytes);
  const lead = text.replace(/^\s+/, '').slice(0, 1);
  const kind = ext === 'svg' || ext === 'dxf' ? ext : lead === '<' ? 'svg' : /^\s*(0|999)\s*$/m.test(text.slice(0, 200)) ? 'dxf' : null;
  if (!kind) throw new DrawingRefused(`${name} is not an SVG or a DXF drawing`);
  return kind === 'svg' ? readSvg(name, text) : readDxf(name, text);
}

/** A drawing read, or the reason it cannot be, in words. */
export function tryReadDrawing(name: string, data: Uint8Array | ArrayBuffer): { drawing: Drawing } | { refused: string } {
  try {
    return { drawing: readDrawing(name, data) };
  } catch (err) {
    if (err instanceof DrawingRefused) return { refused: err.message };
    return { refused: `${name} could not be read: ${err instanceof Error ? err.message : String(err)}` };
  }
}
