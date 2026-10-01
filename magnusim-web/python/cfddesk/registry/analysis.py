"""AnalysisType registry spec (Phase 2 land2)."""

from __future__ import annotations

import json
import re
from collections.abc import Callable
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Literal

from cfddesk.registry.requirements import Requirement
from cfddesk.registry.schema import SchemaField

TimeDependency = Literal["steady", "transient"]
ResultKind = Literal["scalar", "vector"]

# The default analysis is the required bundled plugin's [default_analysis]
# (manifest.toml); the core names no simulation type. DEFAULT_STEADY_KEY,
# DEFAULT_TRANSIENT_KEY and LEGACY_ANALYSIS_ALIAS stay importable (API 1.0):
# they are read from it when used (module __getattr__ below).


def _default_spec() -> dict[str, Any]:
    from cfddesk.registry.discovery import default_analysis

    return default_analysis(loaded=False) or {}


def default_analysis_key(*, time_dependency: str | None = None) -> str:
    """The analysis a study gets when none is named (steady unless transient
    asked): the required bundled plugin's ``[default_analysis]``, "" without it."""
    spec = _default_spec()
    if (time_dependency or "").strip().lower() == "transient":
        return str(spec.get("transient") or spec.get("steady") or "")
    return str(spec.get("steady") or "")


def is_default_alias(name: str | None) -> bool:
    """True for a name studies saved before analysis keys carry for the default analysis."""
    raw = (name or "").strip().lower()
    return bool(raw) and raw in {str(a).lower() for a in _default_spec().get("aliases") or ()}


def __getattr__(name: str) -> str:
    if name == "DEFAULT_STEADY_KEY":
        return default_analysis_key()
    if name == "DEFAULT_TRANSIENT_KEY":
        return default_analysis_key(time_dependency="transient")
    if name == "LEGACY_ANALYSIS_ALIAS":
        aliases = _default_spec().get("aliases") or []
        return str(aliases[0]) if aliases else ""
    raise AttributeError(f"module {__name__!r} has no attribute {name!r}")


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

    Blank, or a name the default analysis lists in its aliases (studies saved
    before analysis keys), maps to the default analysis at the time dependency
    the solver/control fields give. Registered keys pass through. When
    `registry` is given, unknown keys fail closed via `Registry.get`
    (`RegistryError`).
    """
    raw = (key or "").strip()
    td = infer_time_dependency(
        time_dependency=time_dependency,
        solver_mode=solver_mode,
        simulation_control=simulation_control,
        transient=transient,
    )
    if not raw or is_default_alias(raw):
        resolved = default_analysis_key(time_dependency=td)
    else:
        resolved = raw
    if registry is not None:
        registry.get(resolved)  # fail closed on unknown
    return resolved


def analysis_key_for(key: str | None, time_dependency: str | None, registry: Any | None = None) -> str:
    """The registered AnalysisType for a study's analysis family and time dependency.

    The stored key and the time dependency must agree: a study switched to
    Transient solves as its family's transient analysis. The sibling of a key
    is the same name with ``_steady`` / ``_transient`` swapped, when that key
    is registered; else the analysis of its ``family`` with the asked time
    dependency, when the family pairs one analysis of each (a plugin's clone
    keeps the family of the analysis it copied, so a family with two steady
    analyses names no sibling). A key with no sibling for the asked time
    dependency is returned unchanged; callers that must refuse that check
    :func:`analysis_supports_time_dependency`.
    """
    td = "transient" if re.search(r"transient", str(time_dependency or ""), re.I) else "steady"
    raw = (key or "").strip()
    if not raw or is_default_alias(raw):
        return default_analysis_key(time_dependency=td)
    reg = registry
    if reg is None:
        from cfddesk.registry.discovery import get_registry

        reg = get_registry("analysis")
    keys = set(reg.keys())
    if raw in keys and str(getattr(reg.get(raw), "time_dependency", "")) == td:
        return raw
    m = re.match(r"^(.*)_(steady|transient)$", raw)
    if m:
        sibling = f"{m.group(1)}_{td}"
        if sibling in keys:
            return sibling
    family = getattr(getattr(reg.get(raw), "family", None), "key", "") if raw in keys else ""
    if family:
        members = [k for k in reg.keys() if getattr(getattr(reg.get(k), "family", None), "key", "") == family]
        here = str(reg.get(raw).time_dependency)
        same = [k for k in members if str(reg.get(k).time_dependency) == here]
        other = [k for k in members if str(reg.get(k).time_dependency) == td]
        if len(same) == 1 and len(other) == 1:
            return str(other[0])
    return raw


def analysis_supports_time_dependency(key: str, time_dependency: str | None, registry: Any | None = None) -> bool:
    """True when ``key`` (or its sibling) is registered for that time dependency."""
    reg = registry
    if reg is None:
        from cfddesk.registry.discovery import get_registry

        reg = get_registry("analysis")
    td = "transient" if re.search(r"transient", str(time_dependency or ""), re.I) else "steady"
    resolved = analysis_key_for(key, td, reg)
    return resolved in set(reg.keys()) and str(getattr(reg.get(resolved), "time_dependency", "")) == td


@dataclass(frozen=True)
class ResultField:
    """A field exposed in results / post for an analysis."""

    key: str
    label: str
    unit_quantity: str
    kind: ResultKind



@dataclass(frozen=True)
class CaseContext:
    """Inputs for AnalysisType.write_case (Phase 1 prepare_run / web_case).

    Bundles what tools/prepare_run.py computed. Built-in write_case delegates
    to the analysis writer (incompressible_flow.writer.write_solve_case) via run_spec + out_dir
    (other fields reserved for later lands).
    """

    out_dir: Path | None
    run_spec: Any = None
    project: Any = None
    simulation: Any = None
    geometry: Any = None
    mesh_case_dir: Path | None = None
    n_procs: int = 1
    # What the core gathered for the run (cfddesk.project.run_inputs.RunInputs)
    # and the geometry services it offers (cfddesk.project.case_services).
    inputs: Any = None
    services: Any = None


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
    write_case: Callable[[CaseContext], Any] | None = None
    parse_log_line: Callable[[str], Any] | None = None
    requires: tuple[Requirement, ...] = ()
    # Contract 1.1 (cfddesk.registry.contract). All optional: the core falls
    # back to a neutral default for any hook an analysis leaves out.
    family: Any = None  # AnalysisFamily shared with the sibling analysis
    algorithm_label: str = ""  # "SIMPLE" / "PIMPLE"
    residual_keys: tuple[str, ...] = ()  # residual series the run panel plots
    # How the run panel draws them: {key, label, color, fields?, always?, dashed?,
    # max_key?, max_label?, swatch?} per series (contract.residual_series).
    residual_series: tuple[dict[str, Any], ...] = ()
    x_axis: str = ""  # "iterations" | "seconds" ("" = from time_dependency)
    study_defaults: Callable[[str], dict[str, Any]] | None = None
    validate_ready: Callable[[Any], list[Any]] | None = None  # (ReadyContext) -> issues
    run_model: Any = None  # RunModel: defaults / normalize / preview
    launch: Callable[..., Any] | None = None  # (solver_key=...) -> LaunchSpec
    log_parser: Any = None  # LogParserRef to the solver-output parser
    frame_fields: tuple[str, ...] = ()  # fields that mark a written frame ("" = fields)
    plan_case: Callable[[Any], dict[str, Any]] | None = None  # write_case's report, without writing
    run_monitors: Callable[[Any], dict[str, Any]] | None = None  # (case_dir) -> {rho, monitors, custom, balance}
    ui: dict[str, str] = field(default_factory=dict)  # panel ids the plugin provides


def schema_defaults(fields: tuple[SchemaField, ...] | list[SchemaField]) -> dict[str, Any]:
    """Build a defaults dict from SchemaField.default (skips None)."""
    out: dict[str, Any] = {}
    for f in fields:
        if f.default is not None:
            out[f.key] = f.default
        elif f.kind == "bool":
            out[f.key] = False
    return out


def _case_context(inputs: Any, out_dir: Path | str | None) -> tuple[str, CaseContext]:
    """(analysis key, context) for a run: RunInputs from the core, or a spec built by hand (tests)."""
    key = str(getattr(inputs, "analysis_key", "") or "").strip()
    if hasattr(inputs, "require_mesh") and hasattr(inputs, "materials"):
        from cfddesk.project.case_services import CaseServices

        mesh = getattr(inputs, "mesh", None) or {}
        case_dir = mesh.get("case_dir")
        return key, CaseContext(
            out_dir=Path(out_dir) if out_dir is not None else None,
            inputs=inputs,
            simulation=dict(getattr(inputs, "study", None) or {}),
            mesh_case_dir=Path(case_dir) if case_dir else None,
            n_procs=int(getattr(inputs, "n_procs", 1) or 1),
            services=CaseServices(inputs.project_dir, inputs.simulation_id, getattr(inputs, "mesh_id", None)),
        )
    spec = inputs
    study: dict[str, Any] = {}
    if getattr(spec, "project_dir", None) and getattr(spec, "simulation_id", ""):
        from cfddesk.project.readiness import study_doc

        study = study_doc(spec.project_dir, spec.simulation_id)
    return key, CaseContext(
        out_dir=Path(out_dir) if out_dir is not None else None,
        run_spec=spec,
        simulation=study,
        mesh_case_dir=Path(spec.mesh_case_dir) if getattr(spec, "mesh_case_dir", None) else None,
        n_procs=int(getattr(spec, "n_procs", 1) or 1),
    )


def write_run_case(
    inputs: Any,
    out_dir: Path | str,
    *,
    analysis_key: str | None = None,
) -> dict[str, Any]:
    """Write a run's case: the run's AnalysisType.write_case, inside the case.write hooks.

    ``inputs`` is the core's RunInputs (prepare_run), or a spec an analysis
    built itself (its own tests).
    """
    from cfddesk.registry.discovery import get_registry, load_all

    load_all()
    key0, ctx = _case_context(inputs, out_dir)
    key = (analysis_key or "").strip() or key0 or default_analysis_key()
    analysis = get_registry("analysis").get(key)
    writer = analysis.write_case
    if writer is None:
        raise ValueError(f"{key}.write_case is None")
    from cfddesk.registry.hooks import get_hooks

    written_ctx = ctx

    def _write(**kw: Any) -> Any:
        nonlocal written_ctx
        written_ctx = kw.get("ctx", ctx)
        return writer(written_ctx)

    raw = get_hooks().apply("case.write", _write, ctx=ctx)
    written_out = Path(getattr(written_ctx, "out_dir", None) or out_dir)
    _stamp_case(written_out, key, analysis)
    normalized = _normalize_case_result(raw, written_out, inputs)
    get_hooks().call("case.written", ctx=written_ctx, result=normalized)
    return normalized


def plan_run_case(inputs: Any, *, analysis_key: str | None = None) -> dict[str, Any]:
    """What write_run_case would report, without writing (the analysis's plan_case)."""
    from cfddesk.registry.discovery import get_registry, load_all

    load_all()
    key0, ctx = _case_context(inputs, None)
    key = (analysis_key or "").strip() or key0 or default_analysis_key()
    analysis = get_registry("analysis").get(key)
    plan = getattr(analysis, "plan_case", None)
    if not callable(plan):
        return {"ok": True}
    return dict(plan(ctx) or {})


def _stamp_case(out: Path, key: str, spec: Any) -> None:
    """Record in the case's sidecar (``w27-case.json``) what readers of the case
    need from its analysis: its key, and the fields whose files mark a written
    result frame (results list only complete times). The analysis's own keys
    stay as it wrote them."""
    from cfddesk.registry import contract

    if not out.is_dir():
        return
    sidecar = out / "w27-case.json"
    doc: dict[str, Any] = {}
    if sidecar.is_file():
        try:
            loaded = json.loads(sidecar.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            loaded = {}
        if isinstance(loaded, dict):
            doc = loaded
    doc.setdefault("analysis_key", key)
    doc["frame_fields"] = list(contract.frame_fields(spec))
    sidecar.write_text(json.dumps(doc, indent=2) + "\n", encoding="utf-8")


def _normalize_case_result(result: Any, out: Path, spec: Any) -> dict[str, Any]:
    if isinstance(result, dict):
        return result
    sidecar = out / "w27-case.json"
    if sidecar.is_file():
        try:
            data = json.loads(sidecar.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            data = {}
        if isinstance(data, dict):
            return {
                "ok": True,
                "case_dir": str(out),
                "solver": data.get("solver"),
                "n_procs": data.get("nProcs", getattr(spec, "n_procs", 1)),
                "patches": data.get("patches") or [],
                "turbulence": data.get("turbulence"),
                "polyMesh_copied": (out / "constant" / "polyMesh" / "owner").is_file(),
            }
    return {"ok": True, "case_dir": str(out)}


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

