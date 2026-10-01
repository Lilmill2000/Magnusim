// The viewport's own chrome, bottom-right like the core's gizmo cluster
// (shell.html:654-670, style.css:1392-1450): Fit (home) button, XYZ key and
// the triad slot, plus the CAD view tools before them: selection filter,
// section view and the views menu (standard views, Normal to, projection,
// display). Every control here works; nothing is shown that does not.
// Owner: VIEWPORT.
// SPDX-License-Identifier: GPL-3.0-or-later
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { setSelectionFilter } from '../lib/selection';
import { useServices } from '../lib/services';
import { useStateStore } from '../lib/store';
import { ORIGIN_PLANES, type OriginPlaneRef } from '../types/doc';
import type { SelectKind } from '../types/selection';
import type { DisplayMode, PlanesMode, Projection, StandardView, ViewportHandle } from '../types/viewport';
import { normalToTarget, VIEW_COMMANDS } from './commands';

const ICON = {
  home: ['M4 11.2L12 4.5l8 6.7', 'M6.4 10.2V19.5h11.2V10.2', 'M10 19.5v-5.2h4v5.2'],
  views: ['M12 3.2l7.6 4.3v9L12 20.8l-7.6-4.3v-9z', 'M12 12l7.6-4.5', 'M12 12v8.8', 'M12 12L4.4 7.5'],
  section: ['M12 3.2l7.6 4.3v9L12 20.8l-7.6-4.3v-9z', 'M3 15.5l18-7'],
  filter: ['M4 5h16l-6.2 7.4V19l-3.6 1.6v-8.2z'],
};

function Svg({ paths }: { paths: string[] }) {
  return (
    <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" focusable="false">
      <g fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
        {paths.map((d) => (
          <path key={d} d={d} />
        ))}
      </g>
    </svg>
  );
}

/** A popover above the cluster that closes on an outside click or Escape. */
function Popover({ open, onClose, label, children, id }: { open: boolean; onClose: () => void; label: string; children: ReactNode; id: string }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const down = (e: PointerEvent) => {
      const el = ref.current;
      const t = e.target as Node | null;
      if (el && t && !el.contains(t) && !(t as HTMLElement).closest?.(`[data-vp-opens="${id}"]`)) onClose();
    };
    const key = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      // The popover is the topmost layer: this Escape closes it and nothing
      // under it (review round 2: it also closed the open feature panel).
      e.preventDefault();
      e.stopPropagation();
      onClose();
    };
    document.addEventListener('pointerdown', down, true);
    document.addEventListener('keydown', key, true);
    return () => {
      document.removeEventListener('pointerdown', down, true);
      document.removeEventListener('keydown', key, true);
    };
  }, [open, onClose, id]);
  if (!open) return null;
  return (
    <div ref={ref} className="cad-vp-pop" role="dialog" aria-label={label} data-vp-pop={id}>
      {children}
    </div>
  );
}

function Seg<T extends string>({ value, options, onChange, name }: { value: T; options: { value: T; label: string }[]; onChange: (v: T) => void; name: string }) {
  return (
    <div className="cad-vp-seg" role="radiogroup" aria-label={name} data-vp-seg={name}>
      {options.map((o) => (
        <button key={o.value} type="button" role="radio" aria-checked={value === o.value} className={value === o.value ? 'is-on' : ''} onClick={() => onChange(o.value)} data-value={o.value}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

const FILTERS: { kind: SelectKind; label: string }[] = [
  { kind: 'face', label: 'Faces' },
  { kind: 'edge', label: 'Edges' },
  { kind: 'vertex', label: 'Vertices' },
  { kind: 'body', label: 'Bodies' },
  { kind: 'origin', label: 'Planes' },
];

const PLANES: { value: OriginPlaneRef; label: string }[] = [
  { value: 'origin:top', label: 'Top' },
  { value: 'origin:front', label: 'Front' },
  { value: 'origin:right', label: 'Right' },
];

function fmt(n: number): string {
  return String(Math.round(n * 1000) / 1000 || 0);
}

/** A round slider step (1, 2 or 5 times a power of ten) giving about 400 stops over `span`. */
export function sliderStep(span: number): number {
  const raw = Math.max(span / 400, 1e-4);
  const p = 10 ** Math.floor(Math.log10(raw));
  return [1, 2, 5, 10].map((m) => m * p).find((x) => x >= raw - 1e-12) ?? raw;
}

/** Where a new cut starts: the middle of the part, on a round step ("Y 10 mm", not "Y 5.008 mm"). */
export function sectionStart(range: readonly [number, number] | null): number {
  if (!range) return 0;
  const step = sliderStep(Math.abs(range[1] - range[0]));
  const mid = (range[0] + range[1]) / 2;
  return Math.round(mid / step) * step || 0;
}

/**
 * The cut's position shown as the coordinate it fixes (Front plane: y, Top: z,
 * Right: x) rather than the signed offset along the plane's normal (Front's
 * normal is -Y): "Y 10 mm" where the cut is at y = 10.
 */
export function sectionAxis(plane: OriginPlaneRef): { label: string; sign: number } {
  const n = ORIGIN_PLANES[plane].normal;
  const i = n.findIndex((v) => v !== 0);
  return { label: 'XYZ'[i], sign: Math.sign(n[i]) };
}

export function ViewportChrome({ handle }: { handle: ViewportHandle }) {
  const services = useServices();
  const [open, setOpen] = useState<'filter' | 'section' | 'views' | null>(null);
  const vs = useStateStore(handle.state, (s) => ({ projection: s.projection, display: s.display, section: s.section, planes: s.planes }));
  const filter = useStateStore(services.selection, (s) => s.filter);
  const items = useStateStore(services.selection, (s) => s.items);
  const section = vs.section;
  const close = () => setOpen(null);
  const toggle = (which: 'filter' | 'views') => setOpen((o) => (o === which ? null : which));

  const range = open === 'section' && section ? handle.sectionRange(section.plane) : null;
  const axis = section ? sectionAxis(section.plane) : { label: 'Y', sign: 1 };
  const coordRange = range ? ([Math.min(range[0] * axis.sign, range[1] * axis.sign), Math.max(range[0] * axis.sign, range[1] * axis.sign)] as const) : null;
  const normalTo = open === 'views' ? normalToTarget({ items }, handle) : null;

  const setFilterKind = (kind: SelectKind) => {
    const next = filter.includes(kind) ? filter.filter((k) => k !== kind) : [...filter, kind];
    setSelectionFilter(services.selection, FILTERS.map((f) => f.kind).filter((k) => next.includes(k)));
  };

  const toggleSection = () => {
    if (section?.on) {
      handle.setSection({ on: false });
      setOpen(null);
      return;
    }
    const plane = section?.plane ?? 'origin:front';
    handle.setSection({ on: true, plane, offset: sectionStart(handle.sectionRange(plane)) });
    setOpen('section');
  };

  const setPlane = (plane: OriginPlaneRef) => {
    handle.setSection({ plane, offset: sectionStart(handle.sectionRange(plane)) });
  };

  const view = (v: StandardView) => {
    handle.setView(v);
    close();
  };

  return (
    <div className="cad-vp-gizmo" data-cad-gizmo="1">
      <div className="cad-vp-gizmo-row">
        <div className="cad-vp-tool">
          <button
            type="button"
            className={`cad-vp-btn${filter.length ? ' is-on' : ''}`}
            title={filter.length ? `Selection filter: ${FILTERS.filter((f) => filter.includes(f.kind)).map((f) => f.label).join(', ')}` : 'Selection filter'}
            aria-label="Selection filter"
            aria-expanded={open === 'filter'}
            data-vp-opens="filter"
            onClick={() => toggle('filter')}
          >
            <Svg paths={ICON.filter} />
          </button>
          <Popover open={open === 'filter'} onClose={close} label="Selection filter" id="filter">
            <div className="cad-vp-pop-title">Select</div>
            <div className="cad-vp-chips">
              {FILTERS.map((f) => (
                <button key={f.kind} type="button" className={`cad-vp-chip${filter.includes(f.kind) ? ' is-on' : ''}`} aria-pressed={filter.includes(f.kind)} data-filter={f.kind} onClick={() => setFilterKind(f.kind)}>
                  {f.label}
                </button>
              ))}
            </div>
            <div className="cad-vp-pop-hint">{filter.length ? 'Only these can be picked in the viewport.' : 'Faces, edges, vertices and planes can be picked.'}</div>
            {filter.length ? (
              <button type="button" className="cad-vp-link" data-filter-clear="1" onClick={() => setSelectionFilter(services.selection, [])}>
                Pick anything
              </button>
            ) : null}
          </Popover>
        </div>
        <div className="cad-vp-tool">
          <button
            type="button"
            className={`cad-vp-btn${section?.on ? ' is-on' : ''}`}
            title={section?.on ? 'Turn off the section view' : 'Section view'}
            aria-label="Section view"
            aria-pressed={!!section?.on}
            data-vp-opens="section"
            onClick={toggleSection}
          >
            <Svg paths={ICON.section} />
          </button>
          <Popover open={open === 'section' && !!section?.on} onClose={close} label="Section view" id="section">
            <div className="cad-vp-pop-title">Section view</div>
            {section ? (
              <>
                <Seg name="Section plane" value={section.plane} options={PLANES} onChange={setPlane} />
                <label className="cad-vp-row">
                  <span>Cut at</span>
                  <input
                    type="range"
                    min={coordRange ? coordRange[0] : -100}
                    max={coordRange ? coordRange[1] : 100}
                    step={coordRange ? sliderStep(coordRange[1] - coordRange[0]) : 0.5}
                    value={section.offset * axis.sign}
                    aria-label={`Section position along ${axis.label}`}
                    data-section-offset="1"
                    onChange={(e) => handle.setSection({ offset: Number(e.target.value) * axis.sign })}
                  />
                  <span className="cad-vp-num" data-section-value="1">
                    {axis.label} {fmt(section.offset * axis.sign)} mm
                  </span>
                </label>
                <div className="cad-vp-row">
                  <button type="button" className="cad-vp-small" data-section-flip="1" onClick={() => handle.setSection({ flip: !section.flip })}>
                    Flip side
                  </button>
                </div>
              </>
            ) : null}
          </Popover>
        </div>
        <div className="cad-vp-tool">
          <button type="button" className="cad-vp-btn" title="Views" aria-label="Views" aria-expanded={open === 'views'} data-vp-opens="views" onClick={() => toggle('views')}>
            <Svg paths={ICON.views} />
          </button>
          <Popover open={open === 'views'} onClose={close} label="Views" id="views">
            {VIEW_COMMANDS.map((c) => (
              <button key={c.view} type="button" className="cad-vp-item" data-view={c.view} onClick={() => view(c.view)}>
                <span>{c.label}</span>
                <kbd>{c.shortcut}</kbd>
              </button>
            ))}
            <div className="cad-vp-sep" />
            <button
              type="button"
              className="cad-vp-item"
              data-view="normal-to"
              disabled={!normalTo || 'reason' in normalTo}
              title={normalTo && 'reason' in normalTo ? normalTo.reason : undefined}
              onClick={() => {
                if (normalTo && !('reason' in normalTo)) handle.lookAt(normalTo.normal, normalTo.up);
                close();
              }}
            >
              <span>Normal to</span>
              <kbd>N</kbd>
            </button>
            {normalTo && 'reason' in normalTo ? <div className="cad-vp-pop-hint">{normalTo.reason}</div> : null}
            <div className="cad-vp-sep" />
            <div className="cad-vp-pop-title">Projection</div>
            <Seg<Projection>
              name="Projection"
              value={vs.projection}
              options={[
                { value: 'perspective', label: 'Perspective' },
                { value: 'orthographic', label: 'Orthographic' },
              ]}
              onChange={(p) => handle.setProjection(p)}
            />
            <div className="cad-vp-pop-title">Display</div>
            <Seg<DisplayMode>
              name="Display"
              value={vs.display}
              options={[
                { value: 'shaded-edges', label: 'Shaded + edges' },
                { value: 'shaded', label: 'Shaded' },
                { value: 'wireframe', label: 'Wireframe' },
              ]}
              onChange={(d) => handle.setDisplay(d)}
            />
            <div className="cad-vp-pop-title">Origin planes</div>
            <Seg<PlanesMode>
              name="Origin planes"
              value={vs.planes}
              options={[
                { value: 'auto', label: 'Auto' },
                { value: 'always', label: 'Always' },
              ]}
              onChange={(m) => handle.setPlanes(m)}
            />
            <div className="cad-vp-pop-hint">{vs.planes === 'always' ? 'Top, Front and Right are always drawn.' : 'Drawn on an empty part, and while one is selected or hovered.'}</div>
          </Popover>
        </div>
        <button type="button" className="cad-vp-btn" title="Fit model to viewport" aria-label="Fit model to viewport" data-vp-fit="1" onClick={() => handle.setView('home')}>
          <Svg paths={ICON.home} />
        </button>
        <div className="cad-vp-axes-key" title="Axis colours of the triad">
          <span className="ax ax-x">X</span>
          <span className="ax ax-y">Y</span>
          <span className="ax ax-z">Z</span>
        </div>
      </div>
      <div className="cad-vp-triad-slot" data-triad-slot="1" aria-hidden="true" />
    </div>
  );
}
