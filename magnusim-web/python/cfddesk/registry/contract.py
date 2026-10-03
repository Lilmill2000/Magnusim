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
- :func:`live_metrics`: the per-step numbers the Run panel's progress line
  shows (API 1.5).

Hooks live on :class:`~cfddesk.registry.analysis.AnalysisType` as optional
fields, so a plugin that clones a builtin with ``dataclasses.replace`` keeps
the builtin's behaviour.
"""

from __future__ import annotations

import copy
import dataclasses
import re
from collections.abc import Callable
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Literal, TypeGuard

from cfddesk.registry.monitor import MonitorQuantity

CONTRACT_VERSION = "1.5"

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

BUILTIN_PREPARE_JOB = "solve.prepare"
"""The JobKind that writes a run's case for an analysis that names no
``LaunchSpec.prepare_job`` of its own (tools/prepare_run.py, which calls the
analysis's ``write_case``). See docs/plugins/compatibility.md, section 1.5."""

LEGACY_SERIAL_BELOW_CELLS: dict[str, int] = {"steady": 200_000, "transient": 50_000}
"""The cell count under which a run is serial, for a launch spec that says
nothing (``serial_below_cells`` None): the core's rule before API 1.5."""

# A JobKind key, as the relay accepts it in a prepare step.
JOB_KEY_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:-]{0,120}$")


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
    # API 1.5: a mesh with fewer cells than this runs serial, else on every rank
    # the PC offers. None = the core's rule before 1.5 (LEGACY_SERIAL_BELOW_CELLS).
    serial_below_cells: int | None = None
    # API 1.5: the JobKind of the analysis's plugin that writes the run's case
    # into MAGNUSIM_CASE_DIR. "" = the builtin BUILTIN_PREPARE_JOB, which calls
    # the analysis's write_case.
    prepare_job: str = ""

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
            "serial_below_cells": self.serial_below_cells,
            "prepare_job": self.prepare_job,
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
        "result_fields": result_fields(spec),
        "kinematic_fields": _list_or_none(kinematic_fields(spec)),
        "monitor_quantities": declared_monitor_quantities(spec),
        # API 1.5: the Run panel's per-step numbers (None = not declared).
        "live_metrics": live_metrics(spec),
        "ui": dict(_hook(spec, "ui") or {}),
        "study_defaults": study_defaults(spec),
        "run_defaults": run_defaults(spec),
        # API 1.4: the BC types and material models the analysis offers.
        "bc_types": [str(k) for k in getattr(spec, "bc_types", ()) or ()],
        "material_models": [str(k) for k in getattr(spec, "material_models", ()) or ()],
    }


def _list_or_none(names: tuple[str, ...] | None) -> list[str] | None:
    return None if names is None else list(names)


RESULT_KINDS: tuple[str, ...] = ("scalar", "vector", "symm_tensor", "tensor")
UNIT_TEXT_MAX = 32
_CONTROL_RE = re.compile(r"[\x00-\x1f\x7f-\x9f]")


def plain_text(value: Any, limit: int) -> bool:
    """True for a one-line string of at most ``limit`` characters with no control characters."""
    return isinstance(value, str) and len(value) <= limit and not _CONTROL_RE.search(value)


def _row_value(row: Any, name: str) -> Any:
    return row.get(name) if isinstance(row, dict) else getattr(row, name, None)


def result_fields(spec: Any) -> list[dict[str, Any]]:
    """What results colour by, in the analysis's order (API 1.4 adds ``unit``,
    ``magnitude_label`` and ``shown``).

    ``shown`` is the name a view colours by: the key of a scalar, ``mag<key>``
    for a vector, None for a tensor (never offered). A key must be a field name,
    the kind one of :data:`RESULT_KINDS`, and the unit plain text of at most
    32 characters; anything else is a ContractError.
    """
    what = f"{getattr(spec, 'key', '?')}.result_fields"
    out: list[dict[str, Any]] = []
    seen: set[str] = set()
    for row in getattr(spec, "result_fields", ()) or ():
        key = _row_value(row, "key")
        if not field_name_ok(key):
            raise ContractError(
                f"{what}: {key!r} is not a field name (a letter, then up to 63 letters, digits, _ or ., no __)"
            )
        if key in seen:
            raise ContractError(f"{what}: {key!r} is listed twice")
        seen.add(key)
        kind = _row_value(row, "kind")
        if kind not in RESULT_KINDS:
            raise ContractError(f"{what}: {key} has kind {kind!r}; use one of {list(RESULT_KINDS)}")
        unit = _row_value(row, "unit") or ""
        if not plain_text(unit, UNIT_TEXT_MAX):
            raise ContractError(f"{what}: {key} unit {unit!r} must be plain text of at most {UNIT_TEXT_MAX} characters")
        magnitude_label = _row_value(row, "magnitude_label") or ""
        if not plain_text(magnitude_label, 120):
            raise ContractError(f"{what}: {key} magnitude_label {magnitude_label!r} must be one line of plain text")
        shown: str | None = key if kind == "scalar" else ("mag" + key if kind == "vector" else None)
        out.append(
            {
                "key": key,
                "label": str(_row_value(row, "label") or key),
                "unit_quantity": str(_row_value(row, "unit_quantity") or ""),
                "kind": kind,
                "unit": unit,
                "magnitude_label": magnitude_label,
                "shown": shown,
            }
        )
    return out


LIVE_METRIC_FORMATS: tuple[str, ...] = ("time", "sig2")
_METRIC_FIELDS = ("key", "label", "format", "max_key")
_METRIC_KEY_RE = re.compile(r"^[A-Za-z][A-Za-z0-9_]{0,63}$")
LIVE_METRIC_LABEL_MAX = 32


def live_metrics(spec: Any) -> list[dict[str, Any]] | None:
    """The per-step numbers the Run panel's progress line shows after the time
    (API 1.5), checked: ``{key, label, format, max_key}`` per number, in order.

    ``key`` names a run field the solve's progress fills (``delta_t``,
    ``co_mean``, ``co_max``, ...); ``format`` is ``"time"`` (a duration) or
    ``"sig2"`` (two significant digits); ``max_key`` ("" for none) names a
    second field shown as its maximum (``Co 0.42 (max 0.9)``). None when the
    analysis does not say (the panel keeps its text before 1.5: Δt and Co for a
    transient run); ``()`` when it shows none. Anything else is a ContractError.
    """
    raw = _hook(spec, "live_metrics")
    if raw is None:
        return None
    what = f"{getattr(spec, 'key', '?')}.live_metrics"
    if isinstance(raw, (str, dict)) or not isinstance(raw, (tuple, list)):
        raise ContractError(f"{what} must be a tuple of dicts, got {raw!r}")
    out: list[dict[str, Any]] = []
    seen: set[str] = set()
    for row in raw:
        if not isinstance(row, dict):
            raise ContractError(f"{what}: rows must be dicts, got {row!r}")
        bad = set(row) - set(_METRIC_FIELDS)
        if bad:
            raise ContractError(f"{what}: unknown field(s) {sorted(bad)}")
        key = row.get("key")
        if not isinstance(key, str) or not _METRIC_KEY_RE.match(key):
            raise ContractError(f"{what}: key {key!r} must be a letter, then up to 63 letters, digits or _")
        if key in seen:
            raise ContractError(f"{what}: {key!r} is listed twice")
        seen.add(key)
        label = row.get("label", key)
        if not label or not plain_text(label, LIVE_METRIC_LABEL_MAX):
            raise ContractError(f"{what}: {key} label {label!r} must be plain text of 1 to {LIVE_METRIC_LABEL_MAX} characters")
        fmt = row.get("format")
        if fmt not in LIVE_METRIC_FORMATS:
            raise ContractError(f"{what}: {key} format {fmt!r}; use one of {list(LIVE_METRIC_FORMATS)}")
        max_key = row.get("max_key") or ""
        if max_key and not (isinstance(max_key, str) and _METRIC_KEY_RE.match(max_key)):
            raise ContractError(f"{what}: {key} max_key {max_key!r} must be a letter, then up to 63 letters, digits or _")
        out.append({"key": key, "label": label, "format": fmt, "max_key": max_key})
    return out


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


NO_MONITORS: dict[str, Any] = {
    "rho": None,
    "monitors": [],
    "custom": [],
    "balance": None,
    "quantities": [],
    "summary": [],
    "summary_warn": False,
}

LEGACY_MONITOR_QUANTITIES: tuple[MonitorQuantity, ...] = (
    MonitorQuantity(
        "p", "Pressure", "p_Pa", unit_quantity="pressure", unit="Pa", color="#6941c6",
        headline=True, csv="pressure_Pa",
    ),
    MonitorQuantity(
        "Umag", "Mean velocity", "Umag", unit_quantity="velocity", unit="m/s",
        headline=True, csv="mean_velocity_m_s",
    ),
    MonitorQuantity("Ux", "Velocity X", "U", component=0, unit_quantity="velocity", unit="m/s", csv="Ux_m_s"),
    MonitorQuantity("Uy", "Velocity Y", "U", component=1, unit_quantity="velocity", unit="m/s", csv="Uy_m_s"),
    MonitorQuantity("Uz", "Velocity Z", "U", component=2, unit_quantity="velocity", unit="m/s", csv="Uz_m_s"),
    MonitorQuantity(
        "Un", "Normal velocity", "Un_m_s", unit_quantity="velocity", unit="m/s", magnitude=True,
        direction_from="Q_m3s", direction=("in", "out"), plot=False, csv="Un_m_s",
    ),
    MonitorQuantity(
        "Q", "Flow rate", "Q_m3s", unit_quantity="volumetric_flow", unit="m³/s", magnitude=True,
        direction_from="Q_m3s", direction=("in", "out"), plot=False, headline=True, csv="flow_m3_s",
    ),
    MonitorQuantity(
        "mdot", "Mass flow", "mdot_kgs", unit_quantity="mass_flow", unit="kg/s", magnitude=True,
        plot=False, csv="mass_kg_s",
    ),
)
"""The monitor quantities of an analysis that declares none but has a
``run_monitors`` hook (API 1.1 rows: ``p_Pa``, ``Umag``, ``U``, ``Un_m_s``,
``Q_m3s`` per series point). The table the page used to carry. See
docs/plugins/compatibility.md, section 1.4.
"""

_QUANTITY_FIELDS = tuple(f.name for f in dataclasses.fields(MonitorQuantity))
_QUANTITY_KEY_RE = re.compile(r"^[A-Za-z][A-Za-z0-9_]{0,31}$")
_SAMPLE_RE = re.compile(r"^[A-Za-z][A-Za-z0-9_]{0,63}$")
_COLOR_RE = re.compile(r"^#(?:[0-9A-Fa-f]{3}|[0-9A-Fa-f]{6})$")
_CSV_RE = re.compile(r"^[A-Za-z0-9_]{0,64}$")


def _real(value: Any) -> TypeGuard[float]:
    return isinstance(value, (int, float)) and not isinstance(value, bool)


def _quantity_row(what: str, row: Any) -> dict[str, Any]:
    if isinstance(row, dict):
        bad = set(row) - set(_QUANTITY_FIELDS)
        if bad:
            raise ContractError(f"{what}: unknown field(s) {sorted(bad)}")
        try:
            row = MonitorQuantity(**row)
        except TypeError as exc:
            raise ContractError(f"{what}: {exc}") from exc
    if not isinstance(row, MonitorQuantity):
        raise ContractError(f"{what}: rows must be MonitorQuantity or dicts, got {row!r}")
    q = row
    problems = []
    if not isinstance(q.key, str) or not _QUANTITY_KEY_RE.match(q.key):
        problems.append(f"key {q.key!r} must be a letter, then up to 31 letters, digits or _")
    if not q.label or not plain_text(q.label, 64):
        problems.append(f"label {q.label!r} must be plain text of 1 to 64 characters")
    if not isinstance(q.sample, str) or not _SAMPLE_RE.match(q.sample):
        problems.append(f"sample {q.sample!r} must be a series point key")
    if q.component is not None and not (isinstance(q.component, int) and not isinstance(q.component, bool) and 0 <= q.component <= 8):
        problems.append(f"component {q.component!r} must be None or 0 to 8")
    if q.unit_quantity and not (isinstance(q.unit_quantity, str) and _SAMPLE_RE.match(q.unit_quantity)):
        problems.append(f"unit_quantity {q.unit_quantity!r} must be a quantity name")
    if not plain_text(q.unit, UNIT_TEXT_MAX):
        problems.append(f"unit {q.unit!r} must be plain text of at most {UNIT_TEXT_MAX} characters")
    if not isinstance(q.color, str) or not _COLOR_RE.match(q.color):
        problems.append(f"color {q.color!r} must be #rgb or #rrggbb")
    if q.direction_from and not (isinstance(q.direction_from, str) and _SAMPLE_RE.match(q.direction_from)):
        problems.append(f"direction_from {q.direction_from!r} must be a series point key")
    direction = q.direction
    if (
        not isinstance(direction, (tuple, list))
        or len(direction) != 2
        or not all(plain_text(d, UNIT_TEXT_MAX) for d in direction)
    ):
        problems.append(f"direction {direction!r} must be two words (below zero, else)")
    for flag in ("magnitude", "plot", "details", "headline"):
        if not isinstance(getattr(q, flag), bool):
            problems.append(f"{flag} must be true or false")
    if not isinstance(q.csv, str) or not _CSV_RE.match(q.csv):
        problems.append(f"csv {q.csv!r} must be a column name of letters, digits or _")
    if problems:
        raise ContractError(f"{what} {getattr(q, 'key', '?')!r}: " + "; ".join(problems))
    out = dataclasses.asdict(q)
    out["direction"] = list(direction)
    return out


def declared_monitor_quantities(spec: Any) -> list[dict[str, Any]] | None:
    """The monitor quantities the analysis declares, checked (None when it does not say)."""
    raw = _hook(spec, "monitor_quantities")
    if raw is None:
        return None
    what = f"{getattr(spec, 'key', '?')}.monitor_quantities"
    if isinstance(raw, (str, dict)) or not isinstance(raw, (tuple, list)):
        raise ContractError(f"{what} must be a tuple of MonitorQuantity, got {raw!r}")
    rows = [_quantity_row(what, q) for q in raw]
    keys = [r["key"] for r in rows]
    twice = sorted({k for k in keys if keys.count(k) > 1})
    if twice:
        raise ContractError(f"{what}: {twice} listed twice")
    return rows


def monitor_quantities(spec: Any) -> list[dict[str, Any]]:
    """The quantities a run's monitors carry: the analysis's own list; for one
    that declares none but has a ``run_monitors`` hook, :data:`LEGACY_MONITOR_QUANTITIES`;
    else none."""
    declared = declared_monitor_quantities(spec)
    if declared is not None:
        return declared
    if callable(_hook(spec, "run_monitors")):
        return [_quantity_row("LEGACY_MONITOR_QUANTITIES", q) for q in LEGACY_MONITOR_QUANTITIES]
    return []


def _check_monitor_answer(what: str, out: dict[str, Any]) -> None:
    rho = out.get("rho")
    if rho is not None and not _real(rho):
        raise ContractError(f"{what}: rho must be a number or None, got {rho!r}")
    for group in ("monitors", "custom"):
        rows = out.get(group, [])
        if not isinstance(rows, list):
            raise ContractError(f"{what}: {group} must be a list, got {type(rows).__name__}")
        for row in rows:
            if not isinstance(row, dict):
                raise ContractError(f"{what}: each of {group} must be a dict, got {row!r}")
            series = row.get("series")
            if series is None:
                continue
            if not isinstance(series, list):
                raise ContractError(f"{what}: a monitor's series must be a list, got {type(series).__name__}")
            for point in series:
                if not isinstance(point, dict) or not _real(point.get("t")):
                    raise ContractError(f"{what}: each series point needs a number t, got {point!r}")
    balance = out.get("balance")
    if balance is not None and not isinstance(balance, dict):
        raise ContractError(f"{what}: balance must be a dict or None, got {balance!r}")
    summary = out.get("summary", [])
    if not isinstance(summary, list) or not all(
        isinstance(s, dict) and isinstance(s.get("label"), str) for s in summary
    ):
        raise ContractError(f"{what}: summary must be a list of {{label, value}}, got {summary!r}")
    if not isinstance(out.get("summary_warn", False), bool):
        raise ContractError(f"{what}: summary_warn must be true or false")


def _legacy_rows(rows: list[dict[str, Any]], rho: float | None, *, custom: bool) -> list[dict[str, Any]]:
    """API 1.1 monitor rows as the page reads them: a mass flow per point
    (``mdot_kgs`` = ``Q_m3s`` x rho), a ``key`` (``mon_<patch>``; a custom
    monitor keeps its own) and the ``default_quantity`` its plot opens on."""

    def with_mdot(point: Any) -> Any:
        if not isinstance(point, dict) or "mdot_kgs" in point:
            return point
        q = point.get("Q_m3s")
        return {**point, "mdot_kgs": q * rho if _real(q) and rho is not None else None}

    out = []
    for row in rows:
        row = dict(row)
        series = row.get("series")
        if isinstance(series, list):
            new_series = [with_mdot(p) for p in series]
            if isinstance(row.get("last"), dict):
                same = bool(series) and row["last"] is series[-1]
                row["last"] = new_series[-1] if same else with_mdot(row["last"])
            row["series"] = new_series
        elif isinstance(row.get("last"), dict):
            row["last"] = with_mdot(row["last"])
        if not row.get("key") and not custom and row.get("patch"):
            row["key"] = f"mon_{row['patch']}"
        if not row.get("default_quantity"):
            pressure = custom or bool(re.search(r"pressure", str(row.get("bc_type") or ""), re.I))
            row["default_quantity"] = "p" if pressure else "Umag"
        out.append(row)
    return out


def _legacy_summary(balance: Any) -> tuple[list[dict[str, Any]], bool]:
    """The flow balance line (``Flow in … · out … · imbalance … %``), and whether
    it warns (imbalance over 1 %). Empty when nothing flows through the monitors."""
    if not isinstance(balance, dict):
        return [], False
    q_in, q_out = balance.get("in_m3s"), balance.get("out_m3s")
    if not ((_real(q_in) and q_in > 0) or (_real(q_out) and q_out > 0)):
        return [], False
    summary: list[dict[str, Any]] = [
        {"label": "Flow in", "value": q_in, "quantity": "Q", "unit": ""},
        {"label": "out", "value": q_out, "quantity": "Q", "unit": ""},
    ]
    imbalance = balance.get("imbalance")
    if not _real(imbalance):
        return summary, False
    pct = abs(float(imbalance)) * 100
    summary.append({"label": "imbalance", "value": pct, "quantity": "", "unit": "%"})
    return summary, pct > 1


def run_monitors(spec: Any, case_dir: Path) -> dict[str, Any]:
    """A run's monitor results as its analysis reads them (none for an analysis without monitors).

    The answer is checked and gets ``quantities`` (:func:`monitor_quantities`).
    For an analysis that declares no monitor quantities (API 1.1 rows), the
    core also adds what the page used to work out: ``mdot_kgs`` per point,
    each row's ``key`` and ``default_quantity``, and the flow balance as
    ``summary`` and ``summary_warn`` when the answer has none.
    """
    fn = _hook(spec, "run_monitors")
    if not callable(fn):
        return copy.deepcopy(NO_MONITORS)
    out = fn(case_dir)
    what = f"{getattr(spec, 'key', '?')}.run_monitors"
    if not isinstance(out, dict):
        raise ContractError(f"{what} must return a dict, got {type(out).__name__}")
    _check_monitor_answer(what, out)
    answer = {**copy.deepcopy(NO_MONITORS), **out}
    answer["quantities"] = monitor_quantities(spec)
    if _hook(spec, "monitor_quantities") is None:
        rho = answer.get("rho")
        rho = float(rho) if _real(rho) and rho > 0 else None
        answer["monitors"] = _legacy_rows(answer["monitors"], rho, custom=False)
        answer["custom"] = _legacy_rows(answer["custom"], rho, custom=True)
        if "summary" not in out:
            answer["summary"], warn = _legacy_summary(answer.get("balance"))
            if "summary_warn" not in out:
                answer["summary_warn"] = warn
    return answer


def launch_spec(spec: Any, solver_registry: Any, *, solver_key: str | None = None) -> LaunchSpec:
    """How to run a case of ``spec``: its launch hook, else its default solver's app.

    A ``prepare_job`` must be a registered JobKind. One of a plugin other than
    the analysis's (what an analysis cloned from another plugin's with
    ``dataclasses.replace`` inherits) is not used: the answer names none, so the
    run is prepared by :data:`BUILTIN_PREPARE_JOB` with the clone's own
    ``write_case``, as before API 1.5.
    """
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
    jobs, owner = _jobs_and_owner(spec)
    if isinstance(out.prepare_job, str) and out.prepare_job and jobs is not None and owner is not None:
        if out.prepare_job in set(jobs.keys()) and jobs.owner(out.prepare_job) != owner:
            out = dataclasses.replace(out, prepare_job="")
    check_launch_spec(out, solver_registry, jobs=jobs, owner=owner)
    return out


def _jobs_and_owner(spec: Any) -> tuple[Any, str | None]:
    """The loaded JobKind registry and the plugin that registered ``spec`` (None
    when ``spec`` is not the registered analysis of its key)."""
    from cfddesk.registry.discovery import get_hub

    hub = get_hub()
    analyses = hub.registry("analysis")
    key = str(getattr(spec, "key", "") or "")
    owner = analyses.owner(key) if key in set(analyses.keys()) else None
    return hub.registry("job"), owner


def check_launch_spec(
    out: LaunchSpec, solver_registry: Any, *, jobs: Any = None, owner: str | None = None
) -> None:
    """The app must be a registered solver application with a plain name.

    ``serial_below_cells`` is None or a whole number of cells, at least 0.
    ``prepare_job`` is "" or a JobKind key; given the JobKind registry
    (``jobs``) it must be registered, and given the analysis's plugin
    (``owner``) it must be one of that plugin's.
    """
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
    cells = out.serial_below_cells
    if cells is not None and (not isinstance(cells, int) or isinstance(cells, bool) or cells < 0):
        raise ContractError(f"serial_below_cells must be None or a whole number of cells (0 or more), got {cells!r}")
    job = out.prepare_job
    if not isinstance(job, str) or (job and not JOB_KEY_RE.match(job)):
        raise ContractError(f"prepare_job must be '' or a JobKind key, got {job!r}")
    if job and jobs is not None:
        if job not in set(jobs.keys()):
            raise ContractError(f"prepare_job {job!r} is not a registered JobKind")
        if owner is not None and jobs.owner(job) != owner:
            raise ContractError(f"prepare_job {job!r} belongs to {jobs.owner(job)!r}, not to the analysis's plugin {owner!r}")


def effective_prepare_job(launch: LaunchSpec) -> str:
    """The JobKind that writes a run's case: the launch spec's own, else :data:`BUILTIN_PREPARE_JOB`."""
    return launch.prepare_job or BUILTIN_PREPARE_JOB


def serial_below_cells(launch: LaunchSpec, time_dependency: str) -> int:
    """The cell count under which a run is serial: the launch spec's, else :data:`LEGACY_SERIAL_BELOW_CELLS`."""
    if launch.serial_below_cells is not None:
        return int(launch.serial_below_cells)
    return LEGACY_SERIAL_BELOW_CELLS[_td(time_dependency)]


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
