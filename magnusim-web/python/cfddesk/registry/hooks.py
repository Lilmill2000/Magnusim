"""Host hook bus. API 1.0 names are frozen."""

from __future__ import annotations

from collections.abc import Callable
from typing import Any

from cfddesk.registry.base import RegistryError

HOOK_NAMES: frozenset[str] = frozenset(
    {
        "project.load",
        "project.save",
        "project.migrate",
        "geometry.import",
        "geometry.preview",
        "analysis.validate",
        "case.write",
        "case.written",
        "case.write_field",
        "mesh.fingerprint",
        "mesh.generate",
        "mesh.result",
        "solve.prepare",
        "solve.parse_line",
        "solve.stop",
        "results.load",
        "results.filter",
        "ui.tree.transform",
    }
)

Listener = Callable[..., Any]
Around = Callable[..., Any]


class HookBus:
    """on/around listeners tagged with a plugin id, run in priority order."""

    def __init__(self) -> None:
        self._seq = 0
        self._on: dict[str, list[tuple[int, str, int, Listener]]] = {}
        self._around: dict[str, list[tuple[int, str, int, Around]]] = {}

    def clear(self) -> None:
        self._on.clear()
        self._around.clear()

    def clear_plugin(self, plugin: str) -> None:
        want = str(plugin or "")
        for name, rows in list(self._on.items()):
            self._on[name] = [row for row in rows if row[1] != want]
        for name, rows in list(self._around.items()):
            self._around[name] = [row for row in rows if row[1] != want]

    def on(
        self,
        name: str,
        fn: Listener,
        priority: int = 0,
        *,
        plugin: str = "",
    ) -> None:
        self._check(name)
        self._seq += 1
        self._on.setdefault(name, []).append((int(priority), str(plugin or ""), self._seq, fn))

    def around(
        self,
        name: str,
        fn: Around,
        priority: int = 0,
        *,
        plugin: str = "",
    ) -> None:
        """Register fn(proceed, **ctx). proceed(**ctx) runs the next wrapper or the host."""
        self._check(name)
        self._seq += 1
        self._around.setdefault(name, []).append(
            (int(priority), str(plugin or ""), self._seq, fn)
        )

    def call(self, name: str, **ctx: Any) -> list[Any]:
        self._check(name)
        out: list[Any] = []
        for _priority, _plugin, _seq, fn in self._ordered(self._on.get(name, [])):
            out.append(fn(**ctx))
        return out

    def apply(self, name: str, inner: Callable[..., Any], **ctx: Any) -> Any:
        """Run around-hooks around inner. No hooks calls inner once."""
        self._check(name)
        layers = self._ordered(self._around.get(name, []))

        def invoke(index: int, **kw: Any) -> Any:
            if index >= len(layers):
                return inner(**kw)
            _priority, _plugin, _seq, fn = layers[index]

            def proceed(**inner_kw: Any) -> Any:
                return invoke(index + 1, **inner_kw)

            return fn(proceed, **kw)

        return invoke(0, **ctx)

    def _ordered(
        self, rows: list[tuple[int, str, int, Callable[..., Any]]]
    ) -> list[tuple[int, str, int, Callable[..., Any]]]:
        return sorted(rows, key=lambda row: (row[0], row[2]))

    def _check(self, name: str) -> None:
        if name not in HOOK_NAMES:
            raise RegistryError(f"unknown hook {name!r}")


_BUS = HookBus()


def get_hooks() -> HookBus:
    return _BUS
