/**
 * The model's words in the dock (phase 4 spec 2.5): a safe subset of Markdown, built as React
 * elements and never as HTML. Paragraphs (a blank line), `-`/`*`/`1.` lists, fenced code
 * blocks, inline `code` and **bold**. Nothing else: no links (a URL stays text; the model's
 * words can carry text from the person's files), no images, no raw HTML (it shows as typed).
 *
 * While its step streams the block says so (`aria-busy`) and ends with a caret that blinks
 * unless the person asked for reduced motion (style.css).
 */
import type { ReactNode } from 'react';

export type Block =
  | { kind: 'p'; lines: string[] }
  | { kind: 'ul'; items: string[] }
  | { kind: 'ol'; items: string[]; start: number }
  | { kind: 'code'; text: string };

const FENCE = /^\s*```/;
const BULLET = /^\s*[-*]\s+(.*)$/;
const NUMBERED = /^\s*(\d{1,9})[.)]\s+(.*)$/;

/** The text's blocks. An unclosed fence (still streaming) runs to the end. */
export function parseBlocks(text: string): Block[] {
  const lines = String(text ?? '').replace(/\r\n?/g, '\n').split('\n');
  const out: Block[] = [];
  let para: string[] = [];
  let list: { kind: 'ul' | 'ol'; items: string[]; start: number } | null = null;
  const endPara = () => {
    if (para.length) out.push({ kind: 'p', lines: para });
    para = [];
  };
  const endList = () => {
    if (list) out.push(list.kind === 'ul' ? { kind: 'ul', items: list.items } : { kind: 'ol', items: list.items, start: list.start });
    list = null;
  };
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (FENCE.test(line)) {
      endPara();
      endList();
      const body: string[] = [];
      i += 1;
      while (i < lines.length && !FENCE.test(lines[i])) {
        body.push(lines[i]);
        i += 1;
      }
      out.push({ kind: 'code', text: body.join('\n') });
      continue;
    }
    if (!line.trim()) {
      endPara();
      endList();
      continue;
    }
    const b = BULLET.exec(line);
    const n = b ? null : NUMBERED.exec(line);
    if (b || n) {
      endPara();
      const kind = b ? 'ul' : 'ol';
      if (list && list.kind !== kind) endList();
      if (!list) list = { kind, items: [], start: n ? Number(n[1]) : 1 };
      list.items.push(b ? b[1] : (n as RegExpExecArray)[2]);
      continue;
    }
    if (list) {
      // A line that follows a list item without a blank line carries it on.
      const items = (list as { items: string[] }).items;
      items[items.length - 1] = `${items[items.length - 1]}\n${line.trim()}`;
      continue;
    }
    para.push(line);
  }
  endPara();
  endList();
  return out;
}

/** `code` and **bold** in one line of text, as elements (everything else stays text). */
export function inline(text: string, key = 'i'): ReactNode[] {
  const out: ReactNode[] = [];
  const re = /(`[^`\n]+`)|(\*\*[^*\n]+\*\*)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let n = 0;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index));
    if (m[1]) out.push(<code key={`${key}c${n}`}>{m[1].slice(1, -1)}</code>);
    else out.push(<strong key={`${key}b${n}`}>{m[2].slice(2, -2)}</strong>);
    n += 1;
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

function lines(list: string[], key: string): ReactNode[] {
  const out: ReactNode[] = [];
  list.forEach((l, i) => {
    if (i) out.push(<br key={`${key}br${i}`} />);
    out.push(...inline(l, `${key}l${i}`));
  });
  return out;
}

const caret = (
  <span className="dock-caret" aria-hidden="true">
    ▍
  </span>
);

export function ModelText({ text, streaming = false }: { text: string; streaming?: boolean }) {
  const blocks = parseBlocks(text);
  const last = blocks.length - 1;
  // The caret ends the text where it streams: in its last paragraph or list item, else after it.
  const caretInside = streaming && last >= 0 && blocks[last].kind !== 'code';
  return (
    <div className="dock-model-text" data-dock-text="1" aria-busy={streaming ? 'true' : undefined}>
      {blocks.map((b, i) => {
        const key = `b${i}`;
        if (b.kind === 'code') {
          return (
            <pre key={key} className="dock-code">
              <code>{b.text}</code>
            </pre>
          );
        }
        if (b.kind === 'ul') {
          return (
            <ul key={key}>
              {b.items.map((it, j) => (
                <li key={j}>
                  {lines(it.split('\n'), `${key}i${j}`)}
                  {caretInside && i === last && j === b.items.length - 1 ? caret : null}
                </li>
              ))}
            </ul>
          );
        }
        if (b.kind === 'ol') {
          return (
            <ol key={key} start={b.start}>
              {b.items.map((it, j) => (
                <li key={j}>
                  {lines(it.split('\n'), `${key}i${j}`)}
                  {caretInside && i === last && j === b.items.length - 1 ? caret : null}
                </li>
              ))}
            </ol>
          );
        }
        return (
          <p key={key}>
            {lines(b.lines, key)}
            {caretInside && i === last ? caret : null}
          </p>
        );
      })}
      {streaming && !caretInside ? caret : null}
    </div>
  );
}
