"""Build, check or remove a plugin's own Python environment (manifest ``[python]``).

    python tools/plugin_env.py create <key>      # build it (the Install dependencies job)
    python tools/plugin_env.py check <key>       # its state, as JSON
    python tools/plugin_env.py remove <key>      # delete its environments
    python tools/plugin_env.py create-bundled    # every bundled plugin that has one (Setup.ps1 -Plugins)

The plugin is found by its manifest.toml in the bundled and user plugin folders,
without importing its code. ``create`` prints job events (MAGNUSIM_EVENT lines:
stage, log, then result or error) and exits 1 when the build fails. See
:mod:`cfddesk.registry.plugin_env`.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any

_ROOT = Path(__file__).resolve().parents[1]
for _p in (_ROOT, _ROOT / "sdk"):
    if str(_p) not in sys.path:
        sys.path.insert(0, str(_p))

from magnusim_sdk.events import emit  # noqa: E402

from cfddesk.registry import plugin_env  # noqa: E402
from cfddesk.registry.discovery import (  # noqa: E402
    _parse_simple_toml,
    _resolve_web_root,
    bundled_dir_for,
    plugins_dir_for,
)


def _manifests(web_root: Path) -> list[tuple[str, Path, dict[str, Any], str]]:
    """(key, folder, manifest, tier) of every folder plugin, bundled first."""
    out: list[tuple[str, Path, dict[str, Any], str]] = []
    for tier, folder in (("bundled", bundled_dir_for(web_root)), ("user", plugins_dir_for(web_root))):
        if folder is None or not folder.is_dir():
            continue
        for child in sorted(folder.iterdir()):
            toml = child / "manifest.toml"
            if not toml.is_file():
                continue
            meta = _parse_simple_toml(toml.read_text(encoding="utf-8"), source=str(toml))
            if isinstance(meta, dict):
                out.append((str(meta.get("key") or child.name), child, meta, tier))
    return out


def _find(web_root: Path, key: str) -> tuple[Path, plugin_env.PythonEnvSpec]:
    for found, folder, meta, _tier in _manifests(web_root):
        if found == key:
            spec = plugin_env.python_env_from_meta(meta, folder)
            if spec is None:
                raise SystemExit(f"{key} declares no [python] environment")
            return folder, spec
    raise SystemExit(f"no plugin {key!r} in the plugin folders")


def _create(web_root: Path, key: str) -> int:
    folder, spec = _find(web_root, key)
    emit("start", key=key, lock_hash=spec.lock_hash)
    try:
        status = plugin_env.create_env(web_root, key, spec, folder, emit=emit)
    except plugin_env.EnvError as exc:
        emit("error", message=str(exc), tail=exc.tail[-12:])
        return 1
    emit("result", state=status["state"], lock_hash=spec.lock_hash, python_version=status.get("python_version", ""))
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("action", choices=["create", "check", "remove", "create-bundled"])
    parser.add_argument("key", nargs="?", default="")
    parser.add_argument("--web-root", default="")
    args = parser.parse_args(argv)
    web_root = _resolve_web_root(args.web_root or None)
    if web_root is None:
        raise SystemExit("no web root")
    if args.action == "create-bundled":
        failed = 0
        for key, folder, meta, tier in _manifests(web_root):
            if tier == "bundled" and plugin_env.python_env_from_meta(meta, folder) is not None:
                failed += _create(web_root, key)
        return 1 if failed else 0
    if not args.key:
        parser.error(f"{args.action} needs a plugin key")
    if args.action == "create":
        return _create(web_root, args.key)
    if args.action == "check":
        _folder, spec = _find(web_root, args.key)
        print(json.dumps(plugin_env.env_status(web_root, args.key, spec)))
        return 0
    print(json.dumps({"removed": plugin_env.remove_envs(web_root, args.key)}))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
