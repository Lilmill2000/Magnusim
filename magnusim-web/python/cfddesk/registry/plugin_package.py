"""Plugin packages: a plugin folder in a zip, installed into the user's plugins folder.

``npm run plugin:pack -- <key>`` makes one (:func:`pack_plugin`); Settings ->
Plugins -> "Install plugin from zip..." installs one (:func:`inspect_package`,
then :func:`install_package`), and "Remove" takes a user copy away again
(:func:`remove_user_copies`). A package with the key of a bundled plugin is an
update: it is installed only when it is newer than the app's own copy, and the
app uses whichever copy is newer (discovery.pick_plugin_copies).

A zip is checked before anything is written: one plugin folder (or the plugin's
files at the top), relative names only (no ``..``, drive, backslash, link or
name Windows cannot hold), no two names that differ only in case, and limits on
the number and size of its files. It is unpacked into ``.cache/plugin-incoming``
and only then moved into place; the copy it replaces is moved aside first and
moved back if anything fails.
"""

from __future__ import annotations

import errno
import os
import re
import shutil
import stat
import subprocess
import time
import zipfile
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from cfddesk.registry.discovery import (
    _api_compatible,
    _host_api_version,
    _parse_toml,
    bundled_dir_for,
    plugins_dir_for,
)
from cfddesk.registry.versions import compare_versions, parse_version

MB = 1024 * 1024
# A package's own size (the server refuses a bigger upload before reading it).
MAX_PACKAGE_BYTES = 512 * MB
# Its files once unpacked, and how many there are.
MAX_UNPACKED_BYTES = 2048 * MB
MAX_FILES = 20000
# A name inside the plugin folder; the plugins folder's own path comes on top.
MAX_NAME_CHARS = 160

# Keys the server accepts in a URL (validPluginKey in the routes).
KEY_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,120}$")
_BACKSLASH = chr(92)
# Characters Windows does not allow in a file name, and control characters.
_BAD_CHARS = set('<>:"|?*' + _BACKSLASH) | {chr(c) for c in range(32)}
# Device names Windows reserves, with any extension (COM and LPT with a digit or a
# superscript one, two or three, which Windows also takes for a digit).
_PORT_DIGITS = "123456789" + chr(0xB9) + chr(0xB2) + chr(0xB3)
_RESERVED = {
    "con",
    "prn",
    "aux",
    "nul",
    "conin$",
    "conout$",
    "clock$",
    *(f"com{d}" for d in _PORT_DIGITS),
    *(f"lpt{d}" for d in _PORT_DIGITS),
}
# Left out of a package: tests, caches and what a build or an editor leaves behind.
PACK_SKIP_DIRS = {
    "tests",
    "e2e",
    "node_modules",
    "__pycache__",
    ".cache",
    ".venv",
    ".git",
    ".pytest_cache",
    ".mypy_cache",
    ".ruff_cache",
}
PACK_SKIP_FILES = {".DS_Store", "Thumbs.db"}
# Zips made on a Mac carry this folder of Finder data next to the plugin.
_MAC_JUNK = "__MACOSX/"


class PackageError(Exception):
    """Why a package cannot be installed (``code`` for the UI and the tests)."""

    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code
        self.message = message


@dataclass
class Package:
    """What a checked zip holds."""

    key: str
    meta: dict[str, Any]
    # The folder inside the zip holding the plugin ("" when its files are at the top).
    top: str
    # (name in the zip, name inside the plugin folder) of every file.
    files: list[tuple[str, str]] = field(default_factory=list)
    unpacked_bytes: int = 0


def _name_problem(rel: str) -> str | None:
    """Why ``rel`` (a name inside the zip) cannot be unpacked safely, or None."""
    if not rel:
        return "an empty name"
    if rel.startswith("/") or _BACKSLASH in rel:
        return f"{rel!r} is not a relative name with forward slashes"
    parts = rel.rstrip("/").split("/")
    for part in parts:
        if part in ("", ".", ".."):
            return f"{rel!r} has an empty, '.' or '..' part"
        if any(ch in _BAD_CHARS for ch in part):
            return f"{rel!r} has a character Windows does not allow in a name"
        if part.endswith((".", " ")):
            return f"{rel!r} has a part ending in a dot or a space"
        if part.split(".")[0].lower() in _RESERVED:
            return f"{rel!r} uses a name Windows reserves ({part})"
        if len(part) > 255:
            return f"{rel!r} has a part longer than 255 characters"
    return None


def _is_link(info: zipfile.ZipInfo) -> bool:
    mode = (info.external_attr >> 16) & 0xFFFF
    return stat.S_ISLNK(mode)


def read_package(zip_path: Path | str) -> Package:
    """Check a zip and read its manifest; nothing is written. Raises PackageError."""
    path = Path(zip_path)
    try:
        size = path.stat().st_size
    except OSError as exc:
        raise PackageError("unreadable", f"the file could not be read: {exc.strerror or exc}") from None
    if size > MAX_PACKAGE_BYTES:
        raise PackageError("too_big", f"the file is {size // MB} MB; a plugin package is at most {MAX_PACKAGE_BYTES // MB} MB")
    try:
        zf = zipfile.ZipFile(path)
    except (zipfile.BadZipFile, OSError):
        raise PackageError("not_zip", "this is not a zip file") from None
    with zf:
        infos = [i for i in zf.infolist() if not i.filename.startswith(_MAC_JUNK)]
        files = [i for i in infos if not i.is_dir()]
        if not files:
            raise PackageError("empty", "the zip is empty")
        if len(files) > MAX_FILES:
            raise PackageError("too_many_files", f"the zip holds {len(files)} files; at most {MAX_FILES}")
        seen: dict[str, str] = {}
        total = 0
        for info in infos:
            why = _name_problem(info.filename)
            if why:
                raise PackageError("bad_name", f"the zip cannot be unpacked safely: {why}")
            if info.flag_bits & 0x1:
                raise PackageError("encrypted", f"{info.filename!r} is encrypted; a plugin package cannot be")
            if _is_link(info):
                raise PackageError("link", f"{info.filename!r} is a link; a plugin package holds files and folders only")
            low = info.filename.rstrip("/").lower()
            if low in seen and seen[low] != info.filename.rstrip("/"):
                raise PackageError(
                    "case_clash", f"{seen[low]!r} and {info.filename!r} differ only in case (Windows sees one file)"
                )
            seen[low] = info.filename.rstrip("/")
            if not info.is_dir():
                total += int(info.file_size)
        if total > MAX_UNPACKED_BYTES:
            raise PackageError("too_big", f"its files come to {total // MB} MB; at most {MAX_UNPACKED_BYTES // MB} MB")
        names = [i.filename for i in files]
        if "manifest.toml" in names:
            top = ""
        else:
            tops = {n.split("/", 1)[0] for n in names}
            loose = [n for n in names if "/" not in n]
            if loose or len(tops) != 1:
                raise PackageError(
                    "layout",
                    "the zip must hold one plugin folder (with manifest.toml and plugin.py in it); "
                    f"it has {', '.join(sorted(tops)[:4])}{' ...' if len(tops) > 4 else ''} at the top",
                )
            top = next(iter(tops))
        prefix = f"{top}/" if top else ""
        rels = [(n, n[len(prefix):]) for n in names]
        for _n, rel in rels:
            if len(rel) > MAX_NAME_CHARS:
                raise PackageError("bad_name", f"{rel!r} is longer than {MAX_NAME_CHARS} characters")
        have = {rel for _n, rel in rels}
        if "manifest.toml" not in have or "plugin.py" not in have:
            raise PackageError("not_plugin", "there is no manifest.toml and plugin.py in the plugin folder")
        if zf.getinfo(f"{prefix}manifest.toml").file_size > MB:
            raise PackageError("manifest", "manifest.toml is bigger than 1 MB")
        try:
            text = zf.read(f"{prefix}manifest.toml").decode("utf-8")
        except UnicodeDecodeError:
            raise PackageError("manifest", "manifest.toml is not UTF-8 text") from None
    meta, why = _parse_toml(text, source="manifest.toml")
    if meta is None:
        raise PackageError("manifest", f"manifest.toml {why}")
    key = str(meta.get("key") or top or "")
    if not KEY_RE.match(key) or key.endswith((".", " ")):
        raise PackageError("manifest", f"the manifest's key {key!r} is not a valid plugin key")
    version = str(meta.get("version") or "")
    if parse_version(version) is None:
        raise PackageError("manifest", f"the manifest's version {version!r} is not a version number (such as 1.2.0)")
    return Package(key=key, meta=meta, top=top, files=rels, unpacked_bytes=total)


def _manifest_of(folder: Path) -> dict[str, Any] | None:
    try:
        text = (folder / "manifest.toml").read_text(encoding="utf-8")
    except (OSError, UnicodeDecodeError):
        return None
    meta, _why = _parse_toml(text, source=str(folder / "manifest.toml"))
    return meta


def _copies_of(folder: Path | None, key: str) -> list[tuple[Path, dict[str, Any]]]:
    """The plugin folders in ``folder`` whose manifest has ``key`` (sorted by name)."""
    out: list[tuple[Path, dict[str, Any]]] = []
    if folder is None or not folder.is_dir():
        return out
    for child in sorted(folder.iterdir()):
        if not child.is_dir():
            continue
        meta = _manifest_of(child)
        if meta is not None and str(meta.get("key") or child.name) == key:
            out.append((child, meta))
    return out


def _all_keys(folder: Path | None) -> set[str]:
    """The keys of every plugin folder in ``folder``."""
    out: set[str] = set()
    if folder is None or not folder.is_dir():
        return out
    for child in folder.iterdir():
        meta = _manifest_of(child) if child.is_dir() else None
        if meta is not None:
            out.add(str(meta.get("key") or child.name))
    return out


def _newest(copies: list[tuple[Path, dict[str, Any]]]) -> str:
    best = ""
    for _d, meta in copies:
        ver = str(meta.get("version") or "")
        if not best or compare_versions(ver, best) > 0:
            best = ver
    return best


def inspect_package(zip_path: Path | str, web_root: Path) -> dict[str, Any]:
    """What installing this zip would do. Raises PackageError when it cannot be installed."""
    pkg = read_package(zip_path)
    meta = pkg.meta
    name = str(meta.get("name") or pkg.key)
    version = str(meta.get("version") or "")
    api = str(meta.get("api_version") or "1.0")
    if not _api_compatible(api):
        raise PackageError(
            "incompatible",
            f"{name} {version} is for plugin API {api}; this Magnusim has API {_host_api_version()}. "
            "It needs a different version of Magnusim.",
        )
    bundled = _copies_of(bundled_dir_for(web_root), pkg.key)
    bundled_version = str(bundled[0][1].get("version") or "0.0.0") if bundled else ""
    # Keys are case-sensitive, folder names on Windows are not: "Cad" beside "cad" would
    # be two plugins in one folder name.
    for here in _all_keys(bundled_dir_for(web_root)) | _all_keys(plugins_dir_for(web_root)):
        if here != pkg.key and here.lower() == pkg.key.lower():
            raise PackageError(
                "case_clash", f"its key {pkg.key!r} differs only in case from the plugin {here!r} already here"
            )
    if bundled and compare_versions(version, bundled_version) <= 0:
        raise PackageError(
            "not_newer",
            f"{name} {version} is not newer than the copy that comes with Magnusim ({bundled_version}), "
            "so it would not be used.",
        )
    plugins = plugins_dir_for(web_root)
    installed = _copies_of(plugins, pkg.key)
    installed_version = _newest(installed)
    clash = plugins / pkg.key
    if clash.exists() and all(d != clash for d, _m in installed):
        other = _manifest_of(clash) if clash.is_dir() else None
        what = f"the plugin {str(other.get('key'))!r}" if other else "something that is not this plugin"
        raise PackageError("folder_taken", f"the folder plugins/{pkg.key} already holds {what}")
    if installed_version:
        cmp = compare_versions(version, installed_version)
        action = "update" if cmp > 0 else ("reinstall" if cmp == 0 else "downgrade")
    else:
        action = "update" if bundled else "install"
    return {
        "key": pkg.key,
        "name": name,
        "version": version,
        "api_version": api,
        "description": str(meta.get("description") or ""),
        "authors": [str(a) for a in (meta.get("authors") or [])] if isinstance(meta.get("authors"), list) else [],
        "license": str(meta.get("license") or ""),
        "files": len(pkg.files),
        "unpacked_bytes": pkg.unpacked_bytes,
        # The app's own copy of a bundled plugin ("" when it is not one).
        "bundled_version": bundled_version,
        # The newest copy in the user's plugins folder now ("" when there is none).
        "installed_version": installed_version,
        # install (new), update (newer than what is used now), reinstall (same), downgrade.
        "action": action,
    }


def _other_drive(exc: OSError) -> bool:
    """A move between two drives (a rename cannot do it; waiting does not help)."""
    return exc.errno == errno.EXDEV or getattr(exc, "winerror", None) == 17


def _retry(fn: Any, *, attempts: int = 9) -> None:
    """Run a rename, retrying while Windows has the folder open (an antivirus scan,
    an Explorer window, a process just ended): about 9 s in all."""
    delay = 0.1
    for i in range(attempts):
        try:
            fn()
            return
        except FileNotFoundError:
            raise
        except OSError as exc:
            if i == attempts - 1 or _other_drive(exc):
                raise
            time.sleep(delay)
            delay = min(delay * 2, 2.0)


def _move_error(exc: OSError, what: str) -> PackageError:
    if _other_drive(exc):
        return PackageError("other_drive", f"{what} could not be moved: it is on another drive than its staging folder")
    return PackageError(
        "busy",
        f"{what} could not be moved: a program has it open (an Explorer window, an editor "
        "or a terminal there). Close it and try again.",
    )


def _rmtree(path: Path) -> bool:
    """Delete a folder, clearing read-only flags (git objects, packed files). True when gone."""

    def undo_readonly(func: Any, p: str, _exc: Any) -> None:
        try:
            os.chmod(p, stat.S_IWRITE)
            func(p)
        except OSError:
            pass

    try:
        shutil.rmtree(path, onerror=undo_readonly)
    except OSError:
        pass
    return not path.exists()


def _staging_roots(web_root: Path) -> list[Path]:
    """Where a package is unpacked and replaced copies wait: the app's .cache, or,
    when the plugins folder is on another drive (MAGNUSIM_PLUGINS_DIR), a folder
    beside it on that drive (never inside it: the scan reads every folder there).
    A move between drives is no rename, so staging is always on the plugins' drive."""
    cache = web_root / ".cache"
    plugins = plugins_dir_for(web_root)
    roots = [cache]
    try:
        cache.mkdir(parents=True, exist_ok=True)
        plugins.mkdir(parents=True, exist_ok=True)
        same = os.stat(cache).st_dev == os.stat(plugins).st_dev
    except OSError:
        same = True
    beside = plugins.resolve().parent / ".magnusim-plugin-staging"
    return roots if same else [beside, cache]


def _cache(web_root: Path, name: str) -> Path:
    d = _staging_roots(web_root)[0] / name
    d.mkdir(parents=True, exist_ok=True)
    return d


def _fresh(folder: Path, stem: str) -> Path:
    stamp = time.strftime("%Y%m%d-%H%M%S")
    n = 0
    while True:
        cand = folder / f"{stem}-{stamp}{f'-{n}' if n else ''}"
        if not cand.exists():
            return cand
        n += 1


def sweep(web_root: Path, *, older_than_s: float = 3600.0) -> None:
    """Delete what an earlier install or removal left in the cache folders."""
    now = time.time()
    for folder in (r / name for r in _staging_roots(web_root) for name in ("plugin-incoming", "plugin-replaced")):
        if not folder.is_dir():
            continue
        for child in folder.iterdir():
            # A previous version whose rollback failed: kept until the person moves it back.
            if child.name.endswith("-keep"):
                continue
            try:
                if now - child.stat().st_mtime < older_than_s:
                    continue
            except OSError:
                continue
            if child.is_dir():
                _rmtree(child)
            else:
                try:
                    child.unlink()
                except OSError:
                    pass


def _unpack(zip_path: Path, pkg: Package, dest: Path) -> None:
    """Unpack the plugin's files into ``dest``, never more bytes than each says it holds."""
    dest.mkdir(parents=True)
    root = dest.resolve()
    with zipfile.ZipFile(zip_path) as zf:
        for name, rel in pkg.files:
            target = (dest / rel).resolve()
            if root not in target.parents:
                raise PackageError("bad_name", f"{name!r} would land outside the plugin folder")
            target.parent.mkdir(parents=True, exist_ok=True)
            info = zf.getinfo(name)
            left = int(info.file_size)
            with zf.open(info) as src, open(target, "wb") as out:
                while True:
                    chunk = src.read(1024 * 1024)
                    if not chunk:
                        break
                    left -= len(chunk)
                    if left < 0:
                        raise PackageError("bad_zip", f"{name!r} holds more than its stated size")
                    out.write(chunk)


def _park(copies: list[Path], parked_root: Path) -> list[tuple[Path, Path]]:
    """Move each folder into ``parked_root``; on a failure, move back what moved and raise."""
    moved: list[tuple[Path, Path]] = []
    for d in copies:
        to = parked_root / d.name
        try:
            to.parent.mkdir(parents=True, exist_ok=True)
            _retry(lambda d=d, to=to: os.replace(d, to))
        except OSError as exc:
            _unpark(moved)
            raise _move_error(exc, f"plugins/{d.name}") from None
        moved.append((d, to))
    return moved


def _unpark(moved: list[tuple[Path, Path]]) -> None:
    for d, to in reversed(moved):
        try:
            _retry(lambda d=d, to=to: os.replace(to, d))
        except OSError:
            pass


def install_package(zip_path: Path | str, web_root: Path) -> dict[str, Any]:
    """Install a checked package as ``plugins/<key>``, replacing the user's copies
    of that plugin. Returns inspect_package's answer plus ``parked``: the folder
    holding the copies it replaced, kept until the new copy is known to load
    (:func:`commit_install` deletes it, :func:`rollback_install` puts them back).
    Raises PackageError."""
    path = Path(zip_path)
    info = inspect_package(path, web_root)
    pkg = read_package(path)
    sweep(web_root)
    plugins = plugins_dir_for(web_root)
    plugins.mkdir(parents=True, exist_ok=True)
    staging = _fresh(_cache(web_root, "plugin-incoming"), pkg.key)
    staged = staging / pkg.key
    try:
        _unpack(path, pkg, staged)
    except PackageError:
        _rmtree(staging)
        raise
    except OSError as exc:
        _rmtree(staging)
        raise PackageError("write_failed", f"unpacking failed: {exc.strerror or exc}") from None
    old = [d for d, _m in _copies_of(plugins, pkg.key)]
    parked_root = _fresh(_cache(web_root, "plugin-replaced"), pkg.key)
    moved = _park(old, parked_root)
    target = plugins / pkg.key
    try:
        _retry(lambda: os.replace(staged, target))
    except OSError as exc:
        _unpark(moved)
        _rmtree(staging)
        raise _move_error(exc, f"plugins/{pkg.key}") from None
    _rmtree(staging)
    return {**info, "dir": pkg.key, "parked": str(parked_root)}


def commit_install(parked: str | Path) -> None:
    """The new copy loaded: the copies it replaced go."""
    if parked and Path(parked).is_dir():
        _rmtree(Path(parked))


def keep_parked(parked: str | Path) -> str:
    """Putting the replaced copies back failed: rename their folder so the sweep
    never deletes it (``-keep-`` in its name); its path, for the person to move back."""
    root = Path(parked)
    if not root.is_dir():
        return ""
    kept = root.with_name(f"{root.name}-keep")
    try:
        os.replace(root, kept)
    except OSError:
        return str(root)
    return str(kept)


def rollback_install(key: str, parked: str | Path, web_root: Path) -> None:
    """The new copy did not load: take it away and put back the copies it replaced."""
    plugins = plugins_dir_for(web_root)
    target = plugins / key
    if target.is_dir():
        aside = _fresh(_cache(web_root, "plugin-replaced"), f"{key}-failed")
        try:
            _retry(lambda: os.replace(target, aside))
        except OSError as exc:
            raise _move_error(exc, f"plugins/{key}") from None
        _rmtree(aside)
    root = Path(parked) if parked else None
    if root is not None and root.is_dir():
        for child in sorted(root.iterdir()):
            try:
                _retry(lambda child=child: os.replace(child, plugins / child.name))
            except OSError as exc:
                raise _move_error(exc, f"the previous {child.name}") from None
        _rmtree(root)


def remove_user_copies(key: str, web_root: Path) -> dict[str, Any]:
    """Remove every copy of ``key`` in the user's plugins folder. A bundled plugin
    goes back to the app's own copy; a user plugin is gone (its environment and
    its files in projects stay). Raises PackageError."""
    if not KEY_RE.match(key):
        raise PackageError("bad_key", "invalid plugin key")
    plugins = plugins_dir_for(web_root)
    copies = [d for d, _m in _copies_of(plugins, key)]
    if not copies:
        raise PackageError("not_found", f"there is no copy of {key} in the plugins folder")
    sweep(web_root)
    parked_root = _fresh(_cache(web_root, "plugin-replaced"), key)
    _park(copies, parked_root)
    _rmtree(parked_root)
    bundled = _copies_of(bundled_dir_for(web_root), key)
    return {
        "key": key,
        "removed": [d.name for d in copies],
        "bundled_version": str(bundled[0][1].get("version") or "0.0.0") if bundled else "",
    }


# ---------------------------------------------------------------------------
# plugin:pack
# ---------------------------------------------------------------------------


def _git_files(folder: Path) -> list[str] | None:
    """The files git tracks in ``folder`` (relative, forward slashes), or None
    when it is not in a git checkout."""
    try:
        r = subprocess.run(
            ["git", "ls-files", "-z", "--", "."],
            cwd=folder,
            capture_output=True,
            timeout=60,
            check=False,
        )
    except (OSError, subprocess.SubprocessError):
        return None
    if r.returncode != 0:
        return None
    return [p for p in r.stdout.decode("utf-8").split("\0") if p]


def _walk_files(folder: Path) -> list[str]:
    out: list[str] = []
    for dirpath, dirnames, filenames in os.walk(folder):
        dirnames[:] = sorted(d for d in dirnames if d not in PACK_SKIP_DIRS)
        for name in sorted(filenames):
            out.append(Path(dirpath, name).relative_to(folder).as_posix())
    return out


def pack_files(folder: Path) -> tuple[list[str], str]:
    """The files a package of ``folder`` holds and where the list came from: the
    files git tracks there (so build output and local files stay out), else every
    file; never tests, caches or editor files (PACK_SKIP_DIRS / PACK_SKIP_FILES)."""
    tracked = _git_files(folder)
    names = tracked if tracked is not None else _walk_files(folder)
    kept = []
    for rel in names:
        parts = rel.split("/")
        if any(p in PACK_SKIP_DIRS for p in parts[:-1]) or parts[-1] in PACK_SKIP_FILES:
            continue
        if parts[-1].endswith((".pyc", ".pyo")):
            continue
        if not (folder / rel).is_file():
            continue  # tracked but deleted in the working tree
        kept.append(rel)
    return sorted(kept), ("git" if tracked is not None else "folder")


def pack_plugin(folder: Path | str, out_dir: Path | str) -> dict[str, Any]:
    """Zip a plugin folder as ``<out_dir>/<key>-v<version>.zip`` (one top folder named
    after its key) and write its SHA-256 next to it. Checked with read_package."""
    import hashlib

    src = Path(folder).resolve()
    meta = _manifest_of(src)
    if meta is None:
        raise PackageError("not_plugin", f"{src} has no readable manifest.toml")
    key = str(meta.get("key") or src.name)
    version = str(meta.get("version") or "")
    if parse_version(version) is None:
        raise PackageError("manifest", f"the manifest's version {version!r} is not a version number")
    files, origin = pack_files(src)
    for rel in files:
        why = _name_problem(rel)
        if why:
            raise PackageError("bad_name", f"cannot pack: {why}")
    out = Path(out_dir)
    out.mkdir(parents=True, exist_ok=True)
    target = out / f"{key}-v{version}.zip"
    tmp = target.with_suffix(".zip.part")
    with zipfile.ZipFile(tmp, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=9) as zf:
        for rel in files:
            st = (src / rel).stat()
            zi = zipfile.ZipInfo(f"{key}/{rel}", date_time=time.localtime(st.st_mtime)[:6])
            zi.compress_type = zipfile.ZIP_DEFLATED
            zi.external_attr = (0o100644 if not os.access(src / rel, os.X_OK) or os.name == "nt" else 0o100755) << 16
            with open(src / rel, "rb") as fh:
                zf.writestr(zi, fh.read(), compresslevel=9)
    os.replace(tmp, target)
    pkg = read_package(target)
    digest = hashlib.sha256(target.read_bytes()).hexdigest()
    sha = target.with_name(target.name + ".sha256")
    sha.write_text(f"{digest}  {target.name}\n", encoding="utf-8")
    return {
        "key": key,
        "version": version,
        "zip": str(target),
        "sha256": digest,
        "files": len(pkg.files),
        "bytes": target.stat().st_size,
        "unpacked_bytes": pkg.unpacked_bytes,
        "from": origin,
    }
