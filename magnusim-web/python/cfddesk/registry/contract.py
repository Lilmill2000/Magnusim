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

CONTRACT_VERSION = "1.1"

KeepFrames = Literal["all", "latest"]
XAxis = Literal["iterations", "seconds"]

# An application name is put inside double quotes in solve.sh by raw text
# substitution, so it may only be a plain identifier.
APP_NAME_RE = re.compile(r"^[A-Za-z][A-Za-z0-9]*$")


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
    frame_fields: tuple[str, ...] = ("U", "p")

    def to_json(self) -> dict[str, Any]:
        return {
            "app": self.app,
            "keep_frames": self.keep_frames,
            "process_names": list(self.process_names),
            "stop_strategy": self.stop_strategy,
            "parallel": self.parallel,
            "log_parser": self.log_parser.to_json(),
            "frame_fields": list(self.frame_fields),
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
        "x_axis": str(_hook(spec, "x_axis") or ("seconds" if _td(spec.time_dependency) == "transient" else "iterations")),
        "result_fields": result_fields,
        "ui": dict(_hook(spec, "ui") or {}),
        "study_defaults": study_defaults(spec),
        "run_defaults": run_defaults(spec),
    }


def study_defaults(spec: Any, time_dependency: str | None = None) -> dict[str, Any]:
    """Settings a new study of this analysis starts with."""
    fn = _hook(spec, "study_defaults")
    td = _td(time_dependency or spec.time_dependency)
    if callable(fn):
        return dict(fn(td) or {})
    from cfddesk.registry.analysis import schema_defaults

    fam = _hook(spec, "family")
    turb = str(getattr(spec, "default_turbulence", "") or "")
    return {
        **schema_defaults(getattr(spec, "settings_schema", ()) or ()),
        "analysis_type": spec.key,
        "analysis": (fam.study_name or fam.label) if fam is not None else spec.label,
        "analysis_title": fam.title if fam is not None else spec.label,
        "category": str(getattr(spec, "category", "") or ""),
        "flow_group": "",
        "turbulence_model_key": turb,
        "turbulence_model": turb,
        "time_dependency": "Transient" if td == "transient" else "Steady-state",
        "algorithm": str(_hook(spec, "algorithm_label") or ""),
    }


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


def run_normalize(spec: Any, settings: dict[str, Any] | None) -> dict[str, Any]:
    model = run_model(spec)
    raw = dict(settings or {})
    if model is not None:
        return dict(model.normalize(raw) or {})
    return {**run_defaults(spec), **raw}


def run_preview(spec: Any, **kwargs: Any) -> dict[str, Any]:
    """The numbers a run would be written with now (``{"partial": True}`` if unknown)."""
    model = run_model(spec)
    if model is None or model.preview is None:
        return {"ok": True, "partial": True, "reason": None, "control": run_normalize(spec, kwargs.get("settings"))}
    return dict(model.preview(**kwargs) or {})


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


def frame_fields(spec: Any) -> tuple[str, ...]:
    """The fields that mark a written result frame: the analysis's frame_fields, else its fields."""
    return tuple(_hook(spec, "frame_fields") or getattr(spec, "fields", ()) or ("U", "p"))


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
