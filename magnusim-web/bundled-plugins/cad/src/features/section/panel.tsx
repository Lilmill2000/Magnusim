// INSPECT > Section view: the panel over the view's one section state (bind.ts setSectionView):
//   Cut the view   on or off (the command turns it on as it opens the panel; off keeps the panel).
//   Plane          which plane the cut is parallel to, by its name ("Front plane", "Plane 1", "End
//                  face of Extrude 1 on Body 1"): a click on a construction plane or a flat face in the
//                  view, a plane's row in the tree, or Top, Front, Right. A new plane cuts at the
//                  plane itself (offset 0) for a construction plane, through the middle of the shown
//                  bodies for an origin plane or a face (a cut at a face would show nothing new).
//   Offset         along the plane's own normal (mm in the Part's units; parameters and expressions
//                  as any length field takes them); Middle; Keep the other side.
//   The arrow      on the cut in the view while the panel is open (handle.ts): a drag moves the cut,
//                  and Offset shows it as it goes.
// What it says under them is where the cut is now and what it keeps, and the module's note (the
// plane was deleted, it is not built now).
// Owner: VIEWPORT (the section view's plane).
// SPDX-License-Identifier: GPL-3.0-or-later
import { useEffect, useState } from 'react';
import { useServices } from '../../lib/services';
import { createStateStore, useStateStore } from '../../lib/store';
import type { OriginPlaneRef } from '../../types/doc';
import type { ToolPanelProps } from '../../types/modules';
import type { PlaneRef } from '../../types/references';
import type { SectionState } from '../../types/viewport';
import { Button, DisabledReason, Field, Hint, NumberUnitInput, PanelChrome } from '../../ui/kit';
import { derivedLength, formatQuantity } from '../../ui/kit/format';
import { snapLengthWords } from '../move_body/handle-math';
import { Switch } from '../p2/panel';
import { useSelectionMirror } from '../p2/pick';
import { useRefField } from '../refgeom/fields';
import { sectionStart } from '../../viewport/ViewportChrome';
import { originFrame } from '../../viewport/section';
import { sectionNotes, setSectionView } from './bind';
import { startSectionArrow } from './handle';
import { axisIndexOf, cutPoint, keepsWords, sectionPlaneWords } from './plane';

const ORIGINS: { plane: OriginPlaneRef; label: string }[] = [
  { plane: 'origin:top', label: 'Top' },
  { plane: 'origin:front', label: 'Front' },
  { plane: 'origin:right', label: 'Right' },
];

const NO_SECTION = createStateStore<{ section: SectionState | null }>({ section: null });

export function SectionPanel({ close }: ToolPanelProps) {
  const services = useServices();
  const handle = useStateStore(services.viewport, (v) => v.handle);
  const section = useStateStore(handle?.state ?? NO_SECTION, (s) => s.section);
  const units = useStateStore(services.doc.state, (s) => s.doc.units);
  const words = useStateStore(services.doc.state, (s) => (section ? sectionPlaneWords(s, section.plane) : ''));
  const note = useStateStore(sectionNotes(services), (n) => n.note);
  const [error, setError] = useState<string | null>(null);

  // The arrow on the cut while the panel is open (none in a panel the Assistant fills: it never opens this one).
  useEffect(() => {
    if (!handle) return;
    return startSectionArrow(services, handle);
  }, [services, handle]);

  const apply = (c: Parameters<typeof setSectionView>[1]) => {
    setError(null);
    void setSectionView(services, c).then((r) => {
      if (!r.ok) setError(r.reason);
    });
  };
  /** A new plane: at the plane itself for a construction plane, through the middle of the shown bodies otherwise (on a round step). */
  const pickPlane = (plane: PlaneRef) => {
    if (plane.kind === 'feature') return apply({ plane, offset: 0 });
    if (plane.kind === 'origin' && handle) return apply({ plane, offset: sectionStart(handle.sectionRange(originFrame(plane.plane))) });
    return apply({ plane, offset: 'middle' });
  };

  const field = useRefField(services, {
    feature: '',
    accept: 'plane',
    refs: section ? [section.plane] : [],
    max: 1,
    active: true,
    onChange: (refs) => {
      const p = refs[0] as PlaneRef | undefined;
      // The row's ×: no plane, no cut.
      if (!p) apply({ on: false });
      else pickPlane(p);
    },
  });
  useSelectionMirror(services, field.highlight, (picked) => void field.take(picked));

  if (!handle || !section) {
    return (
      <PanelChrome panel="tool" title="Section view" onDone={close}>
        <div data-tool-panel="inspect.section">
          <Hint>The view is not shown now.</Hint>
        </div>
      </PanelChrome>
    );
  }
  const u = (mm: number) => formatQuantity(mm, 'length', units).replace(/^-/, '−');
  const at = cutPoint(section.frame, section.offset);
  const k = axisIndexOf(section.frame.normal);
  const keeps = keepsWords(section.frame, section.offset, section.flip, u);
  const where = k >= 0 ? `Cuts at ${'xyz'[k]} = ${u(at[k])}; keeps ${keeps}` : `Cuts through (${at.map(u).join(', ')}); keeps ${keeps}`;
  const foot = error ? [<DisabledReason key="error">{error}</DisabledReason>] : null;
  return (
    <PanelChrome panel="tool" title="Section view" onDone={close} foot={foot}>
      <div data-tool-panel="inspect.section">
        <div className="cad-field" data-section-control="on">
          <Switch field="section-on" label="Cut the view" checked={section.on} onChange={(on) => apply({ on, ...(on ? { offset: section.offset } : {}) })} />
        </div>
        <div data-section-control="plane" data-section-plane={words}>
          {field.element('Plane', 'section-plane', () => {}, 'Click a construction plane or a flat face in the view, or a plane in the tree')}
        </div>
        <div className="cad-construct-origin" data-section-control="origin">
          <span className="cad-construct-origin-label">Or the origin's:</span>
          {ORIGINS.map((o) => (
            <Button key={o.plane} variant="link" data-section-origin={o.plane} aria-pressed={section.plane.kind === 'origin' && section.plane.plane === o.plane} onClick={() => pickPlane({ kind: 'origin', plane: o.plane })}>
              {o.label}
            </Button>
          ))}
        </div>
        <Field label="Offset" htmlFor="cad-section-offset" field="section-offset">
          <NumberUnitInput
            id="cad-section-offset"
            field="section-offset"
            label="Offset"
            expr={derivedLength(section.offset, units)}
            quantity="length"
            units={services.doc.units}
            onCommit={(_e, value) => apply({ offset: value })}
          />
        </Field>
        <div className="cad-construct-origin" data-section-control="middle">
          <Button variant="link" data-section-middle-panel="1" onClick={() => apply({ offset: 'middle' })}>
            Middle
          </Button>
          <span className="cad-construct-origin-label">through the middle of the shown bodies</span>
        </div>
        <div className="cad-field" data-section-control="flip">
          <Switch field="section-flip" label="Keep the other side" checked={section.flip} onChange={(flip) => apply({ flip })} />
        </div>
        {section.on ? (
          <div data-section-where="1">
            <Hint>{where}</Hint>
          </div>
        ) : null}
        <div data-section-control="arrow" data-section-drag="1">
          <Hint>{section.on ? `Or drag the arrow on the cut in the view (Ctrl: steps of ${snapLengthWords(units.length)}).` : 'The view is not cut: turn it on, or pick a plane.'}</Hint>
        </div>
        {note ? (
          <div data-section-note="1">
            <Hint>{note}</Hint>
          </div>
        ) : null}
      </div>
    </PanelChrome>
  );
}
