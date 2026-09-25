"""ToolKind — a synchronous tool filled from a ResultFilterType."""

from __future__ import annotations

from dataclasses import dataclass
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from cfddesk.registry.discovery import RegistryHub


@dataclass(frozen=True)
class ToolKind:
    """One filter/export tool. ``args_from_params`` become ``--name value`` flags."""

    key: str
    tool: str
    args_from_params: tuple[str, ...] = ()
    cache_scope: str = "case"
    output: str = "json"


def sync_tool_kinds(hub: RegistryHub) -> None:
    """Register a ToolKind for every ResultFilterType currently on the hub."""
    from cfddesk.registry.result_filter import ResultFilterType

    reg = hub.registry("tool")
    filt = hub.registry("filter")
    for spec in filt.items():
        if not isinstance(spec, ResultFilterType):
            continue
        reg.register(
            ToolKind(
                key=spec.key,
                tool=spec.tool,
                args_from_params=tuple(getattr(spec, "args_from_params", ()) or ()),
                cache_scope=str(spec.cache_scope),
                output=str(spec.output),
            ),
            plugin=filt.owner(spec.key),
        )
