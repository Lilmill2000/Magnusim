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

from ..extract import band, downsample, first_crossing, linear_fit, rms, window_mean
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
# Centreline probes at x/D = 1, 2, ..., 14 (Point probe, the cross-check of the line).
PROBE_X_D = tuple(float(i) for i in range(1, 15))

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
            "mean of the centreline speed |U| (= U_x on the axis) from Plot over path (0,0,0) to "
            "(0.3,0,0) m, 300 subdivisions, over x/D 10 to 13, over U_b = Q / A (as for f·Re)"
        ),
        source="route:/api/plot-over-path",
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
            "the first x where the centreline speed from Plot over path reaches 99 % of its own "
            "developed value (its mean over x/D 10 to 13), linearly interpolated between samples, over D_eff"
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
    "Plot over path samples the field interpolated to the mesh's points (each point the average of its cells), "
    "which reads a peak low where the cells are coarse. The centreline Point probes (the containing cell's own "
    "value) are shown beside it as the cross-check.",
)


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
            ucl = w["mean"] / ub
            ucl_detail = (f"centreline {w['mean']:.4f} m/s (from {w['min']:.4f} to {w['max']:.4f} over "
                          f"{int(w['n'])} samples) over U_b {ub:.4f} m/s")
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

    rows.append(compare(QUANTITIES["fRe"], f_re, detail=fit_detail,
                        uncertainty=({"kind": "pct", "value": shown["fre_unc_pct"],
                                      "what": "the slope's standard error and twice the cross-section's"}
                                     if "fre_unc_pct" in shown else None)))
    rows.append(compare(QUANTITIES["ucl"], ucl, detail=ucl_detail))
    rows.append(compare(QUANTITIES["le"], le, detail=le_detail))

    # Shown, not compared: the radial profile at x = 12 D against 2 U_b (1 - (r/R)²).
    r_line = raw.line("u_radial")
    if r_line and r_line.get("n_valid"):
        y, u = _line_xy(r_line, 1)
        prof = downsample(y, u)
        series["u_radial"] = {"y_m": prof["x"], "U_m_s": prof["y"]}
        r_eff = d_eff / 2
        diffs = [ui - 2 * ub * (1 - (yi / r_eff) ** 2) for yi, ui in zip(y, u, strict=True) if abs(yi) <= r_eff]
        if diffs:
            shown["profile_rms_over_ub"] = rms(diffs) / ub
    # The probes (cell values: the containing cell's, no interpolation), cross-check only.
    probes = raw.probe_values("Centreline", component=0)
    if probes:
        series["probes"] = {"x_m": [p[0] for p in probes], "Ux_m_s": [p[1] for p in probes]}
        dev = [v for xp, v in probes if lo - 1e-9 <= xp <= hi + 1e-9]
        if dev:
            shown["probe_ucl_over_ub"] = sum(dev) / len(dev) / ub
    return {"quantities": rows, "series": series, "shown": shown, "warnings": warnings}


def setup_words(result: dict[str, Any]) -> str:
    """The setup in words, for the report."""
    v = result.get("variant")
    mesh = result.get("setup", {}).get("mesh", {})
    fine = (mesh.get("settings") or {}).get("fineness")
    lay = ("an Inflate boundary layer of 4 layers, 1 mm in all, on the wall" if v == "hexdominant"
           else "the mesher's automatic boundary layers and hex core")
    return (
        f"A {GEOMETRY_WORDS} (STEP in mm, built with OCP); a custom fluid with nu = {NU:g} m²/s and "
        f"rho = {RHO:g} kg/m³, so Re = U D / nu = {RE:g}; a velocity inlet of {U:g} m/s normal to the face, "
        f"a 0 Pa pressure outlet and a no-slip wall; laminar, steady (simpleFoam), Accurate numerics, residual "
        f"targets 1e-6; {VARIANT_LABELS.get(str(v), v)} mesh at fineness {fine} with {lay}."
    )


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
                    marker="o", markersize=5, color=SECOND, label="Point probes (cell values)")
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
        ax.plot([v / r_eff for v in y], s["u_radial"]["U_m_s"], color=SERIES, linewidth=1.6, label="Magnusim (Plot over path)")
        rr = [i / 50 - 1 for i in range(101)]
        ub = shown.get("ub_m_s") or U
        ax.plot(rr, [2 * ub * (1 - r * r) for r in rr], color=INK, linestyle="--", linewidth=1.2, label="2 U_b (1 - (r/R)²)")
        ax.set_xlabel("r / R (along y, z = 0)")
        ax.set_ylabel("U (m/s)")
        ax.legend(loc="lower center")
        if shown.get("profile_rms_over_ub") is not None:
            note(ax, f"RMS difference {shown['profile_rms_over_ub']:.4f} U_b")
    elif kind == "residuals":
        h = s["residuals"]
        for i, key in enumerate(k for k in h if k != "t"):
            ax.semilogy(h["t"], h[key], color=(SERIES, SECOND, INK)[i % 3], linewidth=1.4, label=f"{key} (initial residual)")
        ax.axhline(1e-6, color=INK, linestyle=":", linewidth=1.0, label="target 1e-6")
        ax.set_xlabel("iteration")
        ax.set_ylabel("residual")
        ax.legend(loc="upper right")
