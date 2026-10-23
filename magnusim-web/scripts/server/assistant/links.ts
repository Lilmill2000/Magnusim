/**
 * Links a tool result offers the person (spec 06 §8.6): the dock shows them under the
 * step, as a Download the person clicks; the browser saves the file. Saving to disk stays
 * the person's (Daniel). The model never sees them: they go on the log's tool_result only.
 *
 * Only the app's own files: a finished VTK export's zip, same origin, its project named.
 * Anything else is dropped, so a result can't point the person anywhere.
 */
import { cleanText } from './sanitize.ts';

export interface ToolLink {
  label: string;
  href: string;
}

export const LINKS_MAX = 4;
const ALLOWED: readonly RegExp[] = [/^\/api\/results\/export-vtk\/job-[A-Za-z0-9-]{1,60}\/file\?project_id=[A-Za-z0-9._%-]{1,200}$/];

/** The links a result may carry: the allowed hrefs, each label cleaned (≤ 80), at most LINKS_MAX. */
export function safeLinks(raw: unknown): ToolLink[] {
  if (!Array.isArray(raw)) return [];
  const out: ToolLink[] = [];
  for (const l of raw) {
    if (!l || typeof l !== 'object') continue;
    const href = typeof (l as ToolLink).href === 'string' ? (l as ToolLink).href : '';
    if (!ALLOWED.some((re) => re.test(href))) continue;
    const label = cleanText((l as ToolLink).label, 80) || 'Download';
    if (out.some((x) => x.href === href)) continue;
    out.push({ label, href });
    if (out.length >= LINKS_MAX) break;
  }
  return out;
}
