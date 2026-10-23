/**
 * The notice a person sees when a save of theirs was refused because the record changed since
 * their panel loaded it (409 `stale_record`; Assistant phase 5, C2 §6.5): the panel has been
 * reloaded with the saved values first, then this says so, with one button. It goes through
 * confirmAction, as the linked geometry's refusals do (geometryRev.ts).
 *
 * Who changed it comes from the ui_sync frames this window heard (uiSync.ts heardWrite): the
 * Assistant (or another app on this PC, through it) within the last 60 s, else another window.
 */
import { confirmAction } from './dialogs';
import { heardWrite } from './uiSync';

export type StaleKind = 'bc' | 'material' | 'refinement' | 'mesh' | 'run' | 'bc_defaults';

export const STALE_TITLE = 'Not saved: changed elsewhere';
export const STALE_OK = 'OK';
const TAIL = 'Your change was not saved. The panel now shows the saved values. Make your change again if you still want it.';

const NOUN: Record<StaleKind, string> = {
  bc: 'boundary condition',
  material: 'material',
  refinement: 'mesh refinement',
  mesh: 'mesh',
  run: 'run',
  bc_defaults: 'boundary condition defaults',
};

/** What changed, as the sentence names it: `boundary condition "Inlet"`, or the kind alone. */
function what(kind: StaleKind, name: string): string {
  if (kind === 'bc_defaults') return 'the boundary condition defaults';
  const n = String(name || '').trim();
  return n ? `${NOUN[kind]} "${n}"` : `this ${NOUN[kind]}`;
}

function capital(s: string): string {
  return s ? s[0].toUpperCase() + s.slice(1) : s;
}

/** The notice's text: who changed the record (the Assistant, another app, or another window). */
export function staleCopy(kind: StaleKind, name: string, by: 'assistant' | 'app' | null): string {
  const w = what(kind, name);
  const it = kind === 'bc_defaults' ? 'them' : 'it';
  if (by === 'assistant') return `The Assistant changed ${w} while you were editing ${it}. ${TAIL}`;
  if (by === 'app') return `Another app on this PC changed ${w} while you were editing ${it}. ${TAIL}`;
  const was = kind === 'bc_defaults' ? 'were' : 'was';
  return `${capital(w)} ${was} changed in another window while you were editing ${it}. ${TAIL}`;
}

/**
 * The field the person was in lets go of its text before the panel reloads: a refused save's
 * field commits on blur, and the notice takes the focus, so the refused value would be saved
 * again over the newer one. Called first, before the panel's refusal count moves, so a commit
 * that blur makes is dropped with the refused save.
 */
export function releaseFocus(): void {
  const el = typeof document !== 'undefined' ? document.activeElement : null;
  if (el && el !== document.body && typeof (el as HTMLElement).blur === 'function') (el as HTMLElement).blur();
}

/** Say that the person's save of this record was refused (after the panel reloaded it). */
export async function showStaleNotice(kind: StaleKind, id: string, name: string): Promise<void> {
  const by = heardWrite(kind, id);
  await confirmAction({ title: STALE_TITLE, copy: staleCopy(kind, name, by), yes: STALE_OK, notice: true });
}
