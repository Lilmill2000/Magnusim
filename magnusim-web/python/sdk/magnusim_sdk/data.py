"""A plugin's own data in a project: ``projects/<pid>/plugins/<key>/`` (API 1.2).

Standard library only, so a plugin's service (its own environment) uses the
same helper as the host: the worker passes a :class:`PluginData` bound to the
calling plugin and the open project to each in-process plugin method as
``scope["data"]``, a service builds one from its call's scope
(``PluginData.from_scope(scope)``) and a plugin job from its environment
(``PluginData.from_env()``). Paths never leave the folder, so a plugin cannot
read or write another plugin's data or another project's through it.

Writes here are the one exception to "only the worker writes project files":
they are the plugin's own records and files, written through this object
(atomically). The core reaches plugin studies through the ``plugin_studies.*`` RPCs.

JSON records (``read_json``/``write_json``) and binary files (``read_bytes``,
``write_bytes``, ``atomic_path``, ``list_files``, ``delete_file``) share the one
folder; a workspace sees it as ``ws.data`` and ``ws.files``. :func:`data_rel`
holds the path rules. The host's file routes (``scripts/server/plugin-files.ts``)
mirror them, and both pass ``tests/fixtures/plugin-file-paths.json``.

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
import stat
import string
import tempfile
import time
from collections.abc import Callable, Iterator, Mapping, Sequence
from contextlib import contextmanager
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, BinaryIO, TypedDict

PLUGIN_KEY_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,120}$")
STUDY_ID_RE = re.compile(r"^[a-z0-9][a-z0-9-]{0,63}$")
KIND_KEY_RE = re.compile(r"^[a-z][a-z0-9_]{0,40}$")
STALE_MESSAGE = "This study changed in another tab. Reload to continue."
STUDY_RECORD_MESSAGE = "a study's record changes only through the study calls"
# Temp files the host and this module write in a plugin's folder start with this.
# Every name starting with ".magnusim" (any case) is the host's: no path may name
# one, and listings leave them out.
FILE_TEMP_PREFIX = ".magnusim-"
# Files and folders a plugin's folder may hold in a project, for the host's
# checks on ws.files and ws.data (scripts/server/plugin-files.ts MAX_ENTRIES).
MAX_ENTRIES = 100_000

_RESERVED_PREFIX = ".magnusim"
_JSON_TEMP_PREFIX = ".magnusim-tmp-"
# A target's extension kept on its temp (".magnusim-<hex>.part.msh").
_TEMP_EXT = re.compile(r"\.[A-Za-z0-9]{1,16}")
_STUDY_CONTAINER_MESSAGE = "a study is removed only through the study calls"
_STUDY_FOLDER_MESSAGE = "only the study calls write directly in the studies folder"
_MB = 1024 * 1024
_PATH_REQUIRED = "a path inside the plugin's data folder is required"
_WHITESPACE = " \t\n\v\f\r"
# `:` (drive letters, NTFS streams) and `~` (8.3 short names) can alias another
# file on Windows; Windows refuses the rest in a name.
_PART_BAD = re.compile(r'[:~<>"|?*\x00-\x1f\x7f]')
# Matched against the ASCII-lowercased name (as JavaScript's /i does).
_DEVICE = re.compile(r"(?:con|prn|aux|nul|com[0-9\u00b9\u00b2\u00b3]|lpt[0-9\u00b9\u00b2\u00b3]|conin\$|conout\$)(?:\.|\Z)")
_ASCII_LOWER = str.maketrans(string.ascii_uppercase, string.ascii_lowercase)
# JSON temps from before API 1.2 (".tmp-<random>.json"); `.` as JavaScript's.
_OLD_JSON_TEMP = re.compile(r"\.tmp-[^\n\r  ]*\.json\Z")
_MAX_TEXT = 1024
_MAX_PART = 255
_MAX_PARTS = 32
_MAX_REL = 240
_RETRIES = 8
_IO_REPARSE_TAG_MOUNT_POINT = 0xA0000003
_EPOCH = datetime(1970, 1, 1)


class PluginDataError(ValueError):
    """A request outside what the plugin's data scope allows.

    ``code`` names the case as the host's file routes do: ``invalid_path``,
    ``study_record``, ``is_folder``, ``not_folder``, ``busy``.
    """

    code = "bad_request"

    def __init__(self, message: str = "", code: str | None = None) -> None:
        super().__init__(message)
        if code:
            self.code = code


class StaleRevisionError(PluginDataError):
    """The study changed since the caller read it (its rev is newer)."""

    code = "stale"

    def __init__(self, current: int) -> None:
        super().__init__(STALE_MESSAGE)
        self.current = current


class StudyNotFoundError(PluginDataError):
    """No such study in this plugin's folder (deleted, or never made)."""

    code = "study_not_found"


class FileInfo(TypedDict):
    """One file in a plugin's folder, as the host's file routes return it.

    ``rel``: posix path from the plugin's folder, spelled as on disk.
    ``size``: bytes.
    ``mtime``: last write, ISO-8601 UTC with whole milliseconds, e.g.
    ``"2023-11-14T22:13:20.123Z"`` (nanoseconds floored to milliseconds).
    ``etag``: ``'"' + ino hex + "-" + size hex + "-" + mtime ns hex + '"'`` from
    ``os.stat`` (``st_ino``, ``st_size``, ``st_mtime_ns``), quotes included, e.g.
    ``'"1a2b-400-17979cfe362a0f7c"'``. It changes whenever the file is replaced.
    """

    rel: str
    size: int
    mtime: str
    etag: str


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def version_tuple(version: str) -> tuple[int, ...]:
    out: list[int] = []
    for part in str(version or "0").split("."):
        m = re.match(r"\d+", part)
        out.append(int(m.group(0)) if m else 0)
    return tuple(out)


# -- path rules ---------------------------------------------------------


def _bad(message: str) -> PluginDataError:
    return PluginDataError(message, code="invalid_path")


def _units(text: str) -> int:
    """Length in UTF-16 code units: what Windows' name limits and JavaScript count."""
    return len(text.encode("utf-16-le", "surrogatepass")) // 2


def _shown(part: str) -> str:
    return repr(part if len(part) <= 40 else part[:40] + "...")


def _check_part(part: str) -> None:
    if part == "..":
        raise _bad("'..' is not allowed in a path")
    if _PART_BAD.search(part):
        raise _bad(f"{_shown(part)} has a character that is not allowed in a file name")
    if part.endswith((".", " ")):
        raise _bad(f"{_shown(part)} ends with a dot or a space")
    low = part.translate(_ASCII_LOWER)
    if _DEVICE.match(low):
        raise _bad(f"{_shown(part)} is a name Windows keeps for a device")
    if _units(part) > _MAX_PART:
        raise _bad(f"{_shown(part)} is longer than {_MAX_PART} characters")
    if low.startswith(_RESERVED_PREFIX):
        raise _bad(f"{_shown(part)}: names starting with .magnusim are kept for the app")


def is_study_record(parts: Sequence[str]) -> bool:
    """studies/<sid>/study.json in any spelling Windows opens as that file."""
    norm = [str(p).rstrip(" .").lower() for p in parts]
    return len(norm) >= 3 and norm[0] == "studies" and norm[-1] == "study.json"


def is_study_container(parts: Sequence[str]) -> bool:
    """``studies`` or ``studies/<x>``: only the study calls make and remove these,
    so no file is written there (it would block a study's folder) and none is deleted."""
    norm = [str(p).rstrip(" .").lower() for p in parts]
    return 1 <= len(norm) <= 2 and norm[0] == "studies"


def _check_writable(parts: Sequence[str]) -> None:
    if is_study_record(parts):
        raise PluginDataError(STUDY_RECORD_MESSAGE, code="study_record")
    if is_study_container(parts):
        raise PluginDataError(_STUDY_FOLDER_MESSAGE, code="study_record")


def _check_removable(parts: Sequence[str]) -> None:
    if is_study_record(parts):
        raise PluginDataError(STUDY_RECORD_MESSAGE, code="study_record")
    if is_study_container(parts):
        raise PluginDataError(_STUDY_CONTAINER_MESSAGE, code="study_record")


def data_rel(rel: str | None, *, write: bool, allow_empty: bool = False) -> str:
    """A path in a plugin's folder as a plugin or its workspace may name it.

    Backslashes become ``/``; ASCII whitespace is trimmed at both ends; ``""``
    and ``.`` parts drop out. Refused (``invalid_path``): a path over 1024
    characters, one starting with ``/``, ``..``, a name with ``: ~ < > " | ? *``
    or a control character, a name ending with a dot or a space, a Windows
    device name (``con``, ``nul.txt``, ``com1``, ...), a name over 255
    characters, a name starting with ``.magnusim`` (the host's temp and staging
    files), more than 32 parts, or more than 240 characters in all. Lengths are
    UTF-16 code units. A write never names a study's record, ``studies`` or
    ``studies/<x>`` (``study_record``). Returns the parts joined with ``/``;
    ``""`` (the plugin's folder) only when ``allow_empty``.
    """
    if rel is None:
        rel = ""
    if not isinstance(rel, str):
        raise _bad("a path must be text")
    text = rel.replace("\\", "/").strip(_WHITESPACE)
    if _units(text) > _MAX_TEXT:
        raise _bad(f"that path is longer than {_MAX_TEXT} characters")
    if text.startswith("/"):
        raise _bad("a path must be relative to the plugin's folder")
    parts = [part for part in text.split("/") if part not in ("", ".")]
    if not parts:
        if allow_empty:
            return ""
        raise _bad(_PATH_REQUIRED)
    for part in parts:
        _check_part(part)
    if len(parts) > _MAX_PARTS:
        raise _bad(f"that path is more than {_MAX_PARTS} folders deep")
    joined = "/".join(parts)
    if _units(joined) > _MAX_REL:
        raise _bad(f"that path is longer than {_MAX_REL} characters")
    if write:
        _check_writable(parts)
    return joined


def _check_real(parts: Sequence[str], *, write: bool = False, delete: bool = False) -> None:
    """The rules that must hold where a path really lands (long, real names)."""
    for part in parts:
        if part.translate(_ASCII_LOWER).startswith(_RESERVED_PREFIX):
            raise _bad(f"{_shown(part)}: names starting with .magnusim are kept for the app")
    if write:
        _check_writable(parts)
    if delete:
        _check_removable(parts)


def _under(root: Path, target: Path) -> tuple[str, ...] | None:
    """target's parts below root; None when it is not inside (any case on Windows)."""
    head, tail = root.parts, target.parts
    if len(tail) < len(head):
        return None
    if [os.path.normcase(p) for p in tail[: len(head)]] != [os.path.normcase(p) for p in head]:
        return None
    return tuple(tail[len(head) :])


# -- files --------------------------------------------------------------


def _is_link(st: os.stat_result) -> bool:
    """A symlink, or on Windows a junction (lstat reports that as a folder)."""
    return stat.S_ISLNK(st.st_mode) or getattr(st, "st_reparse_tag", 0) == _IO_REPARSE_TAG_MOUNT_POINT


def _reserved(name: str) -> bool:
    """The host's temp and staging files and folders (any case)."""
    return name.translate(_ASCII_LOWER).startswith(_RESERVED_PREFIX)


def _mtime_ns(st: os.stat_result) -> int:
    """st_mtime_ns as the host's Node reads it: on Windows its stat keeps the
    seconds as an unsigned 32-bit count, so a time outside 1970..2106 wraps there;
    it wraps here the same way, so both give one etag and mtime."""
    ns = st.st_mtime_ns
    if os.name == "nt":
        sec, nsec = divmod(ns, 1_000_000_000)
        ns = (sec % 2**32) * 1_000_000_000 + nsec
    return ns


def _mtime_iso(ns: int) -> str:
    ms = ns // 1_000_000
    try:
        return (_EPOCH + timedelta(milliseconds=ms)).isoformat(timespec="milliseconds") + "Z"
    except OverflowError:  # outside years 1..9999
        return ""


def _file_info(rel: str, st: os.stat_result) -> FileInfo:
    ns = _mtime_ns(st)
    return {
        "rel": rel,
        "size": int(st.st_size),
        "mtime": _mtime_iso(ns),
        "etag": f'"{st.st_ino:x}-{st.st_size:x}-{ns:x}"',
    }


def _retry(fn: Callable[[], object]) -> None:
    """Run a replace or delete again while another program (a virus scanner, an
    indexer, a viewer) holds the file: 8 tries, 50, 100, ... 350 ms apart."""
    for attempt in range(_RETRIES):
        try:
            fn()
            return
        except PermissionError:
            if attempt == _RETRIES - 1:
                raise
            time.sleep(0.05 * (attempt + 1))


def _busy(fn: Callable[[], object], rel: str) -> None:
    try:
        _retry(fn)
    except PermissionError as exc:
        raise PluginDataError(f"{rel} is in use by another program", code="busy") from exc


@contextmanager
def _atomic(target: Path, rel: str) -> Iterator[Path]:
    """A temp file next to target that replaces it in one step (removed on error)."""
    target.parent.mkdir(parents=True, exist_ok=True)
    # The target's extension stays last: a mesher or exporter picks its format from it.
    ext = target.suffix if _TEMP_EXT.fullmatch(target.suffix) else ""
    tmp = target.parent / f"{FILE_TEMP_PREFIX}{secrets.token_hex(8)}.part{ext}"
    try:
        yield tmp
        _busy(lambda: os.replace(tmp, target), rel)
    except BaseException:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise


def _count_files(folder: Path) -> int:
    """Files under a folder (a link is not one, and is not followed)."""
    count = 0
    stack = [folder]
    while stack:
        here = stack.pop()
        try:
            entries = list(os.scandir(here))
        except OSError:
            continue
        for entry in entries:
            try:
                st = os.lstat(entry.path)
            except OSError:
                continue
            if _is_link(st):
                continue
            if stat.S_ISDIR(st.st_mode):
                stack.append(Path(entry.path))
            elif stat.S_ISREG(st.st_mode):
                count += 1
    return count


def _atomic_write_json(path: Path, doc: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(prefix=_JSON_TEMP_PREFIX, suffix=".json", dir=str(path.parent))
    try:
        with os.fdopen(fd, "w", encoding="utf-8", newline="\n") as fh:
            json.dump(doc, fh, indent=2, ensure_ascii=False)
            fh.write("\n")
        _retry(lambda: os.replace(tmp, path))
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

    @classmethod
    def from_scope(cls, scope: Mapping[str, Any]) -> PluginData:
        """The calling plugin's folder in the call's project (a service method's scope)."""
        project = (scope or {}).get("project_dir")
        if not project:
            raise PluginDataError("this call has no open project")
        return cls(project, str(scope.get("plugin") or ""))

    @classmethod
    def from_env(cls, environ: Mapping[str, str] | None = None) -> PluginData:
        """The plugin's folder in the project a plugin job runs for: the host sets
        MAGNUSIM_PROJECT_DIR and MAGNUSIM_PLUGIN_KEY for a plugin's jobs."""
        env = os.environ if environ is None else environ
        project = env.get("MAGNUSIM_PROJECT_DIR") or ""
        if not project:
            raise PluginDataError("MAGNUSIM_PROJECT_DIR is not set (the host sets it for a plugin's jobs)")
        return cls(project, env.get("MAGNUSIM_PLUGIN_KEY") or "")

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

    # -- files (API 1.2) ------------------------------------------------

    def _real_root(self) -> Path:
        """This plugin's folder as it really is; refused when a link or junction
        swapped in for it (or for ``plugins``) points anywhere else."""
        root = self.root.resolve()
        if os.path.normcase(str(root)) != os.path.normcase(str(self.root)):
            raise _bad("the plugin's data folder is a link to another folder")
        return root

    def _locate(
        self,
        clean: str,
        *,
        write: bool = False,
        delete: bool = False,
        allow_root: bool = False,
        follow_last: bool = True,
    ) -> tuple[Path, Path, tuple[str, ...]]:
        """(real root, target, target's real parts) for a rel that passed
        :func:`data_rel`, checked again where it really lands: the resolved path
        has Windows' long, real names, so an 8.3 alias or a link inside the folder
        cannot reach a study's record. ``follow_last=False`` keeps a link at the
        end itself (a delete removes the link, not what it points to)."""
        root = self._real_root()
        names = clean.split("/") if clean else []
        if names and not follow_last:
            parent = root.joinpath(*names[:-1]).resolve() if len(names) > 1 else root
            target = parent / names[-1]
        else:
            target = root.joinpath(*names).resolve() if names else root
        parts = _under(root, target)
        if parts is None:
            raise _bad("path leaves the plugin's data folder")
        if not parts and not allow_root:
            raise _bad(_PATH_REQUIRED)
        _check_real(parts, write=write, delete=delete)
        return root, target, parts

    @staticmethod
    def _check_study(root: Path, parts: Sequence[str]) -> None:
        """A file in a study's folder needs the study (it may have been removed
        meanwhile; its folder is not made again without its record)."""
        if len(parts) >= 3 and parts[0].rstrip(" .").lower() == "studies":
            if not (root / parts[0] / parts[1] / "study.json").is_file():
                raise StudyNotFoundError(f"no study {parts[1]!r} (it was removed)")

    def _write_target(self, rel: str) -> tuple[Path, tuple[str, ...]]:
        clean = data_rel(rel, write=True)
        root, target, parts = self._locate(clean, write=True)
        if target.is_dir():
            raise PluginDataError(f"{clean} is a folder", code="is_folder")
        for depth in range(1, len(parts)):
            folder = root.joinpath(*parts[:depth])
            if folder.exists() and not folder.is_dir():
                raise PluginDataError(f"{'/'.join(parts[:depth])} is a file, not a folder", code="is_folder")
        self._check_study(root, parts)
        return target, parts

    def file_path(self, rel: str, *, write: bool = False) -> Path:
        """Where ``rel`` is on disk, after the path rules (:func:`data_rel`); for a
        write also checked where it lands, so it never reaches a study's record,
        and a file in a study's folder needs that study (:class:`StudyNotFoundError`)."""
        root, target, parts = self._locate(data_rel(rel, write=write), write=write)
        if write:
            self._check_study(root, parts)
        return target

    def file_info(self, rel: str) -> FileInfo | None:
        """A file's rel, size, mtime and etag; None when there is no such file."""
        _root, target, parts = self._locate(data_rel(rel, write=False))
        try:
            st = os.stat(target)
        except (FileNotFoundError, NotADirectoryError):
            return None
        if not stat.S_ISREG(st.st_mode):
            return None
        return _file_info("/".join(parts), st)

    def read_bytes(self, rel: str) -> bytes | None:
        """A file's bytes; None when there is no such file."""
        target = self.file_path(rel)
        if not target.is_file():
            return None
        try:
            return target.read_bytes()
        except FileNotFoundError:
            return None

    def open_bytes(self, rel: str) -> BinaryIO:
        """A file opened for reading (a large file, read in pieces). Raises
        FileNotFoundError when there is none."""
        return open(self.file_path(rel), "rb")

    def write_bytes(self, rel: str, data: bytes | bytearray | memoryview) -> FileInfo:
        """Save a file in one step (a reader never sees half of it); returns its info."""
        target, parts = self._write_target(rel)
        shown = "/".join(parts)
        with _atomic(target, shown) as tmp, open(tmp, "wb") as fh:
            fh.write(data)
        return _file_info(shown, os.stat(target))

    @contextmanager
    def atomic_path(self, rel: str) -> Iterator[Path]:
        """A temp path next to ``rel`` for code that writes the file itself (a
        mesher, an exporter). Write it inside the block; when the block ends it
        replaces ``rel`` in one step. The temp (``.magnusim-<hex>.part`` plus
        ``rel``'s extension, so a writer that picks its format from the name
        still does) is removed when the block raises::

            with data.atomic_path("studies/st-1/mesh.msh") as tmp:
                gmsh.write(str(tmp))
        """
        target, parts = self._write_target(rel)
        with _atomic(target, "/".join(parts)) as tmp:
            yield tmp

    def list_files(self, prefix: str = "") -> list[FileInfo]:
        """Every file under ``prefix`` (a folder; "" is the plugin's folder), sorted
        by rel. Never follows a link or junction, and leaves out the host's temp and
        staging files. A missing folder lists nothing."""
        clean = data_rel(prefix, write=False, allow_empty=True)
        _root, folder, base = self._locate(clean, allow_root=True)
        try:
            st = os.stat(folder)
        except (FileNotFoundError, NotADirectoryError):
            return []
        if not stat.S_ISDIR(st.st_mode):
            raise PluginDataError(f"{clean} is a file, not a folder", code="not_folder")
        out: list[FileInfo] = []
        stack: list[tuple[Path, tuple[str, ...]]] = [(folder, base)]
        while stack:
            here, parts = stack.pop()
            try:
                entries = list(os.scandir(here))
            except (FileNotFoundError, NotADirectoryError):
                continue
            for entry in entries:
                if _reserved(entry.name):
                    continue
                try:
                    est = os.lstat(entry.path)
                except FileNotFoundError:
                    continue
                if _is_link(est):
                    continue
                rel_parts = (*parts, entry.name)
                if stat.S_ISDIR(est.st_mode):
                    stack.append((Path(entry.path), rel_parts))
                elif stat.S_ISREG(est.st_mode) and not _OLD_JSON_TEMP.match(entry.name):
                    out.append(_file_info("/".join(rel_parts), est))
        # UTF-16 code-unit order, as JavaScript sorts strings.
        out.sort(key=lambda f: f["rel"].encode("utf-16-be", "surrogatepass"))
        return out

    def usage(self, limit: int = MAX_ENTRIES) -> tuple[int, int]:
        """(bytes in files, files and folders) in this plugin's folder, as the host's
        quota counts them: no link followed, and none of the host's own names
        (``.magnusim*``). Counting stops a little past ``limit`` entries."""
        root = self._real_root()
        size = entries = 0
        stack = [root]
        while stack and entries <= limit:
            try:
                found = list(os.scandir(stack.pop()))
            except (FileNotFoundError, NotADirectoryError):
                continue
            for entry in found:
                if _reserved(entry.name):
                    continue
                try:
                    st = entry.stat(follow_symlinks=False)
                except FileNotFoundError:
                    continue
                if _is_link(st):
                    continue
                entries += 1
                if stat.S_ISDIR(st.st_mode):
                    stack.append(Path(entry.path))
                elif stat.S_ISREG(st.st_mode):
                    size += st.st_size
        return size, entries

    def check_room(self, target: Path, size: int, max_total_bytes: int) -> None:
        """The host's check before a workspace writes ``size`` bytes at ``target``
        (``ws.data``): the plugin's ``[files] max_total_mb`` and :data:`MAX_ENTRIES`
        hold for the whole folder, as for ``ws.files``. Raises ``quota``."""
        used, entries = self.usage()
        try:
            st = os.lstat(target)
        except (FileNotFoundError, NotADirectoryError):
            st = None
        if entries + (0 if st else 1) > MAX_ENTRIES:
            raise PluginDataError(f"a plugin may keep {MAX_ENTRIES} files and folders in a project", code="quota")
        replaced = st.st_size if st is not None and stat.S_ISREG(st.st_mode) else 0
        if used + size - replaced > max_total_bytes:
            raise PluginDataError(
                f"this plugin's files may take {round(max_total_bytes / _MB)} MB in a project", code="quota"
            )

    def delete_file(self, rel: str, *, recursive: bool = False) -> int:
        """Delete a file, or a folder and everything in it when ``recursive``.
        Returns how many files went (0 when there was nothing). A link or junction
        is removed itself, never what it points to. A study's record and its folder
        go only through the study calls."""
        clean = data_rel(rel, write=False)
        _check_removable(clean.split("/"))
        root, target, _parts = self._locate(clean, delete=True, follow_last=False)
        try:
            st = os.lstat(target)
        except (FileNotFoundError, NotADirectoryError):
            return 0
        if _is_link(st):
            try:
                _busy(lambda: os.unlink(target), clean)
            except FileNotFoundError:
                return 0
            return 1
        # Checked again under its real (long) name.
        real = target.resolve()
        parts = _under(root, real)
        if parts is None:
            raise _bad("path leaves the plugin's data folder")
        _check_real(parts, delete=True)
        if stat.S_ISDIR(st.st_mode):
            if not recursive:
                raise PluginDataError(f"{clean} is a folder", code="is_folder")
            count = _count_files(real)
            try:
                _busy(lambda: shutil.rmtree(real), clean)
            except FileNotFoundError:
                pass
            return count
        try:
            _busy(lambda: os.unlink(real), clean)
        except FileNotFoundError:
            return 0
        return 1

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
            raise StudyNotFoundError(f"no study {sid!r}")
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
