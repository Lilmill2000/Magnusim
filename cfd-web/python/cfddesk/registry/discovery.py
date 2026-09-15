"""Plugin discovery: entry points + plugins/ folder scaffolding."""

from __future__ import annotations

import importlib
import importlib.util
import json
import logging
import sys
from pathlib import Path
from typing import Any, Callable

from cfddesk.registry.base import Registry
from cfddesk.registry.manifest import PluginManifest

log = logging.getLogger(__name__)


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


def get_hub() -> RegistryHub:
    global _HUB
    if _HUB is None:
        _HUB = RegistryHub()
    return _HUB


def get_registry(kind: str) -> Registry[Any]:
    return get_hub().registry(kind)


def reset_for_tests() -> None:
    """Clear all registries and load state (unit tests)."""
    global _HUB, _LOADED
    if _HUB is not None:
        _HUB.clear()
    _HUB = RegistryHub()
    _LOADED = False


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


def _entry_point_callables() -> list[tuple[str, Callable[..., Any]]]:
    """Load callables from importlib.metadata entry points group cfddesk.plugins."""
    out: list[tuple[str, Callable[..., Any]]] = []
    try:
        from importlib.metadata import entry_points
    except ImportError:
        return out
    try:
        eps = entry_points()
    except Exception as exc:
        log.warning("entry_points() failed: %s", exc)
        return out
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
            continue
        if callable(loaded):
            out.append((name, loaded))
        else:
            log.warning("Entry point %s is not callable", name)
    return out


def _parse_simple_toml(text: str) -> dict[str, Any]:
    """Minimal TOML subset parser (top-level string/list keys) for scaffolding."""
    try:
        import tomllib

        return tomllib.loads(text)
    except ImportError:
        pass
    except Exception:
        pass
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


def _load_folder_plugin(
    plugin_dir: Path,
    hub: RegistryHub,
    disabled: set[str],
) -> PluginManifest | None:
    manifest_path = plugin_dir / "manifest.toml"
    plugin_py = plugin_dir / "plugin.py"
    if not manifest_path.is_file() or not plugin_py.is_file():
        return None
    try:
        meta = _parse_simple_toml(manifest_path.read_text(encoding="utf-8"))
    except Exception as exc:
        log.warning("Bad manifest in %s: %s", plugin_dir, exc)
        return None
    key = str(meta.get("key") or plugin_dir.name)
    if key in disabled:
        log.info("Plugin %s disabled via .cfddesk-local.json", key)
        return None
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
        return None
    if isinstance(result, PluginManifest):
        return result
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
    return PluginManifest(
        key=key,
        name=str(meta.get("name") or key),
        version=str(meta.get("version") or "0.0.0"),
        requires=requires,
        provides={},
    )


def discover_folder_plugins(
    hub: RegistryHub,
    *,
    web_root: Path | str | None = None,
) -> list[PluginManifest]:
    root = _resolve_web_root(web_root)
    if root is None:
        return []
    plugins_dir = Path(root) / "plugins"
    if not plugins_dir.is_dir():
        return []
    disabled = _disabled_plugins(Path(root))
    manifests: list[PluginManifest] = []
    for child in sorted(plugins_dir.iterdir()):
        if not child.is_dir():
            continue
        m = _load_folder_plugin(child, hub, disabled)
        if m is not None:
            hub.manifests[m.key] = m
            manifests.append(m)
    return manifests


def discover_entry_points(hub: RegistryHub, disabled: set[str] | None = None) -> list[PluginManifest]:
    disabled = disabled or set()
    manifests: list[PluginManifest] = []
    for name, fn in _entry_point_callables():
        if name in disabled:
            log.info("Entry-point plugin %s disabled", name)
            continue
        try:
            result = fn(hub)
        except Exception as exc:
            log.warning("Entry-point plugin %s failed: %s — continuing", name, exc)
            continue
        if isinstance(result, PluginManifest):
            hub.manifests[result.key] = result
            manifests.append(result)
    return manifests


def load_all(*, web_root: Path | str | None = None, force: bool = False) -> RegistryHub:
    """Idempotent: register builtins then discover plugins."""
    global _LOADED
    hub = get_hub()
    if _LOADED and not force:
        return hub
    # Built-ins first — never skip even if plugins fail.
    try:
        from cfddesk.builtin import register_builtins

        register_builtins(hub)
    except Exception as exc:
        log.error("register_builtins failed: %s", exc)
        raise
    disabled = _disabled_plugins(_resolve_web_root(web_root))
    discover_entry_points(hub, disabled)
    discover_folder_plugins(hub, web_root=web_root)
    _LOADED = True
    return hub
