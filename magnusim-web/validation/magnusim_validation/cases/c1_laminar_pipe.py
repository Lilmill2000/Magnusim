"""Case 1: laminar flow in a circular pipe, Re = 100 (3D), on Hex-dominant and on Standard.

A 20 mm pipe 300 mm (15 D) long, a uniform velocity inlet of 1 m/s, a 0 Pa outlet and a
no-slip wall; a custom fluid with nu = 2e-4 m²/s and rho = 1 kg/m³ (pressures in Pa are then
the kinematic values), so Re = U D / nu = 100. The developed part of the flow is the exact
Hagen-Poiseuille solution: -dp/dx = 32 mu U / D² (Darcy f = 64/Re) and a centreline speed of
twice the bulk speed. The flow develops from the uniform inlet within about 5.8 D (Durst et
al.), so the compared values are read over x/D 10 to 13: more than 10 D from the inlet, as the
reference data ask, and 2 D clear of the outlet.
"""

from __future__ import annotations

import math
from typing import Any

import numpy as np

from ..extract import band, downsample, first_crossing, linear_fit, radial_fit, rms, window_mean
from ..model import QuantitySpec, Reference, Tolerance, compare

ID = "c1_laminar_pipe"
TITLE = "Laminar pipe, Re = 100"
GROUP = "Internal flow"
VARIANTS = ("hexdominant", "standard")
VARIANT_LABELS = {"hexdominant": "Hex-dominant", "standard": "Standard"}
MESH_ENGINE = {"hexdominant": "snappy_hexdominant", "standard": "standard"}

D_MM = 20.0
L_MM = 300.0
D = D_MM / 1000.0
L = L_MM / 1000.0
U = 1.0
NU = 2.0e-4
RHO = 1.0
RE = U * D / NU
# The developed part, in x/D: more than 10 D from the uniform inlet, 2 D clear of the outlet.
FIT_FROM_D, FIT_TO_D = 10.0, 13.0
# The radial profile's station (x/D), in the developed part.
PROFILE_AT_D = 12.0
# Centreline probes at x/D = 1, 2, ..., 14 (Point probe: the cell holding each point).
PROBE_X_D = tuple(float(i) for i in range(1, 15))
# The cells and wall faces of the developed part (a box around the pipe over x/D 10 to 13).
_WINDOW_BOX = [[FIT_FROM_D * D, -0.6 * D, -0.6 * D], [FIT_TO_D * D, 0.6 * D, 0.6 * D]]
# The wall's patch: the app names it after its BC ("Pipe wall").
WALL_PATCH = "pipe_wall"

GEOMETRY_WORDS = f"pipe, D = {D_MM:g} mm, L = {L_MM:g} mm ({L_MM / D_MM:g} D) along +x from x = 0"
FACE_SELECTORS: dict[str, dict[str, Any]] = {
    "inlet": {"plane": {"axis": "x", "at_mm": 0.0, "sign": -1}},
    "outlet": {"plane": {"axis": "x", "at_mm": L_MM, "sign": 1}},
    "wall": {"rest": True, "count": 1},
}

_HP = (
    "G. Hagen (1839), \"Ueber die Bewegung des Wassers in engen cylindrischen Röhren\", Ann. Phys. Chem. "
    "46:423-442; J. L. M. Poiseuille (1840), C. R. Acad. Sci. Paris 11:961-967, 1041-1048: the exact "
    "(Hagen-Poiseuille) solution of the Navier-Stokes equations for fully developed laminar pipe flow"
)
_HP_CONDITIONS = "fully developed, steady, Newtonian; Re = rho U D / mu with U the bulk (mean) speed; Re = 100"

QUANTITIES: dict[str, QuantitySpec] = {
    "fRe": QuantitySpec(
        key="fRe",
        label="Darcy friction factor × Re, developed part (x/D 10 to 13)",
        unit="",
        how=(
            "f·Re = 2 D_eff² (−dp/dx) / (mu U_b): dp/dx the least-squares slope of the centreline "
            "pressure from Plot over path (0,0,0) to (0.3,0,0) m, 300 subdivisions, over x/D 10 to 13; "
            "U_b = Q / A and D_eff = sqrt(4 A / pi), Q the flow through the inlet and A the pipe's meshed "
            "cross-section, the mean of the inlet's and the outlet's mesh areas (all three from the run's "
            "monitors), since a meshed circle's area is not exactly pi D²/4"
        ),
        source="route:/api/plot-over-path",
        reference=Reference(
            value=64.0,
            unit="",
            kind="exact",
            confidence="CONFIRMED",
            citation=_HP,
            where="Darcy f = 64/Re (f = 0.640 at Re 100), i.e. -dp/dx = 32 mu U / D² = 16 Pa/m here",
            conditions=_HP_CONDITIONS,
        ),
        tolerance=Tolerance(rel_pct=2.0, note="the answer is exact, so only mesh error remains"),
    ),
    "ucl": QuantitySpec(
        key="ucl",
        label="Centreline speed / bulk speed, developed part (x/D 10 to 13)",
        unit="",
        how=(
            "the centre value u_c of a least-squares fit U_x = u_c + b r² (the developed profile's own form) "
            "to the cell values, not interpolated, of every cell whose centre lies in x/D 10 to 13 within "
            "R/2 of the axis, read from the run's saved U by the app's own volume loader "
            "(case_volume.load_volume, the code behind Plot over path), over U_b = Q / A (as for f·Re)"
        ),
        source="app_sampling (cell values)",
        reference=Reference(
            value=2.0,
            unit="",
            kind="exact",
            confidence="CONFIRMED",
            citation=_HP,
            where="u(r) = 2 U (1 - (r/R)²), so u_c = 2.000 U",
            conditions=_HP_CONDITIONS,
        ),
        tolerance=Tolerance(rel_pct=1.5),
    ),
    "le": QuantitySpec(
        key="le",
        label="Development length L_e / D (to 99 % of the developed centreline speed)",
        unit="",
        how=(
            "the first x where the centreline speed from Plot over path (0,0,0) to (0.3,0,0) m, 300 "
            "subdivisions, reaches 99 % of the same line's developed value (its mean over x/D 10 to 13), "
            "linearly interpolated between samples, over D_eff"
        ),
        source="route:/api/plot-over-path",
        reference=Reference(
            value=round((0.619**1.6 + (0.0567 * RE) ** 1.6) ** (1 / 1.6), 2),
            unit="",
            kind="correlation",
            confidence="SECONDARY",
            citation=(
                "F. Durst, S. Ray, B. Ünsal, O. A. Bayoumi (2005), \"The development lengths of laminar "
                "pipe and channel flows\", J. Fluids Eng. 127:1154-1160"
            ),
            where=(
                "the pipe correlation L/D = [0.619^1.6 + (0.0567 Re)^1.6]^(1/1.6) (constants as quoted from "
                "the abstract by citing papers; error under 3 % for all laminar Re), 5.77 at Re 100"
            ),
            conditions="laminar, uniform inlet; the distance to 99 % of the developed centreline velocity; Re = 100",
            note="Depends on the 99 % definition and on the inlet profile; the 0.05 Re rule (5.0) is about 13 % short.",
        ),
        tolerance=Tolerance(rel_pct=15.0),
    ),
}

# How this case reads its numbers, for the report.
NOTES = (
    "Where the design and the reference data differ, the reference data win: the bands are ±2 % on f·Re and "
    "±1.5 % on U_cl/U_b on both meshers (the design proposed ±2 % / ±5 % and ±2 % / ±3 %), and the developed "
    "part read is x/D 10 to 13 (the design's 8 to 13: the reference data ask for stations more than about 10 D "
    "from a uniform inlet).",
    "The bulk speed and D_eff use the pipe's cross-section as meshed (the mean of the inlet's and the outlet's "
    "mesh areas, from the run's monitors), not pi D²/4: f·Re goes as the area squared.",
    "The compared centreline speed comes from the cell values themselves (a fit of U_x = u_c + b r² over the "
    "window's cells within R/2 of the axis). Plot over path samples the field averaged to the mesh's points, "
    "which reads a peak low where the cells are coarse, and on a mesh whose axis runs along cell edges no cell "
    "centre lies on the axis at all; what the line reads on the axis is shown beside the fit, with the profile's "
    "RMS difference from the exact parabola at the cells' own radii.",
    "The centreline Point probes take the value of the cell that holds each point. Where the axis runs along cell "
    "edges (Hex-dominant) that is one of the off-axis cells around it, the same cells the fit uses, so the probes "
    "are shown, not used as an independent check.",
    "The development length is read on Plot over path's centreline, against the same line's developed value, so "
    "the line's averaging enters both nearly alike. The 99 % point lies where the centreline speed is nearly flat: "
    "a change in the fourth digit of the solution moves it by millimetres, and repeated runs of the same plan can "
    "read a few per cent apart. Its band is wide (±15 %) for that reason and for the 99 % definition.",
    "On Standard the friction factor reads well above the exact value. The wall shear stress the run itself saved "
    "(shown with each run) carries the same excess, and the cell values run faster than the parabola near the "
    "wall and slower at mid-radius, so the pressure drop is the solution's, not an artefact of reading it. The "
    "cause in Standard's mesh is under investigation (an app gap), and the turbulent pipe's Standard runs wait "
    "for it.",
)

# A steady run that stops at its iteration limit counts as settled only when these histories
# (the run's monitors) moved less than SETTLE_DRIFT over its last 10 % of iterations.
SETTLE = (
    {"monitor": "mon_inlet", "sample": "p_Pa", "label": "the inlet's area-averaged pressure"},
    {"monitor": "probes_centreline_12", "sample": "U", "component": 0, "label": "U_x at the centreline probe at x = 12 D"},
)
SETTLE_DRIFT = 1e-3


def build_geometry() -> Any:
    from ..geometry import pipe

    return pipe(D_MM, L_MM)


def requests(variant: str, *, coarse: bool = False, cores: int = 4) -> dict[str, Any]:
    """What the driver sends, faces as selectors (``@inlet``); plan.make_plan resolves them."""
    hexd = variant == "hexdominant"
    fineness = 6 - (2 if coarse else 0)
    end_time = 3000 // (4 if coarse else 1)
    mesh_settings: dict[str, Any] = {
        "fineness": fineness,
        # Hex-dominant: the layers are asked explicitly (below); Standard sizes its own.
        "automatic_boundary_layers": not hexd,
        "physics_based_meshing": True,
        "hex_element_core": True,
        "advanced": {"mesh_engine": MESH_ENGINE[variant]},
    }
    refinements = (
        [{"name": "Wall layers", "type": "Inflate boundary layer", "faces": ["@wall"], "n_layers": 4,
          "total_thickness": 1.0, "total_thickness_unit": "mm"}]
        if hexd
        else []
    )
    probe = {
        "id": "rc-centreline",
        "name": "Centreline",
        "monitor_type": "probe",
        "kind": "Point probe",
        "category": "Point data",
        "write_control": "Time step",
        "faces": [],
        "results": None,
        "series": None,
        "chart_values": None,
        "results_available": False,
        "points": [[round(x * D, 6), 0.0, 0.0] for x in PROBE_X_D],
    }
    return {
        "project": {"title": f"Validation {ID} {variant}", "description": "", "category": "Other",
                    "units": "Metric", "folder": "My Projects"},
        "study": {
            "analysis_type": "incompressible_steady",
            "time_dependency": "Steady-state",
            "name": f"{ID} {variant}",
            "settings": {
                "turbulence_model": "laminar",
                "numerics_preset": "accurate",
                "residual_u": 1e-6,
                "residual_p": 1e-6,
                "n_non_orthogonal": 1 if hexd else 2,
            },
        },
        "material": {"preset": "custom", "name": "Validation fluid", "kinematic_viscosity": NU, "density": RHO,
                     "assigned_volumes": ["Body1"]},
        "bcs": [
            {"name": "Inlet", "bc_type": "Velocity inlet", "velocity_type": "Fixed", "value": U, "unit": "m/s",
             "direction": "Normal to face", "faces": ["@inlet"]},
            {"name": "Outlet", "bc_type": "Pressure", "pressure_type": "Fixed value", "value": 0, "unit": "Pa",
             "faces": ["@outlet"]},
            # A new face-by-face Wall starts Slip: the treatment is always sent.
            {"name": "Pipe wall", "bc_type": "Wall", "wall_type": "No-slip", "faces": ["@wall"]},
        ],
        "mesh": {
            "name": "Mesh 1",
            "settings": mesh_settings,
            "refinements": refinements,
            "expect": {"layers": True, "n_cells": [20_000, 400_000] if not coarse else [2_000, 200_000]},
        },
        "run": {"name": "Validation", "endTime": end_time, "writeInterval": end_time, "cores": int(cores),
                "result_controls": [probe]},
        "extract": [
            # Read from the run's case folder by the harness (sampling.py), where no route gives them.
            {"key": "cells_window", "kind": "cells", "fields": ["U"], "box_m": _WINDOW_BOX},
            {"key": "wall_shear", "kind": "patch", "patch": WALL_PATCH, "field": "wallShearStress", "box_m": _WINDOW_BOX},
            {"key": "p_axis", "kind": "line", "field": "p", "points_m": [[0.0, 0.0, 0.0], [L, 0.0, 0.0]],
             "subdivisions": 300},
            {"key": "u_axis", "kind": "line", "field": "U", "points_m": [[0.0, 0.0, 0.0], [L, 0.0, 0.0]],
             "subdivisions": 300},
            {"key": "u_radial", "kind": "line", "field": "U",
             "points_m": [[PROFILE_AT_D * D, -D / 2, 0.0], [PROFILE_AT_D * D, D / 2, 0.0]], "subdivisions": 100},
        ],
        "flow_patch": "inlet",
        "timeouts_s": {"mesh": 1800, "solve": 5400},
    }


# ---------------------------------------------------------------------------------------- evaluate

def _line_xy(line: dict[str, Any], axis: int) -> tuple[list[float], list[float]]:
    pts = line.get("sample_points") or []
    vals = line.get("values") or []
    n = min(len(pts), len(vals))
    return [float(pts[i][axis]) for i in range(n)], [float(vals[i]) for i in range(n)]


def evaluate(plan: dict[str, Any], raw: Any) -> dict[str, Any]:
    """The compared quantities, the series for the figures, the values shown beside them and
    the warnings, from the run's route answers (``raw``: evaluate.Raw)."""
    warnings: list[str] = []
    shown: dict[str, Any] = {}
    series: dict[str, Any] = {}
    rows: list[dict[str, Any]] = []

    # The pipe's cross-section as meshed: the mean of the inlet's and the outlet's mesh areas
    # (the monitors' own areas; a meshed circle's area is not pi D²/4), half their difference
    # its uncertainty. U_b = Q / A by continuity, Q the flow through the inlet.
    q_in = raw.patch_flow("inlet")
    a_in, a_out = raw.patch_area("inlet"), raw.patch_area("outlet")
    area_unc_pct = 0.0
    if q_in and a_in and a_out:
        area = 0.5 * (a_in + a_out)
        area_unc_pct = 100.0 * abs(a_in - a_out) / 2.0 / area
        ub = q_in / area
        d_eff = math.sqrt(4.0 * area / math.pi)
        nominal = math.pi * D * D / 4
        shown.update({
            "inlet_flow_m3_s": q_in,
            "inlet_area_mm2": a_in * 1e6,
            "outlet_area_mm2": a_out * 1e6,
            "area_mm2": area * 1e6,
            "area_vs_nominal_pct": 100.0 * (area / nominal - 1.0),
            "area_unc_pct": area_unc_pct,
            "ub_m_s": ub,
            "d_eff_mm": d_eff * 1000.0,
        })
    else:
        ub, d_eff = U, D
        warnings.append("no inlet flow or patch areas from the monitors: D and U_b are the nominal 20 mm and 1 m/s")
    shown["re_eff"] = ub * d_eff / NU
    p_in = raw.patch_pressure("inlet")
    if p_in is not None:
        shown["inlet_p_Pa"] = p_in
    bal = raw.flow_balance()
    if bal and bal.get("in_m3s"):
        shown["imbalance_pct"] = 100.0 * bal.get("imbalance", 0.0) / bal["in_m3s"]

    p_line = raw.line("p_axis")
    u_line = raw.line("u_axis")
    lo, hi = FIT_FROM_D * D, FIT_TO_D * D
    f_re = ucl = le = None
    fit_detail = ucl_detail = le_detail = ""
    if p_line and p_line.get("n_valid"):
        x, p = _line_xy(p_line, 0)
        ds = downsample(x, p)
        series["p_axis"] = {"x_m": ds["x"], "p_Pa": ds["y"]}
        try:
            xb, pb = band(x, p, lo, hi)
            fit = linear_fit(xb, pb)
            grad = -fit["slope"]
            f_re = 2.0 * d_eff**2 * grad / (NU * RHO * ub)
            se_pct = 100.0 * fit["slope_se"] / abs(fit["slope"]) if fit["slope"] else float("nan")
            shown["dpdx_Pa_m"] = grad
            shown["dpdx_exact_nominal_Pa_m"] = 32 * NU * RHO * U / D**2
            shown["dpdx_vs_nominal_pct"] = 100.0 * (grad / shown["dpdx_exact_nominal_Pa_m"] - 1.0)
            shown["fit"] = {"slope": fit["slope"], "intercept": fit["intercept"], "slope_se": fit["slope_se"],
                            "r2": fit["r2"], "n": int(fit["n"]), "x_from_m": lo, "x_to_m": hi}
            shown["f_darcy"] = f_re / shown["re_eff"]
            # f·Re goes as A²: the area's uncertainty counts twice, beside the fit's.
            shown["fre_unc_pct"] = math.hypot(se_pct, 2.0 * area_unc_pct)
            fit_detail = (f"-dp/dx {grad:.4f} Pa/m from {int(fit['n'])} samples (slope standard error "
                          f"{se_pct:.2f} %, r² {fit['r2']:.6f}); D_eff {d_eff * 1000:.3f} mm, U_b {ub:.4f} m/s")
        except ValueError as e:
            warnings.append(f"pressure fit: {e}")
    else:
        warnings.append(f"no centreline pressure: {(p_line or {}).get('reason') or 'no answer'}")
    if u_line and u_line.get("n_valid"):
        x, u = _line_xy(u_line, 0)
        ds = downsample(x, u)
        series["u_axis"] = {"x_m": ds["x"], "U_m_s": ds["y"]}
        try:
            w = window_mean(x, u, lo, hi)
            # What the line tool reads on the axis: shown beside the compared cell-value fit.
            shown["ucl_line_over_ub"] = w["mean"] / ub
            shown["ucl_line_min_max"] = [w["min"] / ub, w["max"] / ub]
            developed = w["mean"]
            x99 = first_crossing(x, u, 0.99 * developed)
            if x99 is not None:
                le = x99 / d_eff
                le_detail = f"99 % of {developed:.4f} m/s reached at x = {x99 * 1000:.1f} mm"
                shown["le_x_m"] = x99
            else:
                warnings.append("the centreline speed never reached 99 % of its developed value")
        except ValueError as e:
            warnings.append(f"centreline speed: {e}")
    else:
        warnings.append(f"no centreline speed: {(u_line or {}).get('reason') or 'no answer'}")

    # The compared centreline speed, from the window's cell values (no interpolation).
    r_eff = d_eff / 2
    cells = raw.sample("cells_window")
    if cells and cells.get("n"):
        cx = np.asarray(cells["x"], dtype=float)
        cr = np.hypot(np.asarray(cells["y"], dtype=float), np.asarray(cells["z"], dtype=float))
        cu = np.asarray(cells["U_x"], dtype=float)
        in_win = (cx >= lo - 1e-9) & (cx <= hi + 1e-9)
        core = in_win & (cr <= r_eff / 2)
        try:
            fit_c = radial_fit(cr[core], cu[core])
            ucl = fit_c["centre"] / ub
            r_min = float(cr[in_win].min())
            nearest = in_win & (cr <= r_min + 1e-6)
            u_near = float(cu[nearest].mean())
            shown["ucl_cells"] = {"centre_m_s": fit_c["centre"], "centre_se_m_s": fit_c["centre_se"],
                                  "curvature": fit_c["curvature"], "curvature_exact": -2.0 * ub / r_eff**2,
                                  "n": int(fit_c["n"]), "r_max_m": r_eff / 2,
                                  "nearest_r_m": r_min, "nearest_u_m_s": u_near,
                                  "nearest_exact_m_s": 2.0 * ub * (1.0 - (r_min / r_eff) ** 2)}
            ucl_detail = (f"u_c {fit_c['centre']:.4f} m/s (standard error {fit_c['centre_se']:.4f}) from "
                          f"{int(fit_c['n'])} cells within {r_eff / 2 * 1000:.2f} mm of the axis, over U_b "
                          f"{ub:.4f} m/s; the cells nearest the axis (r = {r_min * 1000:.3f} mm) read "
                          f"{u_near:.4f} m/s, the exact profile there {shown['ucl_cells']['nearest_exact_m_s']:.4f}")
        except ValueError as e:
            warnings.append(f"centreline cell fit: {e}")
        whole = in_win & (cr <= r_eff)
        if whole.any():
            diffs = cu[whole] - 2.0 * ub * (1.0 - (cr[whole] / r_eff) ** 2)
            shown["profile_rms_cells_over_ub"] = rms(diffs) / ub
            shown["profile_cells_n"] = int(whole.sum())
            # The window's cells at their radii (signed by y), a few hundred of them, for the figure.
            idx = np.flatnonzero(whole)
            idx = idx[:: max(1, idx.size // 600)]
            sign = np.where(np.asarray(cells["y"], dtype=float)[idx] < 0, -1.0, 1.0)
            series["cells_profile"] = {"r_m": [float(f"{v:.6g}") for v in (sign * cr[idx]).tolist()],
                                       "Ux_m_s": [float(f"{v:.6g}") for v in cu[idx].tolist()]}
    else:
        warnings.append(f"no cell values of the developed part: {raw.sample_problem('cells_window')}")

    # Shown, not compared: the wall shear stress the run saved, over the same window. In
    # developed flow it balances the pressure gradient: -dp/dx = 4 tau_w / D.
    ws = raw.sample("wall_shear")
    if ws and ws.get("n"):
        tx = np.asarray(ws["wallShearStress_x"], dtype=float)
        fa = np.asarray(ws["area"], dtype=float)
        # wallShearStress is kinematic in an incompressible run (m²/s²): times rho for Pa.
        tau = abs(float(np.sum(tx * fa) / np.sum(fa))) * RHO
        exact = 8.0 * NU * RHO * ub / d_eff
        shown["tau_w"] = {"Pa": tau, "exact_Pa": exact, "vs_exact_pct": 100.0 * (tau / exact - 1.0),
                          "dpdx_balanced_Pa_m": 4.0 * tau / d_eff, "n_faces": int(ws["n"]), "source": ws.get("source")}
    else:
        warnings.append(f"no wall shear stress of the developed part: {raw.sample_problem('wall_shear')}")

    rows.append(compare(QUANTITIES["fRe"], f_re, detail=fit_detail,
                        uncertainty=({"kind": "pct", "value": shown["fre_unc_pct"],
                                      "what": "the slope's standard error and twice the cross-section's"}
                                     if "fre_unc_pct" in shown else None)))
    rows.append(compare(QUANTITIES["ucl"], ucl, detail=ucl_detail))
    rows.append(compare(QUANTITIES["le"], le, detail=le_detail))

    # Shown, not compared: Plot over path's radial profile at x = 12 D against 2 U_b (1 - (r/R)²).
    r_line = raw.line("u_radial")
    if r_line and r_line.get("n_valid"):
        y, u = _line_xy(r_line, 1)
        prof = downsample(y, u)
        series["u_radial"] = {"y_m": prof["x"], "U_m_s": prof["y"]}
        diffs = [ui - 2 * ub * (1 - (yi / r_eff) ** 2) for yi, ui in zip(y, u, strict=True) if abs(yi) <= r_eff]
        if diffs:
            shown["profile_rms_line_over_ub"] = rms(diffs) / ub
    # The probes: the value of the cell holding each point (shown; on a mesh whose axis runs
    # along cell edges, one of the cells around it).
    probes = raw.probe_values("Centreline", component=0)
    if probes:
        series["probes"] = {"x_m": [p[0] for p in probes], "Ux_m_s": [p[1] for p in probes]}
        dev = [v for xp, v in probes if lo - 1e-9 <= xp <= hi + 1e-9]
        if dev:
            shown["probe_ucl_over_ub"] = sum(dev) / len(dev) / ub
    return {"quantities": rows, "series": series, "shown": shown, "warnings": warnings}


def setup_words(result: dict[str, Any]) -> str:
    """The case's setup in words, for the report (the same for every variant)."""
    return (
        f"A {GEOMETRY_WORDS} (STEP in mm, built with OCP); a custom fluid with nu = {NU:g} m²/s and "
        f"rho = {RHO:g} kg/m³, so Re = U D / nu = {RE:g}; a velocity inlet of {U:g} m/s normal to the face, "
        f"a 0 Pa pressure outlet and a no-slip wall; laminar, steady (simpleFoam), Accurate numerics, residual "
        f"targets 1e-6, at most 3000 iterations."
    )


def mesh_words(result: dict[str, Any]) -> str:
    """One variant's mesh settings in words."""
    v = result.get("variant")
    mesh = result.get("setup", {}).get("mesh", {})
    fine = (mesh.get("settings") or {}).get("fineness")
    lay = ("an Inflate boundary layer of 4 layers, 1 mm in all, on the wall (automatic boundary layers off)"
           if v == "hexdominant" else "its automatic boundary layers and hex core")
    n_orth = ((result.get("setup", {}).get("study") or {}).get("settings") or {}).get("n_non_orthogonal")
    return (f"{VARIANT_LABELS.get(str(v), v)} at fineness {fine} with {lay}; "
            f"{n_orth} non-orthogonal corrector{'s' if n_orth != 1 else ''}")


def _n(v: Any, digits: int = 4) -> str:
    from ..report import num

    return num(v, digits)


def shown_words(result: dict[str, Any]) -> list[str]:
    """The values shown beside the compared ones, in words (the report and the page)."""
    s = result.get("shown") or {}
    bits: list[str] = []
    if s.get("d_eff_mm") is not None:
        bits.append(f"the pipe's cross-section as meshed {_n(s['area_mm2'], 5)} mm² (inlet {_n(s['inlet_area_mm2'], 5)}, "
                    f"outlet {_n(s['outlet_area_mm2'], 5)}; {s['area_vs_nominal_pct']:+.2f} % against pi D²/4), "
                    f"so D_eff {_n(s['d_eff_mm'], 5)} mm and U_b {_n(s['ub_m_s'], 5)} m/s")
    if s.get("dpdx_Pa_m") is not None:
        bits.append(f"-dp/dx {_n(s['dpdx_Pa_m'], 5)} Pa/m ({s['dpdx_vs_nominal_pct']:+.2f} % against 32 mu U / D² = "
                    f"{_n(s['dpdx_exact_nominal_Pa_m'], 4)} Pa/m with the nominal D)")
    tw = s.get("tau_w") or {}
    if tw.get("Pa") is not None:
        bits.append(f"the wall shear stress the run saved, over x/D {FIT_FROM_D:g} to {FIT_TO_D:g}, {_n(tw['Pa'], 4)} Pa "
                    f"({tw['vs_exact_pct']:+.2f} % against 8 mu U_b / D_eff = {_n(tw['exact_Pa'], 4)} Pa), which balances "
                    f"-dp/dx = 4 tau_w / D_eff = {_n(tw['dpdx_balanced_Pa_m'], 5)} Pa/m")
    if s.get("inlet_p_Pa") is not None:
        bits.append(f"the inlet's area-averaged pressure {_n(s['inlet_p_Pa'], 4)} Pa (the outlet's 0 Pa)"
                    + (f", flow out against in {_n(s['imbalance_pct'], 2)} %" if s.get("imbalance_pct") is not None else ""))
    if s.get("f_darcy") is not None:
        bits.append(f"Darcy f {_n(s['f_darcy'], 4)} at Re_eff {_n(s['re_eff'], 5)}")
    if s.get("ucl_line_over_ub") is not None:
        bits.append(f"Plot over path's centreline over x/D {FIT_FROM_D:g} to {FIT_TO_D:g} {_n(s['ucl_line_over_ub'], 5)} U_b "
                    f"(the field averaged to the mesh's points)")
    if s.get("probe_ucl_over_ub") is not None:
        bits.append(f"the centreline probes' mean U_x over x/D {FIT_FROM_D:g} to {FIT_TO_D:g} {_n(s['probe_ucl_over_ub'], 5)} U_b "
                    f"(the cell holding each point)")
    if s.get("profile_rms_cells_over_ub") is not None:
        bits.append(f"the {s.get('profile_cells_n')} cells of x/D {FIT_FROM_D:g} to {FIT_TO_D:g} within an RMS "
                    f"{_n(s['profile_rms_cells_over_ub'], 3)} U_b of 2 U_b (1 - (r/R)²) at their own radii")
    if s.get("profile_rms_line_over_ub") is not None:
        bits.append(f"Plot over path's profile at x = {PROFILE_AT_D:g} D within an RMS {_n(s['profile_rms_line_over_ub'], 3)} U_b of it")
    return bits


# ---------------------------------------------------------------------------------------- figures

FIGURES = (
    ("pressure", "centreline pressure"),
    ("centreline", "centreline speed"),
    ("profile", f"velocity profile at x = {PROFILE_AT_D:g} D"),
    ("residuals", "residuals"),
)
_NEEDS = {"pressure": "p_axis", "centreline": "u_axis", "profile": "u_radial", "residuals": "residuals"}


def has_figure(kind: str, result: dict[str, Any]) -> bool:
    return _NEEDS[kind] in (result.get("series") or {})


def _q(result: dict[str, Any], key: str) -> dict[str, Any]:
    return next((q for q in result.get("quantities") or [] if q["key"] == key), {})


def _err_text(q: dict[str, Any], name: str) -> str:
    if q.get("value") is None:
        return f"{name}: no value"
    return (f"{name} {q['value']:.4g} (reference {q['reference']['value']:g}, "
            f"{q['error']['rel_pct']:+.2f} %)")


def draw(kind: str, result: dict[str, Any], ax: Any) -> None:
    """One figure of a case 1 result on ``ax`` (plots.render styles and saves it)."""
    from ..plots import INK, SECOND, SERIES, note

    s = result["series"]
    shown = result.get("shown") or {}
    d_eff = (shown.get("d_eff_mm") or D * 1000.0) / 1000.0
    if kind == "pressure":
        x = [v / D for v in s["p_axis"]["x_m"]]
        ax.plot(x, s["p_axis"]["p_Pa"], color=SERIES, linewidth=1.6, label="Magnusim (Plot over path)")
        fit = shown.get("fit")
        if fit:
            # The exact gradient for the run's own U_b and D_eff, through the fit's middle.
            xs = [6.0, L / D]
            mid = 0.5 * (FIT_FROM_D + FIT_TO_D) * D
            p_mid = fit["slope"] * mid + fit["intercept"]
            exact = 32 * NU * RHO * (shown.get("ub_m_s") or U) / d_eff**2
            ax.plot(xs, [p_mid + exact * (mid - xx * D) for xx in xs], color=INK, linestyle="--", linewidth=1.2,
                    label="Hagen-Poiseuille gradient (U_b, D_eff)")
            ax.axvspan(FIT_FROM_D, FIT_TO_D, color=SERIES, alpha=0.08, linewidth=0, label="fit window")
        ax.set_xlabel("x / D")
        ax.set_ylabel("p (Pa, = kinematic, rho = 1)")
        ax.legend(loc="upper right")
        note(ax, _err_text(_q(result, "fRe"), "f·Re"))
    elif kind == "centreline":
        ub = shown.get("ub_m_s") or U
        x = [v / D for v in s["u_axis"]["x_m"]]
        ax.plot(x, [v / ub for v in s["u_axis"]["U_m_s"]], color=SERIES, linewidth=1.6, label="Magnusim (Plot over path)")
        if "probes" in s:
            ax.plot([v / D for v in s["probes"]["x_m"]], [v / ub for v in s["probes"]["Ux_m_s"]], linestyle="none",
                    marker="o", markersize=5, color=SECOND, label="Point probes (the cell holding each point)")
        cfit = _q(result, "ucl")
        if cfit.get("value") is not None:
            ax.plot([FIT_FROM_D, FIT_TO_D], [cfit["value"]] * 2, color=SECOND, linewidth=3.0, solid_capstyle="butt",
                    label="cell-value fit on the axis (compared)")
        ax.axhline(2.0, color=INK, linestyle="--", linewidth=1.2, label="Hagen-Poiseuille, 2 U_b")
        le_ref = QUANTITIES["le"].reference.value
        ax.axvline(le_ref, color=INK, linestyle=":", linewidth=1.2, label=f"Durst et al. L_e = {le_ref:g} D")
        if shown.get("le_x_m"):
            ax.axvline(shown["le_x_m"] / d_eff, color=SERIES, linestyle=":", linewidth=1.2, label="99 % reached (Magnusim)")
        ax.set_xlabel("x / D")
        ax.set_ylabel("U_cl / U_b")
        ax.set_ylim(0.9, 2.15)
        ax.legend(loc="center right")
        note(ax, _err_text(_q(result, "ucl"), "U_cl/U_b") + "\n" + _err_text(_q(result, "le"), "L_e/D"))
    elif kind == "profile":
        r_eff = d_eff / 2
        y = s["u_radial"]["y_m"]
        if "cells_profile" in s:
            ax.plot([v / r_eff for v in s["cells_profile"]["r_m"]], s["cells_profile"]["Ux_m_s"], linestyle="none",
                    marker=".", markersize=3, color=SECOND, alpha=0.6,
                    label=f"cell values, x/D {FIT_FROM_D:g} to {FIT_TO_D:g} (at ±r)")
        ax.plot([v / r_eff for v in y], s["u_radial"]["U_m_s"], color=SERIES, linewidth=1.6, label="Magnusim (Plot over path)")
        rr = [i / 50 - 1 for i in range(101)]
        ub = shown.get("ub_m_s") or U
        ax.plot(rr, [2 * ub * (1 - r * r) for r in rr], color=INK, linestyle="--", linewidth=1.2, label="2 U_b (1 - (r/R)²)")
        ax.set_xlabel("r / R (the line along y at z = 0; cells at ±r by the sign of y)")
        ax.set_ylabel("U (m/s)")
        ax.legend(loc="lower center")
        bits = []
        if shown.get("profile_rms_cells_over_ub") is not None:
            bits.append(f"cells: RMS difference {shown['profile_rms_cells_over_ub']:.4f} U_b")
        if shown.get("profile_rms_line_over_ub") is not None:
            bits.append(f"line: RMS difference {shown['profile_rms_line_over_ub']:.4f} U_b")
        if bits:
            note(ax, "; ".join(bits))
    elif kind == "residuals":
        h = s["residuals"]
        for i, key in enumerate(k for k in h if k != "t"):
            ax.semilogy(h["t"], h[key], color=(SERIES, SECOND, INK)[i % 3], linewidth=1.4, label=f"{key} (initial residual)")
        ax.axhline(1e-6, color=INK, linestyle=":", linewidth=1.0, label="target 1e-6")
        ax.set_xlabel("iteration")
        ax.set_ylabel("residual")
        ax.legend(loc="upper right")
