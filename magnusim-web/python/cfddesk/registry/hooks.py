"""Host hook bus. API 1.0 names are frozen.

Only the names in :data:`FIRED_HOOKS` ever fire. The rest are reserved: a
plugin may still register them (it loads), and the bus logs once that they
never fire in API 1.3.
"""

from __future__ import annotations

import logging
from collections.abc import Callable
from typing import Any

from cfddesk.registry.base import RegistryError

log = logging.getLogger(__name__)

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

# The names the host fires (API 1.3). The solve names fire in the solve relay
# (cfddesk.wsl.solve_hooks), only when some plugin listens.
FIRED_HOOKS: frozenset[str] = frozenset(
    {
        "case.write",
        "case.written",
        "ui.tree.transform",
        "solve.prepare",
        "solve.parse_line",
        "solve.stop",
    }
)
RESERVED_HOOKS: frozenset[str] = HOOK_NAMES - FIRED_HOOKS

# (plugin, name) pairs already told that their hook is reserved.
_RESERVED_SAID: set[tuple[str, str]] = set()

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
        _say_reserved(name, plugin)
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
        _say_reserved(name, plugin)
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

    def has_listeners(self, name: str) -> bool:
        """Whether any plugin listens on ``name`` (an ``on`` listener)."""
        self._check(name)
        return bool(self._on.get(name))

    def listeners(self, name: str) -> list[tuple[str, Listener]]:
        """``(plugin, fn)`` of every ``on`` listener of ``name``, in the order they run."""
        self._check(name)
        return [(plugin, fn) for _priority, plugin, _seq, fn in self._ordered(self._on.get(name, []))]

    def drop(self, name: str, fn: Listener) -> None:
        """Remove one ``on`` listener of ``name`` (it raised, or was too slow)."""
        self._on[name] = [row for row in self._on.get(name, []) if row[3] is not fn]

    def notify(self, name: str, **ctx: Any) -> int:
        """Run each listener in its own ``try``: one that raises is logged and dropped,
        and the others still run. Returns how many ran without raising."""
        self._check(name)
        ok = 0
        for plugin, fn in self.listeners(name):
            try:
                fn(**ctx)
                ok += 1
            except Exception as exc:
                log.warning("hook %s of %s raised and was dropped: %s", name, plugin or "?", exc)
                self.drop(name, fn)
        return ok

    def _ordered(
        self, rows: list[tuple[int, str, int, Callable[..., Any]]]
    ) -> list[tuple[int, str, int, Callable[..., Any]]]:
        return sorted(rows, key=lambda row: (row[0], row[2]))

    def _check(self, name: str) -> None:
        if name not in HOOK_NAMES:
            raise RegistryError(f"unknown hook {name!r}")


def _say_reserved(name: str, plugin: str) -> None:
    """Log once per plugin and name that a reserved hook never fires."""
    if name not in RESERVED_HOOKS:
        return
    key = (str(plugin or ""), name)
    if key in _RESERVED_SAID:
        return
    _RESERVED_SAID.add(key)
    log.warning("hook %s is reserved and never fires in API 1.3 (plugin %s)", name, plugin or "?")


_BUS = HookBus()


def get_hooks() -> HookBus:
    return _BUS
