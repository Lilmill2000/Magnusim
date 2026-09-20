"""ResultFilterType registry (Phase 2 land6).

Named ResultFilterType (registry type key/label/tool). Distinct from
results.filters.FilterSpec (union of persistence dataclasses) and
results.filters.FilterType (Literal of project filter type strings) —
same lesson as MonitorType vs FO MonitorSpec / MeshBackend vs settings
MeshAlgorithm: do not collapse or rename the product persistence types.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import TYPE_CHECKING, Literal

from cfddesk.registry.schema import SchemaField

if TYPE_CHECKING:
    from cfddesk.registry.discovery import RegistryHub

CacheScope = Literal["case_time", "case"]
FilterOutput = Literal["vtp", "json"]


@dataclass(frozen=True)
class ResultFilterType:
    """Registered result filter / exporter (cut_plane, streamlines, ...)."""

    key: str
    label: str
    params_schema: tuple[SchemaField, ...]
    tool: str  # tools/export_*.py basename
    cache_scope: CacheScope
    output: FilterOutput
    # Soft-pass: point at results.filters persistence dataclass when one exists.
    model: type | None = None


def analysis_has_filter_bags(hub: RegistryHub) -> bool:
    """True if any AnalysisType exposes result_filters / filters string bags.

    land6 soft-pass: AnalysisType currently has none — do not invent a bag.
    Kept as a probe so a later land can wire validation when bags appear.
    """
    for spec in hub.registry("analysis").items():
        if hasattr(spec, "result_filters") or hasattr(spec, "filters"):
            return True
        if hasattr(spec, "filter_types") or hasattr(spec, "result_filter_types"):
            return True
    return False
