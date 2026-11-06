// The Hole panel (SOLID's Hole, as SOLIDWORKS' Hole Wizard and Fusion's Hole): round holes drilled
// into one flat face in one step, the Assistant's hole tool on the person's side.
//   Face       one flat face facing along X, Y or Z (a face selected before Hole is taken).
//   Centres    model X, Y, Z of each centre (the coordinate along the face's normal is the
//              face's own); a click on the face adds a centre where it was clicked; Add centre
//              adds a row to type in; From a sketch puts a hole at each of a sketch's points and
//              circle centres, following them when that sketch changes (× goes back to centres).
//   Size       Custom (Diameter, an expression: "5 mm", "hd"), Clearance hole (a bolt size, metric or
//              inch, and a fit: ISO 273 / ASME B18.2.8) or Tapped hole (a metric or UNC/UNF thread:
//              its tap drill, and its thread drawn in the view, or also cut into the wall: Thread
//              Modelled); Depth: Through (the face's body) or Blind (Depth).
//   Type       Simple, Counterbore (diameter, depth) or Countersink (diameter at the face, angle);
//              with a clearance hole, From the screw table fills them (ISO 4762 socket head,
//              DIN 974-1; ISO 10642 countersunk head at 90°);
//   Bottom     a blind hole's: Flat or Drill point (its angle).
//   Name       "" for the next free "Hole N".
// Done runs the hole tool's own plan (every check, before anything changes: the refusal shows
// here) and makes its features: "<name> sketch" and the cut "<name>" (with "<name> counterbore" or
// "<name> countersink" before it, "<name> tip sketch" and "<name> tip" after it, and a modelled
// thread's "<name> thread"), one undo step, editable as sketches, extrudes and a thread, the same
// records the Assistant's hole stores.
// Owner: ASSISTANT (the person's side of hole).
// SPDX-License-Identifier: GPL-3.0-or-later
import { useEffect, useRef, useState } from 'react';
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
import { counterboreFor, countersinkFor, fastener, SIZE_CHOICES, type ClearanceFit } from './sizes';
import { sketchPoints } from '../../assistant/tools/hole';
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
  const pointsFromRef = useRef('');
  const [diameter, setDiameter] = useState('5 mm');
  const [sizing, setSizing] = useState<'custom' | 'clearance' | 'tapped'>('custom');
  const [system, setSystem] = useState<'metric' | 'unified'>('metric');
  const [size, setSize] = useState('M6');
  const [threadMode, setThreadMode] = useState<HoleInput['thread']>('cosmetic');
  const [fit, setFit] = useState<ClearanceFit>('normal');
  const [type, setType] = useState<HoleInput['type']>('simple');
  const [cbDiameter, setCbDiameter] = useState('11 mm');
  const [cbDepth, setCbDepth] = useState('6.5 mm');
  const [csDiameter, setCsDiameter] = useState('12 mm');
  const [csAngle, setCsAngle] = useState('90 deg');
  const [fromTable, setFromTable] = useState(true);
  /** A sketch whose points are the centres (the holes follow them), or "". */
  const [pointsFrom, setPointsFrom] = useState('');
  pointsFromRef.current = pointsFrom;
  const [tip, setTip] = useState<HoleInput['tip']>('flat');
  const [tipAngle, setTipAngle] = useState('118 deg');
  const [depth, setDepth] = useState<'through' | 'blind'>('through');
  const [distance, setDistance] = useState('10 mm');
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  const fmt = (mm: number) => `${formatReadout(Math.round((mm / MM_PER[units.length]) * 1e4) / 1e4)} ${units.length}`;
  // A click adding a centre leaves a sketch's points (read through a ref: the face picker keeps its first callback).
  const addCentre = (p: Vec3) => {
    if (pointsFromRef.current) {
      setPointsFrom('');
      setRows([{ x: fmt(p[0]), y: fmt(p[1]), z: fmt(p[2]) }]);
      return;
    }
    setRows((cur) => [...cur, { x: fmt(p[0]), y: fmt(p[1]), z: fmt(p[2]) }]);
  };

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
  const sized = sizing !== 'custom';
  // A counterbore or countersink from the screw table: its fields go "" (the plan reads the table).
  const tabled = sizing === 'clearance' && fromTable && (type === 'counterbore' ? !!counterboreFor(size) : type === 'countersink' ? !!countersinkFor(size) : false);
  const doc = useStateStore(services.doc.state, (s) => s.doc);
  const sketches = doc.features.filter((f) => f.type === 'sketch' && f.entities.some((e) => e.kind === 'point' || e.kind === 'circle'));
  /** The holes at the points of a sketch (its points and circle centres), following them; the rows give way. */
  const fromSketch = (name: string) => {
    setError(null);
    try {
      const got = sketchPoints(services, name);
      setPointsFrom(got.name);
      setRows(got.points.map((p) => ({ x: fmt(p[0]), y: fmt(p[1]), z: fmt(p[2]) })));
      setNote(`${got.points.length} ${got.points.length === 1 ? 'hole' : 'holes'} at ${got.name}'s points: they follow those points when ${got.name} changes`);
    } catch (e) {
      setError(holeError(e));
    }
  };
  const input = (): HoleInput => ({
    name: name.trim(),
    centers: pointsFrom ? [] : centreInput(rows, along),
    points: pointsFrom,
    diameter: sized ? '' : diameter.trim(),
    size: sized ? size : '',
    fit: sizing === 'clearance' ? fit : sizing === 'tapped' ? 'tapped' : '',
    depth,
    distance: depth === 'blind' ? distance.trim() : '',
    type,
    cb_diameter: type === 'counterbore' && !tabled ? cbDiameter.trim() : '',
    cb_depth: type === 'counterbore' && !tabled ? cbDepth.trim() : '',
    cs_diameter: type === 'countersink' && !tabled ? csDiameter.trim() : '',
    cs_angle: type === 'countersink' && !tabled ? csAngle.trim() : '',
    tip: depth === 'blind' ? tip : 'flat',
    tip_angle: depth === 'blind' && tip === 'drill' ? tipAngle.trim() : '',
    thread: sizing === 'tapped' ? threadMode : 'cosmetic',
  });
  /** The diameter a size gives, in words ("6.6 mm"), or null. */
  const screw = sized ? fastener(size) : null;
  // The size lists: metric sizes; inch sizes (with a clearance hole in the standard's table), or their UNC and UNF threads.
  const sizeOptions = system === 'metric' ? SIZE_CHOICES.metric.map((r) => ({ value: r.value, label: sizing === 'tapped' ? r.tapped : r.label })) : sizing === 'tapped' ? SIZE_CHOICES.unified : SIZE_CHOICES.unifiedClearance;
  const pickSystem = (v: 'metric' | 'unified') => {
    setSystem(v);
    setSize(v === 'metric' ? 'M6' : sizing === 'tapped' ? '1/4-20' : '1/4');
  };
  const pickSizing = (v: 'custom' | 'clearance' | 'tapped') => {
    setSizing(v);
    // An inch size changes form between the lists ("#10" for a clearance hole, "#10-24" for a thread): keep the size.
    if (system !== 'unified') return;
    const now = fastener(size);
    const thread = now ? now.thread.split(' ')[0] : '1/4-20';
    const bolt = now && now.clearance ? now.size : '1/4';
    setSize(v === 'tapped' ? thread : bolt);
  };
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
      const made = await makeHoles(services, plan);
      const notes = [...plan.warnings, ...made.warnings];
      if (notes.length) services.bridge.toast(`${plan.name}: ${notes.slice(0, 3).join('; ')}`, 'info');
    } catch (e) {
      ui.fail(plan.name, holeError(e));
    }
  };

  const reason = busy ? 'Making the holes' : null;
  const textField = (key: string, label: string, value: string, set: (v: string) => void) => (
    <Field label={label} htmlFor={`cad-hole-${key}`} field={key}>
      <input id={`cad-hole-${key}`} className="mgk-input" type="text" spellCheck={false} value={value} data-field={key} onChange={(e) => set(e.target.value)} />
    </Field>
  );
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
            <span className="cad-pick-label">{pointsFrom ? `Centres: ${pointsFrom}'s points (${rows.length})` : `Centres (${rows.length})`}</span>
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
                        disabled={along === k || !!pointsFrom}
                        placeholder={along === k ? 'on the face' : a.toUpperCase()}
                        value={along === k ? '' : r[a]}
                        onChange={(e) => setRows((cur) => cur.map((x, j) => (j === i ? { ...x, [a]: e.target.value } : x)))}
                      />
                    </td>
                  ))}
                  <td>
                    {pointsFrom ? null : (
                      <button type="button" className="cad-vp-link" aria-label={`Remove centre ${i + 1}`} data-hole-remove={i} onClick={() => setRows((cur) => cur.filter((_, j) => j !== i))}>
                        ×
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {pointsFrom ? (
            <Button
              variant="link"
              onClick={() => {
                setPointsFrom('');
                setNote(null);
              }}
              data-hole-own-centres="1"
            >
              Use my own centres instead
            </Button>
          ) : (
            <Button variant="link" onClick={() => setRows((cur) => [...cur, { x: '0 mm', y: '0 mm', z: '0 mm' }])} data-hole-add="1">
              + Add centre
            </Button>
          )}
          {sketches.length ? (
            <Field label="From a sketch" htmlFor="cad-hole-from-sketch" field="from-sketch">
              <Select
                id="cad-hole-from-sketch"
                label="From a sketch"
                field="from-sketch"
                value=""
                onChange={(v) => v && fromSketch(v)}
                options={[{ value: '', label: 'Its points…' }, ...sketches.map((f) => ({ value: f.name, label: f.name }))]}
              />
            </Field>
          ) : null}
          {active === 'centres' && face ? <Hint>Click on the face to put a centre there (model coordinates, {units.length}).</Hint> : null}
        </div>
        {note ? <Hint>{note}</Hint> : null}
        <Field label="Size" htmlFor="cad-hole-sizing" field="sizing">
          <Select
            id="cad-hole-sizing"
            label="Size"
            field="sizing"
            value={sizing}
            onChange={(v) => pickSizing(v as 'custom' | 'clearance' | 'tapped')}
            options={[
              { value: 'custom', label: 'Custom diameter' },
              { value: 'clearance', label: 'Clearance hole for a bolt' },
              { value: 'tapped', label: 'Tapped hole (tap drill)' },
            ]}
          />
        </Field>
        {sized ? (
          <Field label="Standard" htmlFor="cad-hole-system" field="system">
            <Select
              id="cad-hole-system"
              label="Standard"
              field="system"
              value={system}
              onChange={(v) => pickSystem(v as 'metric' | 'unified')}
              options={[
                { value: 'metric', label: 'Metric (ISO)' },
                { value: 'unified', label: 'Inch (UNC / UNF)' },
              ]}
            />
          </Field>
        ) : null}
        {sized ? (
          <Field label={sizing === 'tapped' ? 'Thread' : 'Bolt size'} htmlFor="cad-hole-size" field="size">
            <Select id="cad-hole-size" label={sizing === 'tapped' ? 'Thread' : 'Bolt size'} field="size" value={size} onChange={setSize} options={sizeOptions} />
          </Field>
        ) : null}
        {sizing === 'clearance' ? (
          <Field label="Fit" htmlFor="cad-hole-fit" field="fit">
            <Select
              id="cad-hole-fit"
              label="Fit"
              field="fit"
              value={fit}
              onChange={(v) => setFit(v as ClearanceFit)}
              options={[
                { value: 'close', label: 'Close' },
                { value: 'normal', label: 'Normal' },
                { value: 'loose', label: 'Loose' },
              ]}
            />
          </Field>
        ) : null}
        {sized ? (
          <Hint>
            {!screw
              ? 'No such size'
              : sizing === 'tapped'
                ? `Tap drill ${screw.tap.words} for ${screw.thread}; ${threadMode === 'modelled' ? 'the thread is cut into the wall (and labelled in the view)' : 'the thread is drawn in the view and listed, not modelled'}.`
                : screw.clearance
                  ? `Clearance hole ${screw.clearance[fit].expr} (${screw.system === 'metric' ? 'ISO 273' : 'ASME B18.2.8'}, ${fit} fit).`
                  : `ASME B18.2.8 has no clearance hole for ${screw.size}.`}
          </Hint>
        ) : (
          <Field label="Diameter" htmlFor="cad-hole-diameter" field="diameter">
            <input id="cad-hole-diameter" className="mgk-input" type="text" spellCheck={false} value={diameter} data-field="diameter" onChange={(e) => setDiameter(e.target.value)} />
          </Field>
        )}
        {sizing === 'tapped' ? (
          <Field label="Thread" htmlFor="cad-hole-thread" field="thread">
            <Select
              id="cad-hole-thread"
              label="Thread"
              field="thread"
              value={threadMode}
              onChange={(v) => setThreadMode(v as HoleInput['thread'])}
              options={[
                { value: 'cosmetic', label: 'Cosmetic (drawn and listed)' },
                { value: 'modelled', label: 'Modelled (cut into the wall)' },
              ]}
            />
          </Field>
        ) : null}
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
        {depth === 'blind' ? (
          <Field label="Bottom" htmlFor="cad-hole-tip" field="tip">
            <Select
              id="cad-hole-tip"
              label="Bottom"
              field="tip"
              value={tip}
              onChange={(v) => setTip(v as HoleInput['tip'])}
              options={[
                { value: 'flat', label: 'Flat' },
                { value: 'drill', label: 'Drill point' },
              ]}
            />
          </Field>
        ) : null}
        {depth === 'blind' && tip === 'drill' ? textField('tip-angle', 'Point angle', tipAngle, setTipAngle) : null}
        <Field label="Type" htmlFor="cad-hole-type" field="type">
          <Select
            id="cad-hole-type"
            label="Type"
            field="type"
            value={type}
            onChange={(v) => setType(v as HoleInput['type'])}
            options={[
              { value: 'simple', label: 'Simple' },
              { value: 'counterbore', label: 'Counterbore' },
              { value: 'countersink', label: 'Countersink' },
            ]}
          />
        </Field>
        {sizing === 'clearance' && type !== 'simple' ? (
          <Field label="From the screw table" htmlFor="cad-hole-from-table" field="from-table">
            <input id="cad-hole-from-table" type="checkbox" className="cad-check" data-field="from-table" checked={fromTable} onChange={(e) => setFromTable(e.target.checked)} />
          </Field>
        ) : null}
        {tabled ? (
          <Hint>
            {type === 'counterbore'
              ? `Counterbore ${counterboreFor(size)!.diameter} mm across, ${counterboreFor(size)!.depth} mm deep, for an ${size} socket head cap screw (ISO 4762, DIN 974-1).`
              : `Countersink ${countersinkFor(size)!.diameter} mm across at 90°, for an ${size} countersunk head screw (ISO 10642).`}
          </Hint>
        ) : null}
        {sizing === 'clearance' && fromTable && type !== 'simple' && !tabled ? <Hint>{system === 'unified' ? 'The screw tables are metric: give the sizes.' : `The screw table has no ${size}: give the sizes.`}</Hint> : null}
        {type === 'counterbore' && !tabled ? textField('cb-diameter', 'Counterbore diameter', cbDiameter, setCbDiameter) : null}
        {type === 'counterbore' && !tabled ? textField('cb-depth', 'Counterbore depth', cbDepth, setCbDepth) : null}
        {type === 'countersink' && !tabled ? textField('cs-diameter', 'Countersink diameter', csDiameter, setCsDiameter) : null}
        {type === 'countersink' && !tabled ? textField('cs-angle', 'Countersink angle', csAngle, setCsAngle) : null}
        <Field label="Name" htmlFor="cad-hole-name" field="name">
          <input id="cad-hole-name" className="mgk-input" type="text" spellCheck={false} placeholder="Hole N" value={name} data-field="name" onChange={(e) => setName(e.target.value)} />
        </Field>
        <Hint>Done makes the sketch of the circles and the cuts: one undo step, edited later as sketches and extrudes.</Hint>
      </div>
    </PanelChrome>
  );
}
