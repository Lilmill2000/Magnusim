// The person's Import SVG/DXF in sketch mode: the command (MODIFY, beside Project and Intersect;
// Settings > Keybinds lists it, no default key) opens the file picker (.svg, .dxf) from the click,
// reads the file (index.ts readDrawing: refused past 20 MB, a binary DXF refused, its reason in the
// panel's foot), then the import tool shows in the Sketch panel what it read (curves by kind, what
// was skipped and why, the size in mm, open ends, the units and notes), the Scale (mm per drawing
// unit, from its units), where it goes (its own origin on the sketch origin, or centred there), the
// DXF's layers to take, and OK / Cancel. The curves are previewed in the sketch while it is open;
// OK adds them in one sketch undo step (common.ts importIntoDraft, the Assistant's import row runs
// the same), Cancel or Escape adds nothing. The drawing is framed when it opens partly off the view,
// and when a Scale, Place or layer change takes it out of view; Fit counts it while the tool is open.
// SPDX-License-Identifier: GPL-3.0-or-later
import { filesFor } from '../../files/transfer';
import type { AppServices } from '../../types/app';
import type { CommandDef } from '../../types/commands';
import { uiFor } from '../../ui/controller';
import type { Vec2 } from '../../types/doc';
import { emptyPreview, toModel, type ApplyResult, type SketchMode, type SketchTool } from '../mode';
import type { ToolOption } from '../tools/options';
import { sig, type ImportPlan } from './common';
import { DRAWING_ACCEPT, DRAWING_MAX_BYTES, importIntoDraft, planImport, previewSegments, summaryWords, tooLarge, tryReadDrawing, type Drawing, type ImportOptions } from './index';

export const IMPORT_COMMAND = 'sketch.import';
export const IMPORT_LABEL = 'Import SVG/DXF';
/** A sheet with a curve and an arrow into it (24 viewBox, outline). */
export const IMPORT_ICON = 'M5 3h9l5 5v13H5z M14 3v5h5 M8 17c2-5 5-5 7-2 M12 10v5 M9.8 12.8L12 15l2.2-2.2';

/** The drawing the command read, for the tool it opens. */
const pending = new WeakMap<SketchMode, Drawing>();

/** Read a picked file and open the import on it (a refusal says why in the panel's foot). */
export async function openDrawing(mode: SketchMode, file: File): Promise<boolean> {
  if (file.size > DRAWING_MAX_BYTES) {
    mode.note(`Not imported: ${tooLarge(file.name)}`);
    return false;
  }
  const r = tryReadDrawing(file.name, new Uint8Array(await file.arrayBuffer()));
  if ('refused' in r) {
    mode.note(`Not imported: ${r.refused}`);
    return false;
  }
  return openRead(mode, r.drawing);
}

/** Open the import tool on a drawing already read. */
export function openRead(mode: SketchMode, d: Drawing): boolean {
  if (!mode.active) return false;
  pending.set(mode, d);
  if (mode.tool?.id === 'import') mode.setTool('select');
  mode.setTool('import');
  return mode.tool?.id === 'import';
}

/** The file picker from the person's click (nothing awaited before it), then the import. */
export function pickDrawing(services: AppServices, mode: SketchMode): void {
  void filesFor(services)
    .pick(DRAWING_ACCEPT)
    .then((f) => (f ? openDrawing(mode, f) : false));
}

/** The import as one sketch undo step: what OK does. */
export function applyImport(mode: SketchMode, d: Drawing, o: ImportOptions = {}): Promise<ApplyResult & { added?: string[] }> {
  let added: string[] = [];
  return mode
    .apply(IMPORT_LABEL, (cur) => {
      const r = importIntoDraft(cur, planImport(d, o));
      added = r.added;
      return r.outcome;
    })
    .then((r) => (r.ok ? { ...r, added } : r));
}

/** The tool the command opens: the panel's summary and options, the preview, OK and Cancel. */
export function importTool(mode: SketchMode): SketchTool {
  const d = pending.get(mode) ?? null;
  pending.delete(mode);
  let scale = d?.mmPerUnit ?? 1;
  let place: 'origin' | 'centre' = 'origin';
  let layers = new Set((d?.layers ?? []).filter((l) => !l.off).map((l) => l.name));
  let plan: ImportPlan | null = null;
  let problem: string | null = null;
  let busy = false;

  const opts = (): ImportOptions => ({ scale, place, layers: d?.layers.length ? [...layers] : null });
  const replan = () => {
    plan = null;
    problem = null;
    if (!d) return;
    try {
      plan = planImport(d, opts());
      problem = plan.summary.refused;
    } catch (err) {
      problem = err instanceof Error ? err.message : String(err);
    }
  };
  const show = () => {
    mode.setPreview(plan && !problem ? { ...emptyPreview(), lines: previewSegments(plan) } : null);
    mode.refreshHint();
  };
  /** The drawing's box as previewed (sketch u/v: min, max), or null when nothing previews. */
  const box = (): [Vec2, Vec2] | null => {
    const b = plan && !problem ? plan.summary.box : null;
    return b ? [[b.min[0], b.min[1]], [b.max[0], b.max[1]]] : null;
  };
  // The drawing in view (the owner's review: part.dxf, 533 mm wide, lay mostly off the view, and
  // Fit framed nothing, the sketch being empty). Opening it fits the view (its preview counting:
  // frameUv) when part of it is off what the panels leave free, once the camera rests; so does a
  // Scale, Place or layer change that takes it out of view. The camera stays when it all shows,
  // and when it did not all show before the change (the person zoomed in on a part of it).
  let waiting: (() => void) | null = null;
  /** Whether the previewed drawing reaches off the view now (null: nothing previews, or no view). */
  const offView = (): boolean | null => {
    const h = mode.services.viewport.get().handle;
    const plane = mode.plane();
    const b = box();
    if (!h?.offView || !plane || !b) return null;
    const [lo, hi] = b;
    return h.offView(([lo, [hi[0], lo[1]], hi, [lo[0], hi[1]]] as Vec2[]).map((uv) => toModel(plane, uv)));
  };
  const frame = () => {
    waiting?.();
    waiting = null;
    const h = mode.services.viewport.get().handle;
    if (!h) return;
    const go = () => {
      if (mode.tool === tool && offView()) h.fit({ auto: true });
    };
    if (!h.state.get().animating) {
      go();
      return;
    }
    const off = h.state.subscribe((s) => {
      if (s.animating) return;
      off();
      waiting = null;
      go();
    });
    waiting = off;
  };
  const refresh = () => {
    // All in view before the change (nothing previewed counts so; a transition running is a framing).
    const shown = mode.services.viewport.get().handle?.state.get().animating === true || offView() !== true;
    replan();
    show();
    if (shown) frame();
  };
  const ok = () => {
    if (!d || !plan || problem || busy) return;
    busy = true;
    // A refusal says why in the panel's foot (sketch mode's own note); done, the curves are in the sketch.
    void applyImport(mode, d, opts()).then((r) => {
      busy = false;
      if (r.ok && mode.tool === tool) mode.setTool('select');
    });
  };

  const tool: SketchTool = {
    id: 'import',
    pointer() {},
    cancel: () => false,
    hint() {
      if (!d) return `${IMPORT_LABEL}: choose an SVG or DXF file`;
      if (!plan) return `${IMPORT_LABEL} ${d.name}: ${problem ?? 'nothing to import'}`;
      const s = plan.summary;
      return `${IMPORT_LABEL} ${d.name}: ${s.total} curve${s.total === 1 ? '' : 's'}, ${sig(s.size[0])} × ${sig(s.size[1])} mm. Set the scale and where it goes, then OK (one undo step); Esc cancels`;
    },
    shortHint: () => (d ? `Import ${d.name}: check it, then OK` : null),
    options(): ToolOption[] {
      if (!d) return [{ kind: 'button', id: 'choose', label: 'Choose a file…', primary: true, run: () => pickDrawing(mode.services, mode) }];
      const out: ToolOption[] = [];
      if (plan) {
        const w = summaryWords(plan.summary);
        out.push({ kind: 'text', id: 'read', text: w.read }, { kind: 'text', id: 'skipped', text: w.skipped }, { kind: 'text', id: 'size', text: w.size }, { kind: 'text', id: 'open', text: w.open }, { kind: 'text', id: 'join', text: w.join });
        for (const [i, n] of w.notes.entries()) out.push({ kind: 'text', id: `note-${i}`, text: n });
      }
      out.push({ kind: 'text', id: 'units', text: `Units: ${d.units} (1 unit = ${sig(d.mmPerUnit)} mm)` });
      out.push({
        kind: 'number',
        id: 'scale',
        label: 'Scale (mm per unit)',
        expr: sig(scale),
        quantity: 'scalar',
        validate: (v) => (Number.isFinite(v) && v > 0 ? null : 'A number above 0'),
        set: (_e, v) => {
          scale = v;
          refresh();
        },
      });
      out.push({
        kind: 'choice',
        id: 'place',
        label: 'Place',
        value: place,
        choices: [
          { value: 'origin', label: "Its origin on the sketch's" },
          { value: 'centre', label: 'Centred on the origin' },
        ],
        set: (v) => {
          place = v === 'centre' ? 'centre' : 'origin';
          refresh();
        },
      });
      for (const l of d.layers) {
        out.push({
          kind: 'check',
          id: `layer:${l.name}`,
          label: `Layer ${l.name} (${l.count})${l.off ? ' · off in the file' : ''}`,
          value: layers.has(l.name),
          set: (v) => {
            layers = new Set(layers);
            if (v) layers.add(l.name);
            else layers.delete(l.name);
            refresh();
          },
        });
      }
      if (problem) out.push({ kind: 'text', id: 'problem', text: problem });
      out.push({ kind: 'button', id: 'ok', label: 'OK', primary: true, disabled: problem ?? (busy ? 'Importing…' : null), run: ok });
      out.push({ kind: 'button', id: 'cancel', label: 'Cancel', run: () => mode.setTool('select') });
      return out;
    },
    commit() {
      if (!plan || problem) return false;
      ok();
      return true;
    },
    frameUv: () => box(),
    dispose() {
      waiting?.();
      waiting = null;
      mode.setPreview(null);
    },
  };
  replan();
  // The preview once the tool is in hand (setTool clears the preview after making it), in view.
  queueMicrotask(() => {
    if (mode.tool !== tool) return;
    show();
    frame();
  });
  return tool;
}

/** The command (MODIFY in sketch mode). */
export function registerImportCommand(services: AppServices, mode: SketchMode): () => void {
  const ui = uiFor(services);
  const def: CommandDef = {
    id: IMPORT_COMMAND,
    label: IMPORT_LABEL,
    group: 'sketch-modify',
    mode: 'sketch',
    icon: IMPORT_ICON,
    hint: 'Bring the lines, arcs, circles and curves of an SVG or DXF drawing into this sketch: what it read shows first, then OK (one undo step)',
    // After Project and Intersect (MODIFY's order as reviewed); first to fold (Toolbar.tsx FOLD_ORDER).
    order: 52,
    explainRefusal: true,
    activeWhen: { sketchTool: 'import' },
    enabled: () => ui.editBlock() ?? (mode.active ? true : 'Edit a sketch first'),
    run: () => pickDrawing(services, mode),
  };
  return services.commands.register(def);
}
