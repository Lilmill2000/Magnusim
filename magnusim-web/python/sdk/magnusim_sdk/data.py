"""A plugin's own data in a project: ``projects/<pid>/plugins/<key>/`` (API 1.1).

Standard library only, so a plugin's service (its own environment) uses the
same helper as the host: the worker passes a :class:`PluginData` bound to the
calling plugin and the open project to each in-process plugin method as
``scope["data"]``, and a service builds one from its call's scope
(``PluginData(scope["project_dir"], scope["plugin"])``). Paths never leave the
folder, so a plugin cannot read or write another plugin's data or another
project's through it.

Writes here are the one exception to "only the worker writes project files":
they are the plugin's own records, written through this object (atomically).
The core reaches plugin studies through the ``plugin_studies.*`` RPCs.

A plugin **study** is a project-level record (not bound to a geometry) at
``plugins/<key>/studies/<sid>/study.json``::

    {id, kind, title, schema_version, rev, plugin, plugin_name, plugin_version,
     created_at, updated_at}

``rev`` goes up on every write; a write that names an older ``rev`` is
refused (:class:`StaleRevisionError`), so two open tabs cannot overwrite each other.
"""

from __future__ import annotations

import json
import os
import re
import secrets
import shutil
import tempfile
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

PLUGIN_KEY_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,120}$")
STUDY_ID_RE = re.compile(r"^[a-z0-9][a-z0-9-]{0,63}$")
KIND_KEY_RE = re.compile(r"^[a-z][a-z0-9_]{0,40}$")
STALE_MESSAGE = "This study changed in another tab. Reload to continue."


class PluginDataError(ValueError):
    """A request outside what the plugin's data scope allows."""


class StaleRevisionError(PluginDataError):
    """The study changed since the caller read it (its rev is newer)."""

    def __init__(self, current: int) -> None:
        super().__init__(STALE_MESSAGE)
        self.current = current


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def version_tuple(version: str) -> tuple[int, ...]:
    out: list[int] = []
    for part in str(version or "0").split("."):
        m = re.match(r"\d+", part)
        out.append(int(m.group(0)) if m else 0)
    return tuple(out)


def _atomic_write_json(path: Path, doc: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(prefix=".tmp-", suffix=".json", dir=str(path.parent))
    try:
        with os.fdopen(fd, "w", encoding="utf-8", newline="\n") as fh:
            json.dump(doc, fh, indent=2, ensure_ascii=False)
            fh.write("\n")
        os.replace(tmp, path)
    except BaseException:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise


class PluginData:
    """One plugin's folder in one project. Created on first write."""

    def __init__(self, project_dir: Path | str, plugin: str) -> None:
        key = str(plugin or "")
        if not PLUGIN_KEY_RE.match(key) or key.endswith("."):
            raise PluginDataError(f"invalid plugin key: {plugin!r}")
        self.project_dir = Path(project_dir).resolve()
        self.plugin = key

    @property
    def root(self) -> Path:
        return self.project_dir / "plugins" / self.plugin

    def path(self, *parts: str) -> Path:
        """A path inside this plugin's folder (never outside it)."""
        target = self.root.joinpath(*[str(p) for p in parts]).resolve()
        root = self.root.resolve()
        if target != root and root not in target.parents:
            raise PluginDataError("path leaves the plugin's data folder")
        return target

    def read_json(self, rel: str, default: Any = None) -> Any:
        p = self.path(rel)
        if not p.is_file():
            return default
        try:
            return json.loads(p.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return default

    def write_json(self, rel: str, doc: Any) -> None:
        p = self.path(rel)
        if p == self.root.resolve():
            raise PluginDataError("cannot write the data folder itself")
        _atomic_write_json(p, doc)

    def delete(self, rel: str) -> None:
        p = self.path(rel)
        if p == self.root.resolve():
            raise PluginDataError("cannot delete the data folder itself")
        if p.is_dir():
            shutil.rmtree(p)
        elif p.exists():
            p.unlink()

    # -- studies --------------------------------------------------------

    def _study_rel(self, sid: str) -> str:
        if not STUDY_ID_RE.match(str(sid or "")):
            raise PluginDataError(f"invalid study id: {sid!r}")
        return f"studies/{sid}/study.json"

    def studies(self) -> list[dict[str, Any]]:
        folder = self.path("studies")
        if not folder.is_dir():
            return []
        out: list[dict[str, Any]] = []
        for child in sorted(folder.iterdir()):
            if not child.is_dir() or not STUDY_ID_RE.match(child.name):
                continue
            rec = self.read_json(f"studies/{child.name}/study.json")
            if isinstance(rec, dict) and str(rec.get("id") or "") == child.name:
                out.append(rec)
        out.sort(key=lambda r: (str(r.get("created_at") or ""), str(r.get("id"))))
        return out

    def study(self, sid: str) -> dict[str, Any]:
        rec = self.read_json(self._study_rel(sid))
        if not isinstance(rec, dict):
            raise PluginDataError(f"no study {sid!r}")
        return rec

    def create_study(
        self,
        kind: str,
        title: str,
        *,
        plugin_name: str = "",
        plugin_version: str = "0.0.0",
        schema_version: int = 1,
    ) -> dict[str, Any]:
        if not KIND_KEY_RE.match(str(kind or "")):
            raise PluginDataError(f"invalid study kind: {kind!r}")
        name = str(title or "").strip()[:120]
        if not name:
            raise PluginDataError("a study needs a title")
        sid = "st-" + secrets.token_hex(4)
        while self.path(self._study_rel(sid)).exists():
            sid = "st-" + secrets.token_hex(4)
        now = _now()
        rec = {
            "id": sid,
            "kind": kind,
            "title": name,
            "schema_version": int(schema_version),
            "rev": 1,
            "plugin": self.plugin,
            "plugin_name": str(plugin_name or self.plugin),
            "plugin_version": str(plugin_version or "0.0.0"),
            "created_at": now,
            "updated_at": now,
        }
        self.write_json(self._study_rel(sid), rec)
        return rec

    def update_study(self, sid: str, patch: dict[str, Any], rev: int | None) -> dict[str, Any]:
        rec = self.study(sid)
        current = int(rec.get("rev") or 0)
        if rev is None or int(rev) != current:
            raise StaleRevisionError(current)
        fixed = {"id", "kind", "plugin", "created_at", "rev"}
        rec.update({k: v for k, v in patch.items() if k not in fixed})
        rec["rev"] = current + 1
        rec["updated_at"] = _now()
        self.write_json(self._study_rel(sid), rec)
        return rec

    def rename_study(self, sid: str, title: str, rev: int | None) -> dict[str, Any]:
        name = str(title or "").strip()[:120]
        if not name:
            raise PluginDataError("a study needs a title")
        return self.update_study(sid, {"title": name}, rev)

    def delete_study(self, sid: str) -> None:
        self.study(sid)
        self.delete(f"studies/{sid}")


def plugin_data_folders(project_dir: Path | str) -> list[str]:
    """Plugin keys that have a data folder in this project (enabled or not)."""
    base = Path(project_dir) / "plugins"
    if not base.is_dir():
        return []
    return sorted(d.name for d in base.iterdir() if d.is_dir() and PLUGIN_KEY_RE.match(d.name))
