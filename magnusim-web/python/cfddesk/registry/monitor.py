"""MonitorType registry (Phase 2 land5 / land5-fix).

Named MonitorType (registry type key/label/target). Distinct from
case.function_objects.MonitorSpec (patch + kind instance descriptor): do not
collapse or rename the Phase 1 FO type; keep both modules' names explicit.
"""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass
from typing import TYPE_CHECKING, Any, Literal

from cfddesk.registry.base import RegistryError
from cfddesk.registry.schema import SchemaField

if TYPE_CHECKING:
    from cfddesk.registry.discovery import RegistryHub

# "boundary" (API 1.4): whole boundaries, each a BC's mesh patch or the walls no BC claims.
MonitorTarget = Literal["patch", "point", "volume", "line", "boundary"]


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
    # API 1.4, published in registry rows: what the monitor is, other names it
    # is known by, whether the user may add one by hand, and the keys of the
    # monitor quantities (MonitorQuantity.key) it measures.
    description: str = ""
    aliases: tuple[str, ...] = ()
    user_creatable: bool = False
    quantities: tuple[str, ...] = ()
    # API 1.4: the BC families (BcFamilySpec keys, e.g. "wall") a "boundary"
    # monitor may be placed on, () = any; "wall" also offers the walls no BC
    # claims. Families, not BC semantics: a symmetry plane meshes like a wall
    # but is not one. And a line its panel shows with an Edit link that opens the
    # study's settings ("" = none).
    boundary_kinds: tuple[str, ...] = ()
    study_note: str = ""


@dataclass(frozen=True)
class MonitorQuantity:
    """One quantity a run's monitors report, and how the page shows it (API 1.4).

    ``sample`` is the series point key it reads (``component`` picks one entry
    of a list sample, such as ``U``). ``unit`` is its unit label ("" = the SI
    label of ``unit_quantity``). ``magnitude`` shows the absolute value;
    ``direction_from`` names a sample whose sign picks a word from
    ``direction`` (below zero, else). ``plot``: offered as the plotted quantity
    of a monitor; ``details``: listed in a monitor's details; ``headline``:
    shown beside the plotted value when hovering the plot; ``csv``: its column
    in a monitor's CSV export ("" = not exported).
    """

    key: str
    label: str
    sample: str
    component: int | None = None
    unit_quantity: str = ""
    unit: str = ""
    color: str = "#3884e6"
    magnitude: bool = False
    direction_from: str = ""
    direction: tuple[str, str] = ("", "")
    plot: bool = True
    details: bool = True
    headline: bool = False
    csv: str = ""


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
