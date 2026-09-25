"""Plugin discovery: entry points + plugins/ folder scaffolding."""

from __future__ import annotations

import importlib
import importlib.util
import json
import logging
import re
import sys
from collections.abc import Callable
from pathlib import Path
from typing import Any

from cfddesk.registry.base import Registry, RegistryError
from cfddesk.registry.bc_extend import BcExtensions
from cfddesk.registry.hooks import get_hooks
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
        self.errors: list[str] = []
        self.incompatible: list[dict[str, Any]] = []
        self.failures: list[dict[str, Any]] = []
        self.bc = BcExtensions()
        self.bc.bind(self)
        self._loading_overrides: dict[str, list[str]] = {}
        self._plugin_dirs: dict[str, Path] = {}
        self._job_packages: dict[str, Path] = {}
        self._methods: dict[tuple[str, str], Callable[..., Any]] = {}

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
        self.errors.clear()
        self.incompatible.clear()
        self.failures.clear()
        self.bc.clear()
        self._loading_overrides.clear()
        self._plugin_dirs.clear()
        self._job_packages.clear()
        self._methods.clear()
        get_hooks().clear()

    def current_overrides(self, plugin: str) -> list[str]:
        pending = self._loading_overrides.get(plugin)
        if pending is not None:
            return list(pending)
        manifest = self.manifests.get(plugin)
        if manifest is None:
            return []
        return list(getattr(manifest, "overrides", []) or [])

    def note_overrides(self, plugin: str, overrides: list[str]) -> None:
        """Stash overrides before register() returns the manifest."""
        self._loading_overrides[str(plugin)] = [str(item) for item in overrides]

    def replace(self, kind: str, spec: Any, *, plugin: str) -> None:
        self.registry(kind).replace(spec, plugin=plugin)

    def unregister(
        self,
        kind: str,
        key: str,
        *,
        plugin: str,
        allow_protected: bool = False,
    ) -> None:
        self.registry(kind).unregister(
            key,
            plugin=plugin,
            allow_protected=allow_protected,
        )

    def register_job(self, spec: Any, *, plugin: str, package_dir: Path | None = None) -> None:
        """Register a JobKind. Plugin tool paths must stay inside package_dir."""
        from cfddesk.registry.jobs import JobKind, ensure_tool_in_package

        if not isinstance(spec, JobKind):
            raise RegistryError("register_job requires a JobKind")
        if plugin != "builtin":
            if package_dir is None:
                raise RegistryError("plugin JobKind requires package_dir")
            ensure_tool_in_package(spec.tool, Path(package_dir))
        self.registry("job").register(spec, plugin=plugin)
        if package_dir is not None:
            self._job_packages[str(spec.key)] = Path(package_dir)

    def note_plugin_dir(self, key: str, package_dir: Path) -> None:
        self._plugin_dirs[str(key)] = Path(package_dir)

    def plugin_dir(self, key: str) -> Path | None:
        return self._plugin_dirs.get(str(key))

    def job_package(self, key: str) -> Path | None:
        return self._job_packages.get(str(key))

    def register_method(self, key: str, method: str, fn: Callable[..., Any]) -> None:
        self._methods[(str(key), str(method))] = fn

    def call_method(
        self,
        key: str,
        method: str,
        params: dict | None = None,
        scope: dict | None = None,
    ) -> Any:
        fn = self._methods.get((str(key), str(method)))
        if fn is None:
            raise RegistryError(f"unknown plugin method {key}.{method}")
        return fn(params=params or {}, scope=scope or {})


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
    else:
        get_hooks().clear()
    _purge_plugin_modules()
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
        import tomli

        return tomli.loads(text)
    except ImportError:
        pass
    except Exception as exc:
        log.warning("TOML parse failed (tomli) for %s: %s", src, exc)
        return None

    # No real TOML library â€” line fallback only for flat string keys.
    if _toml_needs_full_parser(text):
        log.warning(
            "No tomllib/tomli available; refusing to load %s â€” manifest has [tables] "
            "and/or requires arrays that the line fallback would drop silently",
            src,
        )
        return None
    return _fallback_line_toml(text)


def _host_api_version() -> str:
    from cfddesk.registry import API_VERSION

    return str(API_VERSION)


def _api_major(version: str) -> str:
    return str(version or "1.0").split(".", 1)[0]


def _api_compatible(version: str) -> bool:
    return _api_major(version) == _api_major(_host_api_version())


def _overrides_from_meta(meta: dict[str, Any]) -> list[str]:
    raw = meta.get("overrides") or []
    if isinstance(raw, str):
        return [part.strip() for part in raw.split(",") if part.strip()]
    if isinstance(raw, list):
        return [str(item).strip() for item in raw if str(item).strip()]
    return []


def _authors(value: Any) -> list[str]:
    if isinstance(value, list):
        return [str(item).strip() for item in value if str(item).strip()]
    if isinstance(value, str) and value.strip():
        return [part.strip() for part in value.split(",") if part.strip()]
    return []


def _ui_fields(meta: dict[str, Any]) -> tuple[str | None, str]:
    """Return (ui directory, entry file). A missing ui key means no UI bundle."""
    entry = str(meta.get("ui_entry") or "index.js")
    ui = meta.get("ui")
    if ui is False or ui is None or ui == "":
        return None, entry
    if isinstance(ui, str):
        return (ui.strip() or None), entry
    if isinstance(ui, dict):
        directory = str(ui.get("dir") or ui.get("path") or "ui").strip()
        entry = str(ui.get("entry") or entry or "index.js")
        return (directory or None), entry
    return None, entry


def _purge_plugin_modules() -> None:
    for name in list(sys.modules):
        if name.startswith("cfddesk._plugins."):
            del sys.modules[name]


def _apply_disk_meta(
    result: PluginManifest,
    meta: dict[str, Any],
    api: str,
    overrides: list[str],
    source: str,
) -> None:
    ui, entry = _ui_fields(meta)
    if result.ui is None and ui:
        result.ui = ui
    if entry and (not result.ui_entry or result.ui_entry == "index.js"):
        result.ui_entry = entry
    if not result.authors:
        result.authors = _authors(meta.get("authors"))
    if not result.description:
        result.description = str(meta.get("description") or "")
    if not result.overrides:
        result.overrides = list(overrides)
    if not str(result.api_version or "").strip():
        result.api_version = api
    if not result.source:
        result.source = source


def _failure_row(key: str, error: str, meta: dict[str, Any] | None = None) -> dict[str, Any]:
    meta = meta or {}
    ui, entry = _ui_fields(meta) if meta else (None, "index.js")
    return {
        "key": key,
        "name": str(meta.get("name") or key),
        "version": str(meta.get("version") or "0.0.0"),
        "description": str(meta.get("description") or ""),
        "authors": _authors(meta.get("authors")),
        "ui": ui,
        "ui_entry": entry,
        "error": error,
        "source": "local",
    }


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
        hub.failures.append(_failure_row(plugin_dir.name, str(exc)))
        return None, True
    if meta is None:
        # Already warned inside _parse_simple_toml (parse fail or fail-closed fallback).
        hub.failures.append(_failure_row(plugin_dir.name, "bad manifest"))
        return None, True
    key = str(meta.get("key") or plugin_dir.name)
    if key in disabled:
        log.info("Plugin %s disabled via .cfddesk-local.json", key)
        return None, False
    api = str(meta.get("api_version") or "1.0")
    if not _api_compatible(api):
        ui, entry = _ui_fields(meta)
        hub.incompatible.append(
            {
                "key": key,
                "name": str(meta.get("name") or key),
                "version": str(meta.get("version") or "0.0.0"),
                "description": str(meta.get("description") or ""),
                "api_version": api,
                "host": _host_api_version(),
                "source": "local",
                "ui": ui,
                "ui_entry": entry,
            }
        )
        log.info(
            "Plugin %s api_version %s is incompatible with host %s",
            key,
            api,
            _host_api_version(),
        )
        return None, False
    overrides = _overrides_from_meta(meta)
    hub.note_overrides(key, overrides)
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
        hub._loading_overrides.pop(key, None)
        hub.failures.append(_failure_row(key, str(exc), meta))
        sys.modules.pop(mod_name, None)
        return None, True
    if isinstance(result, PluginManifest):
        _apply_disk_meta(result, meta, api, overrides, "local")
        hub._loading_overrides.pop(key, None)
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
    hub._loading_overrides.pop(key, None)
    ui, entry = _ui_fields(meta)
    return (
        PluginManifest(
            key=key,
            name=str(meta.get("name") or key),
            version=str(meta.get("version") or "0.0.0"),
            requires=requires,
            provides={},
            ui=ui,
            ui_entry=entry,
            authors=_authors(meta.get("authors")),
            description=str(meta.get("description") or ""),
            overrides=list(overrides),
            api_version=api,
            source="local",
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
            hub.note_plugin_dir(m.key, child)
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
        api = str(getattr(fn, "api_version", "") or "")
        if api and not _api_compatible(api):
            hub.incompatible.append(
                {"key": str(name), "api_version": api, "host": _host_api_version()}
            )
            log.info("Entry-point plugin %s api_version %s is incompatible", name, api)
            hub.incompatible[-1]["name"] = str(name)
            hub.incompatible[-1]["source"] = "entry_point"
            continue
        try:
            result = fn(hub)
        except Exception as exc:
            log.warning("Entry-point plugin %s failed: %s — continuing", name, exc)
            hub.failures.append(
                {
                    "key": str(name),
                    "name": str(name),
                    "version": "0.0.0",
                    "description": "",
                    "authors": [],
                    "ui": None,
                    "ui_entry": "index.js",
                    "error": str(exc),
                    "source": "entry_point",
                }
            )
            had_failures = True
            continue
        if isinstance(result, PluginManifest):
            if not result.source:
                result.source = "entry_point"
            hub.manifests[result.key] = result
            manifests.append(result)
    return manifests, had_failures


def load_all(*, web_root: Path | str | None = None, force: bool = False) -> RegistryHub:
    """Register builtins then discover plugins, then validate analysis bag refs.

    Sets _LOADED True only when discovery completed without plugin-load failures,
    so a later load_all() without force=True retries discovery after a partial load.
    Builtins stay registered across retries (not wiped).
    """
    global _LOADED, _BUILTINS_REGISTERED
    hub = get_hub()
    if _LOADED and not force:
        return hub
    # Built-ins first â€” never skip even if plugins fail; do not re-stamp on retry
    # unless force (same-plugin re-register is idempotent).
    if not _BUILTINS_REGISTERED or force:
        try:
            from cfddesk.builtin import register_builtins

            register_builtins(hub)
        except Exception as exc:
            log.error("register_builtins failed: %s", exc)
            raise
        _BUILTINS_REGISTERED = True
    # Plugins register hooks. Clear first so force=True does not stack them.
    hub.manifests.clear()
    hub.failures.clear()
    hub.incompatible.clear()
    hub._loading_overrides.clear()
    _purge_plugin_modules()
    get_hooks().clear()
    disabled = _disabled_plugins(_resolve_web_root(web_root))
    _, ep_fail = discover_entry_points(hub, disabled)
    _, folder_fail = discover_folder_plugins(hub, web_root=web_root)
    # After plugins: every AnalysisType bag key must resolve (solver/bc/material/monitor).
    from cfddesk.registry.bc import validate_analysis_bc_refs
    from cfddesk.registry.material import validate_analysis_material_refs
    from cfddesk.registry.monitor import validate_analysis_monitor_refs
    from cfddesk.registry.solver import validate_analysis_solver_refs

    validate_analysis_solver_refs(hub)
    validate_analysis_bc_refs(hub)
    validate_analysis_material_refs(hub)
    validate_analysis_monitor_refs(hub)
    from cfddesk.registry.tools import sync_tool_kinds

    sync_tool_kinds(hub)
    _LOADED = not (ep_fail or folder_fail)
    return hub


def _catalog_row(
    *,
    key: str,
    name: str,
    version: str = "0.0.0",
    description: str = "",
    authors: list[str] | None = None,
    ui: str | None = None,
    ui_entry: str = "index.js",
    provides: dict[str, Any] | None = None,
    source: str = "local",
    status: str = "enabled",
    enabled: bool = True,
    error: str = "",
    missing: list[str] | None = None,
) -> dict[str, Any]:
    return {
        "key": key,
        "name": name,
        "version": version or "0.0.0",
        "description": description,
        "authors": list(authors or []),
        "ui": ui,
        "ui_entry": ui_entry or "index.js",
        "provides": provides or {},
        "source": source or "local",
        "status": status,
        "enabled": enabled,
        "error": error,
        "missing": list(missing or []),
    }


def plugin_catalog(web_root: Path | str | None = None) -> list[dict[str, Any]]:
    """Rows for plugins.list: loaded, disabled, incompatible, and load failures."""
    from cfddesk.registry.requirements import check_requirements

    hub = get_hub()
    root = _resolve_web_root(web_root)
    disabled = _disabled_plugins(root)
    items: list[dict[str, Any]] = []
    seen: set[str] = set()

    def add(row: dict[str, Any]) -> None:
        key = str(row.get("key") or "")
        if not key or key in seen:
            return
        seen.add(key)
        items.append(row)

    for manifest in hub.manifests.values():
        missing = check_requirements(manifest, {})
        reasons = [str(item.reason) for item in missing]
        if manifest.key in disabled:
            status = "disabled"
        elif reasons:
            status = "missing requirement"
        else:
            status = "enabled"
        source = manifest.source or ("local" if hub.plugin_dir(manifest.key) else "entry_point")
        add(
            _catalog_row(
                key=manifest.key,
                name=manifest.name,
                version=str(manifest.version or "0.0.0"),
                description=str(manifest.description or ""),
                authors=list(manifest.authors or []),
                ui=manifest.ui,
                ui_entry=str(manifest.ui_entry or "index.js"),
                provides=dict(manifest.provides or {}),
                source=source,
                status=status,
                enabled=status == "enabled",
                missing=reasons,
            )
        )
    for row in hub.incompatible:
        add(
            _catalog_row(
                key=str(row.get("key") or ""),
                name=str(row.get("name") or row.get("key") or ""),
                version=str(row.get("version") or "0.0.0"),
                description=str(row.get("description") or ""),
                ui=row.get("ui"),
                ui_entry=str(row.get("ui_entry") or "index.js"),
                source=str(row.get("source") or "local"),
                status="incompatible",
                enabled=False,
                error=f"api_version {row.get('api_version') or ''} is incompatible",
            )
        )
    for row in hub.failures:
        add(
            _catalog_row(
                key=str(row.get("key") or ""),
                name=str(row.get("name") or row.get("key") or ""),
                version=str(row.get("version") or "0.0.0"),
                description=str(row.get("description") or ""),
                authors=list(row.get("authors") or []),
                ui=row.get("ui"),
                ui_entry=str(row.get("ui_entry") or "index.js"),
                source=str(row.get("source") or "local"),
                status="error",
                enabled=False,
                error=str(row.get("error") or ""),
            )
        )
    plugins_dir = (Path(root) / "plugins") if root is not None else None
    if plugins_dir is not None and plugins_dir.is_dir():
        for child in sorted(plugins_dir.iterdir()):
            if not child.is_dir():
                continue
            manifest_path = child / "manifest.toml"
            if not manifest_path.is_file():
                continue
            meta = _parse_simple_toml(
                manifest_path.read_text(encoding="utf-8"),
                source=str(manifest_path),
            )
            meta = meta or {}
            key = str(meta.get("key") or child.name)
            if key in seen or child.name in seen:
                continue
            if key not in disabled and child.name not in disabled:
                continue
            ui, entry = _ui_fields(meta)
            add(
                _catalog_row(
                    key=key,
                    name=str(meta.get("name") or child.name),
                    version=str(meta.get("version") or "0.0.0"),
                    description=str(meta.get("description") or ""),
                    authors=_authors(meta.get("authors")),
                    ui=ui,
                    ui_entry=entry,
                    source="local",
                    status="disabled",
                    enabled=False,
                )
            )
    return items

