// Export STEP (proposal §2.13, §4.10): the bodies to export (the selected
// ones, or every shown one, to start with), AP214 (default) or AP242, with
// body names and colours, in mm, handed to the browser as a download. A tool
// panel: nothing is saved or undoable.
// Owner: P2-FEATURES.
// SPDX-License-Identifier: GPL-3.0-or-later
import { useState } from 'react';
import { useServices } from '../../lib/services';
import { useStateStore } from '../../lib/store';
import type { BodyId } from '../../types/doc';
import type { ToolPanelProps } from '../../types/modules';
import { Button, DisabledReason, EmptyState, Field, Hint, PanelChrome, Select } from '../../ui/kit';
import { LARGE_OP_TIMEOUT_MS, timeoutFor } from '../../kernel/timeouts';
import { selectedBodies } from '../../ui/tree/model';
import { filesFor } from '../../files/transfer';
import { formatBytes } from '../../files/words';
import { withStepHeader } from './header';

export type StepSchema = 'AP214' | 'AP242';

/** sRGB 0..1 from "#rrggbb", or undefined. */
export function rgbOf(hex: string): [number, number, number] | undefined {
  const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
  if (!m) return undefined;
  return [parseInt(m[1], 16) / 255, parseInt(m[2], 16) / 255, parseInt(m[3], 16) / 255];
}

/** A file name for the download: the typed name (or the Part's), ending in .step, without characters a file name cannot hold. */
export function stepFileName(typed: string, fallback: string): string {
  const base = (typed.trim() || fallback.trim() || 'Part').replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').replace(/\.(step|stp)$/i, '');
  return `${base || 'Part'}.step`;
}

export function ExportPanel({ close }: ToolPanelProps) {
  const services = useServices();
  const bodies = useStateStore(services.doc.state, (s) => s.rebuild.bodies);
  const title = String(services.bridge.context.study?.title ?? 'Part');
  const [chosen, setChosen] = useState<Set<BodyId>>(() => {
    const sel = selectedBodies(services.selection.get());
    const built = services.doc.state.get().rebuild.bodies;
    const picked = built.filter((b) => sel.has(b.id)).map((b) => b.id);
    return new Set(picked.length ? picked : built.filter((b) => b.visible).map((b) => b.id));
  });
  const [schema, setSchema] = useState<StepSchema>('AP214');
  const [name, setName] = useState(`${title}.step`);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const list = bodies.filter((b) => chosen.has(b.id));
  const invalid = list.filter((b) => !b.valid);

  const run = async () => {
    setBusy(true);
    setError(null);
    setDone(null);
    const file = stepFileName(name, title);
    try {
      const faces = list.reduce((n, b) => n + b.faces, 0);
      const timeoutMs = faces > 2000 ? Math.max(LARGE_OP_TIMEOUT_MS, timeoutFor('export_step')) : undefined;
      const r = await services.kernel.call('export_step', { shapes: list.map((b) => ({ id: b.shape, name: b.name, ...(rgbOf(b.color) ? { color: rgbOf(b.color)! } : {}) })), schema }, timeoutMs ? { timeoutMs } : {});
      const written = r.buffers.step;
      if (!written || !written.byteLength) throw new Error('the kernel wrote an empty file');
      // The header names the file and leaves the author blank (the kernel writes OCCT's defaults).
      const raw = new Uint8Array(written);
      const named = withStepHeader(raw, file);
      if (!named) console.warn('[cad] export: the STEP header is not the one the kernel writes; handed out as written');
      const bytes = named ?? raw;
      filesFor(services).download(new Blob([bytes as Uint8Array<ArrayBuffer>], { type: 'model/step' }), file, 'model/step');
      setDone(`${file} · ${formatBytes(bytes.byteLength)} · ${list.length === 1 ? '1 body' : `${list.length} bodies`}`);
      services.bridge.toast(`Exported ${file}`, 'success');
    } catch (err) {
      setError(`Export failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setBusy(false);
    }
  };

  const reason = busy ? 'Exporting now' : !list.length ? 'Pick at least one body' : null;
  const foot = [];
  if (error) foot.push(<DisabledReason key="error">{error}</DisabledReason>);
  return (
    <PanelChrome panel="tool" title="Export STEP" onDone={close} foot={foot.length ? foot : null}>
      <div data-tool-panel="file.export-step">
        <div className="cad-field-group">
          <div className="cad-field-group-title">Bodies</div>
          {bodies.length ? (
            bodies.map((b) => (
              <label key={b.id} className="cad-switch-row cad-export-body" data-export-body={b.id}>
                <input
                  type="checkbox"
                  checked={chosen.has(b.id)}
                  aria-label={b.name}
                  onChange={(e) =>
                    setChosen((cur) => {
                      const next = new Set(cur);
                      if (e.target.checked) next.add(b.id);
                      else next.delete(b.id);
                      return next;
                    })
                  }
                />
                <span className="cad-swatch" style={{ background: b.color }} aria-hidden="true" />
                <span>{b.name}</span>
                {!b.visible ? <span className="cad-p2-sub">hidden</span> : null}
              </label>
            ))
          ) : (
            <EmptyState>No bodies yet</EmptyState>
          )}
        </div>
        <Field label="Format" htmlFor="cad-export-schema" field="schema">
          <Select id="cad-export-schema" label="Format" field="schema" value={schema} onChange={(v) => setSchema(v as StepSchema)} options={[{ value: 'AP214', label: 'STEP AP214' }, { value: 'AP242', label: 'STEP AP242' }]} />
        </Field>
        <Field label="File name" htmlFor="cad-export-name" field="file-name">
          <input id="cad-export-name" className="mgk-input cad-p2-name-input" type="text" spellCheck={false} value={name} onChange={(e) => setName(e.target.value)} data-field="file-name" />
        </Field>
        {invalid.length ? (
          <div className="cad-p2-warn" data-export-invalid="1">
            {invalid.map((b) => b.name).join(', ')} {invalid.length === 1 ? 'is' : 'are'} not a valid solid: other programs may not read {invalid.length === 1 ? 'it' : 'them'}
          </div>
        ) : null}
        <div className="cad-p2-actions">
          <Button variant="primary" data-export-run="1" disabledReason={reason} onClick={() => void run()}>
            {busy ? 'Exporting…' : 'Export'}
          </Button>
          {done ? (
            <span className="cad-p2-sub" data-export-done="1">
              Exported {done}
            </span>
          ) : null}
        </div>
        <Hint>Names and colours go with the bodies; lengths are written in mm.</Hint>
      </div>
    </PanelChrome>
  );
}
