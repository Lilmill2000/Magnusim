// Check (proposal §2.11): BRepCheck of the selected bodies (or every shown
// body), each "Valid" or its problems by kind with where they are. Runs again
// after every rebuild. A tool panel: nothing is saved or undoable.
// Owner: P2-FEATURES.
// SPDX-License-Identifier: GPL-3.0-or-later
import { useEffect, useState } from 'react';
import { useServices } from '../../lib/services';
import { useStateStore } from '../../lib/store';
import type { BodyId } from '../../types/doc';
import type { KernelResult } from '../../types/kernel-protocol';
import type { ToolPanelProps } from '../../types/modules';
import { Button, DisabledReason, Hint, PanelChrome } from '../../ui/kit';
import { timeoutForFaces } from '../../kernel/timeouts';
import { selectedBodies } from '../../ui/tree/model';

type CheckOut = KernelResult<'check'>;

/** "NotClosed ×1, UnorientableShape ×2" (most first). */
export function countsWords(counts: Record<string, number> | undefined): string {
  if (!counts) return '';
  return Object.entries(counts)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([k, n]) => `${k} ×${n}`)
    .join(', ');
}

function problemCount(r: CheckOut): string {
  const n = r.problem_total ?? r.problems?.length ?? 0;
  return n === 1 ? '1 problem' : `${n} problems`;
}

export function CheckPanel({ close }: ToolPanelProps) {
  const services = useServices();
  const bodies = useStateStore(services.doc.state, (s) => s.rebuild.bodies);
  const sel = useStateStore(services.selection);
  const picked = selectedBodies(sel);
  const chosen = bodies.filter((b) => picked.has(b.id));
  const list = chosen.length ? chosen : bodies.filter((b) => b.visible);
  const key = list.map((b) => `${b.id}|${b.tessKey}`).join(',');
  const [out, setOut] = useState<Record<BodyId, CheckOut>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [again, setAgain] = useState(0);

  useEffect(() => {
    let live = true;
    setOut({});
    setError(null);
    setBusy(true);
    void (async () => {
      const res: Record<BodyId, CheckOut> = {};
      try {
        for (const b of list) {
          const timeoutMs = timeoutForFaces('check', b.faces);
          res[b.id] = (await services.kernel.call('check', { id: b.shape, max_problems: 40 }, timeoutMs ? { timeoutMs } : {})).result;
          if (!live) return;
          setOut({ ...res });
        }
      } catch (err) {
        if (live) setError(`Check failed: ${err instanceof Error ? err.message : String(err)}`);
      } finally {
        if (live) setBusy(false);
      }
    })();
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [services, key, again]);

  const bad = list.filter((b) => out[b.id] && !out[b.id].valid).length;
  const foot = error ? [<DisabledReason key="error">{error}</DisabledReason>] : null;
  return (
    <PanelChrome panel="tool" title="Check" onDone={close} foot={foot}>
      <div data-tool-panel="inspect.check">
        <div className="cad-p2-sub" data-check-summary="1">
          {!list.length ? 'No body is shown' : busy ? `Checking ${list.length === 1 ? list[0].name : `${list.length} bodies`}…` : bad ? `${bad} of ${list.length} ${list.length === 1 ? 'body is' : 'bodies are'} not valid` : list.length === 1 ? `${list[0].name} is valid` : `All ${list.length} bodies are valid`}
        </div>
        <table className="cad-p2-table" data-check-bodies="1">
          <tbody>
            {list.map((b) => {
              const r = out[b.id];
              return (
                <tr key={b.id} data-check-body={b.id} data-valid={r ? (r.valid ? '1' : '0') : undefined}>
                  <td>{b.name}</td>
                  <td className={r ? (r.valid ? 'cad-p2-ok' : 'cad-p2-bad') : ''} data-check-state={b.id}>
                    {!r ? 'Checking…' : r.valid ? 'Valid' : `${problemCount(r)}: ${countsWords(r.problem_counts)}`}
                    {r && !r.valid && r.problems?.length ? (
                      <ul className="cad-p2-problems">
                        {r.problems.map((p, i) => (
                          <li key={i}>
                            {p.status} · {p.type} {p.index + 1}
                            {p.in ? ` of ${p.in.type} ${p.in.index + 1}` : ''}
                          </li>
                        ))}
                      </ul>
                    ) : null}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        <div className="cad-p2-actions">
          <Button variant="secondary" data-check-again="1" disabledReason={busy ? 'Checking now' : null} onClick={() => setAgain((n) => n + 1)}>
            Check again
          </Button>
        </div>
        <Hint>The geometry kernel's own check (BRepCheck): open shells, bad orientation, self-intersections, tolerance gaps.</Hint>
      </div>
    </PanelChrome>
  );
}
