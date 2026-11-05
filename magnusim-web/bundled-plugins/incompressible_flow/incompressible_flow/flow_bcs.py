"""Incompressible Flow's flow boundary conditions, for other plugins (manifest ``exports``).

A public module: another plugin may import it when its manifest names
``incompressible_flow`` in ``requires_plugins`` (host API 1.8, plugin exports).
Its names and their meaning stay across Incompressible Flow's 1.x versions.

It gives a solver of another plugin that solves the same flow (a heat-transfer
analysis on Incompressible Flow's BC kinds) what Incompressible Flow writes for
the velocity and the turbulence of every boundary, from the study's own BC
records and the run's inputs, without copying the inlet logic:

- :func:`flow_patches` reads the core's ``RunInputs`` of one run (what
  ``cfddesk.registry.run_case.run_inputs`` gathers) with the fluid's kinematic
  viscosity and density, the turbulence model and the starting flow the caller
  solves with, and returns a :class:`FlowPatches`:

  - ``U``: the ``0/U`` boundaryField entry of every mesh patch, for every IF BC
    kind: velocity inlets (normal speed, vector, volumetric and mass flow, and
    a "Varies with time" table in a transient run), velocity outlets, pressure
    boundaries, walls (no-slip, slip, moving, rotating; the walls no BC claims
    take the study's default wall), symmetry, freestream and the total-pressure
    inlet. A mass-flow inlet or outlet reads the solver's density field ``rho``
    when ``compressible`` is true (``rhoInlet`` stays as its start value).
  - ``turbulence``: ``{field: {patch: entry}}`` for each field the model reads
    (``k``, ``omega``, ``epsilon``, ``nut``, ``nuTilda``, ``R``; none when
    laminar), with each boundary's own "Turbulence at the inlet" values, and
    ``turbulence_internal`` the case-wide value string of each field.
  - ``kinds``: what each patch is (:data:`KINDS`), ``records`` the BC record
    on it, ``wall_motion`` a wall's treatment, one of :data:`WALL_MOTIONS`.
  - ``speed_ref`` (m/s) and ``hydraulic_diameter`` (m): the case's reference
    speed and the inlet's hydraulic diameter, as Incompressible Flow's own
    turbulence values and time-step estimate use them.
  - ``initial_velocity`` (m/s) and ``initial_from``: the starting velocity
    (``still``, ``custom``, ``inlet``, ``freestream`` or ``none``).
  - ``scales``: the case-wide turbulence scales and ``patch_scales`` those of
    each boundary whose "Turbulence at the inlet" is not Auto, both with the
    keys of :data:`SCALE_KEYS`: ``k`` (m²/s²), ``omega`` (1/s), ``epsilon``
    (m²/s³), ``intensity`` (a fraction: 0.05 is the 5 % a record stores as
    ``turbulence_intensity = 5``), ``length_scale_m`` (m; for a boundary set by
    a viscosity ratio, the length scale its k and omega imply) and ``nu_tilda``
    (m²/s, Spalart-Allmaras only, else None).

- :func:`boundary_pressure_pa` gives a pressure boundary's gauge pressure, a
  total-pressure inlet's total pressure or a freestream's pressure, in Pa: the
  fixed value, never a "Varies with time" table (:func:`varies_with_time` says
  when a table replaces it).
- :func:`wall_motion` gives a wall record's treatment as one of :data:`WALL_MOTIONS`.
- :func:`varies_with_time` says whether a boundary's "Varies with time" table
  is in effect in a run (steady runs solve the fixed value).
- :func:`boundary_problem` gives what Incompressible Flow's own Start refuses
  about one BC record, as a :class:`BoundaryProblem` whose ``message`` is the
  sentence Incompressible Flow shows; :func:`first_boundary_problem` the one its
  Start reports first for all of a study's records (kind by kind across them).

A turbulence model this module does not know raises ``ValueError``.

The pressure entries of ``0/p`` are not part of this module: Incompressible
Flow stores pressure divided by density, another solver writes its own.
"""

from __future__ import annotations

import dataclasses
import math
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, NamedTuple

__all__ = [
    "KINDS",
    "PROBLEM_KINDS",
    "SCALE_KEYS",
    "WALL_MOTIONS",
    "BoundaryProblem",
    "FlowPatches",
    "boundary_kind",
    "boundary_pressure_pa",
    "boundary_problem",
    "first_boundary_problem",
    "flow_patches",
    "turbulence_model_name",
    "varies_with_time",
    "wall_motion",
]

# What a mesh patch is, by its BC (``wall`` too for a patch no BC claims).
KINDS: tuple[str, ...] = (
    "inlet",
    "pressure",
    "velocity_outlet",
    "wall",
    "symmetry",
    "freestream",
    "total_pressure",
)

# A wall's treatment (FlowPatches.wall_motion): fixed tokens, not the BC editor's labels.
WALL_MOTIONS: tuple[str, ...] = ("no_slip", "slip", "moving", "rotating")
_WALL_TOKENS: dict[str, str] = {"No-slip": "no_slip", "Slip": "slip", "Moving": "moving", "Rotating": "rotating"}

# The keys of FlowPatches.scales and of each FlowPatches.patch_scales entry.
SCALE_KEYS: tuple[str, ...] = ("k", "omega", "epsilon", "intensity", "length_scale_m", "nu_tilda")

# What a BoundaryProblem is about.
PROBLEM_KINDS: tuple[str, ...] = ("turbulence", "time_table", "wall_motion")

_CMU = 0.09


class BoundaryProblem(NamedTuple):
    """What Incompressible Flow's Start refuses about one BC record.

    ``kind`` is one of :data:`PROBLEM_KINDS`; ``detail`` the reason in the user's
    words (no capital, no full stop); ``message`` the sentence Incompressible Flow
    shows, with the BC's name.
    """

    kind: str
    detail: str
    message: str


@dataclass(frozen=True)
class FlowPatches:
    """The velocity and turbulence boundary entries of one run (see the module note)."""

    patch_names: list[str]
    U: dict[str, dict[str, str]]
    turbulence: dict[str, dict[str, dict[str, str]]]
    turbulence_internal: dict[str, str]
    kinds: dict[str, str]
    records: dict[str, dict[str, Any]]
    wall_motion: dict[str, str]
    speed_ref: float
    hydraulic_diameter: float
    initial_velocity: list[float]
    initial_from: str
    scales: dict[str, float | None] = field(default_factory=dict)
    patch_scales: dict[str, dict[str, float | None]] = field(default_factory=dict)


def turbulence_model_name(value: Any) -> str:
    """The OpenFOAM name of a turbulence model (``laminar`` too), as Incompressible Flow
    reads a study's choice ("k-omega SST", "spalart-allmaras", "kOmegaSST" ...).

    Raises ``ValueError`` for a name it does not know.
    """
    from .physics import TURBULENCE_MODELS, normalize_turbulence

    name = normalize_turbulence(value)
    if name is None:
        raise ValueError(f"unknown turbulence model {value!r}: one of {', '.join(TURBULENCE_MODELS)}")
    return name


def boundary_kind(record: dict[str, Any] | None) -> str | None:
    """One of :data:`KINDS` for a BC record, None when it is none of Incompressible Flow's."""
    from magnusim_sdk.study import is_pressure_bc, is_velocity_inlet, is_velocity_outlet, is_wall_bc

    from .bc_kinds import is_freestream, is_symmetry, is_total_pressure_inlet

    if not isinstance(record, dict):
        return None
    if is_velocity_inlet(record):
        return "inlet"
    if is_pressure_bc(record):
        return "pressure"
    if is_velocity_outlet(record):
        return "velocity_outlet"
    if is_wall_bc(record):
        return "wall"
    if is_symmetry(record):
        return "symmetry"
    if is_freestream(record):
        return "freestream"
    if is_total_pressure_inlet(record):
        return "total_pressure"
    return None


def wall_motion(record: dict[str, Any] | None) -> str | None:
    """A wall record's treatment, one of :data:`WALL_MOTIONS` (``no_slip`` when it names
    none); None for a record that is not a wall."""
    from .bc_kinds import wall_kind

    if boundary_kind(record) != "wall":
        return None
    return _WALL_TOKENS[wall_kind(record)]


def boundary_pressure_pa(record: dict[str, Any]) -> float:
    """A pressure boundary's gauge pressure, a total-pressure inlet's total pressure or a
    freestream's pressure, in Pa (any unit the record holds); 0 for anything else.

    The fixed value: a "Varies with time" table on the record is not read here.
    """
    from .writer import freestream_pressure_pa, pressure_pa

    kind = boundary_kind(record)
    if kind in ("pressure", "total_pressure"):
        return float(pressure_pa(record))
    if kind == "freestream":
        return float(freestream_pressure_pa(record))
    return 0.0


def varies_with_time(record: dict[str, Any], *, transient: bool) -> bool:
    """The record's "Varies with time" table is what the run solves with (transient runs only)."""
    from . import time_table

    return bool(time_table.in_effect(record, transient))


def _problem_of_kind(record: dict[str, Any], what: str, *, model: str, transient: bool) -> BoundaryProblem | None:
    """One of Start's checks (``what``, one of PROBLEM_KINDS) on one record with assigned faces."""
    from magnusim_sdk.study import bc_faces

    from .bc_kinds import wall_motion_problem
    from .inlet_turbulence import settings_problem
    from .time_table import table_problem
    from .time_table import varies_with_time as _varies
    from .writer import carries_inlet_turbulence, inlet_quantity

    kind = boundary_kind(record)
    if kind is None or not bc_faces(record):
        return None
    name = record.get("name")
    if what == "turbulence":
        if model != "laminar" and carries_inlet_turbulence(record):
            problem = settings_problem(record, model)
            if problem:
                return BoundaryProblem("turbulence", problem, f'Turbulence at the inlet of "{name}": {problem}.')
    elif what == "time_table":
        if transient and _varies(record):
            if kind == "inlet":
                problem = table_problem(record, inlet_quantity(record))
            elif kind in ("pressure", "total_pressure"):
                problem = table_problem(record, "pressure")
            else:
                problem = None
            if problem:
                return BoundaryProblem("time_table", problem, f'"Varies with time" on "{name}": {problem}.')
    elif kind == "wall":
        problem = wall_motion_problem(record)
        if problem:
            return BoundaryProblem("wall_motion", problem, f'Wall "{name}": {problem}.')
    return None


def boundary_problem(record: dict[str, Any], *, turbulence_model: str, transient: bool) -> BoundaryProblem | None:
    """What Incompressible Flow's Start refuses about one BC record, else None.

    The checks its Start makes on a single boundary with assigned faces (one with
    none is not checked), in :data:`PROBLEM_KINDS` order: its "Turbulence at the
    inlet" (when the model is not laminar), its "Varies with time" table (transient
    runs), and a rotating wall's axis. ``turbulence_model`` is read as Incompressible
    Flow reads a study's choice (:func:`turbulence_model_name`). For a study's
    records use :func:`first_boundary_problem`: Start's order runs across them.
    """
    model = turbulence_model_name(turbulence_model)
    for what in PROBLEM_KINDS:
        problem = _problem_of_kind(record, what, model=model, transient=transient)
        if problem is not None:
            return problem
    return None


def first_boundary_problem(
    records: Any, *, turbulence_model: str, transient: bool
) -> BoundaryProblem | None:
    """The problem Incompressible Flow's Start reports first for a study's BC records, else None.

    Start checks kind by kind across all records, in :data:`PROBLEM_KINDS` order: the
    "Turbulence at the inlet" of every record, then every "Varies with time" table,
    then every wall's motion. So a turbulence problem on a later record comes before a
    wall problem on an earlier one. A caller that checks a study's BCs as Incompressible
    Flow does (Heat Transfer's Start) uses this rather than :func:`boundary_problem`
    record by record.
    """
    model = turbulence_model_name(turbulence_model)
    rows = [r for r in (records or []) if isinstance(r, dict)]
    for what in PROBLEM_KINDS:
        for record in rows:
            problem = _problem_of_kind(record, what, model=model, transient=transient)
            if problem is not None:
                return problem
    return None


def _scales(raw: dict[str, Any], nu_tilda: float | None) -> dict[str, float | None]:
    """The fixed SCALE_KEYS of one set of k / omega scales."""
    k = float(raw["k"])
    omega = float(raw["omega"])
    length = raw.get("length_scale_m")
    if length is None:
        length = math.sqrt(k) / ((_CMU**0.25) * omega) if omega > 0 else 0.0
    return {
        "k": k,
        "omega": omega,
        "epsilon": float(raw.get("epsilon", _CMU * k * omega)),
        "intensity": float(raw["intensity"]),
        "length_scale_m": float(length),
        "nu_tilda": None if nu_tilda is None else float(nu_tilda),
    }


def flow_patches(
    inputs: Any,
    *,
    nu: float,
    rho: float,
    turbulence_model: str,
    poly_mesh: Path | str | None = None,
    initial_flow: str = "still",
    initial_u: tuple[float, float, float] = (0.0, 0.0, 0.0),
    compressible: bool = False,
) -> FlowPatches:
    """The velocity and turbulence entries of every patch of one run (see the module note).

    ``inputs`` is the core's ``RunInputs`` for the run. ``nu`` (m²/s) and ``rho``
    (kg/m³) are the fluid's; ``turbulence_model`` an OpenFOAM RAS model name or
    ``laminar`` (:func:`turbulence_model_name`; an unknown one raises ``ValueError``).
    ``poly_mesh`` is the case's ``constant/polyMesh`` (its ``boundary`` gives the
    patches in mesh order; without one they come from the BCs). ``initial_flow`` is
    ``still``, ``inlet`` or ``custom`` (``initial_u`` in m/s).
    """
    from .bc_kinds import wall_kind
    from .inlet_turbulence import sa_auto_nu_tilda
    from .physics import SA_MODEL, StudyPhysics
    from .runspec import load_run_spec
    from .writer import (
        _bc_dict,
        _build_field_patches,
        _patch_names,
        initial_velocity,
        k_omega_from_scales,
        patch_turbulence,
        resolve_speed_and_dhyd,
        turb_value_strings,
        two_d_empty_patches,
    )

    model = turbulence_model_name(turbulence_model)
    spec = load_run_spec(inputs)
    physics = StudyPhysics(
        turbulence_model=model,
        initial_flow=initial_flow if initial_flow in ("still", "inlet", "custom") else "still",
        initial_u=(float(initial_u[0]), float(initial_u[1]), float(initial_u[2])),
    )
    spec = dataclasses.replace(spec, nu=float(nu), rho=float(rho), physics=physics)
    poly = Path(poly_mesh) if poly_mesh else None
    names = _patch_names(spec, poly)

    # As write_solve_case: the resolved reference speed, unless the spec names its own.
    speed_ref, d_hyd = resolve_speed_and_dhyd(spec)
    if spec.speed_for_k and spec.speed_for_k != 1.0:
        speed_ref = float(spec.speed_for_k)
    turb = k_omega_from_scales(speed_ref, d_hyd)
    nu_tilda = sa_auto_nu_tilda(float(nu)) if model == SA_MODEL else None
    values = turb_value_strings(turb["k"], turb["omega"], nu_tilda)
    own = patch_turbulence(spec, speed_ref) if model != "laminar" else {}
    own_values = {p: turb_value_strings(sc["k"], sc["omega"], sc.get("nu_tilda")) for p, sc in own.items()}
    # One cell across (2D): its ends' entries are empty (their kind stays symmetry).
    empties = two_d_empty_patches(spec, poly)
    u_entries, _p, turb_patches = _build_field_patches(
        spec, names, turb_values=values, patch_turb=own_values, empty_patches=empties
    )
    if compressible:
        for entry in u_entries.values():
            if "massFlowRate" in entry and "rho" not in entry:
                entry["rho"] = "rho"
    u0, u0_from = initial_velocity(spec, speed_ref)

    kinds: dict[str, str] = {}
    records: dict[str, dict[str, Any]] = {}
    motions: dict[str, str] = {}
    for m in spec.mapped or []:
        patch = str(m.get("patch") or "")
        if not patch or not m.get("bc"):
            continue
        rec = _bc_dict(m["bc"])
        kind = boundary_kind(rec)
        if kind is None:
            continue
        kinds[patch] = kind
        records[patch] = dict(rec)
        if kind == "wall":
            motions[patch] = _WALL_TOKENS[wall_kind(rec)]
    # The study's default wall, read as the writer reads it (any spelling of its label).
    default_wall = _WALL_TOKENS[wall_kind({"wall_type": spec.wall_default})]
    for name in names:
        if name not in kinds:
            kinds[name] = "wall"
            motions[name] = default_wall

    internal = {name: ("uniform 0" if name == "nut" else f"uniform {values[name]}") for name in turb_patches}
    case_scales = {"k": turb["k"], "omega": turb["omega"], "intensity": turb["I"], "length_scale_m": turb["L"]}
    return FlowPatches(
        patch_names=list(names),
        U=u_entries,
        turbulence=turb_patches,
        turbulence_internal=internal,
        kinds=kinds,
        records=records,
        wall_motion=motions,
        speed_ref=float(speed_ref),
        hydraulic_diameter=float(d_hyd),
        initial_velocity=[float(c) for c in u0],
        initial_from=str(u0_from),
        scales=_scales(case_scales, nu_tilda),
        patch_scales={p: _scales(sc, sc.get("nu_tilda")) for p, sc in own.items()},
    )
