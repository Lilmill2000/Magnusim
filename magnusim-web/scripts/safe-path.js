import { existsSync, realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path';

export function resolvedPath(path) {
  const absolute = resolve(String(path));
  if (existsSync(absolute)) return realpathSync(absolute);
  const parent = dirname(absolute);
  return parent === absolute ? absolute : resolve(resolvedPath(parent), basename(absolute));
}

export function pathIsWithin(path, root) {
  const rel = relative(resolvedPath(root), resolvedPath(path));
  return !isAbsolute(rel) && rel !== '..' && !rel.startsWith('..' + sep);
}

export function safeProjectPath(root, id) {
  const value = String(id || '');
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,120}$/.test(value) || /[. ]$/.test(value)) {
    throw Object.assign(new Error('invalid project id'), { status: 400 });
  }
  const path = resolve(root, value);
  if (!pathIsWithin(path, root)) throw Object.assign(new Error('project path outside workspace'), { status: 400 });
  return path;
}
