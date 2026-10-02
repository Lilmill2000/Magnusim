/**
 * The name a new plugin study is offered: the first "<Kind title> N" that none
 * of the project's studies of that plugin has. Titles match trimmed and
 * ignoring case, so "part 1 " takes "Part 1".
 */
export function firstFreeStudyName(kindTitle: string, titles: readonly unknown[]): string {
  const base = String(kindTitle || '').trim() || 'Study';
  const taken = new Set(titles.map((t) => String(t ?? '').trim().toLowerCase()));
  let n = 1;
  while (taken.has(`${base} ${n}`.toLowerCase())) n += 1;
  return `${base} ${n}`;
}

/**
 * The titles of a plugin's studies the STUDIES section shows now, for a new
 * study asked for elsewhere (the header's Workspaces menu).
 */
export function shownStudyTitles(plugin: string): string[] {
  if (typeof document === 'undefined') return [];
  return Array.from(document.querySelectorAll('[data-plugin-studies-tree] > li[data-plugin-study]'))
    .filter((li) => li.getAttribute('data-plugin') === plugin)
    .map((li) => li.querySelector('.tl')?.textContent || '');
}

/**
 * Titles a study made without a prompt may not take: every plugin's study in the
 * project (not this plugin's alone) and the project's geometry names, so two plugins
 * whose kinds share a title make "Part 1" and "Part 2".
 */
export function takenStudyTitles(doc: {
  plugin_studies?: ReadonlyArray<{ title?: unknown }> | null;
  geometries?: ReadonlyArray<{ name?: unknown }> | null;
} | null): string[] {
  if (!doc) return [];
  return [
    ...(doc.plugin_studies || []).map((s) => String(s.title ?? '')),
    ...(doc.geometries || []).map((g) => String(g.name ?? '')),
  ].filter(Boolean);
}

/** What /api/plugin-studies/create answered. */
export interface CreateAnswer {
  json?: { ok?: boolean; error?: string; study?: { id?: unknown; workspace?: unknown } | null } | null;
}

/** What "+ New <kind>" needs from the workbench (runtime.js gives the real ones). */
export interface NewStudyHost {
  /** The plugin's study titles STUDIES shows, when the caller sent none. */
  shownTitles(): readonly unknown[];
  /** Asks for the name (not needed with `ask: false`). */
  promptName?(opts: { title: string; label: string; value: string; yes: string }): Promise<unknown>;
  create(body: { kind: string; title: string }): Promise<CreateAnswer>;
  notice(title: string, copy: string): Promise<unknown>;
  /** Reloads the tree, which adds the new row. */
  sync(): void;
  /** Where the user is: the project and the page. */
  where(): string;
  /** Shows the study in its plugin's workspace. */
  open(workspace: string, studyId: string): void;
}

/**
 * "+ New <kind>" from STUDIES or the Workspaces menu: asks for a name (the first
 * free "<Kind> N"), creates the study and opens it in its workspace when its kind
 * has one. If the user went elsewhere while it was named or made, the row is
 * added and nothing opens. With `ask: false` (a start action, API 1.4) it takes
 * the first free name without asking; the header's rename changes it later.
 */
export async function newPluginStudy(
  detail: { kind?: unknown; title?: unknown; titles?: unknown; open?: unknown },
  host: NewStudyHost,
  opts: { ask?: boolean } = {},
): Promise<void> {
  const kindTitle = String(detail.title || 'study');
  const titles = Array.isArray(detail.titles) ? detail.titles : host.shownTitles();
  const from = host.where();
  const offered = firstFreeStudyName(kindTitle, titles);
  const asked =
    opts.ask === false || !host.promptName
      ? offered
      : await host.promptName({ title: `New ${kindTitle}`, label: 'Name', value: offered, yes: 'Create' });
  const title = String(asked || '').trim();
  if (!title) return;
  const r = await host.create({ kind: String(detail.kind || ''), title });
  const json = r && r.json;
  if (!json || !json.ok) await host.notice('Could not create the study', (json && json.error) || 'The study was not created.');
  host.sync();
  const made = json && json.ok ? json.study : null;
  if (made && made.workspace && made.id && host.where() === from) host.open(String(made.workspace), String(made.id));
}
