"""Generic Registry[T] for plugin specs."""

from __future__ import annotations

import logging
from typing import Any, Generic, Protocol, TypeVar, runtime_checkable

log = logging.getLogger(__name__)


class RegistryError(Exception):
    """Raised for duplicate keys or missing registry entries."""


@runtime_checkable
class Spec(Protocol):
    """Minimal protocol every registered spec must satisfy."""

    key: str
    label: str


T = TypeVar("T")

# Core specs a plugin may replace only when manifest.overrides names them,
# and may not drop unless a test passes allow_protected=True.
PROTECTED_KEYS: frozenset[tuple[str, str]] = frozenset(
    {
        ("mesher", "cfmesh"),
        ("mesher", "standard"),
    }
)

# The same protection for specs a bundled plugin owns: its manifest lists them
# (``protected = ["analysis:incompressible_steady", ...]``) and discovery adds
# them here while it is loaded.
_PLUGIN_PROTECTED: set[tuple[str, str]] = set()


def protect(kind: str, key: str) -> None:
    _PLUGIN_PROTECTED.add((str(kind), str(key)))


def clear_plugin_protected() -> None:
    _PLUGIN_PROTECTED.clear()


def is_protected(kind: str, key: str) -> bool:
    return (kind, key) in PROTECTED_KEYS or (kind, key) in _PLUGIN_PROTECTED


def _manifest_overrides(plugin: str) -> list[str]:
    """Overrides stashed for ``plugin`` on the live hub (manifest or in-flight load)."""
    from cfddesk.registry.discovery import get_hub

    return get_hub().current_overrides(plugin)


def _schema_to_json(schema: Any, *, kind: str, key: str, bag: str) -> Any:
    """Convert SchemaField bags to JSON Schema; warn + None on failure."""
    try:
        from cfddesk.registry.schema import to_json_schema

        return to_json_schema(list(schema))
    except (TypeError, ValueError, AttributeError) as exc:
        log.warning(
            "describe: %s for %s/%s failed (%s); setting %s=None",
            bag,
            kind,
            key,
            exc,
            bag,
        )
        return None


def _plain_json(value: Any) -> Any:
    """A JSON-ready copy of plain data (tuples become lists, other objects text)."""
    if isinstance(value, dict):
        return {str(k): _plain_json(v) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        return [_plain_json(v) for v in value]
    if isinstance(value, (str, int, float, bool)) or value is None:
        return value
    return str(value)


class Registry(Generic[T]):
    """Keyed store of specs for one kind (analysis, solver, bc, ...)."""

    def __init__(self, kind: str) -> None:
        self.kind = kind
        self._items: dict[str, T] = {}
        self._plugins: dict[str, str] = {}
        self._baseline: dict[str, tuple[T, str]] = {}

    def register(self, spec: T, *, plugin: str = "builtin") -> None:
        key = getattr(spec, "key", None)
        if not isinstance(key, str) or not key:
            raise RegistryError(f"{self.kind}: spec missing non-empty key")
        if self.kind == "mesher":
            from cfddesk.registry.mesher import validate_mesher

            validate_mesher(spec)
        existing_plugin = self._plugins.get(key)
        if key in self._items and existing_plugin != plugin:
            raise RegistryError(
                f"{self.kind}: duplicate key {key!r} "
                f"(owned by plugin {existing_plugin!r}, refused from {plugin!r})"
            )
        # Same plugin re-register is allowed (tests / idempotent load).
        self._items[key] = spec
        self._plugins[key] = plugin
        # Best-effort stamp plugin on mutable specs for describe().
        if not hasattr(spec, "plugin"):
            try:
                object.__setattr__(spec, "plugin", plugin)
            except (AttributeError, TypeError):
                pass

    def replace(self, spec: T, *, plugin: str) -> None:
        """Swap an existing spec. The plugin manifest must list ``kind:key``."""
        key = getattr(spec, "key", None)
        if not isinstance(key, str) or not key:
            raise RegistryError(f"{self.kind}: spec missing non-empty key")
        token = f"{self.kind}:{key}"
        if token not in set(_manifest_overrides(plugin)):
            raise RegistryError(
                f"{self.kind}: replace {key!r} refused; {token} is not in manifest.overrides"
            )
        if key not in self._items:
            raise RegistryError(f"{self.kind}: cannot replace unknown key {key!r}")
        if self.kind == "mesher":
            from cfddesk.registry.mesher import validate_mesher

            validate_mesher(spec)
        if key not in self._baseline:
            self._baseline[key] = (self._items[key], self._plugins.get(key, "builtin"))
        self._items[key] = spec
        self._plugins[key] = plugin
        if not hasattr(spec, "plugin"):
            try:
                object.__setattr__(spec, "plugin", plugin)
            except (AttributeError, TypeError):
                pass

    def unregister(
        self,
        key: str,
        *,
        plugin: str,
        allow_protected: bool = False,
    ) -> None:
        """Drop a spec. Protected built-ins stay unless a test explicitly allows it."""
        token = f"{self.kind}:{key}"
        protected = is_protected(self.kind, key)
        named = token in set(_manifest_overrides(plugin))
        if protected and not (named and allow_protected):
            raise RegistryError(f"{self.kind}: refusing to unregister protected key {key!r}")
        if key not in self._items:
            raise RegistryError(f"{self.kind}: unknown key {key!r}")
        if key in self._baseline:
            spec, owner = self._baseline.pop(key)
            self._items[key] = spec
            self._plugins[key] = owner
            return
        if protected:
            raise RegistryError(f"{self.kind}: protected key {key!r} stays registered")
        if not named and plugin != self._plugins.get(key):
            raise RegistryError(
                f"{self.kind}: unregister {key!r} refused for plugin {plugin!r}"
            )
        del self._items[key]
        self._plugins.pop(key, None)

    def drop_plugin(self, plugin: str) -> list[str]:
        """Remove every spec ``plugin`` registered; restore any builtin it replaced."""
        dropped: list[str] = []
        for key, owner in list(self._plugins.items()):
            if owner != plugin:
                continue
            if key in self._baseline:
                spec, base_owner = self._baseline.pop(key)
                self._items[key] = spec
                self._plugins[key] = base_owner
            else:
                self._items.pop(key, None)
                self._plugins.pop(key, None)
            dropped.append(key)
        return dropped

    def owner(self, key: str) -> str:
        if key not in self._items:
            raise RegistryError(f"{self.kind}: unknown key {key!r}")
        return self._plugins.get(key, "builtin")

    def get(self, key: str) -> T:
        try:
            return self._items[key]
        except KeyError as exc:
            raise RegistryError(f"{self.kind}: unknown key {key!r}") from exc

    def keys(self) -> list[str]:
        return list(self._items.keys())

    def items(self) -> list[T]:
        return list(self._items.values())

    def clear(self) -> None:
        self._items.clear()
        self._plugins.clear()
        self._baseline.clear()

    def describe(self) -> list[dict[str, Any]]:
        out: list[dict[str, Any]] = []
        for key, spec in self._items.items():
            row: dict[str, Any] = {
                "key": key,
                "label": getattr(spec, "label", key),
                "plugin": self._plugins.get(key, getattr(spec, "plugin", "builtin")),
            }
            # Historical dump key: settings/params/properties/schema -> "schema"
            primary = (
                getattr(spec, "settings_schema", None)
                or getattr(spec, "params_schema", None)
                or getattr(spec, "properties_schema", None)
                or getattr(spec, "schema", None)
            )
            if primary is not None:
                row["schema"] = _schema_to_json(
                    primary, kind=self.kind, key=key, bag="schema"
                )
            # AnalysisType bags (land16): emit when present so dump isn't hollow.
            for bag in ("numerics_schema", "control_schema"):
                if not hasattr(spec, bag):
                    continue
                bag_val = getattr(spec, bag)
                if bag_val is None:
                    continue
                row[bag] = _schema_to_json(
                    bag_val, kind=self.kind, key=key, bag=bag
                )
            requires = getattr(spec, "requires", None)
            if requires is not None:
                row["requires"] = [
                    r.__dict__ if hasattr(r, "__dict__") else r for r in list(requires)
                ]
            if hasattr(spec, "supported"):
                row["supported"] = bool(spec.supported)
            if self.kind == "mesher":
                from cfddesk.project.mesh_refinements import (
                    REFINEMENT_TYPE_HINTS,
                    REFINEMENT_TYPE_LABELS,
                )

                row["engine"] = str(getattr(spec, "engine", "") or key)
                row["refinement_types"] = [
                    {"key": t, "label": REFINEMENT_TYPE_LABELS[t], "hint": REFINEMENT_TYPE_HINTS.get(t, "")}
                    for t in getattr(spec, "refinement_types", ()) or ()
                ]
                row["stage_labels"] = dict(getattr(spec, "stage_labels", ()) or ())
                row["stage_details"] = [list(d) for d in getattr(spec, "stage_details", ()) or ()]
                row["report"] = [list(r) for r in getattr(spec, "report", ()) or ()]
            if self.kind == "filter":
                for extra in ("tool", "cache_scope", "output"):
                    if hasattr(spec, extra):
                        row[extra] = getattr(spec, extra)
            # AnalysisType product keys W17 reads from the dump (not a parallel JS dict).
            if self.kind == "analysis":
                for extra in (
                    "time_dependency",
                    "default_turbulence",
                    "default_solver",
                    "category",
                    "turbulence_models",
                ):
                    if not hasattr(spec, extra):
                        continue
                    val = getattr(spec, extra)
                    if val is None:
                        continue
                    # API 1.0 turbulence fields: published only when the analysis sets them.
                    if extra in ("default_turbulence", "turbulence_models") and not val:
                        continue
                    row[extra] = list(val) if isinstance(val, tuple) else val
                from cfddesk.registry.contract import describe_extra

                row.update(describe_extra(spec))
            if self.kind == "solver":
                for extra in ("application", "time_dependency", "parallel", "stop_strategy"):
                    if hasattr(spec, extra):
                        row[extra] = getattr(spec, extra)
            if self.kind == "bc":
                # API 1.4: what the BC type is and which family variant it is.
                from cfddesk.registry.bc import describe_bc

                row.update(describe_bc(spec))
            if self.kind == "bc_family":
                from cfddesk.registry.bc import describe_bc_family

                row.update(describe_bc_family(spec))
            if self.kind == "material":
                # API 1.4: the properties form, the presets and how a record stores them.
                if "schema" not in row:
                    row["schema"] = _schema_to_json(
                        getattr(spec, "properties_schema", ()) or (), kind=self.kind, key=key, bag="properties_schema"
                    )
                row["library"] = _plain_json(list(getattr(spec, "library", ()) or ()))
                row["record_keys"] = {
                    str(k): [str(a) for a in v] for k, v in dict(getattr(spec, "record_keys", None) or {}).items()
                }
                row["record_constants"] = _plain_json(dict(getattr(spec, "record_constants", None) or {}))
                row["custom_preset"] = str(getattr(spec, "custom_preset", "custom") or "custom")
            if self.kind == "monitor":
                # API 1.4: what the monitor is and measures; its fields_schema is its "schema".
                row["target"] = str(getattr(spec, "target", "") or "")
                row["description"] = str(getattr(spec, "description", "") or "")
                row["aliases"] = [str(a) for a in getattr(spec, "aliases", ()) or ()]
                row["user_creatable"] = bool(getattr(spec, "user_creatable", False))
                row["quantities"] = [str(q) for q in getattr(spec, "quantities", ()) or ()]
                if "schema" not in row:
                    row["schema"] = _schema_to_json(
                        getattr(spec, "fields_schema", ()) or (), kind=self.kind, key=key, bag="fields_schema"
                    )
            out.append(row)
        return out
