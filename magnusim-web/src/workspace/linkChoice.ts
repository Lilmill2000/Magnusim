/**
 * The host's question when a linked geometry gets a new shape (host API 1.5, LINK proposal
 * 5.0): the same for every linking plugin, asked by the host in its own dialog
 * (#modal-link-choice in shell.html), one at a time with the app's other dialogs
 * (dialogs.ts). The plugin has no say: its linkGeometry call waits while the dialog is
 * open and then sees the geometry that resulted, or `cancelled` after "Keep editing".
 *
 * - "Save as new geometry": the part lands as a new project geometry ("<Geometry> v2");
 *   the old one and its studies, meshes and results stay as they are. One checkbox per
 *   study in use copies its setup onto the new geometry (only the study the geometry
 *   showed last starts checked, D36); a copy that cannot be made is disabled with why.
 * - "Overwrite <Geometry>": the update in place; disabled while a plugin that owns some of
 *   its studies' records is off or not installed (plugin_needed, D30).
 * - "Keep editing": nothing changes.
 *
 * When the geometry the study edited or linked was removed (API 1.7, `kind: 'removed'`):
 * "<Geometry> was removed from the project. Add <Part> as a new geometry?", with
 * "Add as new geometry", "Not now" (nothing is added; asked again on a later link) and
 * "Keep editing".
 *
 * The answer goes to POST /api/plugin-geometry/choose, which only the host calls: no
 * bridge call of a page reaches it.
 */
import { queueDialog, type DialogOpts } from '../workbench/dialogs';

/** One study the question lists: its copy is 'ok' or the reason it cannot be made. */
export interface LinkChoiceStudy {
  id: string;
  title: string;
  copy: string;
  checked?: boolean;
}

/** The server's question (the link route's `choosing`). */
export interface LinkQuestion {
  geometry: { id: string; name: string };
  study: { id: string; title: string };
  new_name: string;
  studies: LinkChoiceStudy[];
  overwrite: 'ok' | { code: string; message: string; records?: unknown[] };
  fenced?: boolean;
  /** API 1.7: the study edits this project geometry (a geometry action): the question names the geometry. */
  edits?: boolean;
  /** API 1.7: the geometry the study edited or linked was removed: add the part as a new geometry, or not now. */
  kind?: 'removed';
}

export type LinkChoice = { choice: 'new'; copy: string[] } | { choice: 'overwrite' } | { choice: 'not_now' } | { choice: 'cancel' };

/** "A", "A and B", "A, B and C". */
export function listNames(names: string[]): string {
  if (names.length <= 1) return names[0] || '';
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

/** The dialog's words (plain text). */
export function linkChoiceText(q: LinkQuestion): {
  title: string;
  copy: string;
  newLabel: string;
  newLine: string;
  copyLabel: (study: string) => string;
  overwriteLabel: string;
  overwriteLine: string;
  overwriteBlocked: string | null;
  cancelLabel: string;
} {
  const g = q.geometry.name;
  if (q.kind === 'removed') {
    // The second button is "Not now" here: nothing to overwrite.
    return {
      title: `${g} was removed from the project`,
      copy: `Add ${q.study.title} as a new geometry?`,
      newLabel: 'Add as new geometry',
      newLine: `Adds ${q.new_name} to the project.`,
      copyLabel: (study) => `Copy the setup of ${study} onto it`,
      overwriteLabel: 'Not now',
      overwriteLine: `Nothing is added. ${q.study.title} stays out of the simulation; you are asked again the next time it goes back with a change.`,
      overwriteBlocked: null,
      cancelLabel: 'Keep editing',
    };
  }
  return {
    title: `${q.edits ? g : q.study.title} has a new shape`,
    copy: `${g} is used by ${listNames(q.studies.map((s) => s.title))}. How should the simulation get the new shape?`,
    newLabel: 'Save as new geometry',
    newLine: `Adds ${q.new_name}. ${g} and its studies, meshes and results stay as they are.`,
    copyLabel: (study) => `Copy the setup of ${study} onto it`,
    overwriteLabel: `Overwrite ${g}`,
    overwriteLine: `Updates ${g} in place. Faces are matched by name; its meshes must be generated again before a run.`,
    overwriteBlocked: q.overwrite === 'ok' ? null : String(q.overwrite.message || 'Overwrite is not possible now.'),
    cancelLabel: 'Keep editing',
  };
}

/** The studies whose copy box starts checked (D36: only the one the geometry showed last). */
export function initiallyChecked(q: LinkQuestion): string[] {
  return q.studies.filter((s) => s.copy === 'ok' && s.checked).map((s) => s.id);
}

function el<T extends HTMLElement = HTMLElement>(id: string): T | null {
  return document.getElementById(id) as T | null;
}

function showLinkChoiceNow(q: LinkQuestion, o: DialogOpts): Promise<LinkChoice | null> {
  const modal = el('modal-link-choice');
  if (!modal) return Promise.resolve(null);
  const t = linkChoiceText(q);
  const heading = el('lc-heading');
  const copy = el('lc-copy');
  const newBtn = el<HTMLButtonElement>('lc-new');
  const newLine = el('lc-new-line');
  const copies = el('lc-copies');
  const over = el<HTMLButtonElement>('lc-overwrite');
  const overLine = el('lc-overwrite-line');
  const cancel = el<HTMLButtonElement>('lc-cancel');
  const backdrop = el('lc-backdrop');
  if (heading) heading.textContent = t.title;
  if (copy) copy.textContent = t.copy;
  if (newBtn) newBtn.textContent = t.newLabel;
  if (newLine) newLine.textContent = t.newLine;
  if (over) {
    over.textContent = t.overwriteLabel;
    over.disabled = !!t.overwriteBlocked;
  }
  if (overLine) overLine.textContent = t.overwriteBlocked || t.overwriteLine;
  if (cancel) cancel.textContent = t.cancelLabel;
  const checked = new Set(initiallyChecked(q));
  if (copies) {
    copies.replaceChildren();
    for (const st of q.studies) {
      const label = document.createElement('label');
      const box = document.createElement('input');
      box.type = 'checkbox';
      box.value = st.id;
      box.dataset.linkCopy = st.id;
      box.disabled = st.copy !== 'ok';
      box.checked = st.copy === 'ok' && checked.has(st.id);
      const words = document.createElement('span');
      words.textContent = t.copyLabel(st.title);
      if (st.copy !== 'ok') {
        label.classList.add('is-disabled');
        const why = document.createElement('span');
        why.className = 'link-choice-why';
        why.textContent = st.copy;
        words.appendChild(why);
      }
      label.append(box, words);
      copies.appendChild(label);
    }
  }
  modal.hidden = false;
  return new Promise<LinkChoice | null>((resolve) => {
    const done = (answer: LinkChoice | null) => {
      modal.hidden = true;
      newBtn?.removeEventListener('click', onNew);
      over?.removeEventListener('click', onOver);
      cancel?.removeEventListener('click', onCancel);
      backdrop?.removeEventListener('click', onCancel);
      document.removeEventListener('keydown', onKey);
      o.signal?.removeEventListener('abort', onAbort);
      resolve(answer);
    };
    const picked = () =>
      [...(copies?.querySelectorAll<HTMLInputElement>('input[type=checkbox]') || [])].filter((b) => b.checked && !b.disabled).map((b) => b.value);
    const onNew = () => done({ choice: 'new', copy: picked() });
    const onOver = () => {
      if (over && !over.disabled) done(q.kind === 'removed' ? { choice: 'not_now' } : { choice: 'overwrite' });
    };
    const onCancel = () => done({ choice: 'cancel' });
    // The asker went away (the page closed): the question stays open on the server.
    const onAbort = () => done(null);
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented) return;
      if (e.key === 'Escape') {
        e.preventDefault();
        onCancel();
      } else if (e.key === 'Enter' && document.activeElement === newBtn) {
        e.preventDefault();
        onNew();
      }
    };
    newBtn?.addEventListener('click', onNew);
    over?.addEventListener('click', onOver);
    cancel?.addEventListener('click', onCancel);
    backdrop?.addEventListener('click', onCancel);
    document.addEventListener('keydown', onKey);
    o.signal?.addEventListener('abort', onAbort);
    try {
      newBtn?.focus();
    } catch {
      /* not focusable */
    }
  });
}

/**
 * Ask the question (queued with the app's other dialogs). Null when it was dropped or its
 * asker went away before an answer: the question then stays open on the server, and the
 * geometry's row offers "Choose…".
 */
export function showLinkChoice(q: LinkQuestion, opts?: DialogOpts): Promise<LinkChoice | null> {
  return queueDialog<DialogOpts, LinkChoice | null>(opts, (o) => showLinkChoiceNow(q, o), null);
}

/** The scope of a question: its project, plugin and study, and its job. */
export interface LinkChoiceScope {
  projectId: string;
  plugin: string;
  studyId: string;
  jobId: string;
}

/** POST /api/plugin-geometry/choose: the answer. Throws an Error with `code` on a refusal. */
export async function sendLinkChoice(
  s: LinkChoiceScope,
  answer: LinkChoice,
): Promise<{ geometry_id?: string; created?: boolean; queued?: boolean; waiting?: boolean; cancelled?: boolean }> {
  const r = await fetch(`/api/plugin-geometry/choose?project_id=${encodeURIComponent(s.projectId)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      project_id: s.projectId,
      plugin: s.plugin,
      study_id: s.studyId,
      job_id: s.jobId,
      choice: answer.choice,
      copy: answer.choice === 'new' ? answer.copy : [],
    }),
  });
  let body: Record<string, unknown> = {};
  try {
    body = (await r.json()) as Record<string, unknown>;
  } catch {
    body = {};
  }
  if (!r.ok || body.ok === false) {
    const err = new Error(String(body.error || `The answer was refused (${r.status})`)) as Error & { code?: string };
    err.code = String(body.code || 'failed');
    throw err;
  }
  return body as { geometry_id?: string; created?: boolean; queued?: boolean; cancelled?: boolean };
}

/** What a "Save as new" copy came to (the job's `copies`). */
export interface LinkCopyOutcome {
  studyId: string;
  title: string;
  ok: boolean;
  error?: string | null;
  newTitle?: string | null;
  lost?: Array<{ item: string; label?: string | null; name?: string | null; old?: string | null }>;
  claimedTwice?: Array<{ items: string[]; label?: string | null; name?: string | null; target?: string | null }>;
}

/** The report after "Save as new" (5.14): the new geometry, then each copy's outcome. */
export function savedAsNewText(newName: string, oldName: string, copies: LinkCopyOutcome[] | null | undefined): { title: string; copy: string } {
  const lines = [`${newName} added. ${oldName} and its studies are kept as they were.`];
  for (const c of copies || []) {
    if (!c.ok) {
      lines.push(`Couldn't copy the setup of ${c.title}: ${c.error || 'it failed'}`);
      continue;
    }
    // The copy's own title only when it differs (a copy keeps its study's title unless taken).
    lines.push(`Copied the setup of ${c.title} onto it${c.newTitle && c.newTitle !== c.title ? `, as ${c.newTitle}` : ''}.`);
    const lost = c.lost || [];
    if (lost.length) {
      lines.push('These faces are not on the new shape. Each one stays listed on its record:');
      for (const f of lost) lines.push(`${f.item}: '${f.label || f.name || f.old || 'a face'}'`);
    }
    for (const t of c.claimedTwice || []) lines.push(`Pick one: '${t.label || t.name || t.target || 'a face'}' was in ${t.items.join(' and ')}.`);
  }
  return { title: `${newName} added`, copy: lines.join('\n') };
}
