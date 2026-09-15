"""Plugin discovery: entry points + plugins/ folder scaffolding."""

from __future__ import annotations

import importlib
import importlib.util
import json
import logging
import re
import sys
from pathlib import Path
from typing import Any, Callable

from cfddesk.registry.base import Registry
from cfddesk.registry.manifest import PluginManifest

log = logging.getLogger(__name__)

# Table header or requires=array that the line fallback cannot represent.
_TABLE_HDR_RE = re.compile(r"^\s*\[")
_REQUIRES_ARRAY_RE = re.compile(r"^\s*requires\s*=\s*\[", re.IGNORECASE)


class RegistryHub:
    """Named collection of Registry instances passed to plugin register()."""

    def __init__(self) -> None:
        self._regs: dict[str, Registry[Any]] = {}
        self.manifests: dict[str, PluginManifest] = {}

    def registry(self, kind: str) -> Registry[Any]:
        if kind not in self._regs:
            self._regs[kind] = Registry(kind)
        return self._regs[kind]

    def kinds(self) -> list[str]:
        return list(self._regs.keys())

    def clear(self) -> None:
        for reg in self._regs.values():
            reg.clear()
        self._regs.clear()
        self.manifests.clear()


_HUB: RegistryHub | None = None
_LOADED = False
_BUILTINS_REGISTERED = False


def get_hub() -> RegistryHub:
    global _HUB
    if _HUB is None:
        _HUB = RegistryHub()
    return _HUB


def get_registry(kind: str) -> Registry[Any]:
    return get_hub().registry(kind)


def reset_for_tests() -> None:
    """Clear all registries and load state (unit tests)."""
    global _HUB, _LOADED, _BUILTINS_REGISTERED
    if _HUB is not None:
        _HUB.clear()
    _HUB = RegistryHub()
    _LOADED = False
    _BUILTINS_REGISTERED = False


def _disabled_plugins(web_root: Path | None) -> set[str]:
    disabled: set[str] = set()
    paths: list[Path] = []
    try:
        from cfddesk.wsl.config import local_json_path

        paths.append(local_json_path())
    except Exception:
        pass
    if web_root is not None:
        paths.append(web_root / ".cfddesk-local.json")
    for path in paths:
        try:
            if not path.is_file():
                continue
            data = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError, TypeError):
            continue
        if not isinstance(data, dict):
            continue
        plugins = data.get("plugins")
        if isinstance(plugins, dict):
            raw = plugins.get("disabled") or []
        else:
            raw = data.get("plugins.disabled") or []
        if isinstance(raw, list):
            disabled.update(str(x) for x in raw)
    return disabled


def _resolve_web_root(web_root: Path | str | None = None) -> Path | None:
    if web_root is not None:
        return Path(web_root)
    import os

    env = (os.environ.get("CFDDESK_WEB_ROOT") or "").strip()
    if env:
        return Path(env)
    try:
        from cfddesk.wsl.config import web_root as _wr

        return _wr()
    except Exception:
        return None


def _entry_point_callables() -> tuple[list[tuple[str, Callable[..., Any]]], bool]:
    """Load callables from importlib.metadata entry points group cfddesk.plugins.

    Returns (callables, had_failures). ep.load() / non-callable failures set
    had_failures so load_all does not sticky-set _LOADED after a partial EP load.
    """
    out: list[tuple[str, Callable[..., Any]]] = []
    had_failures = False
    try:
        from importlib.metadata import entry_points
    except ImportError:
        return out, False
    try:
        eps = entry_points()
    except Exception as exc:
        log.warning("entry_points() failed: %s", exc)
        return out, False
    # Python 3.10 returns a SelectableGroups dict-like; 3.12+ has .select
    selected = []
    if hasattr(eps, "select"):
        selected = list(eps.select(group="cfddesk.plugins"))
    elif isinstance(eps, dict):
        selected = list(eps.get("cfddesk.plugins", []))
    else:
        try:
            selected = [ep for ep in eps if getattr(ep, "group", None) == "cfddesk.plugins"]
        except TypeError:
            selected = []
    for ep in selected:
        name = getattr(ep, "name", str(ep))
        try:
            loaded = ep.load()
        except Exception as exc:
            log.warning("Failed to load entry point %s: %s", name, exc)
            had_failures = True
            continue
        if callable(loaded):
            out.append((name, loaded))
        else:
            log.warning("Entry point %s is not callable", name)
            had_failures = True
    return out, had_failures


def _toml_needs_full_parser(text: str) -> bool:
    """True if source has [tables] or requires arrays the line fallback cannot represent."""
    for raw in text.splitlines():
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        if _TABLE_HDR_RE.match(line) or line.startswith("["):
            return True
        if _REQUIRES_ARRAY_RE.match(line):
            return True
    return False


def _fallback_line_toml(text: str) -> dict[str, Any]:
    """Minimal top-level string-key parser (no tables/arrays)."""
    data: dict[str, Any] = {}
    for raw in text.splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or line.startswith("["):
            continue
        if "=" not in line:
            continue
        key, _, val = line.partition("=")
        key = key.strip()
        val = val.strip().strip('"').strip("'")
        data[key] = val
    return data


def _parse_simple_toml(text: str, *, source: str = "") -> dict[str, Any] | None:
    """Parse TOML preferring tomllib/tomli; fail-closed when fallback cannot represent."""
    src = source or "manifest"

    try:
        import tomllib

        return tomllib.loads(text)
    except ImportError:
        pass
    except Exception as exc:
        log.warning("TOML parse failed for %s: %s", src, exc)
        return None

    try:
        import tomli  # type: ignore[import-not-found]

        return tomli.loads(text)
    except ImportError:
        pass
    except Exception as exc:
        log.warning("TOML parse failed (tomli) for %s: %s", src, exc)
        return None

    # No real TOML library — line fallback only for flat string keys.
    if _toml_needs_full_parser(text):
        log.warning(
            "No tomllib/tomli available; refusing to load %s — manifest has [tables] "
            "and/or requires arrays that the line fallback would drop silently",
            src,
        )
        return None
    return _fallback_line_toml(text)


def _load_folder_plugin(
    plugin_dir: Path,
    hub: RegistryHub,
    disabled: set[str],
) -> tuple[PluginManifest | None, bool]:
    """Load one folder plugin. Returns (manifest_or_None, load_failed)."""
    manifest_path = plugin_dir / "manifest.toml"
    plugin_py = plugin_dir / "plugin.py"
    if not manifest_path.is_file() or not plugin_py.is_file():
        return None, False
    try:
        meta = _parse_simple_toml(
            manifest_path.read_text(encoding="utf-8"),
            source=str(manifest_path),
        )
    except Exception as exc:
        log.warning("Bad manifest in %s: %s", plugin_dir, exc)
        return None, True
    if meta is None:
        # Already warned inside _parse_simple_toml (parse fail or fail-closed fallback).
        return None, True
    key = str(meta.get("key") or plugin_dir.name)
    if key in disabled:
        log.info("Plugin %s disabled via .cfddesk-local.json", key)
        return None, False
    mod_name = f"cfddesk._plugins.{plugin_dir.name}"
    try:
        spec = importlib.util.spec_from_file_location(mod_name, plugin_py)
        if spec is None or spec.loader is None:
            raise ImportError(f"cannot load {plugin_py}")
        module = importlib.util.module_from_spec(spec)
        sys.modules[mod_name] = module
        spec.loader.exec_module(module)
        register = getattr(module, "register", None)
        if not callable(register):
            raise ImportError(f"{plugin_py} missing register(hub)")
        result = register(hub)
    except Exception as exc:
        log.warning("Failing plugin import %s: %s — continuing", key, exc)
        return None, True
    if isinstance(result, PluginManifest):
        return result, False
    # Build a minimal manifest from toml if register returned None
    from cfddesk.registry.requirements import Requirement

    requires_raw = meta.get("requires") or []
    requires: list[Requirement] = []
    if isinstance(requires_raw, list):
        for item in requires_raw:
            if isinstance(item, dict):
                requires.append(
                    Requirement(
                        kind=item.get("kind", "wsl_tool"),
                        name=str(item.get("name", "")),
                        version_spec=str(item.get("version_spec", "") or ""),
                    )
                )
    return (
        PluginManifest(
            key=key,
            name=str(meta.get("name") or key),
            version=str(meta.get("version") or "0.0.0"),
            requires=requires,
            provides={},
        ),
        False,
    )


def discover_folder_plugins(
    hub: RegistryHub,
    *,
    web_root: Path | str | None = None,
) -> tuple[list[PluginManifest], bool]:
    """Discover plugins under web_root/plugins. Returns (manifests, had_failures)."""
    root = _resolve_web_root(web_root)
    if root is None:
        return [], False
    plugins_dir = Path(root) / "plugins"
    if not plugins_dir.is_dir():
        return [], False
    disabled = _disabled_plugins(Path(root))
    manifests: list[PluginManifest] = []
    had_failures = False
    for child in sorted(plugins_dir.iterdir()):
        if not child.is_dir():
            continue
        m, failed = _load_folder_plugin(child, hub, disabled)
        if failed:
            had_failures = True
        if m is not None:
            hub.manifests[m.key] = m
            manifests.append(m)
    return manifests, had_failures


def discover_entry_points(
    hub: RegistryHub, disabled: set[str] | None = None
) -> tuple[list[PluginManifest], bool]:
    """Load entry-point plugins. Returns (manifests, had_failures)."""
    disabled = disabled or set()
    manifests: list[PluginManifest] = []
    callables, load_fail = _entry_point_callables()
    had_failures = load_fail
    for name, fn in callables:
        if name in disabled:
            log.info("Entry-point plugin %s disabled", name)
            continue
        try:
            result = fn(hub)
        except Exception as exc:
            log.warning("Entry-point plugin %s failed: %s — continuing", name, exc)
            had_failures = True
            continue
        if isinstance(result, PluginManifest):
            hub.manifests[result.key] = result
            manifests.append(result)
    return manifests, had_failures


def load_all(*, web_root: Path | str | None = None, force: bool = False) -> RegistryHub:
    """Register builtins then discover plugins, then validate solver refs.

    Sets _LOADED True only when discovery completed without plugin-load failures,
    so a later load_all() without force=True retries discovery after a partial load.
    Builtins stay registered across retries (not wiped).
    """
    global _LOADED, _BUILTINS_REGISTERED
    hub = get_hub()
    if _LOADED and not force:
        return hub
    # Built-ins first — never skip even if plugins fail; do not re-stamp on retry
    # unless force (same-plugin re-register is idempotent).
    if not _BUILTINS_REGISTERED or force:
        try:
            from cfddesk.builtin import register_builtins

            register_builtins(hub)
        except Exception as exc:
            log.error("register_builtins failed: %s", exc)
            raise
        _BUILTINS_REGISTERED = True
    disabled = _disabled_plugins(_resolve_web_root(web_root))
    _, ep_fail = discover_entry_points(hub, disabled)
    _, folder_fail = discover_folder_plugins(hub, web_root=web_root)
    # After plugins: every AnalysisType solver bag key must resolve.
    from cfddesk.registry.solver import validate_analysis_solver_refs

    validate_analysis_solver_refs(hub)
    _LOADED = not (ep_fail or folder_fail)
    return hub
