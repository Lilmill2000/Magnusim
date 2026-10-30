// The Picture panel: the view tool's input as fields (directions, bodies left out, section on
// Top, Front, Right, a construction plane or the selected flat face, labels, size, display,
// projection), drawn by the code the view tool runs (assistant/view.ts
// takeView) on the person's own handle table, so a face label (#f3) is one the Find panel reads.
// Take picture draws it; Save PNG keeps it. The person's view never moves.
// Owner: ASSISTANT (the person's side of view).
// SPDX-License-Identifier: GPL-3.0-or-later
import { useEffect, useState } from 'react';
import { useServices } from '../../lib/services';
import { useStateStore } from '../../lib/store';
import type { AppServices } from '../../types/app';
import type { ToolPanelProps } from '../../types/modules';
import { Button, DisabledReason, Field, Hint, PanelChrome, Select } from '../../ui/kit';
import { personCall } from '../../assistant/person-call';
import { VIEW_DIRECTIONS } from '../../assistant/schemas';
import { takeView } from '../../assistant/view';
import { findError } from '../find/panel';

export type PictureView = (typeof VIEW_DIRECTIONS)[number];

export const VIEW_WORDS: Readonly<Record<PictureView, string>> = {
  iso: 'Isometric',
  iso_back: 'Back isometric',
  front: 'Front',
  back: 'Back',
  left: 'Left',
  right: 'Right',
  top: 'Top',
  bottom: 'Bottom',
};

export interface PictureChoice {
  views: PictureView[];
  hide: string[];
  /** plane: '' (none), Top, Front, Right, a construction plane's name, or 'selection' (the flat face or plane the person selected). */
  section: { plane: string; at: 'offset' | 'middle'; offset: string; flip: boolean };
  labels: 'none' | 'bodies' | 'faces';
  size: 'small' | 'large';
  display: 'shaded_edges' | 'shaded' | 'wireframe';
  projection: 'orthographic' | 'perspective';
}

/** The view tool's input for the panel's choice (the same fields the Assistant sends). */
export function viewInput(c: PictureChoice): Record<string, unknown> {
  const s = c.section;
  const section = s.plane ? [s.plane, s.at === 'middle' ? 'middle' : s.offset.trim() ? `offset ${s.offset.trim()}` : '', s.flip ? 'flip' : ''].filter(Boolean).join(' ') : '';
  return { views: c.views, hide: c.hide, section, labels: c.labels, size: c.size, display: c.display, projection: c.projection, sketch: '' };
}

export interface Picture {
  url: string;
  blob: Blob;
  type: string;
  text: string;
  labels: { handle: string; words: string }[];
}

/** Draw the picture as the view tool does. */
export async function takePicture(services: AppServices, c: PictureChoice): Promise<Picture> {
  const ctx = personCall(services, 'view', viewInput(c));
  const r = await takeView(ctx);
  const img = r.images?.[0];
  if (!img) throw new Error('No picture was drawn');
  const labels = Array.isArray(r.data.labels) ? (r.data.labels as { handle: string; words: string }[]) : [];
  return { url: URL.createObjectURL(img.data), blob: img.data, type: img.mediaType, text: r.text, labels };
}

const DEFAULT: PictureChoice = {
  views: ['iso'],
  hide: [],
  section: { plane: '', at: 'offset', offset: '', flip: false },
  labels: 'none',
  size: 'small',
  display: 'shaded_edges',
  projection: 'orthographic',
};

export function PicturePanel({ close }: ToolPanelProps) {
  const services = useServices();
  const bodies = useStateStore(services.doc.state, (s) => s.rebuild.bodies);
  // The construction planes, as the view tool's section names them.
  const planes = useStateStore(services.doc.state, (s) => s.doc.features.filter((f) => f.type === 'ref_plane').map((f) => f.name).join('|'));
  const [c, setC] = useState<PictureChoice>(DEFAULT);
  const [pic, setPic] = useState<Picture | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => () => {
    if (pic) URL.revokeObjectURL(pic.url);
  }, [pic]);

  const set = (patch: Partial<PictureChoice>) => {
    setC((cur) => ({ ...cur, ...patch }));
    setError(null);
  };
  const toggleView = (v: PictureView, on: boolean) => {
    const views = on ? [...c.views.filter((x) => x !== v), v] : c.views.filter((x) => x !== v);
    set({ views: VIEW_DIRECTIONS.filter((x) => views.includes(x)) });
  };
  const take = () => {
    setBusy(true);
    setError(null);
    takePicture(services, c).then(
      (p) => {
        setPic(p);
        setBusy(false);
      },
      (e: unknown) => {
        setError(findError(e));
        setBusy(false);
      },
    );
  };
  const reason = busy ? 'Drawing the picture' : !c.views.length ? 'Pick at least one direction' : c.views.length > 4 ? 'At most 4 directions on one picture' : null;
  const foot = error ? [<DisabledReason key="error">{error}</DisabledReason>] : null;
  const ext = pic?.type === 'image/jpeg' ? 'jpg' : 'png';
  return (
    <PanelChrome panel="tool" title="Picture" onDone={close} foot={foot}>
      <div data-tool-panel="file.picture">
        <div className="cad-field-group">
          <div className="cad-field-group-title">Directions (1 to 4)</div>
          {VIEW_DIRECTIONS.map((v) => (
            <label key={v} className="cad-switch-row" data-picture-view={v}>
              <input type="checkbox" checked={c.views.includes(v)} aria-label={VIEW_WORDS[v]} onChange={(e) => toggleView(v, e.target.checked)} />
              <span>{VIEW_WORDS[v]}</span>
            </label>
          ))}
        </div>
        <Field label="Labels" htmlFor="cad-picture-labels" field="labels">
          <Select
            id="cad-picture-labels"
            label="Labels"
            field="labels"
            value={c.labels}
            onChange={(v) => set({ labels: v as PictureChoice['labels'] })}
            options={[
              { value: 'none', label: 'None' },
              { value: 'bodies', label: 'Body names' },
              { value: 'faces', label: 'Face labels' },
            ]}
          />
        </Field>
        <Field label="Size" htmlFor="cad-picture-size" field="size">
          <Select
            id="cad-picture-size"
            label="Size"
            field="size"
            value={c.size}
            onChange={(v) => set({ size: v as PictureChoice['size'] })}
            options={[
              { value: 'small', label: 'Small (768 px)' },
              { value: 'large', label: 'Large (1280 px)' },
            ]}
          />
        </Field>
        <Field label="Display" htmlFor="cad-picture-display" field="display">
          <Select
            id="cad-picture-display"
            label="Display"
            field="display"
            value={c.display}
            onChange={(v) => set({ display: v as PictureChoice['display'] })}
            options={[
              { value: 'shaded_edges', label: 'Shaded + edges' },
              { value: 'shaded', label: 'Shaded' },
              { value: 'wireframe', label: 'Wireframe' },
            ]}
          />
        </Field>
        <Field label="Projection" htmlFor="cad-picture-projection" field="projection">
          <Select
            id="cad-picture-projection"
            label="Projection"
            field="projection"
            value={c.projection}
            onChange={(v) => set({ projection: v as PictureChoice['projection'] })}
            options={[
              { value: 'orthographic', label: 'Orthographic' },
              { value: 'perspective', label: 'Perspective' },
            ]}
          />
        </Field>
        <Field label="Section" htmlFor="cad-picture-section" field="section">
          <Select
            id="cad-picture-section"
            label="Section"
            field="section"
            value={c.section.plane}
            onChange={(v) => set({ section: { ...c.section, plane: v } })}
            options={[
              { value: '', label: 'None' },
              { value: 'Top', label: 'Top plane' },
              { value: 'Front', label: 'Front plane' },
              { value: 'Right', label: 'Right plane' },
              ...(planes ? planes.split('|').map((n) => ({ value: n, label: n })) : []),
              { value: 'selection', label: 'The selected flat face or plane' },
            ]}
          />
        </Field>
        {c.section.plane ? (
          <>
            <Field label="Cut at" htmlFor="cad-picture-at" field="section-at">
              <Select
                id="cad-picture-at"
                label="Cut at"
                field="section-at"
                value={c.section.at}
                onChange={(v) => set({ section: { ...c.section, at: v as 'offset' | 'middle' } })}
                options={[
                  { value: 'offset', label: 'An offset' },
                  { value: 'middle', label: 'The middle of the shown bodies' },
                ]}
              />
            </Field>
            {c.section.at === 'offset' ? (
              <Field label="Offset" htmlFor="cad-picture-offset" field="section-offset">
                <input
                  id="cad-picture-offset"
                  className="mgk-input"
                  type="text"
                  spellCheck={false}
                  placeholder="0 mm"
                  value={c.section.offset}
                  data-field="section-offset"
                  onChange={(e) => set({ section: { ...c.section, offset: e.target.value } })}
                />
              </Field>
            ) : null}
            <label className="cad-switch-row" data-picture-flip="1">
              <input type="checkbox" checked={c.section.flip} aria-label="Keep the other side" onChange={(e) => set({ section: { ...c.section, flip: e.target.checked } })} />
              <span>Keep the other side</span>
            </label>
          </>
        ) : null}
        {bodies.length ? (
          <div className="cad-field-group">
            <div className="cad-field-group-title">Leave out</div>
            {bodies.map((b) => (
              <label key={b.id} className="cad-switch-row" data-picture-hide={b.id}>
                <input
                  type="checkbox"
                  checked={c.hide.includes(b.name)}
                  aria-label={`Leave out ${b.name}`}
                  onChange={(e) => set({ hide: e.target.checked ? [...c.hide, b.name] : c.hide.filter((n) => n !== b.name) })}
                />
                <span className="cad-swatch" style={{ background: b.color }} aria-hidden="true" />
                <span>{b.name}</span>
              </label>
            ))}
          </div>
        ) : null}
        <div className="cad-measure-point">
          <Button variant="primary" onClick={take} disabledReason={reason} data-picture-take="1">
            Take picture
          </Button>
          {pic ? (
            <a className="mgk-btn mgk-btn--secondary" href={pic.url} download={`Part picture.${ext}`} data-picture-save="1">
              Save {ext.toUpperCase()}
            </a>
          ) : null}
        </div>
        {busy ? <Hint>Drawing…</Hint> : null}
        {pic ? (
          <>
            <img className="cad-picture" src={pic.url} alt={pic.text} data-picture-image="1" data-picture-text={pic.text} />
            <Hint>{pic.text}</Hint>
            {pic.labels.length ? (
              <table className="cad-p2-table" data-picture-labels="1">
                <tbody>
                  {pic.labels.map((l) => (
                    <tr key={l.handle} data-picture-label={l.handle}>
                      <td>{l.handle}</td>
                      <td>{l.words}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : null}
          </>
        ) : (
          <Hint>Your own view does not move: the picture is drawn off screen.</Hint>
        )}
      </div>
    </PanelChrome>
  );
}
