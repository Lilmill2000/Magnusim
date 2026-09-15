"""AnalysisType registry spec (Phase 2 land2)."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Callable, Literal

from cfddesk.registry.requirements import Requirement
from cfddesk.registry.schema import SchemaField

TimeDependency = Literal["steady", "transient"]
ResultKind = Literal["scalar", "vector"]

DEFAULT_STEADY_KEY = "incompressible_steady"
DEFAULT_TRANSIENT_KEY = "incompressible_transient"
# Product still persists free-string "incompressible" (PRIMARY_SIM_ANALYSIS);
# registered keys above are additive this land — no model migration.


@dataclass(frozen=True)
class ResultField:
    """A field exposed in results / post for an analysis."""

    key: str
    label: str
    unit_quantity: str
    kind: ResultKind


@dataclass(frozen=True)
class AnalysisType:
    """Registered analysis / physics type (incompressible, CHT, ...)."""

    key: str
    label: str
    category: str
    time_dependency: TimeDependency
    fields: tuple[str, ...]
    turbulence_models: tuple[str, ...]
    default_turbulence: str
    bc_types: tuple[str, ...]
    material_models: tuple[str, ...]
    solver_backends: tuple[str, ...]
    default_solver: str
    monitors: tuple[str, ...]
    result_fields: tuple[ResultField, ...]
    settings_schema: tuple[SchemaField, ...]
    numerics_schema: tuple[SchemaField, ...]
    control_schema: tuple[SchemaField, ...]
    validate: Callable[..., list[str]]
    region_roles: tuple[str, ...] = ("fluid",)
    write_case: Callable[..., None] | None = None
    parse_log_line: Callable[[str], Any] | None = None
    requires: tuple[Requirement, ...] = ()


def schema_defaults(fields: tuple[SchemaField, ...] | list[SchemaField]) -> dict[str, Any]:
    """Build a defaults dict from SchemaField.default (skips None)."""
    out: dict[str, Any] = {}
    for f in fields:
        if f.default is not None:
            out[f.key] = f.default
        elif f.kind == "bool":
            out[f.key] = False
    return out


def run_analysis_validate(
    spec: AnalysisType,
    project: Any = None,
    simulation: Any = None,
    *,
    mesher: Any = None,
    **kwargs: Any,
) -> list[str]:
    """Invoke AnalysisType.validate with region_roles + optional mesher."""
    return list(
        spec.validate(
            project,
            simulation,
            region_roles=spec.region_roles,
            mesher=mesher,
            **kwargs,
        )
        or []
    )

