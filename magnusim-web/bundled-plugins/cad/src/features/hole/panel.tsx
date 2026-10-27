// The Hole panel (SOLID's Hole, as SOLIDWORKS' Hole Wizard and Fusion's Hole): round holes drilled
// into one flat face in one step, the Assistant's hole tool on the person's side.
//   Face       one flat face facing along X, Y or Z (a face selected before Hole is taken).
//   Centres    model X, Y, Z of each centre (the coordinate along the face's normal is the
//              face's own); a click on the face adds a centre where it was clicked; Add centre
//              adds a row to type in.
//   Diameter   an expression ("5 mm", "hd"); Depth: Through (the face's body) or Blind (Depth).
//   Name       "" for the next free "Hole N".
// Done runs the hole tool's own plan (every check, before anything changes: the refusal shows
// here) and makes its two features: "<name> sketch" and the cut "<name>", one undo step, editable
// as a sketch and an extrude, the same records the Assistant's hole stores.
// Owner: ASSISTANT (the person's side of hole).
// SPDX-License-Identifier: GPL-3.0-or-later
import { useEffect, useState } from 'react';
import { useServices } from '../../lib/services';
import { useStateStore } from '../../lib/store';
import type { Vec3 } from '../../types/doc';
import type { ToolPanelProps } from '../../types/modules';
import { selectionKey, type SelectionItem } from '../../types/selection';
import { Button, DisabledReason, Field, Hint, PanelChrome, Select } from '../../ui/kit';
import { formatReadout, MM_PER } from '../../ui/kit/format';
import { uiFor } from '../../ui/controller';
import { userSelection } from '../../lib/selection';
import { PickList } from '../p2/PickList';
import { usePicker, useSelectionMirror } from '../p2/pick';
import { itemLabel } from '../measure/words';
import { holeError, makeHoles, planFor, type HoleInput } from './make';
import { kernelLookup } from '../../naming';

const AXES = ['x', 'y', 'z'] as const;
const COS1 = Math.cos(Math.PI / 180);

/** The model axis a normal runs along within 1 degree (0, 1, 2), or null. */
export function normalAxis(n: readonly number[] | null | undefined): 0 | 1 | 2 | null {
  if (!n) return null;
  const l = Math.hypot(n[0], n[1], n[2]) || 1;
  for (const i of [0, 1, 2] as const) if (Math.abs(n[i] / l) >= COS1) return i;
  return null;
}

export interface CentreRow {
  x: string;
  y: string;
  z: string;
}

/** The hole tool's centre rows: the coordinate along the face's normal "" (the face's own). */
export function centreInput(rows: readonly CentreRow[], along: 0 | 1 | 2 | null): HoleInput['centers'] {
  return rows.map((r) => ({ x: along === 0 ? '' : r.x.trim(), y: along === 1 ? '' : r.y.trim(), z: along === 2 ? '' : r.z.trim() }));
}

/** A flat face selected before Hole (its first face), or null. */
function preselected(items: readonly SelectionItem[]): SelectionItem | null {
  return items.find((it) => it.kind === 'face') ?? null;
}

export function HolePanel({ close }: ToolPanelProps) {
  const services = useServices();
  const ui = uiFor(services);
  const units = useStateStore(services.doc.state, (s) => s.doc.units);
  const bodies = useStateStore(services.doc.state, (s) => s.rebuild.bodies);
  const [face, setFace] = useState<{ item: SelectionItem; along: 0 | 1 | 2 | null } | null>(() => {
    const it = preselected(userSelection(services.selection.get()).items);
    return it ? { item: it, along: null } : null;
  });
  const [active, setActive] = useState<'face' | 'centres'>(() => (face ? 'centres' : 'face'));
  const [rows, setRows] = useState<CentreRow[]>([]);
  const [diameter, setDiameter] = useState('5 mm');
  const [depth, setDepth] = useState<'through' | 'blind'>('through');
  const [distance, setDistance] = useState('10 mm');
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  const fmt = (mm: number) => `${formatReadout(Math.round((mm / MM_PER[units.length]) * 1e4) / 1e4)} ${units.length}`;
  const addCentre = (p: Vec3) => setRows((cur) => [...cur, { x: fmt(p[0]), y: fmt(p[1]), z: fmt(p[2]) }]);

  usePicker(services, {
    id: 'hole',
    active: !busy,
    kinds: ['face'],
    onPick(p) {
      setError(null);
      setNote(null);
      if (p.item.kind !== 'face') return;
      const along = normalAxis(p.normal);
      // The first face, or Face active: the face. Then a click on that face adds a centre there.
      if (!face || active === 'face') {
        setFace({ item: p.item, along });
        setRows(face && selectionKey(face.item) === selectionKey(p.item) ? rows : []);
        setActive('centres');
        if (along === null) setNote('That face does not face along X, Y or Z: a hole needs one that does (sketch circles on it and cut them otherwise)');
        return;
      }
      if (selectionKey(p.item) !== selectionKey(face.item)) {
        setNote(`Click on ${itemLabel(face.item, bodies)} to put a centre there, or click Face to take another face`);
        return;
      }
      if (face.along === null && along !== null) setFace({ ...face, along });
      addCentre(p.point);
    },
  });
  useSelectionMirror(services, face ? [face.item] : [], (added) => {
    const f = added.find((it) => it.kind === 'face');
    if (f) {
      setFace({ item: f, along: null });
      setRows([]);
      setActive('centres');
    }
  });

  // The face's own normal (a face taken from the selection, or one whose click gave none): which coordinate is the face's.
  const faceKey = face ? selectionKey(face.item) : '';
  useEffect(() => {
    if (!face || face.along !== null || face.item.kind !== 'face') return;
    const it = face.item;
    const b = services.doc.state.get().rebuild.bodies.find((x) => x.id === it.body);
    if (!b) return;
    let live = true;
    kernelLookup(services.kernel)
      .faces(b.shape, [it.index])
      .then(([t]) => {
        if (!live) return;
        const ax = t?.type === 'plane' ? normalAxis(t.normal ?? null) : null;
        if (ax !== null) setFace((cur) => (cur && selectionKey(cur.item) === selectionKey(it) ? { ...cur, along: ax } : cur));
        else setNote(t?.type === 'plane' ? 'That face does not face along X, Y or Z: a hole needs one that does (sketch circles on it and cut them otherwise)' : 'That face is curved: a hole drills into one flat face');
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [faceKey, face?.along]);

  const along = face?.along ?? null;
  const input = (): HoleInput => ({ name: name.trim(), centers: centreInput(rows, along), diameter: diameter.trim(), depth, distance: depth === 'blind' ? distance.trim() : '' });
  const done = async () => {
    if (!face && !rows.length) {
      close();
      return;
    }
    if (!face) {
      setError('Pick a flat face for the holes');
      return;
    }
    if (!rows.length) {
      setError('Add at least one centre: click on the face, or Add centre');
      return;
    }
    setBusy(true);
    setError(null);
    let plan;
    try {
      plan = await planFor(services, face.item, input());
    } catch (e) {
      setBusy(false);
      setError(holeError(e));
      return;
    }
    // Planned: the panel goes, and the sketch and the cut are made on the person's own paths.
    close();
    try {
      await makeHoles(services, plan);
      if (plan.warnings.length) services.bridge.toast(`${plan.name}: ${plan.warnings.slice(0, 3).join('; ')}`, 'info');
    } catch (e) {
      ui.fail(plan.name, holeError(e));
    }
  };

  const reason = busy ? 'Making the holes' : null;
  const foot = error ? [<DisabledReason key="error">{error}</DisabledReason>] : null;
  const axisName = along === null ? null : AXES[along].toUpperCase();
  return (
    <PanelChrome panel="tool" title="Hole" onDone={() => void done()} doneDisabled={reason} foot={foot}>
      <div data-tool-panel="solid.hole" data-hole-along={axisName ?? ''}>
        <PickList
          field="hole-face"
          label="Face"
          rows={face ? [{ key: selectionKey(face.item), label: itemLabel(face.item, bodies), sub: axisName ? `faces along ${axisName}` : null }] : []}
          active={active === 'face'}
          onActivate={() => setActive('face')}
          onRemove={() => {
            setFace(null);
            setRows([]);
            setActive('face');
          }}
          single
          hint="Click one flat face facing along X, Y or Z"
        />
        <div className={`cad-pick${active === 'centres' ? ' is-active' : ''}`} data-pick-field="hole-centres" data-active={active === 'centres' ? '1' : '0'} onClick={() => face && setActive('centres')}>
          <div className="cad-pick-head">
            <span className="cad-pick-label">Centres ({rows.length})</span>
          </div>
          <table className="cad-p2-table" data-hole-centres="1">
            <tbody>
              {rows.map((r, i) => (
                <tr key={i} data-hole-centre={i}>
                  {AXES.map((a, k) => (
                    <td key={a}>
                      <input
                        type="text"
                        className="mgk-input cad-hole-coord"
                        aria-label={`Centre ${i + 1} ${a.toUpperCase()}`}
                        data-hole-coord={`${i}-${a}`}
                        spellCheck={false}
                        disabled={along === k}
                        placeholder={along === k ? 'on the face' : a.toUpperCase()}
                        value={along === k ? '' : r[a]}
                        onChange={(e) => setRows((cur) => cur.map((x, j) => (j === i ? { ...x, [a]: e.target.value } : x)))}
                      />
                    </td>
                  ))}
                  <td>
                    <button type="button" className="cad-vp-link" aria-label={`Remove centre ${i + 1}`} data-hole-remove={i} onClick={() => setRows((cur) => cur.filter((_, j) => j !== i))}>
                      ×
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <Button variant="link" onClick={() => setRows((cur) => [...cur, { x: '0 mm', y: '0 mm', z: '0 mm' }])} data-hole-add="1">
            + Add centre
          </Button>
          {active === 'centres' && face ? <Hint>Click on the face to put a centre there (model coordinates, {units.length}).</Hint> : null}
        </div>
        {note ? <Hint>{note}</Hint> : null}
        <Field label="Diameter" htmlFor="cad-hole-diameter" field="diameter">
          <input id="cad-hole-diameter" className="mgk-input" type="text" spellCheck={false} value={diameter} data-field="diameter" onChange={(e) => setDiameter(e.target.value)} />
        </Field>
        <Field label="Depth" htmlFor="cad-hole-depth" field="depth">
          <Select
            id="cad-hole-depth"
            label="Depth"
            field="depth"
            value={depth}
            onChange={(v) => setDepth(v as 'through' | 'blind')}
            options={[
              { value: 'through', label: 'Through the body' },
              { value: 'blind', label: 'Blind' },
            ]}
          />
        </Field>
        {depth === 'blind' ? (
          <Field label="Depth distance" htmlFor="cad-hole-distance" field="distance">
            <input id="cad-hole-distance" className="mgk-input" type="text" spellCheck={false} value={distance} data-field="distance" onChange={(e) => setDistance(e.target.value)} />
          </Field>
        ) : null}
        <Field label="Name" htmlFor="cad-hole-name" field="name">
          <input id="cad-hole-name" className="mgk-input" type="text" spellCheck={false} placeholder="Hole N" value={name} data-field="name" onChange={(e) => setName(e.target.value)} />
        </Field>
        <Hint>Done makes the sketch of the circles and the cut: one undo step, edited later as a sketch and an extrude.</Hint>
      </div>
    </PanelChrome>
  );
}
