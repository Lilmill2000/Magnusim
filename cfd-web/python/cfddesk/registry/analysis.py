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
# Legacy free-string persisted before land11. Alias map lives here (registry-
# owned) so product paths resolve through builtins — not a third name list.
LEGACY_ANALYSIS_ALIAS = "incompressible"


def default_analysis_key(*, time_dependency: str | None = None) -> str:
    """Registered default AnalysisType key (steady unless transient asked)."""
    if (time_dependency or "").strip().lower() == "transient":
        return DEFAULT_TRANSIENT_KEY
    return DEFAULT_STEADY_KEY


def infer_time_dependency(
    *,
    time_dependency: str | None = None,
    solver_mode: str | None = None,
    simulation_control: dict[str, Any] | None = None,
    transient: bool | None = None,
) -> TimeDependency:
    """Infer steady/transient from product fields (solver / control / flags)."""
    td = (time_dependency or "").strip().lower()
    if td in ("steady", "transient"):
        return td  # type: ignore[return-value]
    if transient is True:
        return "transient"
    mode = (solver_mode or "").strip().lower()
    if mode == "transient":
        return "transient"
    if mode == "steady":
        return "steady"
    ctrl = simulation_control or {}
    raw_t = ctrl.get("transient")
    if raw_t is True or (isinstance(raw_t, dict) and bool(raw_t)):
        return "transient"
    ctrl_td = str(ctrl.get("time_dependency") or "").strip().lower()
    if ctrl_td.startswith("transient"):
        return "transient"
    return "steady"


def resolve_analysis_key(
    key: str | None,
    *,
    time_dependency: str | None = None,
    solver_mode: str | None = None,
    simulation_control: dict[str, Any] | None = None,
    transient: bool | None = None,
    registry: Any | None = None,
) -> str:
    """Map legacy/product analysis strings onto registered AnalysisType keys.

    `"incompressible"` aliases to `incompressible_steady` or
    `incompressible_transient` from solver/control time dependency.
    Registered keys pass through. When `registry` is given, unknown keys
    fail closed via `Registry.get` (`RegistryError`).
    """
    raw = (key or "").strip()
    td = infer_time_dependency(
        time_dependency=time_dependency,
        solver_mode=solver_mode,
        simulation_control=simulation_control,
        transient=transient,
    )
    if not raw or raw == LEGACY_ANALYSIS_ALIAS:
        resolved = default_analysis_key(time_dependency=td)
    else:
        resolved = raw
    if registry is not None:
        registry.get(resolved)  # fail closed on unknown
    return resolved


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

