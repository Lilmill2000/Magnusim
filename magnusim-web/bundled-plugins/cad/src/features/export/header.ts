// The exported STEP file's header. The kernel's writer fills FILE_NAME with
// OCCT's defaults ('Open CASCADE Shape Model', author 'Author', organization
// 'Open CASCADE', authorization 'Unknown'); the file Magnusim CAD hands out
// names itself (the file name chosen in the panel), leaves the author,
// organization and authorization blank, and says which system made it. The
// preprocessor (OCCT's STEP writer) and the time stamp stay as written.
// Review P2/P3 round 3: "Part 3.step" said 'Open CASCADE Shape Model' and 'Author'.
// Owner: P2-FEATURES.
// SPDX-License-Identifier: GPL-3.0-or-later

/** The system named in FILE_NAME's originating_system. */
export const ORIGINATING_SYSTEM = 'Magnusim CAD';

/** A STEP string literal (ISO 10303-21 §6.4.3): ' doubled, \ doubled, characters outside printable ASCII as \X2\hhhh\X0\. */
export function stepString(text: string): string {
  let out = '';
  let wide = '';
  const flush = () => {
    if (wide) out += `\\X2\\${wide}\\X0\\`;
    wide = '';
  };
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code < 0x20 || code > 0x7e) {
      wide += code.toString(16).toUpperCase().padStart(4, '0');
      continue;
    }
    flush();
    const ch = text[i];
    out += ch === "'" ? "''" : ch === '\\' ? '\\\\' : ch;
  }
  flush();
  return `'${out}'`;
}

/** FILE_NAME's parameters as written (raw text of each, top level), and where the statement starts and ends. */
function fileNameParams(head: string): { start: number; end: number; params: string[] } | null {
  const h = head.indexOf('HEADER;');
  const at = head.indexOf('FILE_NAME', h < 0 ? 0 : h);
  if (h < 0 || at < 0) return null;
  let i = head.indexOf('(', at);
  if (i < 0) return null;
  const params: string[] = [];
  let depth = 0;
  let cur = '';
  for (i += 1; i < head.length; i++) {
    const ch = head[i];
    if (ch === "'") {
      // A string, '' inside it is one quote.
      let j = i + 1;
      for (; j < head.length; j++) {
        if (head[j] === "'") {
          if (head[j + 1] === "'") j++;
          else break;
        }
      }
      if (j >= head.length) return null;
      cur += head.slice(i, j + 1);
      i = j;
      continue;
    }
    if (ch === '(') depth++;
    if (ch === ')') {
      if (depth === 0) {
        params.push(cur.trim());
        let k = i + 1;
        while (k < head.length && /\s/.test(head[k])) k++;
        if (head[k] !== ';') return null;
        return { start: at, end: k + 1, params };
      }
      depth--;
    }
    if (ch === ',' && depth === 0) {
      params.push(cur.trim());
      cur = '';
      continue;
    }
    if (ch !== '\r' && ch !== '\n') cur += ch;
  }
  return null;
}

/**
 * The STEP file with its FILE_NAME rewritten: name = `fileName`, author and
 * organization (''), originating system ORIGINATING_SYSTEM, authorization ''.
 * Only the header's bytes change; null when the header is not the shape the
 * kernel writes (the file is then handed out as written).
 */
export function withStepHeader(bytes: Uint8Array, fileName: string): Uint8Array | null {
  const scan = Math.min(bytes.length, 16384);
  let head = '';
  for (let i = 0; i < scan; i++) head += String.fromCharCode(bytes[i]);
  const end = head.indexOf('ENDSEC;');
  if (end < 0) return null;
  const found = fileNameParams(head.slice(0, end));
  if (!found || found.params.length !== 7) return null;
  const [, stamp, , , preprocessor] = found.params;
  const statement = `FILE_NAME(${stepString(fileName)},${stamp},(''),(''),${preprocessor},${stepString(ORIGINATING_SYSTEM)},'');`;
  const before = head.slice(0, found.start);
  const out = new Uint8Array(before.length + statement.length + (bytes.length - found.end));
  for (let i = 0; i < before.length; i++) out[i] = before.charCodeAt(i);
  for (let i = 0; i < statement.length; i++) out[before.length + i] = statement.charCodeAt(i);
  out.set(bytes.subarray(found.end), before.length + statement.length);
  return out;
}
