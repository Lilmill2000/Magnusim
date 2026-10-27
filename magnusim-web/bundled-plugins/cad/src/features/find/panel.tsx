// The Find panel: a query in the Assistant's selector language (help selectors), run by the code
// the find tool runs (selectors/resolve.ts selectAny, find's rows). Enter or Find lists what it
// matches (each row: its handle, its words, its type and size); a row's click selects it (Ctrl
// adds it), Select all selects every match, and hovering a row lights it in the view. A query that
// does not read says where it stops, as the find tool's bad_selector does.
// Owner: ASSISTANT (the person's side of find).
// SPDX-License-Identifier: GPL-3.0-or-later
import { useEffect, useRef, useState } from 'react';
import { useServices } from '../../lib/services';
import { useStateStore } from '../../lib/store';
import type { AppServices } from '../../types/app';
import type { ToolPanelProps } from '../../types/modules';
import type { SelectionItem } from '../../types/selection';
import { Button, DisabledReason, Hint, PanelChrome } from '../../ui/kit';
import { formatArea } from '../measure/words';
import { formatQuantity } from '../../ui/kit/format';
import { personCall } from '../../assistant/person-call';
import { selectAny, withScene } from '../../assistant/selectors/resolve';
import { rowOf, type FindRow } from '../../assistant/tools/find';
import { itemsOfHit } from '../../assistant/tools/workspace';

/** The most rows the panel lists (Select all still takes every match). */
export const FIND_ROWS_MAX = 200;

export interface FindResult {
  query: string;
  count: number;
  kind: string;
  rows: (FindRow & { items: SelectionItem[] })[];
  /** Every match as selection items (Select all). */
  items: SelectionItem[];
  live: boolean;
}

/** The words of a refusal of the selector code, without its reason prefix ("bad_selector: ..."). */
export function findError(e: unknown): string {
  const m = e instanceof Error ? e.message : String(e);
  const hint = e && typeof e === 'object' && 'hint' in e && typeof (e as { hint: unknown }).hint === 'string' ? (e as { hint: string }).hint : '';
  const text = m.replace(/^[a-z_]+: /, '');
  return hint && !text.includes(hint) ? `${text} ${hint}` : text;
}

/** Run `query` on the Part as it is now, as the find tool does. */
export async function runFind(services: AppServices, query: string): Promise<FindResult> {
  const ctx = personCall(services, 'find', { query, limit: FIND_ROWS_MAX });
  await services.doc.settled();
  return withScene(ctx, {}, async (sc) => {
    const r = await selectAny(sc, query);
    const rows: FindResult['rows'] = [];
    for (const h of r.hits.slice(0, FIND_ROWS_MAX)) rows.push({ ...(await rowOf(sc, h, r.text)), items: itemsOfHit(h) });
    const items = r.hits.flatMap(itemsOfHit);
    return { query, count: r.hits.length, kind: r.kind, rows, items, live: !!r.live };
  });
}

const EXAMPLES = ['Body 1 faces >Z', 'largest', 'Body 1 faces hole', 'edges of Extrude 1.end', 'face at (0, 0, 10)', 'bodies', 'Sketch 1 regions'];

export function FindPanel({ close }: ToolPanelProps) {
  const services = useServices();
  const units = useStateStore(services.doc.state, (s) => s.doc.units);
  const seq = useStateStore(services.doc.state, (s) => s.rebuild.seq);
  const [text, setText] = useState('');
  const [asked, setAsked] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const [result, setResult] = useState<FindResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const handle = useStateStore(services.viewport, (s) => s.handle);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    input.current?.focus({ preventScroll: true });
  }, []);

  // The query runs again after a rebuild (the matches follow the Part).
  useEffect(() => {
    if (!asked) return;
    let live = true;
    setBusy(true);
    runFind(services, asked).then(
      (r) => {
        if (!live) return;
        setResult(r);
        setError(null);
        setBusy(false);
      },
      (e: unknown) => {
        if (!live) return;
        setResult(null);
        setError(findError(e));
        setBusy(false);
      },
    );
    return () => {
      live = false;
    };
  }, [services, asked, seq, tick]);

  useEffect(() => () => handle?.flash([]), [handle]);

  const run = () => {
    const q = text.trim();
    if (!q) {
      setError('Enter a query, for example Body 1 faces >Z');
      return;
    }
    setAsked(q);
    // The same query again runs again.
    setTick((t) => t + 1);
  };
  const select = (items: SelectionItem[], add: boolean) => {
    const sel = services.selection;
    if (!add) sel.set((s) => ({ ...s, items: [...items] }));
    else {
      const have = new Set(sel.get().items.map((it) => JSON.stringify(it)));
      sel.set((s) => ({ ...s, items: [...s.items, ...items.filter((it) => !have.has(JSON.stringify(it)))] }));
    }
  };
  const size = (r: FindRow): string => {
    const u = units;
    if (typeof r.area_mm2 === 'number') return formatArea(r.area_mm2, u);
    if (typeof r.length_mm === 'number') return formatQuantity(r.length_mm, 'length', u);
    return '';
  };
  const what = result ? (result.kind === 'mixed' ? 'things' : result.count === 1 ? result.kind : result.kind === 'vertex' ? 'vertices' : result.kind === 'body' ? 'bodies' : `${result.kind}s`) : '';
  const foot = error ? [<DisabledReason key="error">{error}</DisabledReason>] : null;
  return (
    <PanelChrome panel="tool" title="Find" onDone={close} foot={foot}>
      <div data-tool-panel="inspect.find">
        <div className="cad-measure-point">
          <input
            ref={input}
            type="text"
            className="mgk-input"
            aria-label="Find query"
            placeholder="Body 1 faces >Z"
            spellCheck={false}
            autoComplete="off"
            data-find-query="1"
            value={text}
            onChange={(e) => {
              setText(e.target.value);
              setError(null);
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                run();
              }
            }}
          />
          <Button variant="primary" onClick={run} data-find-run="1">
            Find
          </Button>
        </div>
        {busy ? <Hint>Finding…</Hint> : null}
        {result ? (
          <>
            <div className="cad-p2-sub" data-find-count={result.count}>
              {result.count} {what} match {result.query}
              {result.rows.length < result.count ? ` (the first ${result.rows.length} listed)` : ''}
            </div>
            <Button variant="secondary" onClick={() => select(result.items, false)} data-find-select-all="1">
              Select all ({result.items.length})
            </Button>
            <table className="cad-p2-table" data-find-rows="1">
              <tbody>
                {result.rows.map((r) => (
                  <tr
                    key={`${r.handle}|${r.words}`}
                    className="cad-find-row"
                    data-find-row={r.handle}
                    data-find-kind={r.kind}
                    onClick={(e) => select(r.items, e.ctrlKey || e.metaKey)}
                    onMouseEnter={() => handle?.flash(r.items)}
                    onMouseLeave={() => handle?.flash([])}
                  >
                    <td>{r.handle}</td>
                    <td>{r.label ?? r.words}</td>
                    <td>{r.type ?? r.kind}</td>
                    <td className="num">{size(r)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {result.live ? <Hint>These are all the edges of the faces named: a fillet or chamfer given this query follows them as the part changes.</Hint> : null}
          </>
        ) : null}
        <Hint>
          The Assistant's selectors: {EXAMPLES.map((x, i) => (
            <span key={x}>
              {i ? ', ' : ''}
              <button type="button" className="cad-vp-link" data-find-example={x} onClick={() => setText(x)}>
                {x}
              </button>
            </span>
          ))}
          . Click a row to select it (Ctrl adds it).
        </Hint>
      </div>
    </PanelChrome>
  );
}
