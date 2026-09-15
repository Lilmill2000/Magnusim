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


class Registry(Generic[T]):
    """Keyed store of specs for one kind (analysis, solver, bc, ...)."""

    def __init__(self, kind: str) -> None:
        self.kind = kind
        self._items: dict[str, T] = {}
        self._plugins: dict[str, str] = {}

    def register(self, spec: T, *, plugin: str = "builtin") -> None:
        key = getattr(spec, "key", None)
        if not isinstance(key, str) or not key:
            raise RegistryError(f"{self.kind}: spec missing non-empty key")
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

    def describe(self) -> list[dict[str, Any]]:
        out: list[dict[str, Any]] = []
        for key, spec in self._items.items():
            row: dict[str, Any] = {
                "key": key,
                "label": getattr(spec, "label", key),
                "plugin": self._plugins.get(key, getattr(spec, "plugin", "builtin")),
            }
            # Historical dump key: settings/params/schema -> "schema"
            primary = (
                getattr(spec, "settings_schema", None)
                or getattr(spec, "params_schema", None)
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
                row["supported"] = bool(getattr(spec, "supported"))
            out.append(row)
        return out