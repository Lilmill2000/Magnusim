"""Old project.json blocks: kept as stored, and the frozen values their migrations read.

A study's ``solver``, ``boundary``, ``numerics`` and ``initial_conditions``
blocks (``LEGACY_SIM_KEYS``) come from the desktop-era Project model. Nothing
reads them on a run path: a study's physics settings live in its analysis's
study files. The core keeps them as opaque dicts (``Simulation.legacy``) and
writes them back as they were, so an old file loads and saves unchanged. The
only value still read is ``solver.mode``, which picks steady or transient for
a study saved before analysis keys (``legacy_solver_mode``).

The constants are copies of what old files were written with, kept here so a
migration means today what it meant when the file was saved. They must never
follow the fluids library, the BC registry or a plugin's defaults: when those
change, these stay.

- ``V7_ASSUMED_DENSITY_KG_M3``: the density pre-v7 files are assumed to use
  (dry air at 20 °C, 1 atm) when their kinematic pressures become Pa and when a
  recovered run's snapshot gets a density.
- ``V4_BOUNDARY_DEFAULTS``: the v4 ``boundary`` values the BC conversion
  reads, for a key the file does not have.
- ``V4_BC_SETTINGS``: the settings of the three BC types a v4 file's face
  roles become, as the BC registry gave them.
- ``LEGACY_SOLVER_DEFAULTS``: the ``solver`` block a v4/v5 file is given, key by
  key, when it has no value; a recovered run's snapshot lists these keys.
- ``V12_*``: what the v12 migration seeds into a pre-v12 study's numerics,
  simulation control and initial conditions.
"""

from __future__ import annotations

import copy
from collections.abc import Iterable, Mapping
from typing import Any

LEGACY_SIM_KEYS: tuple[str, ...] = ("solver", "boundary", "numerics", "initial_conditions")

V7_ASSUMED_DENSITY_KG_M3 = 1.204

V4_BOUNDARY_DEFAULTS: dict[str, Any] = {
    "inlet_speed_m_s": 0.5,
    "inlet_direction_mode": "normal",
    "inlet_vector": [-1.0, 0.0, 0.0],
    "outlet_p": 0.0,
}

V4_BC_SETTINGS: dict[str, dict[str, Any]] = {
    "velocity_inlet_fixed": {
        "direction_mode": "normal",
        "speed_m_s": 20.0,
        "velocity": [0.0, 0.0, 0.0],
        "temperature_K": 293.15,
    },
    "pressure_outlet_gauge": {
        "gauge_pressure": 0.0,
    },
    "wall_noslip": {
        "thermal_mode": "adiabatic",
        "temperature_K": 293.15,
        "heat_flux_W_m2": 0.0,
        "htc_W_m2K": 10.0,
        "ambient_T_K": 293.15,
    },
}

LEGACY_SOLVER_DEFAULTS: dict[str, Any] = {
    "mode": "steady",
    "backend": "amgx",
    "end_condition": "residual",
    "end_time": 1000,
    "residual_u": 1e-06,
    "residual_p": 1e-06,
    "turbulence": "laminar",
    "turbulence_intensity_pct": 5.0,
    "warm_start": False,
    "energy": False,
}

V12_NUMERICS_SEED: dict[str, Any] = {
    "relaxation_type": "manual",
    "n_non_orthogonal": 1,
    "p_ref_cell": 0,
    "p_ref_value_pa": 0.0,
    "residual_u": 1e-06,
    "residual_p": 1e-06,
    "residual_k": 1e-06,
    "residual_omega": 1e-06,
    "residual_epsilon": None,
    "u_solver": "PBiCGStab",
    "p_solver": "GAMG",
    "turb_solver": "PBiCGStab",
    "relax_p": 0.3,
    "relax_u": 0.7,
    "relax_k": 0.7,
    "relax_omega": 0.7,
    "relax_epsilon": 0.7,
    "relax_r": 0.5,
    "ddt_default": "steadyState",
    "grad_default": "cellLimited leastSquares 1",
    "div_phi_u": "bounded Gauss linearUpwindV grad(U)",
    "div_nu_eff": "Gauss linear",
    "laplacian_default": "Gauss linear limited corrected 0.5",
    "interpolation_default": "linear",
    "sn_grad_default": "limited 0.5",
    "wall_dist_method": "meshWave",
    "solver_u": {
        "solver_type": "PBiCGStab",
        "absolute_tolerance": 1e-08,
        "relative_tolerance": 0.01,
        "preconditioner": "DILU",
    },
    "solver_p": {
        "solver_type": "GAMG",
        "absolute_tolerance": 1e-06,
        "relative_tolerance": 0.001,
        "smoother": "Gauss-Seidel",
        "n_pre_sweeps": 2,
        "n_post_sweeps": 1,
        "cache_agglomeration": True,
        "n_cells_coarsest": 100,
        "n_merge_levels": 1,
    },
    "solver_k": {
        "solver_type": "PBiCGStab",
        "absolute_tolerance": 1e-08,
        "relative_tolerance": 0.01,
        "preconditioner": "DILU",
    },
    "solver_omega": {
        "solver_type": "PBiCGStab",
        "absolute_tolerance": 1e-08,
        "relative_tolerance": 0.01,
        "preconditioner": "DILU",
    },
    "schemes": {
        "time_default": "Steady-state",
        "gradient_default": {"scheme": "Celllimited leastSquares", "limiter_coefficient": 1.0},
        "grad_p": {"scheme": "Celllimited leastSquares", "limiter_coefficient": 1.0},
        "grad_U": {"scheme": "Celllimited leastSquares", "limiter_coefficient": 1.0},
        "divergence_default": "Gauss linear",
        "div_phi_U": "Gauss linear upwind v ∇U",
        "div_phi_k": "Bounded Gauss upwind",
        "div_phi_omega": "Bounded Gauss upwind",
        "laplacian_default": {"scheme": "Gauss linear limited corrected", "limiter_coefficient": 0.5},
        "laplacian_nuEff_U": {"scheme": "Gauss linear limited corrected", "limiter_coefficient": 0.5},
        "laplacian_1AU_p": {"scheme": "Gauss linear limited corrected", "limiter_coefficient": 0.5},
        "laplacian_nu_U": {"scheme": "Gauss linear limited corrected", "limiter_coefficient": 0.5},
        "interpolation_default": "Linear",
        "interpolate_HbyA": "Linear",
        "sn_grad_default": "Limited",
        "sn_grad_limiter_coefficient": 0.5,
    },
}

V12_SIMULATION_CONTROL_SEED: dict[str, Any] = {
    "delta_t": 1.0,
    "write_control": "timeStep",
    "write_interval": 1000,
    "cpu_mode": "automatic",
    "n_cpus": 16,
    "max_runtime_s": 20000.0,
    "potential_flow_init": False,
    "decompose_method": "scotch",
}

# The initial-condition fields the v12 migration seeded per stored
# ``solver.turbulence``; any other value seeded none (as "laminar").
V12_IC_TURBULENCE_FIELDS: dict[str, tuple[str, ...]] = {
    "laminar": (),
    "kEpsilon": ("k", "epsilon"),
    "kOmegaSST": ("k", "omega"),
    "LRR": ("k", "epsilon", "R"),
    "SSG": ("k", "epsilon", "R"),
}
# The BC whose speed gave the seed's reference velocity, and the fallback.
V12_IC_INLET_KEY = "velocity_inlet_fixed"
V12_IC_DEFAULT_UREF_M_S = 20.0
# Mixing-length inlet estimate: k = 1.5 (U I)^2, L = 0.07 D_h.
V12_IC_C_MU = 0.09
V12_IC_HYDRAULIC_DIAMETER_M = 0.0508


# ---- the blocks as stored ---------------------------------------------------


def legacy_blocks(sim: Mapping[str, Any]) -> dict[str, dict[str, Any]]:
    """A deep copy of the legacy blocks a stored study holds (dicts only)."""
    return {
        key: copy.deepcopy(dict(sim[key]))
        for key in LEGACY_SIM_KEYS
        if isinstance(sim.get(key), dict)
    }


def legacy_solver_mode(blocks: Mapping[str, Any]) -> str:
    """``steady`` or ``transient`` from a stored ``solver.mode`` (``steady``
    when there is none), for a study saved before analysis keys."""
    solver = blocks.get("solver")
    mode = solver.get("mode") if isinstance(solver, Mapping) else None
    return "transient" if mode == "transient" else "steady"


def legacy_solver(raw: Mapping[str, Any] | None) -> dict[str, Any]:
    """A ``solver`` block with every key, as old files were normalised.

    ``turbulence`` is kept as stored when it is a non-empty string (the core
    names no turbulence model); a missing one is ``laminar``.
    """
    d = LEGACY_SOLVER_DEFAULTS
    if not raw:
        return copy.deepcopy(d)
    backend = raw.get("backend", d["backend"])
    if backend not in ("cpu", "amgx"):
        backend = d["backend"]
    end_condition = raw.get("end_condition", d["end_condition"])
    if end_condition not in ("residual", "iterations"):
        end_condition = d["end_condition"]
    turbulence = raw.get("turbulence")
    if not isinstance(turbulence, str) or not turbulence.strip():
        turbulence = d["turbulence"]
    mode = raw.get("mode", d["mode"])
    if mode not in ("steady", "transient"):
        mode = d["mode"]
    return {
        "mode": mode,
        "backend": backend,
        "end_condition": end_condition,
        "end_time": int(raw.get("end_time", d["end_time"])),
        "residual_u": float(raw.get("residual_u", d["residual_u"])),
        "residual_p": float(raw.get("residual_p", d["residual_p"])),
        "turbulence": turbulence,
        "turbulence_intensity_pct": float(
            raw.get("turbulence_intensity_pct", d["turbulence_intensity_pct"])
        ),
        "warm_start": bool(raw.get("warm_start", d["warm_start"])),
        "energy": bool(raw.get("energy", d["energy"])),
    }


def legacy_boundary(raw: Mapping[str, Any] | None) -> dict[str, Any]:
    """A ``boundary`` block with every key, as old files were normalised."""
    return {
        **_v4_boundary(raw),
        "walls_type": str((raw or {}).get("walls_type", "noSlip")),
    }


def recover_run_snapshot(raw_solver: Any) -> tuple[dict[str, Any], list[str]]:
    """(settings snapshot, unrecoverable keys) of the run a v4/v5 results tree
    becomes: the file's solver block, or nothing and every key unrecoverable."""
    full = legacy_solver(raw_solver if isinstance(raw_solver, Mapping) else None)
    if isinstance(raw_solver, Mapping) and raw_solver:
        return dict(full), []
    return {}, sorted(full)


# ---- v7: kinematic pressure to Pa ---------------------------------------------


def v7_kinematic_to_pa(p_kinematic: Any) -> float:
    """A pre-v7 kinematic pressure (m^2/s^2) in Pa, at the assumed density."""
    return float(p_kinematic) * V7_ASSUMED_DENSITY_KG_M3


_V7_PRESSURE_KEYS = ("gauge_pressure", "pressure")


def v7_blocks_to_pa(blocks: Mapping[str, Any]) -> dict[str, Any]:
    """The legacy blocks with their kinematic pressures in Pa: ``boundary.outlet_p``
    and the initial conditions' ``gauge_pressure`` / ``pressure`` (a bare
    numeric ``p`` also gives ``gauge_pressure``)."""
    out = copy.deepcopy(dict(blocks))
    boundary = out.get("boundary")
    if isinstance(boundary, dict) and "outlet_p" in boundary:
        boundary["outlet_p"] = v7_kinematic_to_pa(boundary["outlet_p"])
    ic = out.get("initial_conditions")
    if isinstance(ic, dict):
        for key in _V7_PRESSURE_KEYS:
            if key in ic and ic[key] is not None:
                ic[key] = v7_kinematic_to_pa(ic[key])
        if ic.get("gauge_pressure") is None and isinstance(ic.get("p"), (int, float)):
            ic["gauge_pressure"] = v7_kinematic_to_pa(ic["p"])
    return out


# ---- v12: numerics, simulation control and initial-condition seed ------------


def v12_seed(
    blocks: Mapping[str, Any],
    simulation_control: Mapping[str, Any] | None,
    inlets: Iterable[tuple[str, Mapping[str, Any]]],
) -> tuple[dict[str, Any], dict[str, Any]]:
    """(legacy blocks, simulation control) of a pre-v12 study after the v12 seed.

    An empty numerics block and an empty simulation control get the v12
    defaults, and a simulation control that holds values is normalised to the
    v12 keys as it was then; initial conditions without ``p`` get the seed for
    the stored turbulence. A numerics block that holds values is kept as stored
    (nothing reads it). ``inlets`` is (BC registry key, settings) per BC that
    has faces.
    """
    out = copy.deepcopy(dict(blocks))
    solver = legacy_solver(out.get("solver"))
    if not out.get("numerics"):
        numerics = copy.deepcopy(V12_NUMERICS_SEED)
        p_solver = "amgx" if solver["backend"] == "amgx" else "GAMG"
        numerics["p_solver"] = p_solver
        numerics["solver_p"]["solver_type"] = p_solver
        numerics["residual_u"] = solver["residual_u"]
        numerics["residual_p"] = solver["residual_p"]
        out["numerics"] = numerics
    control = _v12_simulation_control(simulation_control)
    ic = out.get("initial_conditions")
    if not isinstance(ic, dict):
        ic = {}
    if not ic or "p" not in ic:
        ic = _v12_initial_conditions(solver, legacy_boundary(out.get("boundary")), ic, inlets)
    out["initial_conditions"] = ic
    return out, control


def _v12_simulation_control(raw: Mapping[str, Any] | None) -> dict[str, Any]:
    """The v12 simulation control: the seed, or the stored one with its v12
    keys typed and defaulted (other keys dropped, as v12 did)."""
    d = V12_SIMULATION_CONTROL_SEED
    if not raw:
        return copy.deepcopy(d)
    cpu_mode = raw.get("cpu_mode", d["cpu_mode"])
    if cpu_mode not in ("automatic", "manual"):
        cpu_mode = d["cpu_mode"]
    method = raw.get("decompose_method", d["decompose_method"])
    if isinstance(method, str):
        method = method.strip().lower()
    if method not in ("scotch", "hierarchical", "simple"):
        method = d["decompose_method"]
    write_control = str(raw.get("write_control", d["write_control"]))
    if write_control in ("Time step", "time step", "timestep"):
        write_control = "timeStep"
    return {
        "delta_t": float(raw.get("delta_t", d["delta_t"])),
        "write_control": write_control,
        "write_interval": int(raw.get("write_interval", d["write_interval"])),
        "cpu_mode": cpu_mode,
        "n_cpus": int(raw.get("n_cpus", d["n_cpus"])),
        "max_runtime_s": float(raw.get("max_runtime_s", d["max_runtime_s"])),
        "potential_flow_init": bool(raw.get("potential_flow_init", d["potential_flow_init"])),
        "decompose_method": method,
    }


def _v12_uref(inlets: Iterable[tuple[str, Mapping[str, Any]]], boundary_speed: float) -> float:
    best: float | None = None
    for key, settings in inlets:
        if key != V12_IC_INLET_KEY:
            continue
        if str(settings.get("direction_mode", "normal")) == "vector":
            v = settings.get("velocity") or [0.0, 0.0, 0.0]
            u_mag = (float(v[0]) ** 2 + float(v[1]) ** 2 + float(v[2]) ** 2) ** 0.5
        else:
            u_mag = abs(float(settings.get("speed_m_s", boundary_speed)))
        if u_mag > 0 and (best is None or u_mag > best):
            best = u_mag
    return V12_IC_DEFAULT_UREF_M_S if best is None else best


def _v12_initial_conditions(
    solver: Mapping[str, Any],
    boundary: Mapping[str, Any],
    prev: Mapping[str, Any],
    inlets: Iterable[tuple[str, Mapping[str, Any]]],
) -> dict[str, Any]:
    u_ref = _v12_uref(inlets, float(boundary["inlet_speed_m_s"]))
    fields = V12_IC_TURBULENCE_FIELDS.get(str(solver["turbulence"]), ())

    p_pa = 0.0
    if isinstance(prev.get("p"), dict) and "global_pa" in prev["p"]:
        p_pa = float(prev["p"]["global_pa"])
    elif "gauge_pressure" in prev:
        p_pa = float(prev["gauge_pressure"])
    u_global = [0.0, 0.0, 0.0]
    if isinstance(prev.get("U"), dict) and prev["U"].get("global") is not None:
        g = prev["U"]["global"]
        u_global = [float(g[0]), float(g[1]), float(g[2])]

    ic: dict[str, Any] = {
        "p": {"global_pa": p_pa},
        "U": {"global": u_global},
        "subdomains_stub": True,
        "uref_m_s": float(u_ref),
    }
    if not fields:
        return ic
    c_mu = V12_IC_C_MU
    u = abs(float(u_ref))
    intensity = max(float(solver["turbulence_intensity_pct"]), 0.01) / 100.0
    length = 0.07 * max(float(V12_IC_HYDRAULIC_DIAMETER_M), 1e-6)
    k = max(1.5 * (u * intensity) ** 2, 1e-12)
    eps = max((c_mu**0.75) * (k**1.5) / length, 1e-12)
    omega = max(eps / (c_mu * k), 1e-12)
    values = {"k": k, "epsilon": eps, "omega": omega}
    for name in fields:
        if name == "R":
            d = float((2.0 / 3.0) * k)
            ic["R"] = {"global_diag": [d, d, d]}
        else:
            ic[name] = {"global": values[name]}
    return ic


# ---- v4: face roles to BCs ----------------------------------------------------


def _v4_boundary(boundary: Mapping[str, Any] | None) -> dict[str, Any]:
    """The v4 ``boundary`` block with missing keys filled and values typed."""
    raw = dict(boundary or {})
    mode = raw.get("inlet_direction_mode", V4_BOUNDARY_DEFAULTS["inlet_direction_mode"])
    if mode not in ("normal", "vector"):
        mode = "normal"
    vec = raw.get("inlet_vector", V4_BOUNDARY_DEFAULTS["inlet_vector"])
    return {
        "inlet_speed_m_s": float(
            raw.get("inlet_speed_m_s", V4_BOUNDARY_DEFAULTS["inlet_speed_m_s"])
        ),
        "inlet_direction_mode": mode,
        "inlet_vector": [float(vec[0]), float(vec[1]), float(vec[2])],
        "outlet_p": float(raw.get("outlet_p", V4_BOUNDARY_DEFAULTS["outlet_p"])),
    }


def v4_bcs_from_roles(
    face_roles: Iterable[tuple[int, str]],
    boundary: Mapping[str, Any] | None,
    refinement: Mapping[str, int],
) -> list[dict[str, Any]]:
    """BCs for a v4 file: one each for its inlet, outlet and walls faces.

    ``face_roles`` is (face id, role) per face, ``boundary`` the file's
    ``boundary`` block (pressures still kinematic; the v7 migration converts
    them) and ``refinement`` the mesh refinement level per role. Returns the BC
    fields without ids, inlet first; a role no face has gets no BC.
    """
    by_role: dict[str, list[int]] = {"inlet": [], "outlet": [], "walls": []}
    for face_id, role in face_roles:
        if role in by_role:
            by_role[role].append(int(face_id))
    b = _v4_boundary(boundary)

    bcs: list[dict[str, Any]] = []
    if by_role["inlet"]:
        settings = copy.deepcopy(V4_BC_SETTINGS["velocity_inlet_fixed"])
        settings["speed_m_s"] = b["inlet_speed_m_s"]
        settings["direction_mode"] = b["inlet_direction_mode"]
        settings["velocity"] = list(b["inlet_vector"])
        bcs.append(
            {
                "name": "Velocity inlet 1",
                "patch_name": "inlet",
                "type": "velocity_inlet_fixed",
                "settings": settings,
                "face_ids": sorted(by_role["inlet"]),
                "refinement_level": int(refinement["inlet"]),
            }
        )
    if by_role["outlet"]:
        settings = copy.deepcopy(V4_BC_SETTINGS["pressure_outlet_gauge"])
        settings["gauge_pressure"] = b["outlet_p"]
        bcs.append(
            {
                "name": "Pressure outlet 1",
                "patch_name": "outlet",
                "type": "pressure_outlet_gauge",
                "settings": settings,
                "face_ids": sorted(by_role["outlet"]),
                "refinement_level": int(refinement["outlet"]),
            }
        )
    if by_role["walls"]:
        bcs.append(
            {
                "name": "Wall no-slip 1",
                "patch_name": "walls",
                "type": "wall_noslip",
                "settings": copy.deepcopy(V4_BC_SETTINGS["wall_noslip"]),
                "face_ids": sorted(by_role["walls"]),
                "refinement_level": int(refinement["walls"]),
            }
        )
    return bcs
