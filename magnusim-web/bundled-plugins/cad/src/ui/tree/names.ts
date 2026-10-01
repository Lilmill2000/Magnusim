// Name rules the UI checks before asking the document to rename something, so
// a refused name is explained where it was typed. The document's own checks
// (DocService.rename / renameBody / addParam / updateParam) still decide.
// Owner: UI-SHELL.
// SPDX-License-Identifier: GPL-3.0-or-later
import { paramNameProblem } from '../../doc';
import type { Param } from '../../types/doc';
import { NAME_MAX } from '../kit/Rename';

export type NameCheck = { ok: true; name: string } | { ok: false; reason: string } | { ok: 'same' };

// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/;

function lower(s: string): string {
  return s.toLocaleLowerCase();
}

/**
 * A feature or body name: trimmed, 1..64 characters, no control characters,
 * not the same (ignoring case) as another item's name in `siblings`.
 */
export function checkItemName(raw: string, siblings: { id: string; name: string }[], selfId: string, noun: 'feature' | 'body'): NameCheck {
  const name = raw.trim();
  if (!name) return { ok: false, reason: 'Enter a name' };
  if (name.length > NAME_MAX) return { ok: false, reason: `Use ${NAME_MAX} characters or fewer` };
  if (CONTROL.test(name)) return { ok: false, reason: 'Names cannot contain tabs or line breaks' };
  const self = siblings.find((s) => s.id === selfId);
  if (self && self.name === name) return { ok: 'same' };
  const clash = siblings.find((s) => s.id !== selfId && lower(s.name) === lower(name));
  if (clash) return { ok: false, reason: `A ${noun} named "${clash.name}" already exists` };
  return { ok: true, name };
}

/**
 * Parameter names: the document's own rule (identifier, not a unit, function
 * or constant name: paramNameProblem, src/doc/params.ts), plus one the UI
 * adds: no two names that differ only in case ("Width" beside "width").
 */
export function checkParamName(raw: string, params: Param[] | Pick<Param, 'id' | 'name'>[], selfId: string | null): NameCheck {
  const name = raw.trim();
  const self = selfId ? params.find((p) => p.id === selfId) : undefined;
  if (self && self.name === name) return { ok: 'same' };
  const problem = paramNameProblem(name, params as Param[], selfId ?? undefined);
  if (problem) return { ok: false, reason: problem };
  const clash = params.find((p) => p.id !== selfId && lower(p.name) === lower(name));
  if (clash) return { ok: false, reason: `A parameter named "${clash.name}" already exists` };
  return { ok: true, name };
}
