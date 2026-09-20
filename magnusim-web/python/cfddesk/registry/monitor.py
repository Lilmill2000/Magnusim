"""MonitorType registry (Phase 2 land5 / land5-fix).

Named MonitorType (registry type key/label/target). Distinct from
case.function_objects.MonitorSpec (patch + kind instance descriptor) - same
lesson as SolverApp vs settings.SolverBackend: do not collapse or rename the
Phase 1 FO type; keep both modules' names explicit.
"""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass
from typing import TYPE_CHECKING, Any, Literal

from cfddesk.registry.base import RegistryError
from cfddesk.registry.schema import SchemaField

if TYPE_CHECKING:
    from cfddesk.registry.discovery import RegistryHub

MonitorTarget = Literal["patch", "point", "volume", "line"]


@dataclass(frozen=True)
class MonitorType:
    """Registered monitor / functionObject type (area_average, flow_rate, ...)."""

    key: str
    label: str
    target: MonitorTarget
    fields_schema: tuple[SchemaField, ...] = ()
    # Soft-pass stubs - point at Phase 1 function_objects without moving call sites.
    write_function_object: Callable[..., str] | None = None
    parse_dat: Callable[[str], Any] | None = None


def validate_analysis_monitor_refs(hub: RegistryHub) -> None:
    """Fail if any AnalysisType.monitors key is not registered."""
    mon_keys = set(hub.registry("monitor").keys())
    for spec in hub.registry("analysis").items():
        bag = tuple(getattr(spec, "monitors", ()) or ())
        unknown = [k for k in bag if k not in mon_keys]
        if unknown:
            key = getattr(spec, "key", "?")
            raise RegistryError(
                f"analysis {key!r}: unknown monitor key(s) {unknown}; "
                f"registered monitors={sorted(mon_keys)}"
            )
