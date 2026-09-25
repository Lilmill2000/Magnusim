"""Extra BC field writers. Built-in write_U / write_p stay the default."""

from __future__ import annotations

from collections.abc import Callable
from typing import Any


class BcExtensions:
    """hub.bc.extend(key, field, writer) stores a field writer on an existing BC."""

    def __init__(self) -> None:
        self._hub: Any = None
        self._extra: dict[tuple[str, str], tuple[Callable[..., Any], str]] = {}

    def bind(self, hub: Any) -> None:
        self._hub = hub

    def clear(self) -> None:
        self._extra.clear()

    def extend(
        self,
        key: str,
        field: str,
        writer: Callable[..., Any],
        *,
        plugin: str = "",
    ) -> None:
        if self._hub is None:
            raise RuntimeError("BC extensions are not bound to a hub")
        self._hub.registry("bc").get(key)
        self._extra[(str(key), str(field))] = (writer, str(plugin or ""))

    def writer(self, key: str, field: str) -> Callable[..., Any] | None:
        if self._hub is None:
            return None
        spec = self._hub.registry("bc").get(key)
        if field == "U" and getattr(spec, "write_U", None) is not None:
            return spec.write_U
        if field == "p" and getattr(spec, "write_p", None) is not None:
            return spec.write_p
        found = self._extra.get((str(key), str(field)))
        if found is not None:
            return found[0]
        if field == "T":
            return getattr(spec, "write_T", None)
        return None
