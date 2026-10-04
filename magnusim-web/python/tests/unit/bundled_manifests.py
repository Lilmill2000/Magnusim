"""The app's bundled plugins as their manifests declare them.

Tests whose answer depends on which bundled plugins a fresh install turns on read it
from here, so they hold whichever optional plugin ships on or off (manifest
``default_enabled``). No plugin is named here.
"""

from __future__ import annotations

import shutil
from pathlib import Path
from typing import Any

try:
    import tomllib
except ModuleNotFoundError:  # Python 3.10
    import tomli as tomllib

WEB = Path(__file__).resolve().parents[3]
BUNDLED = WEB / "bundled-plugins"


def bundled_manifests(folder: Path = BUNDLED) -> dict[str, dict[str, Any]]:
    """{plugin key: its manifest} for every bundled plugin folder (folder order)."""
    out: dict[str, dict[str, Any]] = {}
    for d in sorted(p for p in folder.iterdir() if (p / "manifest.toml").is_file()):
        meta = tomllib.loads((d / "manifest.toml").read_text(encoding="utf-8"))
        out[str(meta.get("key") or d.name)] = {**meta, "_dir": d}
    return out


def default_on_keys(folder: Path = BUNDLED) -> list[str]:
    """The bundled plugins a fresh install turns on: every one whose manifest does not
    set ``default_enabled = false`` (sorted keys)."""
    return sorted(k for k, m in bundled_manifests(folder).items() if m.get("default_enabled", True) is not False)


def default_off_keys(folder: Path = BUNDLED) -> list[str]:
    return sorted(k for k, m in bundled_manifests(folder).items() if m.get("default_enabled", True) is False)


def required_only_copy(dest: Path, folder: Path = BUNDLED) -> Path:
    """A bundled folder at ``dest`` holding only the required plugins (``required =
    true``): the app without its optional plugins, whichever ship on."""
    dest.mkdir(parents=True, exist_ok=True)
    for meta in bundled_manifests(folder).values():
        if meta.get("required") is True:
            d = meta["_dir"]
            shutil.copytree(d, dest / d.name, ignore=shutil.ignore_patterns("tests", "__pycache__", "node_modules"))
    return dest
