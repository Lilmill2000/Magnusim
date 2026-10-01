"""Plugin discovery: entry points + plugins/ folder scaffolding."""

from __future__ import annotations

import importlib
import importlib.util
import json
import logging
import os
import re
import sys
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from cfddesk.registry.base import Registry, RegistryError
from cfddesk.registry.bc_extend import BcExtensions
from cfddesk.registry.hooks import get_hooks
from cfddesk.registry.manifest import MB, FilesSpec, PluginManifest, StudyKind, WorkspaceSpec

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
        # Required bundled plugins that did not load: {key, name, error}.
        self.required_failures: list[dict[str, Any]] = []
        # Folder plugins skipped because they are off (never imported): catalog rows.
        self.off_plugins: list[dict[str, Any]] = []

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
        self.required_failures.clear()
        self.off_plugins.clear()
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
            if not (Path(package_dir) / spec.tool).is_file():
                raise RegistryError(f"plugin JobKind tool {spec.tool!r} is not in the plugin folder")
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
# After a load with a failed plugin, load_all() retries discovery only when the
# plugin folders changed on disk or this long has passed (an entry point may
# have been mid-install). Every call re-importing every plugin cost ~0.3 s on
# each tree read and study save while one plugin was broken.
_RETRY_AFTER_S = 30.0
_FAILED_AT: float | None = None
_FAILED_SIG: tuple[Any, ...] | None = None


def get_hub() -> RegistryHub:
    global _HUB
    if _HUB is None:
        _HUB = RegistryHub()
    return _HUB


def get_registry(kind: str) -> Registry[Any]:
    return get_hub().registry(kind)


def reset_for_tests() -> None:
    """Clear all registries and load state (unit tests)."""
    global _HUB, _LOADED, _BUILTINS_REGISTERED, _FAILED_AT, _FAILED_SIG
    if _HUB is not None:
        _HUB.clear()
    else:
        get_hooks().clear()
    _purge_plugin_modules()
    _HUB = RegistryHub()
    _LOADED = False
    _BUILTINS_REGISTERED = False
    _FAILED_AT = None
    _FAILED_SIG = None


_SIG_SKIP_DIRS = {"__pycache__", "node_modules", ".venv", ".git", "wheels"}


def _plugin_sources_signature(web_root: Path | str | None) -> tuple[Any, ...]:
    """What a fix to a failed plugin changes: the plugin folders there are, and
    the size and time of each manifest, lock and Python file in them."""
    root = _resolve_web_root(web_root)
    out: list[Any] = []
    for folder in (bundled_dir_for(root), plugins_dir_for(root) if root is not None else None):
        if folder is None or not Path(folder).is_dir():
            out.append((str(folder), None))
            continue
        for dirpath, dirnames, filenames in os.walk(folder):
            dirnames[:] = sorted(d for d in dirnames if d not in _SIG_SKIP_DIRS)
            for name in sorted(filenames):
                if name.endswith(".py") or name in ("manifest.toml", "requirements.lock"):
                    try:
                        st = os.stat(os.path.join(dirpath, name))
                    except OSError:
                        continue
                    out.append((os.path.join(dirpath, name), st.st_mtime_ns, st.st_size))
            out.append((dirpath, tuple(dirnames)))
    return tuple(out)


@dataclass(frozen=True)
class PluginState:
    """The user's plugin choices on this PC (local JSON, written only by the worker).

    ``disabled``: turned off. ``enabled``: turned on, which is what brings an
    optional bundled plugin that ships off (``default_enabled = false``) in.
    An explicit off wins when a key is in both.
    """

    disabled: frozenset[str] = frozenset()
    enabled: frozenset[str] = frozenset()


def plugin_state(web_root: Path | None) -> PluginState:
    """The on/off lists from the local JSON and the legacy web-root file (union)."""
    disabled: set[str] = set()
    enabled: set[str] = set()
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
            on = plugins.get("enabled") or []
            if isinstance(on, list):
                enabled.update(str(x) for x in on)
        else:
            raw = data.get("plugins.disabled") or []
        if isinstance(raw, list):
            disabled.update(str(x) for x in raw)
    return PluginState(frozenset(disabled), frozenset(enabled))


def _disabled_plugins(web_root: Path | None) -> set[str]:
    return set(plugin_state(web_root).disabled)


def _manifest_bool(meta: dict[str, Any], name: str, default: bool) -> bool:
    """A true/false manifest key (the line-fallback parser yields strings)."""
    raw = meta.get(name, default)
    if isinstance(raw, bool):
        return raw
    if isinstance(raw, str) and raw.strip().lower() in ("true", "false"):
        return raw.strip().lower() == "true"
    raise ValueError(f"{name} must be true or false")


def tier_flags(meta: dict[str, Any], tier: str) -> tuple[bool, bool]:
    """(required, default_enabled) for a plugin of ``tier``.

    Both are bundled-tier keys: a user plugin is never required and is on unless
    turned off. A required plugin cannot ship off.
    """
    if tier != "bundled":
        return False, True
    required = _manifest_bool(meta, "required", False)
    default_enabled = _manifest_bool(meta, "default_enabled", True)
    if required and not default_enabled:
        raise ValueError("a required plugin cannot be off by default (default_enabled = false)")
    return required, default_enabled


def plugin_is_on(key: str, *, tier: str, required: bool, default_enabled: bool, state: PluginState) -> bool:
    """Whether a plugin loads: required ones always, then an explicit off, then an
    explicit on for a bundled plugin that ships off, else on."""
    if tier == "bundled" and required:
        return True
    if key in state.disabled:
        return False
    if tier == "bundled" and not default_enabled:
        return key in state.enabled
    return True


def _resolve_web_root(web_root: Path | str | None = None) -> Path | None:
    if web_root is not None:
        return Path(web_root)
    import os

    env = (os.environ.get("MAGNUSIM_WEB_ROOT") or os.environ.get("CFDDESK_WEB_ROOT") or "").strip()
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


_TOML_AT_RE = re.compile(r"^(.*) \(at line (\d+), column (\d+)\)$", re.DOTALL)
# The parser can quote a whole key, however long: its words are cut to this.
_TOML_SAID_MAX = 200


def _cut(text: str, limit: int = _TOML_SAID_MAX) -> str:
    """At most ``limit`` characters, the last one "…" when cut."""
    return text if len(text) <= limit else text[: limit - 1] + "…"


def _toml_error(exc: Exception) -> str:
    """What the TOML parser says is wrong, with its line and column (never a path).
    Its words are cut at 200 characters; the line and column always show."""
    msg, line, col = getattr(exc, "msg", None), getattr(exc, "lineno", None), getattr(exc, "colno", None)
    if not (isinstance(msg, str) and isinstance(line, int) and isinstance(col, int)):
        # tomllib before 3.14 has only the text: "<what> (at line N, column M)".
        m = _TOML_AT_RE.match(str(exc))
        if not m:
            return f"is not valid TOML: {_cut(str(exc))}"
        msg, line, col = m.group(1), int(m.group(2)), int(m.group(3))
    return f"is not valid TOML (line {line}, column {col}): {_cut(msg)}"


def _parse_toml(text: str, *, source: str = "") -> tuple[dict[str, Any] | None, str]:
    """(table, "") or (None, what is wrong). Prefers tomllib/tomli; fail-closed
    when the line fallback cannot represent the text."""
    src = source or "manifest"

    try:
        import tomllib

        return tomllib.loads(text), ""
    except ImportError:
        pass
    except Exception as exc:
        log.warning("TOML parse failed for %s: %s", src, exc)
        return None, _toml_error(exc)

    try:
        import tomli

        return tomli.loads(text), ""
    except ImportError:
        pass
    except Exception as exc:
        log.warning("TOML parse failed (tomli) for %s: %s", src, exc)
        return None, _toml_error(exc)

    # No real TOML library â€” line fallback only for flat string keys.
    if _toml_needs_full_parser(text):
        log.warning(
            "No tomllib/tomli available; refusing to load %s â€” manifest has [tables] "
            "and/or requires arrays that the line fallback would drop silently",
            src,
        )
        return None, "has [tables] or a requires array, which need a TOML parser (tomllib or tomli) this Python lacks"
    return _fallback_line_toml(text), ""


def _parse_simple_toml(text: str, *, source: str = "") -> dict[str, Any] | None:
    """Parse TOML preferring tomllib/tomli; fail-closed when fallback cannot represent."""
    return _parse_toml(text, source=source)[0]


# A top-level name = "..." line, read from a manifest that does not parse.
_NAME_LINE_RE = re.compile(r"""^\s*name\s*=\s*(?:"([^"\\]*)"|'([^']*)')\s*(?:#.*)?$""")


def _lenient_name(text: str) -> str:
    """The name of a manifest that does not parse, for display only ("" when unclear).
    A line inside a multi-line string is text, never the name or a table."""
    inside = ""  # the quotes of the multi-line string the scan is in
    for raw in text.splitlines():
        if inside:
            if raw.count(inside) % 2:
                inside = ""
            continue
        if raw.lstrip().startswith("["):
            break
        m = _NAME_LINE_RE.match(raw)
        if m:
            return (m.group(1) if m.group(1) is not None else m.group(2)).strip()[:80]
        opens = [(raw.find(q), q) for q in ('"""', "'''") if q in raw]
        if opens:
            first = min(opens)[1]
            if raw.count(first) % 2:
                inside = first
    return ""


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


# Folders of loaded plugins: each is on sys.path so a plugin can import its own
# package (``import incompressible_flow.writer``).
_PLUGIN_ROOTS: set[str] = set()


def _purge_plugin_modules() -> None:
    roots = tuple(str(Path(r).resolve()) for r in _PLUGIN_ROOTS)
    for name, mod in list(sys.modules.items()):
        if name.startswith(("cfddesk._plugins.", "cfddesk._bundled.")):
            del sys.modules[name]
            continue
        file = getattr(mod, "__file__", None) if roots else None
        if file and str(Path(file).resolve()).startswith(roots):
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
    if not result.license:
        result.license = str(meta.get("license") or "")


_REF_ANALYSIS = re.compile(r"analysis '([^']+)'")


def _drop_failed_plugin(hub: RegistryHub, plugin: str, error: str) -> None:
    """Unload one plugin whose specs broke cross-reference validation."""
    for kind in hub.kinds():
        hub.registry(kind).drop_plugin(plugin)
    get_hooks().clear_plugin(plugin)
    manifest = hub.manifests.pop(plugin, None)
    meta: dict[str, Any] = {}
    source = "local"
    if manifest is not None:
        meta = {
            "name": manifest.name,
            "version": manifest.version,
            "description": manifest.description,
            "authors": list(manifest.authors or []),
            "ui": manifest.ui,
            "ui_entry": manifest.ui_entry,
        }
        source = str(manifest.source or "local")
    hub.failures.append(_failure_row(plugin, error, meta, source=source))
    log.warning("plugin %s unloaded: %s", plugin, error)


def _validate_cross_refs(hub: RegistryHub) -> None:
    """Every AnalysisType bag key must resolve. A plugin that breaks this is unloaded
    and listed as an error; builtins and the other plugins keep loading. A builtin
    that breaks it is a core bug and still raises."""
    from cfddesk.registry.bc import validate_analysis_bc_refs
    from cfddesk.registry.material import validate_analysis_material_refs
    from cfddesk.registry.monitor import validate_analysis_monitor_refs
    from cfddesk.registry.solver import validate_analysis_solver_refs

    checks = (
        validate_analysis_solver_refs,
        validate_analysis_bc_refs,
        validate_analysis_material_refs,
        validate_analysis_monitor_refs,
    )
    for _ in range(64):
        try:
            for check in checks:
                check(hub)
            return
        except RegistryError as exc:
            match = _REF_ANALYSIS.search(str(exc))
            analyses = hub.registry("analysis")
            key = match.group(1) if match else ""
            owner = analyses.owner(key) if key in analyses.keys() else "builtin"
            if owner == "builtin":
                raise
            _drop_failed_plugin(hub, owner, str(exc))
    raise RegistryError("cross-reference validation did not settle after unloading plugins")


def _failure_row(
    key: str, error: str, meta: dict[str, Any] | None = None, *, source: str = "local"
) -> dict[str, Any]:
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
        "source": source,
    }


def _read_manifest(
    plugin_dir: Path, hub: RegistryHub, *, tier: str = "user"
) -> tuple[dict[str, Any] | None, bool]:
    """(manifest dict, failed). None and not failed when the folder is not a plugin.

    A manifest that cannot be read or parsed is listed under its folder name, as
    the tier it was found in, with what is wrong and its name if a line still gives it.
    """
    manifest_path = plugin_dir / "manifest.toml"
    plugin_py = plugin_dir / "plugin.py"
    if not manifest_path.is_file() or not plugin_py.is_file():
        return None, False
    source = "bundled" if tier == "bundled" else "local"
    try:
        text = manifest_path.read_text(encoding="utf-8")
    except Exception as exc:
        log.warning("Bad manifest in %s: %s", plugin_dir, exc)
        # An OSError's text holds the full path; the row says only what went wrong.
        why = (exc.strerror or type(exc).__name__) if isinstance(exc, OSError) else str(exc)
        hub.failures.append(_failure_row(plugin_dir.name, f"manifest.toml could not be read: {why}", source=source))
        return None, True
    # Already warned inside _parse_toml (parse fail or fail-closed fallback).
    meta, why = _parse_toml(text, source=str(manifest_path))
    if meta is None:
        name = _lenient_name(text)
        hub.failures.append(
            _failure_row(plugin_dir.name, f"manifest.toml {why}", {"name": name} if name else None, source=source)
        )
        return None, True
    return meta, False


_ICON_PATH_RE = re.compile(r"^[MmLlHhVvCcSsQqTtAaZz0-9 ,.\-eE]{0,4000}$")


def study_kinds_from_meta(meta: dict[str, Any]) -> list[StudyKind]:
    """Validate ``[[study_kinds]]``: key, title, icon (one SVG path), workspace."""
    from cfddesk.registry.plugin_data import KIND_KEY_RE

    raw = meta.get("study_kinds") or []
    if not isinstance(raw, list):
        raise ValueError("must be an array of tables")
    out: list[StudyKind] = []
    seen: set[str] = set()
    for row in raw:
        if not isinstance(row, dict):
            raise ValueError("each study kind is a table")
        key = str(row.get("key") or "")
        if not KIND_KEY_RE.match(key):
            raise ValueError(f"key {key!r} must be lower_snake_case")
        if key in seen:
            raise ValueError(f"key {key!r} is declared twice")
        seen.add(key)
        title = str(row.get("title") or "").strip()
        if not title:
            raise ValueError(f"{key}: needs a title")
        icon = str(row.get("icon") or "")
        if not _ICON_PATH_RE.match(icon):
            raise ValueError(f"{key}: icon must be one SVG path (d attribute)")
        workspace = str(row.get("workspace") or "")
        if workspace and not KIND_KEY_RE.match(workspace):
            raise ValueError(f"{key}: workspace {workspace!r} must be lower_snake_case")
        try:
            schema_version = int(row.get("schema_version", 1))
        except (TypeError, ValueError):
            raise ValueError(f"{key}: schema_version must be an integer") from None
        out.append(StudyKind(key, title[:80], icon, workspace, max(1, schema_version)))
    return out


def workspaces_from_meta(meta: dict[str, Any], plugin_dir: Path) -> list[WorkspaceSpec]:
    """Validate ``[[workspaces]]``: key, title, icon (one SVG path), entry (an HTML
    file in the plugin's ``workspace/`` folder, which is all the host serves)."""
    from cfddesk.registry.plugin_data import KIND_KEY_RE

    raw = meta.get("workspaces") or []
    if not isinstance(raw, list):
        raise ValueError("must be an array of tables")
    folder = (plugin_dir / "workspace").resolve()
    out: list[WorkspaceSpec] = []
    seen: set[str] = set()
    for row in raw:
        if not isinstance(row, dict):
            raise ValueError("each workspace is a table")
        key = str(row.get("key") or "")
        if not KIND_KEY_RE.match(key):
            raise ValueError(f"key {key!r} must be lower_snake_case")
        if key in seen:
            raise ValueError(f"key {key!r} is declared twice")
        seen.add(key)
        title = str(row.get("title") or "").strip()
        if not title:
            raise ValueError(f"{key}: needs a title")
        icon = str(row.get("icon") or "")
        if not _ICON_PATH_RE.match(icon):
            raise ValueError(f"{key}: icon must be one SVG path (d attribute)")
        entry = str(row.get("entry") or "workspace/index.html").replace("\\", "/")
        target = (plugin_dir / entry).resolve()
        if not entry.startswith("workspace/") or folder not in target.parents or target.suffix.lower() != ".html":
            raise ValueError(f"{key}: entry {entry!r} must be an .html file in the plugin's workspace/ folder")
        if not target.is_file():
            raise ValueError(f"{key}: entry {entry!r} is missing")
        out.append(WorkspaceSpec(key, title[:80], icon, entry))
    return out


def files_spec_from_meta(meta: dict[str, Any]) -> FilesSpec:
    """Validate ``[files]``: max_file_mb (1..4096, default 64) and max_total_mb
    (1..65536, default 512, at least max_file_mb), whole numbers of MB."""
    raw = meta.get("files")
    if raw is None:
        return FilesSpec()
    if not isinstance(raw, dict):
        raise ValueError("must be a table")

    def whole_mb(name: str, default: int, top: int) -> int:
        value = raw.get(name, default)
        if isinstance(value, bool) or not isinstance(value, int):
            raise ValueError(f"{name} must be a whole number of MB, not {value!r}")
        if not 1 <= value <= top:
            raise ValueError(f"{name} must be between 1 and {top}, not {value}")
        return value

    file_mb = whole_mb("max_file_mb", 64, 4096)
    total_mb = whole_mb("max_total_mb", 512, 65536)
    if total_mb < file_mb:
        raise ValueError(f"max_total_mb ({total_mb}) must be at least max_file_mb ({file_mb})")
    return FilesSpec(file_mb * MB, total_mb * MB)


def _files_row(spec: FilesSpec) -> dict[str, int]:
    return {"max_file_bytes": spec.max_file_bytes, "max_total_bytes": spec.max_total_bytes}


def _str_list(value: Any) -> list[str]:
    if isinstance(value, str):
        return [part.strip() for part in value.split(",") if part.strip()]
    if isinstance(value, list):
        return [str(item).strip() for item in value if str(item).strip()]
    return []


def _load_folder_plugin(
    plugin_dir: Path,
    hub: RegistryHub,
    *,
    meta: dict[str, Any] | None = None,
    tier: str = "user",
) -> tuple[PluginManifest | None, bool]:
    """Load one folder plugin. Returns (manifest_or_None, load_failed)."""
    plugin_py = plugin_dir / "plugin.py"
    if meta is None:
        meta, failed = _read_manifest(plugin_dir, hub, tier=tier)
        if meta is None:
            return None, failed
    key = str(meta.get("key") or plugin_dir.name)
    api = str(meta.get("api_version") or "1.0")
    source = "bundled" if tier == "bundled" else "local"
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
                "source": source,
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
    try:
        kinds = study_kinds_from_meta(meta)
    except ValueError as exc:
        hub.failures.append(_failure_row(key, f"manifest [[study_kinds]]: {exc}", meta, source=source))
        return None, True
    try:
        workspaces = workspaces_from_meta(meta, plugin_dir)
        declared = {w.key for w in workspaces}
        for kind in kinds:
            if kind.workspace and kind.workspace not in declared:
                raise ValueError(f"study kind {kind.key}: workspace {kind.workspace!r} is not declared")
    except ValueError as exc:
        hub.failures.append(_failure_row(key, f"manifest [[workspaces]]: {exc}", meta, source=source))
        return None, True
    try:
        files = files_spec_from_meta(meta)
    except ValueError as exc:
        hub.failures.append(_failure_row(key, f"manifest [files]: {exc}", meta, source=source))
        return None, True
    from cfddesk.registry.plugin_env import python_env_from_meta

    try:
        python_env = python_env_from_meta(meta, plugin_dir)
    except ValueError as exc:
        hub.failures.append(_failure_row(key, f"manifest [python]: {exc}", meta, source=source))
        return None, True
    overrides = _overrides_from_meta(meta)
    hub.note_overrides(key, overrides)
    mod_name = f"cfddesk.{'_bundled' if tier == 'bundled' else '_plugins'}.{plugin_dir.name}"
    root = str(plugin_dir.resolve())
    if root not in sys.path:
        sys.path.insert(0, root)
    _PLUGIN_ROOTS.add(root)
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
        hub.failures.append(_failure_row(key, str(exc), meta, source=source))
        sys.modules.pop(mod_name, None)
        return None, True
    if isinstance(result, PluginManifest):
        _apply_disk_meta(result, meta, api, overrides, source)
        _apply_tier_meta(result, meta, tier)
        result.study_kinds = kinds
        result.workspaces = workspaces
        result.files = files
        result.python_env = python_env
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
    manifest = PluginManifest(
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
        source=source,
        license=str(meta.get("license") or ""),
        study_kinds=kinds,
        workspaces=workspaces,
        files=files,
        python_env=python_env,
    )
    _apply_tier_meta(manifest, meta, tier)
    return manifest, False


def _apply_tier_meta(result: PluginManifest, meta: dict[str, Any], tier: str) -> None:
    """Tier, required, dependencies and protected keys from manifest.toml."""
    from cfddesk.registry.base import protect

    result.tier = "bundled" if tier == "bundled" else "user"
    result.required, result.default_enabled = tier_flags(meta, result.tier)
    result.requires_plugins = _str_list(meta.get("requires_plugins"))
    result.protected = _str_list(meta.get("protected")) if result.tier == "bundled" else []
    for token in result.protected:
        kind, _, key = token.partition(":")
        if kind and key:
            protect(kind, key)
    # Checked before the plugin is imported (_load_ordered); only a required
    # bundled plugin's counts.
    try:
        spec = _parse_default_analysis(meta)
    except ValueError:
        spec = {}
    result.default_analysis = spec if result.tier == "bundled" and result.required else {}


_PLAIN_KEY = re.compile(r"^[A-Za-z][A-Za-z0-9_]*$")


def _parse_default_analysis(meta: dict[str, Any]) -> dict[str, Any]:
    """A manifest's ``[default_analysis]`` table: ``steady`` (an analysis key),
    ``transient`` (its sibling, optional) and ``aliases`` (stored names that mean
    it). ``{}`` when there is none."""
    raw = meta.get("default_analysis")
    if raw is None:
        return {}
    if not isinstance(raw, dict):
        raise ValueError("[default_analysis] must be a table")
    out: dict[str, Any] = {"steady": str(raw.get("steady") or "").strip()}
    transient = str(raw.get("transient") or "").strip()
    if transient:
        out["transient"] = transient
    out["aliases"] = _str_list(raw.get("aliases"))
    for name in [out["steady"], transient, *out["aliases"]]:
        if name and not _PLAIN_KEY.match(name):
            raise ValueError(f"[default_analysis] names must be plain keys, got {name!r}")
    if not out["steady"]:
        raise ValueError("[default_analysis] needs steady = \"<analysis key>\"")
    return out


_DEFAULT_FROM_DISK: dict[str, tuple[float, dict[str, Any]]] = {}


def default_analysis(*, loaded: bool = True) -> dict[str, Any] | None:
    """The analysis a study gets when none is named: the ``[default_analysis]``
    of the loaded required bundled plugin (``{steady, transient?, aliases}``),
    or None when it is not loaded.

    ``loaded=False`` also reads it from the required plugins' manifest.toml
    when they are not loaded (yet), without importing them, so the project
    model can name a study's analysis before the registry has loaded.
    """
    found = default_analysis_of(get_hub())
    if found or loaded:
        return found
    folder = bundled_dir_for(_resolve_web_root(None))
    if folder is None:
        return None
    for key in REQUIRED_BUNDLED:
        path = folder / key / "manifest.toml"
        try:
            mtime = path.stat().st_mtime
        except OSError:
            continue
        hit = _DEFAULT_FROM_DISK.get(str(path))
        if hit is None or hit[0] != mtime:
            meta = _parse_simple_toml(path.read_text(encoding="utf-8-sig"), source=str(path))
            try:
                spec = _parse_default_analysis(meta or {})
            except ValueError:
                spec = {}
            hit = (mtime, spec)
            _DEFAULT_FROM_DISK[str(path)] = hit
        if hit[1]:
            return dict(hit[1])
    return None


def default_analysis_of(hub: RegistryHub) -> dict[str, Any] | None:
    """The ``[default_analysis]`` of a required plugin loaded in ``hub``, or None."""
    for manifest in hub.manifests.values():
        if manifest.required and manifest.default_analysis:
            return dict(manifest.default_analysis)
    return None


def _check_default_analysis(hub: RegistryHub) -> None:
    """A required plugin's [default_analysis] must name its own analyses, of
    the right time dependency; otherwise the plugin fails to load."""
    analyses = hub.registry("analysis")
    for manifest in list(hub.manifests.values()):
        spec = manifest.default_analysis
        if not spec:
            continue
        for td in ("steady", "transient"):
            key = spec.get(td)
            if not key:
                continue
            if key not in analyses.keys() or analyses.owner(key) != manifest.key:
                err = f"[default_analysis] {td} = {key!r} is not one of its analyses"
            elif str(getattr(analyses.get(key), "time_dependency", "")) != td:
                err = f"[default_analysis] {td} = {key!r} is not a {td} analysis"
            else:
                continue
            _drop_failed_plugin(hub, manifest.key, err)
            break


def plugins_dir_for(root: Path | str) -> Path:
    """User plugin folders: ``root/plugins``, or ``MAGNUSIM_PLUGINS_DIR`` when set (the tests use it)."""
    override = (os.environ.get("MAGNUSIM_PLUGINS_DIR") or "").strip()
    return Path(override) if override else Path(root) / "plugins"


# The bundled plugins the product cannot work without (key -> display name).
# Missing, broken or failing one of these blocks creating and running
# simulations with an honest error instead of an empty picker.
REQUIRED_BUNDLED: dict[str, str] = {"incompressible_flow": "Incompressible Flow"}


def bundled_dir_for(root: Path | str | None = None) -> Path | None:
    """The bundled plugins ship with the app: ``<app>/bundled-plugins``.

    ``MAGNUSIM_BUNDLED_DIR`` overrides it (tests). A ``web_root`` given to
    load_all moves the user plugins folder only, never the bundled ones.
    """
    override = (os.environ.get("MAGNUSIM_BUNDLED_DIR") or "").strip()
    if override:
        return Path(override)
    try:
        from cfddesk.wsl.config import web_root as _app_root

        return Path(_app_root()) / "bundled-plugins"
    except Exception:
        return Path(root) / "bundled-plugins" if root is not None else None


_REQ_RE = re.compile(r"^\s*([A-Za-z0-9_.-]+)\s*(?:(>=|==|>|<=|<)\s*([0-9][0-9.]*))?\s*$")


def _version_tuple(v: str) -> tuple[int, ...]:
    out: list[int] = []
    for part in str(v or "0").split("."):
        m = re.match(r"\d+", part)
        out.append(int(m.group(0)) if m else 0)
    return tuple(out)


def _requirement_met(
    req: str, manifests: dict[str, PluginManifest], off: dict[str, str] | None = None
) -> str | None:
    """None when ``req`` ("key" or "key>=1.0") is satisfied, else why not.
    ``off``: plugins skipped because they are off, {key: name}."""
    m = _REQ_RE.match(req)
    if not m:
        return f"bad plugin requirement {req!r}"
    key, op, want = m.group(1), m.group(2), m.group(3)
    have = manifests.get(key)
    if have is None:
        if off and key in off:
            return f"needs the {off[key]} plugin, which is off"
        return f"needs the {key} plugin"
    if op:
        a, b = _version_tuple(have.version), _version_tuple(want or "0")
        ok = {">=": a >= b, ">": a > b, "==": a == b, "<=": a <= b, "<": a < b}[op]
        if not ok:
            return f"needs {key} {op} {want} (installed: {have.version})"
    return None


def _dependency_order(
    found: list[tuple[Path, dict[str, Any]]], hub: RegistryHub, *, source: str
) -> list[tuple[Path, dict[str, Any]]]:
    """Plugins ordered so each loads after the plugins it requires (sorted within a level).

    A cycle is an error: every plugin in it gets a failure row and is skipped.
    """
    by_key = {str(meta.get("key") or d.name): (d, meta) for d, meta in found}
    deps = {
        k: [r for r in (_REQ_RE.match(x) for x in _str_list(meta.get("requires_plugins"))) if r]
        for k, (_d, meta) in by_key.items()
    }
    order: list[str] = []
    state: dict[str, int] = {}  # 1 = visiting, 2 = done
    cyclic: set[str] = set()

    def visit(k: str, path: list[str]) -> None:
        if state.get(k) == 2:
            return
        if state.get(k) == 1:
            cyclic.update(path[path.index(k):])
            return
        state[k] = 1
        for r in deps.get(k, []):
            dep = r.group(1)
            if dep in by_key:
                visit(dep, [*path, dep])
        state[k] = 2
        order.append(k)

    for k in sorted(by_key):
        visit(k, [k])
    for k in sorted(cyclic):
        d, meta = by_key[k]
        hub.failures.append(
            _failure_row(k, f"plugin dependency cycle: {' -> '.join(sorted(cyclic))}", meta, source=source)
        )
    return [by_key[k] for k in order if k not in cyclic]


def _load_ordered(
    found: list[tuple[Path, dict[str, Any]]],
    hub: RegistryHub,
    state: PluginState,
    *,
    tier: str,
) -> tuple[list[PluginManifest], bool]:
    source = "bundled" if tier == "bundled" else "local"
    manifests: list[PluginManifest] = []
    had_failures = False
    off_names = {str(r.get("key")): str(r.get("name")) for r in hub.off_plugins}
    for child, meta in _dependency_order(found, hub, source=source):
        key = str(meta.get("key") or child.name)
        try:
            required, default_enabled = tier_flags(meta, tier)
            if _parse_default_analysis(meta) and not (tier == "bundled" and required):
                raise ValueError("[default_analysis] is only for a required bundled plugin")
        except ValueError as exc:
            hub.failures.append(_failure_row(key, f"manifest: {exc}", meta, source=source))
            had_failures = True
            continue
        # Decided before anything is imported: a plugin that is off is never run.
        if not plugin_is_on(key, tier=tier, required=required, default_enabled=default_enabled, state=state):
            log.info("Plugin %s is off", key)
            hub.off_plugins.append(_off_row(child, meta, key, tier, default_enabled))
            off_names[key] = str(meta.get("name") or key)
            continue
        unmet = [
            why
            for req in _str_list(meta.get("requires_plugins"))
            if (why := _requirement_met(req, hub.manifests, off_names))
        ]
        if unmet:
            hub.failures.append(_failure_row(key, "; ".join(unmet), meta, source=source))
            had_failures = True
            continue
        m, failed = _load_folder_plugin(child, hub, meta=meta, tier=tier)
        if failed:
            had_failures = True
        if m is not None:
            hub.manifests[m.key] = m
            hub.note_plugin_dir(m.key, child)
            manifests.append(m)
    return manifests, had_failures


def _off_row(child: Path, meta: dict[str, Any], key: str, tier: str, default_enabled: bool) -> dict[str, Any]:
    """What the catalog shows of a folder plugin that is off (from its manifest only)."""
    ui, entry = _ui_fields(meta)
    return {
        "key": key,
        "name": str(meta.get("name") or key),
        "version": str(meta.get("version") or "0.0.0"),
        "description": str(meta.get("description") or ""),
        "authors": _authors(meta.get("authors")),
        "ui": ui,
        "ui_entry": entry,
        "license": str(meta.get("license") or ""),
        "tier": "bundled" if tier == "bundled" else "user",
        "source": "bundled" if tier == "bundled" else "local",
        "dir": child.name,
        "default_enabled": default_enabled,
    }


def _scan_plugin_dir(
    folder: Path | None, hub: RegistryHub, *, tier: str = "user"
) -> tuple[list[tuple[Path, dict[str, Any]]], bool]:
    if folder is None or not folder.is_dir():
        return [], False
    found: list[tuple[Path, dict[str, Any]]] = []
    had_failures = False
    for child in sorted(folder.iterdir()):
        if not child.is_dir():
            continue
        meta, failed = _read_manifest(child, hub, tier=tier)
        had_failures = had_failures or failed
        if meta is not None:
            found.append((child, meta))
    return found, had_failures


def discover_bundled_plugins(
    hub: RegistryHub,
    *,
    web_root: Path | str | None = None,
) -> tuple[list[PluginManifest], bool]:
    """Load the plugins that ship with the app, in dependency order.

    A required one (``required = true``) ignores the off list. Every key in
    :data:`REQUIRED_BUNDLED` that did not load is recorded in
    ``hub.required_failures`` with the reason.
    """
    folder = bundled_dir_for(_resolve_web_root(web_root))
    found, scan_failed = _scan_plugin_dir(folder, hub, tier="bundled")
    state = plugin_state(_resolve_web_root(web_root))
    manifests, failed = _load_ordered(found, hub, state, tier="bundled")
    hub.required_failures.clear()
    _record_required_failures(hub, folder)
    return manifests, (scan_failed or failed)


def _record_required_failures(hub: RegistryHub, folder: Path | None) -> None:
    """A ``hub.required_failures`` row (logged once) for every key in
    :data:`REQUIRED_BUNDLED` that is not loaded and has no row yet.

    Runs after the bundled plugins load, and again after cross-reference
    validation, which can unload a required plugin whose analyses lost a
    solver, BC type, material or monitor to another plugin.
    """
    have = {str(r.get("key")) for r in hub.required_failures}
    for key, name in REQUIRED_BUNDLED.items():
        if key in hub.manifests or key in have:
            continue
        err = next((f.get("error") for f in hub.failures if f.get("key") == key), None)
        row = {
            "key": key,
            "name": name,
            "error": str(err or f"not found in {folder}"),
            "folder": str(folder) if folder is not None else "",
        }
        row["log"] = _log_required_failure(row)
        hub.required_failures.append(row)


def _log_required_failure(row: dict[str, Any]) -> str:
    """Append a required plugin's load failure to .cache/logs/plugins.log; return the path."""
    import datetime

    try:
        from cfddesk.wsl.config import web_root as _app_root

        path = Path(_app_root()) / ".cache" / "logs" / "plugins.log"
        path.parent.mkdir(parents=True, exist_ok=True)
        stamp = datetime.datetime.now().isoformat(timespec="seconds")
        with path.open("a", encoding="utf-8") as fh:
            fh.write(f"{stamp} {row['name']} ({row['key']}) failed to load: {row['error']}\n")
        return str(path)
    except OSError:
        return ""


def discover_folder_plugins(
    hub: RegistryHub,
    *,
    web_root: Path | str | None = None,
) -> tuple[list[PluginManifest], bool]:
    """Discover plugins under web_root/plugins. Returns (manifests, had_failures)."""
    root = _resolve_web_root(web_root)
    if root is None:
        return [], False
    found, scan_failed = _scan_plugin_dir(plugins_dir_for(root), hub)
    manifests, failed = _load_ordered(found, hub, plugin_state(Path(root)), tier="user")
    return manifests, (scan_failed or failed)


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

    Sets _LOADED True only when discovery completed without plugin-load failures.
    After a partial load, a later load_all() without force=True retries discovery
    once the plugin folders change on disk or _RETRY_AFTER_S has passed (not on
    every call). Builtins stay registered across retries (not wiped).
    """
    global _LOADED, _BUILTINS_REGISTERED, _FAILED_AT, _FAILED_SIG
    hub = get_hub()
    if _LOADED and not force:
        return hub
    if not force and _FAILED_AT is not None:
        import time

        if time.monotonic() - _FAILED_AT < _RETRY_AFTER_S and _plugin_sources_signature(web_root) == _FAILED_SIG:
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
    hub.off_plugins.clear()
    hub._loading_overrides.clear()
    _purge_plugin_modules()
    get_hooks().clear()
    from cfddesk.registry.base import clear_plugin_protected

    clear_plugin_protected()
    disabled = _disabled_plugins(_resolve_web_root(web_root))
    # Order: core builtins, the bundled plugins (in dependency order), entry
    # points, then the user's plugins folder.
    _, bundled_fail = discover_bundled_plugins(hub, web_root=web_root)
    _, ep_fail = discover_entry_points(hub, disabled)
    _, folder_fail = discover_folder_plugins(hub, web_root=web_root)
    # After plugins: every AnalysisType bag key must resolve (solver/bc/material/monitor).
    _validate_cross_refs(hub)
    _check_default_analysis(hub)
    # A required plugin unloaded by these checks is missing too (the app says so).
    _record_required_failures(hub, bundled_dir_for(_resolve_web_root(web_root)))
    from cfddesk.registry.tools import sync_tool_kinds

    sync_tool_kinds(hub)
    _LOADED = not (bundled_fail or ep_fail or folder_fail)
    if _LOADED:
        _FAILED_AT = None
        _FAILED_SIG = None
    else:
        import time

        _FAILED_AT = time.monotonic()
        _FAILED_SIG = _plugin_sources_signature(web_root)
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
    dir: str | None = None,
    license: str = "",
    tier: str = "user",
    required: bool = False,
    python_env: dict[str, Any] | None = None,
    notes: list[str] | None = None,
    workspaces: list[dict[str, Any]] | None = None,
    default_enabled: bool = True,
    files: dict[str, int] | None = None,
) -> dict[str, Any]:
    return {
        # "bundled" ships with the app; a required one cannot be turned off.
        "tier": tier,
        "required": required,
        # False: an optional bundled plugin that ships off until someone turns it on.
        "default_enabled": default_enabled,
        "key": key,
        # Folder name under the plugins root (never a full path); a manifest key
        # may differ from it, and the UI files are served from the folder.
        "dir": dir,
        "license": license,
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
        # Its own environment ([python]): state ready / needs_setup / failed.
        "python_env": python_env,
        # What is only reported (a GPU the plugin can do without).
        "notes": list(notes or []),
        # Full workspaces it draws in a sandboxed frame.
        "workspaces": list(workspaces or []),
        # Size limits (bytes) for its own files in a project; the defaults when not loaded.
        "files": dict(files) if files else _files_row(FilesSpec()),
    }


def _env_row_public(env_row: dict[str, Any] | None) -> dict[str, Any] | None:
    """What the Plugins settings row shows of an environment (no local paths)."""
    if env_row is None:
        return None
    return {
        "state": env_row.get("state"),
        "error": env_row.get("error") or "",
        "tail": list(env_row.get("tail") or [])[-8:],
        "lock_hash": env_row.get("lock_hash") or "",
        "service": bool(env_row.get("service")),
        "python_version": env_row.get("python_version") or "",
    }


def plugin_catalog(web_root: Path | str | None = None) -> list[dict[str, Any]]:
    """Rows for plugins.list: loaded, disabled, incompatible, and load failures."""
    import shutil

    from cfddesk.registry import wsl_tools
    from cfddesk.registry.plugin_env import env_status
    from cfddesk.registry.requirements import check_requirements

    hub = get_hub()
    root = _resolve_web_root(web_root)
    state = plugin_state(root)
    disabled = set(state.disabled)
    # The real environment: programs in WSL (cached probe; None until it answers),
    # each plugin's own packages (its environment's stamp), an NVIDIA GPU.
    wsl_names = {
        str(r.name)
        for m in hub.manifests.values()
        for r in (m.requires or [])
        if getattr(r, "kind", "") == "wsl_tool"
    }
    have_wsl = wsl_tools.available(wsl_names, root) if wsl_names else set()
    gpu = shutil.which("nvidia-smi") is not None
    items: list[dict[str, Any]] = []
    seen: set[str] = set()

    def add(row: dict[str, Any]) -> None:
        key = str(row.get("key") or "")
        if not key or key in seen:
            return
        seen.add(key)
        items.append(row)

    for manifest in hub.manifests.values():
        env_row: dict[str, Any] | None = None
        if manifest.python_env is not None and root is not None:
            env_row = env_status(root, manifest.key, manifest.python_env)
        missing = check_requirements(
            manifest,
            {"wsl_tools": have_wsl, "python_packages": (env_row or {}).get("installed") or [], "gpu": gpu},
        )
        reasons = [str(item.reason) for item in missing if item.blocking]
        notes = [str(item.reason) for item in missing if not item.blocking]
        required = bool(getattr(manifest, "required", False))
        tier = str(getattr(manifest, "tier", "user") or "user")
        default_enabled = bool(getattr(manifest, "default_enabled", True))
        # The lists as they are now (a hand edit, or a change the hub has not reloaded).
        if not plugin_is_on(manifest.key, tier=tier, required=required, default_enabled=default_enabled, state=state):
            status = "disabled"
        elif env_row is not None and env_row.get("state") != "ready":
            status = "needs setup"
        elif reasons:
            status = "missing requirement"
        else:
            status = "enabled"
        source = manifest.source or ("local" if hub.plugin_dir(manifest.key) else "entry_point")
        folder = hub.plugin_dir(manifest.key)
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
                dir=folder.name if folder is not None else None,
                license=str(manifest.license or ""),
                tier=tier,
                required=required,
                python_env=_env_row_public(env_row),
                notes=notes,
                workspaces=[
                    {"key": w.key, "title": w.title, "icon": w.icon, "entry": w.entry}
                    for w in (manifest.workspaces or [])
                ],
                default_enabled=default_enabled,
                files=_files_row(getattr(manifest, "files", None) or FilesSpec()),
            )
        )
    # Folder plugins that are off: listed from their manifest, so they can be turned on.
    for row in hub.off_plugins:
        add(
            _catalog_row(
                key=str(row["key"]),
                name=str(row["name"]),
                version=str(row["version"]),
                description=str(row["description"]),
                authors=list(row["authors"]),
                ui=row["ui"],
                ui_entry=str(row["ui_entry"]),
                source=str(row["source"]),
                status="disabled",
                enabled=False,
                dir=str(row["dir"]),
                license=str(row["license"]),
                tier=str(row["tier"]),
                default_enabled=bool(row["default_enabled"]),
            )
        )
    for row in hub.required_failures:
        add(
            _catalog_row(
                key=str(row.get("key") or ""),
                name=str(row.get("name") or row.get("key") or ""),
                source="bundled",
                status="error",
                enabled=False,
                error=str(row.get("error") or ""),
                tier="bundled",
                required=True,
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
                tier="bundled" if row.get("source") == "bundled" else "user",
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
                tier="bundled" if row.get("source") == "bundled" else "user",
            )
        )
    plugins_dir = plugins_dir_for(root) if root is not None else None
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
                    dir=child.name,
                )
            )
    return items

