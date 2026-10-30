// Sketch copy and paste (the person's; the Assistant's copy row runs the same clip.ts):
//  - Copy (Ctrl+C in a sketch, or the selection's right-click menu) holds the selected sketch
//    geometry with its points and the relations and dimensions inside it (src/sketch/tools/clip.ts)
//    in the page; it is kept in the plugin's prefs too (when small enough), so a sketch of another
//    Part pastes it as well, and another open tab hears it. The panel's foot says what was copied.
//    With no sketch geometry selected, or with text selected on the page (the panel's red reason,
//    which stays selectable to copy into a report), the key is the browser's (it copies the text);
//    in a text or number field it is the field's, never sketch mode's (the keyboard leaves fields alone).
//  - Paste (Ctrl+V, or the sketch's right-click menu) takes up the paste tool: the copy follows the
//    pointer, held by the middle of its box (snapping to the sketch's points and curves as the
//    drawing tools do; Ctrl stops it), a click (or Enter) places it as one sketch undo step and
//    selects what it made, Escape puts it down with nothing added. What tied the copied geometry to
//    geometry left behind is left out, and the panel's foot says how much.
// Owner: SKETCH.
// SPDX-License-Identifier: GPL-3.0-or-later
import type { AppServices } from '../../types/app';
import type { CommandDef } from '../../types/commands';
import type { Vec2 } from '../../types/doc';
import { uiFor } from '../../ui/controller';
import { infer } from '../inference';
import { emptyPreview, type ApplyResult, type SketchMode, type SketchPreview, type SketchTool } from '../mode';
import { clipOf, clipSegments, clipWords, leftOutWords, pasteClip, readClip, valuedWords, type SketchClip } from './clip';
import { placeKey } from './place-key';
import type { ToolOption } from './options';

export const COPY_COMMAND = 'sketch.copy';
export const PASTE_COMMAND = 'sketch.paste';
/** The plugin's prefs key that carries the last copy to another Part (or tab). */
export const CLIP_PREF = 'sketch-clipboard';
/** The largest copy the prefs carry (JSON characters): the plugin keeps 64 KB of prefs in all. */
export const CLIP_PREF_MAX = 16 * 1024;

// ------------------------------------------------------------------ the clipboard (the page's)

let held: SketchClip | null = null;
/** The prefs' copy has been read (or there are none). */
let prefsRead = false;

/** The copy the page holds now, or null (tests). */
export function peekClip(): SketchClip | null {
  return held;
}

/** Forget the page's copy (tests). */
export function forgetClip(): void {
  held = null;
  prefsRead = false;
}

/** Hold a copy: in the page, and in the prefs for another Part when it is small enough ('page' when it is not, or there are no prefs). */
export function holdClip(services: Pick<AppServices, 'bridge'>, clip: SketchClip): 'prefs' | 'page' {
  held = clip;
  prefsRead = true;
  const prefs = services.bridge?.prefs ?? null;
  if (!prefs) return 'page';
  const fits = JSON.stringify(clip).length <= CLIP_PREF_MAX;
  // An older copy in the prefs never comes back in another Part in place of this one.
  (fits ? prefs.set(CLIP_PREF, clip) : prefs.remove(CLIP_PREF)).catch(() => {});
  return fits ? 'prefs' : 'page';
}

/** The copy to paste: the page's, else the prefs' (another Part's Copy), else null. */
export async function heldClip(services: Pick<AppServices, 'bridge'>): Promise<SketchClip | null> {
  if (held || prefsRead) return held;
  const prefs = services.bridge?.prefs ?? null;
  if (!prefs) return null;
  try {
    const c = readClip(await prefs.get(CLIP_PREF));
    if (!held && c) held = c;
  } catch {
    /* no copy from elsewhere */
  }
  prefsRead = true;
  return held;
}

// ------------------------------------------------------------------ copy

/** Whether the person has text selected on the page (a panel's reason drag-selected): Ctrl+C copies that, not the sketch. */
export function pageTextSelected(doc: Document | null = typeof document === 'undefined' ? null : document): boolean {
  const sel = doc?.getSelection?.() ?? null;
  return !!sel && !sel.isCollapsed && sel.rangeCount > 0 && sel.toString().trim() !== '';
}

/** Why Copy has nothing to take now, or null. */
export function copyRefusal(mode: Pick<SketchMode, 'active' | 'selected' | 'draft'>): string | null {
  if (!mode.active) return 'Edit a sketch first';
  const d = mode.draft();
  const ids = mode.selected().map((h) => h.id);
  if (!d || !ids.length) return 'Select sketch geometry to copy';
  const c = clipOf(d, ids);
  return typeof c === 'string' ? 'Select sketch geometry to copy: lines, arcs, circles, splines or points' : null;
}

/** Copy the selection (the command, the menu): what the panel's foot says, or why not. */
export function copySelection(services: Pick<AppServices, 'bridge'>, mode: SketchMode): SketchClip | string {
  const d = mode.draft();
  if (!d) return 'Edit a sketch first';
  const clip = clipOf(
    d,
    mode.selected().map((h) => h.id),
    mode.services.doc.units.units(),
  );
  if (typeof clip === 'string') {
    mode.note(`Not copied: ${clip}`);
    return clip;
  }
  const where = holdClip(services, clip);
  const left = leftOutWords(clip.outside);
  const words = [`Copied ${clipWords(clip)}`, left ? `${left.replace(/ (was|were) left out$/, '')} will be left out` : '', where === 'page' && services.bridge?.prefs ? 'only for this Part (too big to keep for another)' : ''].filter(Boolean);
  // What it did, never in a refusal's red: amber when something will be left out.
  mode.note(`${words.join('; ')}.`, left ? 'warning' : 'info');
  return clip;
}

// ------------------------------------------------------------------ paste

const pending = new WeakMap<SketchMode, SketchClip>();

/** Take up the paste tool with this copy (false when no sketch is open, or the Assistant draws it). */
export function startPaste(mode: SketchMode, clip: SketchClip): boolean {
  if (!mode.active) return false;
  pending.set(mode, clip);
  if (mode.tool?.id === 'paste') mode.setTool('select');
  mode.setTool('paste');
  pending.delete(mode);
  return mode.tool?.id === 'paste';
}

/** The paste as one sketch undo step, the copy's middle on `at`: what a click does. */
export function applyPaste(mode: SketchMode, clip: SketchClip, at: Vec2): Promise<ApplyResult & { added?: string[]; valued?: string[] }> {
  let added: string[] = [];
  let valued: string[] = [];
  const units = mode.services.doc.units;
  return mode
    .apply('Paste', (cur) => {
      const r = pasteClip(cur, clip, at, { evaluate: (expr, q) => evaluatedIn(units, expr, q), units: units.units() });
      added = r.added;
      valued = r.valued;
      return r.outcome;
    })
    .then((r) => (r.ok ? { ...r, added, valued } : r));
}

/** What a Part reads an expression as (mm or deg), or null when it cannot. */
export function evaluatedIn(units: AppServices['doc']['units'], expr: string, q: 'length' | 'angle'): number | null {
  const r = units.evaluate(expr, q);
  return r.ok ? r.value : null;
}

/** The paste tool: the copy follows the pointer; a click places it, Escape puts it down. */
export function pasteTool(mode: SketchMode): SketchTool {
  const clip = pending.get(mode) ?? null;
  const drawn = clip ? clipSegments(clip) : { lines: [], points: [] };
  let at: Vec2 | null = null;
  let glyphs: SketchPreview['glyphs'] = [];
  let busy = false;

  const show = () => {
    if (!clip || !at) {
      mode.setPreview(null);
      return;
    }
    const dx = at[0] - clip.anchor[0];
    const dy = at[1] - clip.anchor[1];
    const p = emptyPreview();
    p.lines = drawn.lines.map(([a, b]) => [
      [a[0] + dx, a[1] + dy],
      [b[0] + dx, b[1] + dy],
    ]);
    p.points = [...drawn.points.map((q): Vec2 => [q[0] + dx, q[1] + dy]), [at[0], at[1]]];
    p.glyphs = glyphs;
    mode.setPreview(p);
  };

  const place = (where: Vec2) => {
    if (!clip || busy) return;
    busy = true;
    void applyPaste(mode, clip, where).then((r) => {
      busy = false;
      if (!r.ok || mode.tool !== tool) return;
      mode.setTool('select');
      mode.select((r.added ?? []).map((id) => ({ what: 'entity' as const, id })), false);
      const said = [leftOutWords(clip.outside), valuedWords(r.valued ?? [])].filter(Boolean);
      // Said only when something was left out or a dimension took its value: amber, never a refusal's red.
      mode.note(said.length ? `Pasted ${clipWords(clip)}: ${said.join('; ')}.` : null, 'warning');
    });
  };

  const tool: SketchTool = {
    id: 'paste',
    hint() {
      if (!clip) return 'Paste: nothing copied yet (select sketch geometry, then Copy)';
      return `Paste ${clipWords(clip)}: click where the middle of the copy goes (${placeKey(mode)}a click places it, one undo step; Esc cancels)`;
    },
    shortHint: () => (clip ? 'Paste: click where the copy goes' : null),
    options(): ToolOption[] {
      if (!clip) return [];
      const left = leftOutWords(clip.outside);
      return [
        { kind: 'text', id: 'what', text: `From ${clip.from}: ${clipWords(clip)}` },
        ...(left ? [{ kind: 'text' as const, id: 'left-out', text: `${left.replace(/ (was|were) left out$/, '')} will be left out` }] : []),
        { kind: 'button', id: 'cancel', label: 'Cancel', run: () => mode.setTool('select') },
      ];
    },
    pointer(e) {
      if (!clip) return;
      if (e.type === 'move' || e.type === 'click') {
        const d = mode.draft();
        const inf = infer({ f: d ?? { points: {}, entities: [] }, at: e.uv, px: e.px, suppress: e.ctrl });
        at = inf.at;
        glyphs = inf.glyphs.length ? [{ at: inf.at, kinds: inf.glyphs }] : [];
        show();
        if (e.type === 'click') place(inf.at);
        return;
      }
      if (e.type === 'leave') {
        at = null;
        show();
      }
    },
    // Escape puts the paste down at once (the tool goes: sketch mode's escape).
    cancel: () => false,
    commit() {
      if (!clip || !at) return false;
      place(at);
      return true;
    },
    dispose() {
      mode.setPreview(null);
    },
  };
  // The copy under the pointer at once (setTool clears the preview after making the tool).
  queueMicrotask(() => {
    if (mode.tool === tool) mode.repeatPointer?.();
  });
  return tool;
}

// ------------------------------------------------------------------ the commands

/** Copy and Paste (keyboard and the sketch's right-click menu; Settings > Keybinds lists them). */
export function registerClipboardCommands(services: AppServices, mode: SketchMode): () => void {
  const ui = uiFor(services);
  const offs: (() => void)[] = [];
  const copy: CommandDef = {
    id: COPY_COMMAND,
    label: 'Copy',
    mode: 'sketch',
    hint: 'Copy the selected sketch geometry, with the relations and dimensions between its pieces',
    explainRefusal: true,
    enabled: () => copyRefusal(mode) ?? true,
    // Nothing of the sketch selected, or text selected on the page: the browser's own copy (the text).
    passKey: () => copyRefusal(mode) != null || pageTextSelected(),
    run: () => {
      copySelection(services, mode);
    },
  };
  const paste: CommandDef = {
    id: PASTE_COMMAND,
    label: 'Paste',
    mode: 'sketch',
    hint: 'Paste what was copied: it follows the pointer, a click places it',
    explainRefusal: true,
    enabled: () => ui.editBlock() ?? (mode.active ? true : 'Edit a sketch first'),
    run: async () => {
      const clip = await heldClip(services);
      if (!clip) {
        mode.note('Nothing to paste: select sketch geometry and Copy it first');
        return;
      }
      startPaste(mode, clip);
    },
  };
  offs.push(services.commands.register(copy), services.commands.register(paste));
  // Another tab's Copy (the prefs tell this page), and a copy kept from before this page.
  const prefs = services.bridge?.prefs ?? null;
  if (prefs) {
    offs.push(
      prefs.onChange((key, value) => {
        if (key !== CLIP_PREF) return;
        const c = readClip(value);
        if (c) {
          held = c;
          prefsRead = true;
        }
      }),
    );
    void heldClip(services);
  }
  return () => {
    for (const off of offs.splice(0).reverse()) off();
  };
}
