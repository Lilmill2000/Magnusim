"""Per-field initial conditions + turbulence U_ref seed rule (Phase 4 §2.3)."""

from __future__ import annotations

from typing import Any

from cfddesk.case.ras import (
    DEFAULT_HYDRAULIC_DIAMETER_M,
    RSM_MODELS,
    TurbulenceModel,
    TurbulenceScalars,
    inlet_turbulence_scalars,
)

# Hardcoded fallback when no velocity-magnitude inlet BC exists.
# Matches velocity_inlet_fixed registry default — never "first BC in list".
DEFAULT_IC_UREF_M_S = 20.0

_VELOCITY_MAG_INLET_KEYS = frozenset(
    {
        "velocity_inlet_fixed",
    }
)


def resolve_turbulence_uref(project: Any) -> tuple[float, str]:
    """Return (|U_ref|, reason) for RAS IC derivation.

    Candidates: inlet BCs with faces that expose a velocity magnitude.
    Several → max |U|. Zero → DEFAULT_IC_UREF_M_S.
    """
    from cfddesk.case.bc_menu import registry_key_for_bc
    from cfddesk.case.bc_registry import get_type

    candidates: list[tuple[float, str]] = []
    for bc in getattr(project, "boundary_conditions", []) or []:
        if not getattr(bc, "face_ids", None):
            continue
        try:
            reg = registry_key_for_bc(bc)
            sem = get_type(reg).semantic
        except KeyError:
            continue
        if sem != "inlet" or reg not in _VELOCITY_MAG_INLET_KEYS:
            continue
        settings = bc.settings if isinstance(bc.settings, dict) else {}
        u_mag: float | None = None
        if reg == "velocity_inlet_fixed":
            mode = str(settings.get("direction_mode", "normal"))
            if mode == "vector":
                v = settings.get("velocity") or [0.0, 0.0, 0.0]
                u_mag = (
                    float(v[0]) ** 2 + float(v[1]) ** 2 + float(v[2]) ** 2
                ) ** 0.5
            else:
                u_mag = abs(
                    float(
                        settings.get(
                            "speed_m_s",
                            getattr(project.boundary, "inlet_speed_m_s", DEFAULT_IC_UREF_M_S),
                        )
                    )
                )
        else:
            u_mag = abs(
                float(
                    settings.get(
                        "speed_m_s",
                        getattr(project.boundary, "inlet_speed_m_s", DEFAULT_IC_UREF_M_S),
                    )
                )
            )
        if u_mag is not None and u_mag > 0:
            candidates.append((u_mag, f"{bc.name}:{reg}"))

    if not candidates:
        return DEFAULT_IC_UREF_M_S, "fallback_default_20"
    best = max(candidates, key=lambda t: t[0])
    reason = "single_inlet" if len(candidates) == 1 else f"max_of_{len(candidates)}"
    return best[0], f"{reason}:{best[1]}"


def fields_for_turbulence(model: TurbulenceModel) -> list[str]:
    """Ordered IC field keys for the tree (always includes p, U)."""
    base = ["p", "U"]
    if model == "laminar":
        return base
    if model == "kOmegaSST":
        return base + ["k", "omega"]
    if model in RSM_MODELS:
        return base + ["k", "epsilon", "R"]
    # kEpsilon
    return base + ["k", "epsilon"]


def rebuild_initial_conditions(
    project: Any,
    *,
    intensity_pct: float | None = None,
    D_h: float = DEFAULT_HYDRAULIC_DIAMETER_M,
    U_ref: float | None = None,
) -> dict[str, Any]:
    """Discard-and-default IC dict for the current turbulence model."""
    model: TurbulenceModel = project.solver.turbulence
    intensity = (
        float(intensity_pct)
        if intensity_pct is not None
        else float(project.solver.turbulence_intensity_pct)
    )
    if U_ref is None:
        U_ref, _reason = resolve_turbulence_uref(project)
    scalars: TurbulenceScalars | None = None
    if model != "laminar":
        scalars = inlet_turbulence_scalars(U_ref, intensity_pct=intensity, D_h=D_h)

    prev = {}
    sim = project.primary_simulation()
    if sim is not None and isinstance(sim.initial_conditions, dict):
        prev = dict(sim.initial_conditions)

    # Preserve user p/U globals when present; turb fields always re-derived.
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
        "uref_m_s": float(U_ref),
    }
    if scalars is not None:
        ic["k"] = {"global": scalars.k}
        if model == "kOmegaSST":
            ic["omega"] = {"global": scalars.omega}
        else:
            ic["epsilon"] = {"global": scalars.epsilon}
        if model in RSM_MODELS:
            # Store isotropic diagonal as a 3-tuple (form + writer both accept this).
            d = float(scalars.R_diag)
            ic["R"] = {"global_diag": [d, d, d]}
    return ic


def normalize_r_diag(value: Any) -> float:
    """Accept float or length-3 sequence from IC model → single diagonal scalar."""
    if isinstance(value, (list, tuple)):
        return float(value[0]) if value else 0.0
    return float(value) if value is not None else 0.0


def ic_internal_p_kinematic(ic: dict[str, Any], rho: float) -> float:
    from cfddesk.units.pressure import pa_to_kinematic

    p = ic.get("p") or {}
    pa = float(p.get("global_pa", ic.get("gauge_pressure", 0.0)))
    return pa_to_kinematic(pa, rho)


def ic_internal_u(ic: dict[str, Any]) -> tuple[float, float, float]:
    u = ic.get("U") or {}
    g = u.get("global", [0.0, 0.0, 0.0])
    return (float(g[0]), float(g[1]), float(g[2]))
