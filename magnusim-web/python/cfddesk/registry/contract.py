"""The analysis contract (API 1.1): how the core talks to a simulation type.

The core never reaches into an analysis's physics. For every step it calls
one of the functions below, which call the analysis's own hook when it has
one and otherwise fall back to a neutral default:

- :func:`describe_extra`: what the Create modal, the study panel and the run
  panel show about the analysis (family title and tags, algorithm label,
  residual series, x axis, result fields, UI panels).
- :func:`study_defaults` and :func:`sibling`: a new study's settings, and the
  analysis of the same family for the other time dependency.
- :func:`validate_ready`: what still blocks a run, as
  ``[{"message", "fix"}]`` (empty when the run can start).
- :func:`run_defaults`, :func:`run_normalize`, :func:`run_preview`: the run
  settings model (iterations, or simulated time and time step).
- :func:`launch_spec`: which program runs the case, how many frames are
  kept, which processes belong to it and how it is stopped.
- :func:`log_parser_ref`: the module that turns the solver's output into job
  events (the one parser; Node only aggregates events).

Hooks live on :class:`~cfddesk.registry.analysis.AnalysisType` as optional
fields, so a plugin that clones a builtin with ``dataclasses.replace`` keeps
the builtin's behaviour.
"""

from __future__ import annotations

import re
from collections.abc import Callable
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Literal

CONTRACT_VERSION = "1.4"

KeepFrames = Literal["all", "latest"]
XAxis = Literal["iterations", "seconds"]

# An application name is put inside double quotes in solve.sh by raw text
# substitution, so it may only be a plain identifier.
APP_NAME_RE = re.compile(r"^[A-Za-z][A-Za-z0-9]*$")

# A result field name: a letter, then up to 63 letters, digits, "_" or ".",
# with no "__" (the WSL case writer substitutes __NAME__ placeholders).
FIELD_NAME_RE = re.compile(r"^[A-Za-z][A-Za-z0-9_.]{0,63}$")


def field_name_ok(name: Any) -> bool:
    return isinstance(name, str) and bool(FIELD_NAME_RE.match(name)) and "__" not in name


LEGACY_FRAME_FIELDS: tuple[str, ...] = ("U", "p")
"""The frame fields of a case written before API 1.1 (by the default analysis).

Such a case names no ``frame_fields`` of its own, so a saved time counts as a
result frame when these fields are written in it. See
docs/plugins/compatibility.md, section 1.1.
"""


@dataclass(frozen=True)
class AnalysisFamily:
    """What the sibling analyses of one physics (steady and transient) share."""

    key: str
    label: str
    title: str
    description: str
    tags: tuple[str, ...] = ()
    study_name: str = ""


@dataclass(frozen=True)
class ReadyContext:
    """What :func:`validate_ready` may look at: one run of one study.

    ``study`` is the study record (id.json + catalog row). ``read_study`` reads
    one of the study's JSON documents (``materials``, ``bcs``, ...), or None.
    """

    project_dir: Path
    simulation_id: str
    run_id: str
    mesh_id: str
    mesh_case_dir: Path | None
    patches: tuple[str, ...]
    study: dict[str, Any]
    read_study: Callable[[str], Any]
    mesh: dict[str, Any] = field(default_factory=dict)
    materials: tuple[dict[str, Any], ...] = ()  # the study's material records
    bcs: tuple[dict[str, Any], ...] = ()  # the study's boundary-condition records


@dataclass(frozen=True)
class LogParserRef:
    """Where the solver-output parser lives: ``module:factory``.

    ``path`` is a folder added to ``sys.path`` before the import (a plugin's
    folder); empty for modules the core environment can import already.
    The factory returns an object with ``feed(line) -> list[Event]``.
    """

    module: str
    factory: str
    path: str = ""

    def to_json(self) -> dict[str, str]:
        return {"module": self.module, "factory": self.factory, "path": self.path}


@dataclass(frozen=True)
class LaunchSpec:
    """How the core runs a written case."""

    app: str
    keep_frames: KeepFrames
    process_names: tuple[str, ...]
    stop_strategy: str
    parallel: bool
    log_parser: LogParserRef
    # Fields whose file in a time folder means that result frame was written.
    frame_fields: tuple[str, ...] = LEGACY_FRAME_FIELDS
    # Fields the case stores divided by density (API 1.4; None = not declared).
    kinematic_fields: tuple[str, ...] | None = None

    def to_json(self) -> dict[str, Any]:
        return {
            "app": self.app,
            "keep_frames": self.keep_frames,
            "process_names": list(self.process_names),
            "stop_strategy": self.stop_strategy,
            "parallel": self.parallel,
            "log_parser": self.log_parser.to_json(),
            "frame_fields": list(self.frame_fields),
            "kinematic_fields": None if self.kinematic_fields is None else list(self.kinematic_fields),
        }


@dataclass(frozen=True)
class RunModel:
    """An analysis's run settings: defaults, clean-up and the preview numbers."""

    defaults: Callable[[], dict[str, Any]]
    normalize: Callable[[dict[str, Any]], dict[str, Any]]
    preview: Callable[..., dict[str, Any]] | None = None


class ContractError(ValueError):
    """An analysis broke the contract (bad app name, unknown solver, ...)."""


# The core's own parser: solve.sh events plus the solver's log lines as log
# events. Analyses without one of their own get this.
GENERIC_LOG_PARSER = LogParserRef("cfddesk.wsl.solve_run", "GenericParser")


def _hook(spec: Any, name: str) -> Any:
    return getattr(spec, name, None)


def _td(value: Any) -> Literal["steady", "transient"]:
    return "transient" if re.search(r"transient", str(value or ""), re.I) else "steady"


def describe_extra(spec: Any) -> dict[str, Any]:
    """The contract fields ``Registry.describe`` adds to an analysis row."""
    fam = _hook(spec, "family")
    result_fields = [
        {"key": f.key, "label": f.label, "unit_quantity": f.unit_quantity, "kind": f.kind}
        for f in (getattr(spec, "result_fields", ()) or ())
    ]
    return {
        "contract": CONTRACT_VERSION,
        "family": (
            {
                "key": fam.key,
                "label": fam.label,
                "title": fam.title,
                "description": fam.description,
                "tags": list(fam.tags),
                "study_name": fam.study_name or fam.label,
            }
            if fam is not None
            else None
        ),
        "algorithm_label": str(_hook(spec, "algorithm_label") or ""),
        "residual_keys": list(_hook(spec, "residual_keys") or ()),
        "residual_series": residual_series(spec),
        "x_axis": str(_hook(spec, "x_axis") or ("seconds" if _td(spec.time_dependency) == "transient" else "iterations")),
        "result_fields": result_fields,
        "kinematic_fields": _list_or_none(kinematic_fields(spec)),
        "ui": dict(_hook(spec, "ui") or {}),
        "study_defaults": study_defaults(spec),
        "run_defaults": run_defaults(spec),
    }


def _list_or_none(names: tuple[str, ...] | None) -> list[str] | None:
    return None if names is None else list(names)


_SERIES_KEYS = ("key", "label", "color", "fields", "always", "dashed", "max_key", "max_label", "swatch")


def residual_series(spec: Any) -> list[dict[str, Any]]:
    """The series the run panel plots, in order: the analysis's own, else one per residual key.

    ``fields`` are the solver-log fields a point takes the largest of (default
    the key itself). A ``dashed`` series is a per-step metric drawn on the same
    log axis, with its own line in the hover readout (``max_key`` adds its max).
    """
    raw = list(_hook(spec, "residual_series") or ())
    if not raw:
        raw = [{"key": k} for k in (_hook(spec, "residual_keys") or ())]
    out: list[dict[str, Any]] = []
    for row in raw:
        if not isinstance(row, dict) or not str(row.get("key") or "").strip():
            raise ContractError(f"{spec.key}.residual_series rows need a key: {row!r}")
        bad = set(row) - set(_SERIES_KEYS)
        if bad:
            raise ContractError(f"{spec.key}.residual_series: unknown field(s) {sorted(bad)}")
        key = str(row["key"])
        out.append(
            {
                "key": key,
                "label": str(row.get("label") or key),
                "color": str(row.get("color") or "#667085"),
                "fields": [str(f) for f in (row.get("fields") or [key])],
                "always": bool(row.get("always", False)),
                "dashed": bool(row.get("dashed", False)),
                "max_key": str(row.get("max_key") or ""),
                "max_label": str(row.get("max_label") or ""),
                "swatch": str(row.get("swatch") or ""),
            }
        )
    return out


def study_defaults(spec: Any, time_dependency: str | None = None) -> dict[str, Any]:
    """Settings a new study of this analysis starts with.

    The analysis's ``study_defaults`` hook, else the study's identity
    (analysis key and names, category, time dependency, algorithm). A key the
    record leaves out is filled from the API 1.0 ``default_turbulence``
    (:func:`_legacy_seed`), then from the ``settings_schema`` defaults: the
    hook wins over both, and ``default_turbulence`` over a schema default.
    """
    from cfddesk.registry.analysis import schema_defaults

    fn = _hook(spec, "study_defaults")
    td = _td(time_dependency or spec.time_dependency)
    if callable(fn):
        out = dict(fn(td) or {})
    else:
        fam = _hook(spec, "family")
        out = {
            "analysis_type": spec.key,
            "analysis": (fam.study_name or fam.label) if fam is not None else spec.label,
            "analysis_title": fam.title if fam is not None else spec.label,
            "category": str(getattr(spec, "category", "") or ""),
            "time_dependency": "Transient" if td == "transient" else "Steady-state",
            "algorithm": str(_hook(spec, "algorithm_label") or ""),
        }
    _legacy_seed(spec, out)
    for key, value in schema_defaults(getattr(spec, "settings_schema", ()) or ()).items():
        out.setdefault(key, value)
    return out


def _legacy_seed(spec: Any, out: dict[str, Any]) -> None:
    """The API 1.0 meaning of ``AnalysisType.default_turbulence``: a new study's
    ``turbulence_model`` and ``turbulence_model_key``, when the record has none.

    The only place the core still names turbulence; an analysis that leaves
    ``default_turbulence`` empty carries its choice in its own settings_schema.
    """
    turb = str(getattr(spec, "default_turbulence", "") or "")
    if turb:
        out.setdefault("turbulence_model", turb)
        out.setdefault("turbulence_model_key", turb)


def sibling(spec: Any, time_dependency: str, registry: Any | None = None) -> str | None:
    """The analysis of the same family for ``time_dependency`` (None if not registered)."""
    from cfddesk.registry.analysis import analysis_key_for, analysis_supports_time_dependency

    if not analysis_supports_time_dependency(spec.key, time_dependency, registry):
        return None
    return analysis_key_for(spec.key, time_dependency, registry)


def validate_ready(spec: Any, ctx: ReadyContext) -> list[dict[str, Any]]:
    """What blocks a run of this analysis, as ``[{"message", "fix", ...}]``."""
    fn = _hook(spec, "validate_ready")
    if not callable(fn):
        return []
    out: list[dict[str, Any]] = []
    for issue in fn(ctx) or []:
        if isinstance(issue, str):
            out.append({"message": issue, "fix": None})
        elif isinstance(issue, dict) and issue.get("message"):
            out.append({"fix": None, **issue})
        else:
            raise ContractError(f"{spec.key}.validate_ready returned {issue!r}")
    return out


def run_model(spec: Any) -> RunModel | None:
    model = _hook(spec, "run_model")
    return model if isinstance(model, RunModel) else None


def run_defaults(spec: Any) -> dict[str, Any]:
    """Run settings a new run starts with (from the analysis's control schema)."""
    model = run_model(spec)
    if model is not None:
        return dict(model.defaults() or {})
    from cfddesk.registry.analysis import schema_defaults

    return schema_defaults(getattr(spec, "control_schema", ()) or ())


def run_normalize(
    spec: Any, settings: dict[str, Any] | None, base: dict[str, Any] | None = None
) -> dict[str, Any]:
    """Run settings as the analysis stores them: ``settings`` (edits) over
    ``base`` (what is stored), cleaned up by its run model. A value the model
    rejects falls back to its default."""
    model = run_model(spec)
    raw = {**(base or {}), **(settings or {})}
    if model is not None:
        return dict(model.normalize(raw) or {})
    return {**run_defaults(spec), **raw}


def run_preview(spec: Any, **kwargs: Any) -> dict[str, Any]:
    """The numbers a run would be written with now (``{"partial": True}`` if unknown)."""
    model = run_model(spec)
    if model is None or model.preview is None:
        return {"ok": True, "partial": True, "reason": None, "control": run_normalize(spec, kwargs.get("settings"))}
    return dict(model.preview(**kwargs) or {})


NO_MONITORS: dict[str, Any] = {"rho": None, "monitors": [], "custom": [], "balance": None}


def run_monitors(spec: Any, case_dir: Path) -> dict[str, Any]:
    """A run's monitor results as its analysis reads them (none for an analysis without monitors)."""
    fn = _hook(spec, "run_monitors")
    if not callable(fn):
        return dict(NO_MONITORS)
    out = fn(case_dir)
    if not isinstance(out, dict):
        raise ContractError(f"{spec.key}.run_monitors must return a dict, got {type(out).__name__}")
    return {**NO_MONITORS, **out}


def launch_spec(spec: Any, solver_registry: Any, *, solver_key: str | None = None) -> LaunchSpec:
    """How to run a case of ``spec``: its launch hook, else its default solver's app."""
    fn = _hook(spec, "launch")
    key = solver_key or getattr(spec, "default_solver", "")
    if callable(fn):
        out = fn(solver_key=key)
        if not isinstance(out, LaunchSpec):
            raise ContractError(f"{spec.key}.launch must return a LaunchSpec, got {out!r}")
    else:
        if key not in set(solver_registry.keys()):
            raise ContractError(f"{spec.key}: solver {key!r} is not registered")
        app = solver_registry.get(key)
        td = _td(spec.time_dependency)
        out = LaunchSpec(
            app=str(app.application),
            keep_frames="all" if td == "transient" else "latest",
            process_names=(str(app.application),),
            stop_strategy=str(app.stop_strategy),
            parallel=str(app.parallel) == "mpirun",
            log_parser=log_parser_ref(spec),
            frame_fields=frame_fields(spec),
            kinematic_fields=kinematic_fields(spec),
        )
    check_launch_spec(out, solver_registry)
    return out


def check_launch_spec(out: LaunchSpec, solver_registry: Any) -> None:
    """The app must be a registered solver application with a plain name."""
    if not APP_NAME_RE.match(out.app or ""):
        raise ContractError(f"solver application {out.app!r} is not a plain program name")
    apps = {str(solver_registry.get(k).application) for k in solver_registry.keys()}
    if out.app not in apps:
        raise ContractError(f"solver application {out.app!r} is not a registered solver app ({sorted(apps)})")
    for name in out.process_names:
        if not APP_NAME_RE.match(name or ""):
            raise ContractError(f"process name {name!r} is not a plain program name")
    if out.keep_frames not in ("all", "latest"):
        raise ContractError(f"keep_frames must be 'all' or 'latest', got {out.keep_frames!r}")
    if not out.frame_fields or not all(re.fullmatch(r"[A-Za-z_][A-Za-z0-9_.]*", f) for f in out.frame_fields):
        raise ContractError(f"frame_fields must be plain field names, got {out.frame_fields!r}")
    if out.kinematic_fields is not None:
        _check_field_names("kinematic_fields", out.kinematic_fields)


def frame_fields(spec: Any) -> tuple[str, ...]:
    """The fields that mark a written result frame: the analysis's frame_fields, else its fields."""
    return tuple(_hook(spec, "frame_fields") or getattr(spec, "fields", ()) or LEGACY_FRAME_FIELDS)


def kinematic_fields(spec: Any) -> tuple[str, ...] | None:
    """The fields a case of this analysis stores divided by density (API 1.4).

    None when the analysis does not say (a case's sidecar then keeps what its
    writer put there, and a case with no list is read as ``("p",)``); ``()``
    when it stores none. Each name must be a plain field name.
    """
    raw = _hook(spec, "kinematic_fields")
    if raw is None:
        return None
    if isinstance(raw, str) or not isinstance(raw, (tuple, list)):
        raise ContractError(f"{getattr(spec, 'key', '?')}.kinematic_fields must be a tuple of field names, got {raw!r}")
    names = tuple(raw)
    _check_field_names(f"{getattr(spec, 'key', '?')}.kinematic_fields", names)
    return names


def _check_field_names(what: str, names: tuple[str, ...]) -> None:
    for name in names:
        if not field_name_ok(name):
            raise ContractError(
                f"{what}: {name!r} is not a field name (a letter, then up to 63 letters, digits, _ or ., no __)"
            )


def log_parser_ref(spec: Any) -> LogParserRef:
    ref = _hook(spec, "log_parser")
    return ref if isinstance(ref, LogParserRef) else GENERIC_LOG_PARSER


def load_log_parser(ref: dict[str, Any] | LogParserRef | None) -> Any:
    """Build the parser object a launch spec names (``feed(line) -> events``)."""
    import importlib
    import sys

    r = ref if isinstance(ref, LogParserRef) else LogParserRef(**(ref or GENERIC_LOG_PARSER.to_json()))
    if r.path and r.path not in sys.path:
        sys.path.insert(0, r.path)
    mod = importlib.import_module(r.module)
    return getattr(mod, r.factory)()
