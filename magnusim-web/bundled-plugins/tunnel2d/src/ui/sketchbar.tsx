// The sketch toolbar, over the view while a sketch body is being edited: the drawing tools,
// relations on the selection, construction, delete, the sketch's status (how defined it is,
// whether its outline is closed) and Done; and the box a dimension's value is typed in.
// SPDX-License-Identifier: GPL-3.0-or-later
import { Button, Icon, Select } from '@magnusim/plugin-ui';
import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { profileOf } from '../geometry/shapes';
import { RELATION_LABELS, SKETCH_ICONS } from '../sketch/cad';
import { RELATIONS, TOOL_LABELS, type SketchEditor, type SketchTool } from '../sketch/editor';

const TOOL_ICONS: Record<SketchTool, string> = {
  select: 'M6 3l12 9-5.5 1L15 19l-2.5 1.2-2.6-6L6 17z',
  line: SKETCH_ICONS.line,
  rectangle: SKETCH_ICONS.rectangle,
  circle: SKETCH_ICONS.circle,
  arc: SKETCH_ICONS.arc,
  spline: 'M4 17c3-9 6-9 8-5s5 4 8-5 M4 17h0 M20 7h0',
  point: SKETCH_ICONS.point,
  fillet: 'M5 20V12a7 7 0 0 1 7-7h7 M5 20h0 M19 5h0',
  dimension: SKETCH_ICONS.dimension,
};

const TOOL_HELP: Record<SketchTool, string> = {
  select: 'Click a point, curve or dimension; Shift adds to the selection. Drag a point to move it; double-click a dimension to change it.',
  line: 'Click point after point; back on the first point closes the outline. Double-click or Enter ends the chain.',
  rectangle: 'Click two opposite corners.',
  circle: 'Click the centre, then a point on the circle.',
  arc: 'Click the start, the end, then a point the arc passes through.',
  spline: 'Click the points it passes through; double-click or Enter finishes.',
  point: 'Click to place a point.',
  fillet: 'Click a corner where two lines meet to round it.',
  dimension: 'Pick a line, circle or arc (or two points or lines), then click where the dimension goes.',
};

export function useEditor(editor: SketchEditor): number {
  return useSyncExternalStore(
    (fn) => editor.subscribe(fn),
    () => editor.version,
  );
}

export function SketchBar({ editor }: { editor: SketchEditor }) {
  useEditor(editor);
  if (!editor.editing) return null;
  const st = editor.status?.state ?? 'unsolved';
  const words = editor.statusWords();
  // Drawn on, but no closed outline yet: not in the flow (red, as an over-defined sketch).
  const open = !editor.busy && editor.sketch.entities.length > 0 && !profileOf(editor.sketch).rings.length;
  return (
    <div className="t2d-sketchbar" role="toolbar" aria-label="Sketch" data-t2d-sketchbar>
      <div className="t2d-sketchbar-row">
        <span className="t2d-sketchbar-title">{editor.body?.name ?? 'Sketch'}</span>
        {(Object.keys(TOOL_LABELS) as SketchTool[]).map((t) => (
          <button
            key={t}
            type="button"
            className={`t2d-tool${editor.tool === t ? ' is-on' : ''}`}
            aria-pressed={editor.tool === t}
            aria-label={TOOL_LABELS[t]}
            title={`${TOOL_LABELS[t]}: ${TOOL_HELP[t]}`}
            data-t2d-tool={t}
            onClick={() => editor.setTool(t)}
          >
            <Icon path={TOOL_ICONS[t]} size={18} />
          </button>
        ))}
        <span className="t2d-sep" />
        <Select
          label="Add relation"
          value=""
          options={[{ value: '', label: 'Relation…' }, ...RELATIONS.map((k) => ({ value: k, label: RELATION_LABELS[k] }))]}
          onChange={(v) => v && editor.applyRelation(v as (typeof RELATIONS)[number])}
        />
        <Button variant="neutral" disabled={!editor.selection.length} onClick={() => editor.toggleConstruction()} title="Construction geometry guides the outline but is not part of the body" attrs={{ 'data-t2d-sketch-construction': '1' }}>
          Construction
        </Button>
        <Button variant="neutral" disabled={!editor.selection.length} onClick={() => editor.deleteSelection()} title="Delete" attrs={{ 'data-t2d-sketch-delete': '1' }}>
          Delete
        </Button>
        <span className="t2d-sep" />
        <Button variant="primary" onClick={() => editor.close()} title="Esc" attrs={{ 'data-t2d-sketch-done': '1' }}>
          Done
        </Button>
      </div>
      <div className="t2d-sketchbar-row t2d-sketchbar-status">
        <span className={`t2d-sketch-chip t2d-sketch-chip--${open ? 'open' : st}`} data-t2d-sketch-status={open ? 'open' : st}>
          {words}
        </span>
        <span className="t2d-sketch-help">{TOOL_HELP[editor.tool]}</span>
      </div>
      {editor.message ? (
        <div className="t2d-sketch-message" role="status" data-t2d-sketch-message>
          {editor.message}
        </div>
      ) : null}
    </div>
  );
}

/** The value box over a dimension's label (double-click a dimension). Enter applies, Escape cancels. */
export function DimensionInput({ editor }: { editor: SketchEditor }) {
  useEditor(editor);
  const d = editor.editingDim;
  if (!d || !editor.editing) return null;
  return <DimensionBox key={`${d.id}:${d.x}:${d.y}`} editor={editor} d={d} />;
}

function DimensionBox({ editor, d }: { editor: SketchEditor; d: NonNullable<SketchEditor['editingDim']> }) {
  const [text, setText] = useState(d.text);
  const [error, setError] = useState('');
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    input.current?.focus();
    input.current?.select();
  }, []);
  const cancel = () => editor.cancelDimensionEdit();
  return (
    <div className="t2d-dim-edit" style={{ left: d.x, top: d.y }} data-t2d-dim-edit={d.id}>
      <input
        ref={input}
        className="mgk-input"
        aria-label="Dimension value"
        aria-invalid={error ? true : undefined}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === 'Enter') {
            const err = editor.setDimension(d.id, text);
            setError(err ?? '');
          } else if (e.key === 'Escape') cancel();
        }}
        onBlur={() => {
          if (editor.editingDim?.id === d.id) cancel();
        }}
      />
      {error ? (
        <div className="t2d-dim-error" role="alert" data-t2d-dim-error>
          {error}
        </div>
      ) : null}
    </div>
  );
}
