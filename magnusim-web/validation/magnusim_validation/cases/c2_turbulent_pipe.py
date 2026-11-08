"""Case 2: turbulent flow in a smooth circular pipe, Re = 50 000 (3D), k-omega SST and
k-epsilon with wall functions, on Hex-dominant and on Standard.

A 20 mm pipe 600 mm (30 D) long, a uniform velocity inlet of 1 m/s (its turbulence Auto: 5 %,
0.07 D), a 0 Pa outlet and a no-slip wall; a custom fluid with nu = 4e-7 m²/s and rho = 1 kg/m³,
so Re = U D / nu = 50 000. The reference data ask for the friction at least 40 D from the inlet,
or with a cyclic or mapped inlet; this case meets neither (the app has no cyclic inlet, gap G9,
and the pipe is 30 D, the length its bands were locked on: when the case was built Hex-dominant
could not mesh one much longer cleanly, ``NOTES``). The
friction factor is read over x/D 20 to 25, 5 D clear of the outlet; its slope over x/D 15 to 20
is shown beside it, and a run whose two differ by more than ``DEVELOPING_PCT`` carries a
warning: its flow is still developing where f is read, so f is not yet its developed value (above
or below it: with the Auto inlet the probes of 2026-11-06 read it below).

Each mesher's mesh is made once: the k-epsilon run solves on the k-omega SST run's mesh (the
same geometry, fluid, BCs and mesh; only the study's turbulence model and the run differ).
"""

from __future__ import annotations

import math
from dataclasses import replace
from typing import Any

import numpy as np

from ..extract import band, downsample, linear_fit, window_mean
from ..model import QuantitySpec, Reference, Tolerance, compare
from .c1_laminar_pipe import _line_xy, standard_mesh_words

ID = "c2_turbulent_pipe"
TITLE = "Turbulent pipe, Re = 50 000"
GROUP = "Internal flow"
VARIANTS = ("hexdominant_sst", "hexdominant_kepsilon", "standard_sst", "standard_kepsilon")
VARIANT_LABELS = {
    "hexdominant_sst": "Hex-dominant, k-omega SST",
    "hexdominant_kepsilon": "Hex-dominant, k-epsilon",
    "standard_sst": "Standard, k-omega SST",
    "standard_kepsilon": "Standard, k-epsilon",
}
MESHER = {v: v.split("_", 1)[0] for v in VARIANTS}
MODEL = {v: "kOmegaSST" if v.endswith("_sst") else "kEpsilon" for v in VARIANTS}
MODEL_WORDS = {"kOmegaSST": "k-omega SST", "kEpsilon": "k-epsilon"}
MESH_ENGINE = {"hexdominant": "snappy_hexdominant", "standard": "standard"}
# The k-epsilon run solves on the k-omega SST run's mesh (plan.py: mesh_from; the driver).
MESH_FROM = {"hexdominant_kepsilon": "hexdominant_sst", "standard_kepsilon": "standard_sst"}

D_MM = 20.0
L_MM = 600.0
D = D_MM / 1000.0
L = L_MM / 1000.0
U = 1.0
NU = 4.0e-7
RHO = 1.0
RE = U * D / NU
FIT_FROM_D, FIT_TO_D = 20.0, 25.0
# The stretch before it: a developed flow reads the same slope on both. Two that differ by
# more than DEVELOPING_PCT give the run a warning (still developing where f is read).
EARLY_FROM_D, EARLY_TO_D = 15.0, 20.0
DEVELOPING_PCT = 1.0
PROBE_X_D = tuple(float(x) for x in range(5, 30, 5))
_WINDOW_BOX = [[FIT_FROM_D * D, -0.6 * D, -0.6 * D], [FIT_TO_D * D, 0.6 * D, 0.6 * D]]
WALL_PATCH = "pipe_wall"
FINENESS = 6
# Hex-dominant's wall layer: one of 0.6 mm, so the first cell's centre lies near y+ 35 for the
# wall functions (y+ = 2570 y / D at f = 0.0211). Two layers of 1.2 mm in all (the design's
# kind of stack) came out as about one on the mesh probe (0.96 of 2), one of 0.6 mm as 0.91 of 1.
LAYERS = {"n_layers": 1, "total_thickness": 0.6}
END_TIME = 2500

GEOMETRY_WORDS = f"pipe, D = {D_MM:g} mm, L = {L_MM:g} mm ({L_MM / D_MM:g} D) along +x from x = 0"
FACE_SELECTORS: dict[str, dict[str, Any]] = {
    "inlet": {"plane": {"axis": "x", "at_mm": 0.0, "sign": -1}},
    "outlet": {"plane": {"axis": "x", "at_mm": L_MM, "sign": 1}},
    "wall": {"rest": True, "count": 1},
}

_MCKEON = (
    "B. J. McKeon, M. V. Zagarola, A. J. Smits (2005), \"A new friction factor relationship for fully developed "
    "pipe flow\", J. Fluid Mech. 538:429-443"
)
_REF = Reference(
    value=0.0211,
    unit="",
    kind="correlation",
    confidence="CONFIRMED",
    citation=_MCKEON,
    where=(
        "eq. (3.5), p. 441: 1/sqrt f = 1.920 log10(Re sqrt f) - 0.475 - 7.04/(Re sqrt f)^0.55, within 1.4 % of the "
        "Princeton Superpipe data and within 2.0 % of Blasius for 10e3 < Re <= 90e3; 0.02109 at Re 5e4"
    ),
    conditions="fully developed flow in a hydraulically smooth pipe; Darcy f = (dp/L) D / (rho U_b² / 2); Re = U_b D / nu = 50 000",
    note=(
        "Blasius (1913), f = 0.3164 Re^-0.25 (as given in McKeon et al. 2005 eq. 1.3), gives 0.02116; Colebrook (1939), "
        "J. ICE 11(4):133-156, smooth, 0.02089 (as reproduced in standard texts); the correlations span 0.0207 to "
        "0.0212, and the data scatter about ±1.5 %."
    ),
)
_BAND = Tolerance(locked=True, rel_pct=10.0,
                  note="the reference data's band for RANS with wall functions (an engineering judgement)")
# The variants whose values stay report-only although the tolerances were locked (2026-11-07,
# after Daniel reviewed the second full run of the whole set), with why: they are compared and
# shown with the same band, and give no pass or fail until the limit is fixed (validation/README.md,
# "k-omega SST on Standard's tetrahedra"). Taking a variant out of here locks its band.
REPORT_ONLY = {"standard_sst": "known limit of k-omega SST on Standard's tetrahedra"}


def _band(variant: str | None) -> Tolerance:
    why = REPORT_ONLY.get(variant or "", "")
    return replace(_BAND, locked=False, report_only=why) if why else _BAND


def _specs(variant: str | None = None) -> dict[str, QuantitySpec]:
    band = _band(variant)
    return {
        "f": QuantitySpec(
            key="f",
            label=f"Darcy friction factor from the pressure drop, x/D {FIT_FROM_D:g} to {FIT_TO_D:g}",
            unit="",
            how=(
                f"f = (−dp/dx) D_eff / (rho U_b² / 2): dp/dx the least-squares slope of the centreline pressure from "
                f"Plot over path (0,0,0) to ({L:g},0,0) m, 300 subdivisions, over x/D {FIT_FROM_D:g} to {FIT_TO_D:g}; "
                "U_b = Q / A and D_eff = sqrt(4 A / pi), Q the flow through the inlet and A the pipe's meshed "
                "cross-section, the mean of the inlet's and the outlet's mesh areas (all three from the run's monitors)"
            ),
            source="route:/api/plot-over-path",
            reference=_REF,
            tolerance=band,
        ),
        "f_tau": QuantitySpec(
            key="f_tau",
            label=f"Darcy friction factor from the wall shear stress, x/D {FIT_FROM_D:g} to {FIT_TO_D:g}",
            unit="",
            how=(
                "f_tau = 8 tau_w / (rho U_b²): tau_w the area-weighted mean of the axial wall shear stress the run "
                f"saved (wallShearStress, kinematic, times rho) on the wall's faces between x/D {FIT_FROM_D:g} and "
                f"{FIT_TO_D:g}; U_b as for f"
            ),
            source="case_file:<latest>/wallShearStress",
            reference=_REF,
            tolerance=band,
        ),
    }


# The case's quantities (the report lists their references); each variant's own bands: quantities().
QUANTITIES = _specs()
_BY_VARIANT = {v: _specs(v) for v in VARIANTS}


def quantities(variant: str) -> list[QuantitySpec]:
    return list(_BY_VARIANT[variant].values())

# k-epsilon's walls (nutkWallFunction) switch to the log law at y+ 11.53; on the clean developed
# wedge of 2026-11-06 they read f +4.8 % at y+ 10.2 and -4.8 % at y+ 11.6 (4.2 to 4.9 % low from
# there to y+ 100: validation/README.md, "k-omega SST at the wall").
KE_SWITCH_YPLUS = 11.53
KE_WEDGE_ABOVE_PCT = -4.8


def _note_standard_kepsilon(by: dict[str, dict[str, Any]]) -> str | None:
    """Standard k-epsilon's error read against its walls' own error at the reported run's y+: an
    error near 0 there is most likely errors that cancel (the probes, 2026-11-06), not the best
    variant. None without that run or its y+."""
    res = by.get("standard_kepsilon") or {}
    yp = (res.get("shown") or {}).get("y_plus") or {}
    errs: list[tuple[float, str]] = []
    for k in ("f", "f_tau"):
        e = (_q(res, k).get("error") or {}).get("rel_pct")
        if isinstance(e, (int, float)):
            errs.append((float(e), k))
    if not yp or len(errs) != 2:
        return None
    lo, hi, mean = float(yp["min"]), float(yp["max"]), float(yp["mean"])
    switch = f"its wall function's switch at y+ {KE_SWITCH_YPLUS:g}"
    if lo >= KE_SWITCH_YPLUS:
        where = f"all above {switch}"
    elif hi < KE_SWITCH_YPLUS:
        where = f"all below {switch}"
    else:
        where = f"on both sides of {switch} (their area-weighted mean {mean:.3g})"
    est = ((res.get("precheck") or {}).get("estimate") or {}).get("yplus")
    text = (
        f"On Standard, k-epsilon's wall faces where f is read sit at y+ {lo:.3g} to {hi:.3g} on the reported run"
        + (f" (the pre-run check estimated {est:.2g})" if isinstance(est, (int, float)) else "")
        + f", {where}. On the clean developed wedge (the probes of "
        "2026-11-06) its walls read f +4.8 % at y+ 10.2 and -4.8 % at y+ 11.6, and 4.2 to 4.9 % low from there to y+ "
        "100, so a mesh whose wall cells sit on the other side of the switch can move f by up to about 10 points."
    )
    if mean >= KE_SWITCH_YPLUS:
        rest = sorted(e - KE_WEDGE_ABOVE_PCT for e, _ in errs)
        text += (
            f" Its walls alone would read f about {abs(KE_WEDGE_ABOVE_PCT):g} % low there, so its f {errs[0][0]:+.2f} % and "
            f"f_tau {errs[1][0]:+.2f} % mean the rest (the tetrahedra and the still-developing flow, not probed apart) "
            f"reads it {rest[0]:.1f} to {rest[1]:.1f} points high: most likely errors that cancel, not a sign that it is "
            "the best variant."
        )
    return text


def _note_standard_sst(by: dict[str, dict[str, Any]]) -> str | None:
    """k-omega SST on Standard against its band, the reported run's own errors and y+ and the velocity
    gradient its case was written with (its "Numerics as written"), beside Hex-dominant's run of the same
    model. None without that run's two errors."""
    res = by.get("standard_sst") or {}
    qs = [_q(res, k) for k in ("f", "f_tau")]
    errs = [(q.get("error") or {}).get("rel_pct") for q in qs]
    if not all(isinstance(e, (int, float)) for e in errs):
        return None
    band = (qs[0].get("tolerance") or {}).get("rel_pct")
    outside = [q for q in qs if q.get("within") is False]
    side = (f", {'both' if len(outside) == 2 else 'f' if outside[0] is qs[0] else 'f_tau'} outside the ±{band:g} % band"
            if outside and isinstance(band, (int, float)) else "")
    yp = (res.get("shown") or {}).get("y_plus") or {}
    at = f" (its wall faces where f is read at y+ {float(yp['min']):.3g} to {float(yp['max']):.3g})" if yp else ""
    text = f"On Standard, k-omega SST read f {errs[0]:+.2f} % and f_tau {errs[1]:+.2f} % on the reported run{at}{side}."
    written = next((str(r.get("value")) for r in ((res.get("run") or {}).get("numerics_used") or {}).get("written") or []
                    if r.get("label") == "Velocity gradient"), "")
    if written:
        text += (" Its case was written with the plain velocity gradient and flux, as the app writes k-omega SST on a "
                 f"Standard mesh (its \"Numerics as written\": {written.split(';')[0]}).")
    text += (" This is a limitation, not fixed: from an inlet, k-omega SST reads a pipe's friction low on Standard's "
             "tetrahedra (the probes of 2026-11-07 read it 11 to 18 % low with wall layers, and why is not shown: the "
             "validation README, \"k-omega SST on Standard's tetrahedra\").")
    why = (qs[0].get("tolerance") or {}).get("report_only")
    if why:
        text += (f" So its two values are report-only ({why}): the tolerances were locked on 2026-11-07, after "
                 "Daniel reviewed the second full run of the whole set, and these two are compared and shown with "
                 "their band and error but give no pass or fail until the limit is fixed.")
    hex_errs = [(_q(by.get("hexdominant_sst") or {}, k).get("error") or {}).get("rel_pct") for k in ("f", "f_tau")]
    if all(isinstance(e, (int, float)) for e in hex_errs):
        text += (f" On Hex-dominant the same model and walls read f {hex_errs[0]:+.2f} % and f_tau {hex_errs[1]:+.2f} %: "
                 "the Study panel's model help says what a pipe from an inlet read on each mesher.")
    return text


NOTES = (
    "The reference is McKeon et al.'s relation (0.0211 at Re 5e4); the band is ±10 %, the reference data's for RANS "
    "with wall functions (the design proposed ±8 % for SST, ±10 % for k-epsilon and ±15 % on Standard). The reference "
    "data win.",
    "The reference data ask for the friction to be read at least 40 D from the inlet, or with a cyclic or mapped "
    "inlet. This case meets neither: the app has no cyclic or mapped inlet (gap G9), and the pipe is 30 D long. The "
    "friction is read over x/D 20 to 25 and its slope over x/D 15 to 20 is shown beside it: in a developed flow the "
    "two agree. Where they differ by more than 1 % the run carries a warning: the flow is still developing where f "
    "is read, so it is not quite the fully developed f the reference is for. Which side of it f reads depends on "
    "the inlet's turbulence: from the Auto inlet (5 %, 0.07 D) the centreline speed overshoots and f at 20 to 25 D "
    "reads below its developed value (the probes of 2026-11-06: 2.6 to 3.6 % below on Hex-dominant, against a "
    "mapped inlet that holds the developed flow), from 10 % and 0.1 D it read above it. On Standard the slope over "
    "5 D moved by about 2 % between two meshes of the same settings while the wall shear stress agreed within "
    "0.2 %, so a warning there can come from the mesh as much as from the flow. The pipe is 30 D, the length its "
    "bands were locked on, because when the case was built Hex-dominant could not mesh a much longer pipe cleanly "
    "(an app gap): its background block kept at least 8 and 12 cells across the pipe while its cells along the pipe "
    "grew with the length, so the cells near the wall got long and flat. On the mesh probes (2026-11-05) a 55 D pipe "
    "at fineness 6 had 25 196 faces over 65 degrees non-orthogonal before snapping, and its mesh failed checkMesh "
    "(8 cells of negative volume) although Generate finished; a 40 D pipe at fineness 7 kept 0.03 of its 2 wall "
    "layers and failed checkMesh too. Since 2026-11-07 Hex-dominant keeps every background cell within 3 times as "
    "long as wide, and a Hex-dominant mesh that fails checkMesh ends Generate failed: the 55 D pipe at fineness 6 "
    "passes checkMesh (its worst face 65.1 degrees), and this 30 D pipe meshes on an 80 × 8 × 12 block where it had "
    "67 × 8 × 12. On that block snappyHexMesh first left the inlet and outlet off their planes (the third full run, "
    "2026-11-08): their centres 1.26 mm inside the pipe, each 344.3 mm² for the disc's 314.2, so the inlet let in "
    "9.6 % more and f read 23 % high. Since 2026-11-08 the block's ends sit just outside the pipe's two planes, and "
    "the ends are 314.0 mm².",
    "Two readings of the same friction: the pressure drop along the axis, and the wall shear stress the run saved. "
    "In a settled, developed flow they are equal (the force balance -dp/dx = 4 tau_w / D); a gap between them is a "
    "finding about the solution, not about the reading.",
    "The wall's y+ (OpenFOAM's yPlus, saved by every turbulent run) is shown for the same faces. k-epsilon's wall "
    "functions assume y+ of about 30 to 100 at the first cell's centre (on a clean developed wedge they read f "
    "-4.2 to -4.9 % from y+ 11.6 up and 5 to 75 % high below it). k-omega SST's walls take Spalding's law with "
    "stepwise omega since the first full run (which wrote nutkWallFunction: 8 to 20 % low from y+ 12 to 35 on the "
    "wedge): on the wedge it reads within about 2 % from y+ 5 to 15, +4.4 % at 20 and -3.3 % at 100, and 6 to 9 % "
    "low with the first cell's centre at y+ 1 to 3. Hex-dominant's one wall layer of 0.6 mm is sized for about "
    "35; Standard sizes its own layers, so its y+ is what its layers give.",
    lambda by: _note_standard_kepsilon(by),
    lambda by: _note_standard_sst(by),
    "Each mesher's mesh is made once and both turbulence models solve on it (the k-epsilon run on the k-omega SST "
    "run's mesh, the same geometry, fluid, BCs and mesh settings).",
)

SETTLE = (
    {"monitor": "mon_inlet", "sample": "p_Pa", "label": "the inlet's area-averaged pressure"},
    {"monitor": "probes_centreline_4", "sample": "U", "component": 0, "label": "U_x at the centreline probe at x = 20 D"},
)
SETTLE_DRIFT = 1e-3


def build_geometry() -> Any:
    from ..geometry import pipe

    return pipe(D_MM, L_MM)


def requests(variant: str, *, coarse: bool = False, cores: int = 4) -> dict[str, Any]:
    mesher = MESHER[variant]
    hexd = mesher == "hexdominant"
    model = MODEL[variant]
    end_time = END_TIME // (4 if coarse else 1)
    mesh_settings: dict[str, Any] = {
        "fineness": FINENESS - (2 if coarse else 0),
        "automatic_boundary_layers": not hexd,
        "physics_based_meshing": True,
        "hex_element_core": True,
        "advanced": {"mesh_engine": MESH_ENGINE[mesher]},
    }
    refinements = (
        [{"name": "Wall layers", "type": "Inflate boundary layer", "faces": ["@wall"], **LAYERS,
          "total_thickness_unit": "mm"}]
        if hexd
        else []
    )
    probe = {
        "id": "rc-centreline", "name": "Centreline", "monitor_type": "probe", "kind": "Point probe",
        "category": "Point data", "write_control": "Time step", "faces": [], "results": None, "series": None,
        "chart_values": None, "results_available": False,
        "points": [[round(x * D, 6), 0.0, 0.0] for x in PROBE_X_D],
    }
    return {
        "project": {"title": f"Validation {ID} {mesher}", "description": "", "category": "Other",
                    "units": "Metric", "folder": "My Projects"},
        "study": {
            "analysis_type": "incompressible_steady",
            "time_dependency": "Steady-state",
            "name": f"{ID} {mesher}",
            "settings": {
                "turbulence_model": model,
                "numerics_preset": "accurate",
                "residual_u": 1e-5,
                "residual_p": 1e-5,
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
            {"name": "Pipe wall", "bc_type": "Wall", "wall_type": "No-slip", "faces": ["@wall"]},
        ],
        "mesh": {
            "name": "Mesh 1",
            "settings": mesh_settings,
            "refinements": refinements,
            "expect": {"layers": True, "n_cells": [20_000, 600_000] if not coarse else [2_000, 300_000]},
        },
        "run": {"name": f"Validation {MODEL_WORDS[model]}", "endTime": end_time, "writeInterval": end_time,
                "cores": int(cores), "result_controls": [probe]},
        "extract": [
            {"key": "wall_shear", "kind": "patch", "patch": WALL_PATCH, "field": "wallShearStress", "box_m": _WINDOW_BOX},
            {"key": "y_plus", "kind": "patch", "patch": WALL_PATCH, "field": "yPlus", "box_m": _WINDOW_BOX},
            {"key": "p_axis", "kind": "line", "field": "p", "points_m": [[0.0, 0.0, 0.0], [L, 0.0, 0.0]],
             "subdivisions": 300},
            {"key": "u_axis", "kind": "line", "field": "U", "points_m": [[0.0, 0.0, 0.0], [L, 0.0, 0.0]],
             "subdivisions": 300},
        ],
        "flow_patch": "inlet",
        "timeouts_s": {"mesh": 2400, "solve": 7200},
    }


# ---------------------------------------------------------------------------------------- evaluate

def _slope(x: list[float], p: list[float], lo_d: float, hi_d: float) -> dict[str, float]:
    xb, pb = band(x, p, lo_d * D, hi_d * D)
    return linear_fit(xb, pb)


def evaluate(plan: dict[str, Any], raw: Any) -> dict[str, Any]:
    warnings: list[str] = []
    shown: dict[str, Any] = {}
    series: dict[str, Any] = {}
    q_in = raw.patch_flow("inlet")
    a_in, a_out = raw.patch_area("inlet"), raw.patch_area("outlet")
    area_unc_pct = 0.0
    if q_in and a_in and a_out:
        area = 0.5 * (a_in + a_out)
        area_unc_pct = 100.0 * abs(a_in - a_out) / 2.0 / area
        ub = q_in / area
        d_eff = math.sqrt(4.0 * area / math.pi)
        shown.update({"inlet_area_mm2": a_in * 1e6, "outlet_area_mm2": a_out * 1e6, "area_mm2": area * 1e6,
                      "area_vs_nominal_pct": 100.0 * (area / (math.pi * D * D / 4) - 1.0), "area_unc_pct": area_unc_pct,
                      "ub_m_s": ub, "d_eff_mm": d_eff * 1000.0})
    else:
        ub, d_eff = U, D
        warnings.append("no inlet flow or patch areas from the monitors: D and U_b are the nominal 20 mm and 1 m/s")
    shown["re_eff"] = ub * d_eff / NU
    p_in = raw.patch_pressure("inlet")
    if p_in is not None:
        shown["inlet_p_Pa"] = p_in
    bal = raw.flow_balance()
    if bal and bal.get("in_m3s"):
        shown["imbalance_pct"] = 100.0 * bal.get("imbalance", 0.0)
    dyn = 0.5 * RHO * ub * ub
    f = f_tau = None
    f_detail = tau_detail = ""
    p_line = raw.line("p_axis")
    if p_line and p_line.get("n_valid"):
        x, p = _line_xy(p_line, 0)
        ds = downsample(x, p)
        series["p_axis"] = {"x_m": ds["x"], "p_Pa": ds["y"]}
        try:
            fit = _slope(x, p, FIT_FROM_D, FIT_TO_D)
            grad = -fit["slope"]
            f = grad * d_eff / dyn
            se_pct = 100.0 * fit["slope_se"] / abs(fit["slope"]) if fit["slope"] else float("nan")
            shown["dpdx_Pa_m"] = grad
            shown["fit"] = {"slope": fit["slope"], "intercept": fit["intercept"], "slope_se": fit["slope_se"],
                            "r2": fit["r2"], "n": int(fit["n"]), "x_from_m": FIT_FROM_D * D, "x_to_m": FIT_TO_D * D}
            shown["f_unc_pct"] = math.hypot(se_pct, 2.5 * area_unc_pct)
            f_detail = (f"-dp/dx {grad:.5g} Pa/m from {int(fit['n'])} samples (slope standard error {se_pct:.2f} %, "
                        f"r² {fit['r2']:.5f}); D_eff {d_eff * 1000:.3f} mm, U_b {ub:.4f} m/s")
            early = _slope(x, p, EARLY_FROM_D, EARLY_TO_D)
            shown["f_early"] = -early["slope"] * d_eff / dyn
            shown["f_early_vs_f_pct"] = 100.0 * (shown["f_early"] / f - 1.0)
            if abs(shown["f_early_vs_f_pct"]) > DEVELOPING_PCT:
                warnings.append(
                    f"still developing where f is read: f over x/D {EARLY_FROM_D:g} to {EARLY_TO_D:g} reads "
                    f"{shown['f_early_vs_f_pct']:+.2f} % against x/D {FIT_FROM_D:g} to {FIT_TO_D:g} (more than "
                    f"{DEVELOPING_PCT:g} % apart; a developed flow reads the same), so f is not yet its developed "
                    "value (above or below it, as the inlet's turbulence sets: the case's notes): the pipe is 30 D, "
                    "not the 40 D from the inlet the reference data ask for, and the app has no cyclic inlet (gap G9)"
                )
        except ValueError as e:
            warnings.append(f"pressure fit: {e}")
    else:
        warnings.append(f"no centreline pressure: {(p_line or {}).get('reason') or 'no answer'}")
    u_line = raw.line("u_axis")
    if u_line and u_line.get("n_valid"):
        x, u = _line_xy(u_line, 0)
        ds = downsample(x, u)
        series["u_axis"] = {"x_m": ds["x"], "U_m_s": ds["y"]}
        try:
            shown["ucl_over_ub"] = window_mean(x, u, FIT_FROM_D * D, FIT_TO_D * D)["mean"] / ub
        except ValueError as e:
            warnings.append(f"centreline speed: {e}")
    ws = raw.sample("wall_shear")
    if ws and ws.get("n"):
        tx = np.asarray(ws["wallShearStress_x"], dtype=float)
        fa = np.asarray(ws["area"], dtype=float)
        tau = abs(float(np.sum(tx * fa) / np.sum(fa))) * RHO
        f_tau = 8.0 * tau / (RHO * ub * ub)
        shown["tau_w_Pa"] = tau
        shown["tau_w_faces"] = int(ws["n"])
        tau_detail = f"tau_w {tau:.5g} Pa over {int(ws['n'])} wall faces, U_b {ub:.4f} m/s"
        if f is not None:
            shown["f_tau_vs_f_pct"] = 100.0 * (f_tau / f - 1.0)
    else:
        warnings.append(f"no wall shear stress of the developed part: {raw.sample_problem('wall_shear')}")
    yp = raw.sample("y_plus")
    if yp and yp.get("n"):
        v = np.asarray(yp["yPlus"], dtype=float)
        a = np.asarray(yp["area"], dtype=float)
        shown["y_plus"] = {"min": float(v.min()), "mean": float(np.sum(v * a) / np.sum(a)), "max": float(v.max()),
                           "n_faces": int(yp["n"])}
    else:
        warnings.append(f"no y+ of the developed part: {raw.sample_problem('y_plus')}")
    probes = raw.probe_values("Centreline", component=0)
    if probes:
        series["probes"] = {"x_m": [p[0] for p in probes], "Ux_m_s": [p[1] for p in probes]}
    specs = _BY_VARIANT[str(plan["variant"])]
    rows = [
        compare(specs["f"], f, detail=f_detail,
                uncertainty=({"kind": "pct", "value": shown["f_unc_pct"],
                              "what": "the slope's standard error and 2.5 times the cross-section's"}
                             if "f_unc_pct" in shown else None)),
        compare(specs["f_tau"], f_tau, detail=tau_detail),
    ]
    return {"quantities": rows, "series": series, "shown": shown, "warnings": warnings}


def setup_words(result: dict[str, Any]) -> str:
    model = MODEL_WORDS[MODEL[str(result.get("variant"))]]
    return (
        f"A {GEOMETRY_WORDS} (STEP in mm, built with OCP); a custom fluid with nu = {NU:g} m²/s and rho = {RHO:g} kg/m³, "
        f"so Re = U D / nu = {RE:,.0f}".replace(",", " ") + f"; a velocity inlet of {U:g} m/s normal to the face (its "
        "turbulence Auto: 5 % intensity, 0.07 D), a 0 Pa pressure outlet and a no-slip wall; steady (simpleFoam), "
        f"{model} with wall functions, Accurate numerics, residual targets 1e-5, at most {END_TIME} iterations."
    )


def mesh_words(result: dict[str, Any]) -> str:
    v = str(result.get("variant"))
    mesh = result.get("setup", {}).get("mesh", {})
    fine = (mesh.get("settings") or {}).get("fineness")
    lay = (f"an Inflate boundary layer of {LAYERS['n_layers']} layers, {LAYERS['total_thickness']:g} mm in all, on the "
           "wall (automatic boundary layers off)" if MESHER[v] == "hexdominant" else standard_mesh_words(result))
    n_orth = ((result.get("setup", {}).get("study") or {}).get("settings") or {}).get("n_non_orthogonal")
    label = "Hex-dominant" if MESHER[v] == "hexdominant" else "Standard"
    return f"{label} at fineness {fine} with {lay}; {n_orth} non-orthogonal corrector{'s' if n_orth != 1 else ''}"


def shown_words(result: dict[str, Any]) -> list[str]:
    from ..report import num

    s = result.get("shown") or {}
    bits: list[str] = []
    if s.get("d_eff_mm") is not None:
        bits.append(f"the pipe's cross-section as meshed {num(s['area_mm2'], 5)} mm² ({s['area_vs_nominal_pct']:+.2f} % "
                    f"against pi D²/4), so D_eff {num(s['d_eff_mm'], 5)} mm, U_b {num(s['ub_m_s'], 5)} m/s and Re_eff "
                    f"{num(s['re_eff'], 5)}")
    if s.get("f_early") is not None:
        bits.append(f"f from the pressure over x/D {EARLY_FROM_D:g} to {EARLY_TO_D:g} {num(s['f_early'], 4)} "
                    f"({s['f_early_vs_f_pct']:+.2f} % against x/D {FIT_FROM_D:g} to {FIT_TO_D:g}: a developed flow reads the same)")
    if s.get("f_tau_vs_f_pct") is not None:
        bits.append(f"f from the wall shear stress {s['f_tau_vs_f_pct']:+.2f} % against f from the pressure drop")
    yp = s.get("y_plus") or {}
    if yp:
        bits.append(f"the wall's y+ over x/D {FIT_FROM_D:g} to {FIT_TO_D:g} from {num(yp['min'], 3)} to {num(yp['max'], 3)}, "
                    f"area-weighted mean {num(yp['mean'], 3)} ({yp['n_faces']} faces"
                    + ("; k-epsilon's wall functions assume about 30 to 100)" if MODEL.get(str(result.get("variant"))) == "kEpsilon" else ")"))
    if s.get("ucl_over_ub") is not None:
        bits.append(f"the centreline speed over x/D {FIT_FROM_D:g} to {FIT_TO_D:g} {num(s['ucl_over_ub'], 4)} U_b "
                    "(Plot over path)")
    if s.get("inlet_p_Pa") is not None:
        bits.append(f"the inlet's area-averaged pressure {num(s['inlet_p_Pa'], 4)} Pa"
                    + (f", flow out against in {num(s['imbalance_pct'], 2)} %" if s.get("imbalance_pct") is not None else ""))
    return bits


# ---------------------------------------------------------------------------------------- figures

FIGURES = (
    ("pressure", "centreline pressure"),
    ("centreline", "centreline speed"),
    ("residuals", "residuals"),
)
_NEEDS = {"pressure": "p_axis", "centreline": "u_axis", "residuals": "residuals"}


def has_figure(kind: str, result: dict[str, Any]) -> bool:
    return _NEEDS[kind] in (result.get("series") or {})


def _q(result: dict[str, Any], key: str) -> dict[str, Any]:
    return next((q for q in result.get("quantities") or [] if q["key"] == key), {})


def _err_text(q: dict[str, Any], name: str) -> str:
    if q.get("value") is None:
        return f"{name}: no value"
    return f"{name} {q['value']:.4g} (reference {q['reference']['value']:g}, {q['error']['rel_pct']:+.2f} %)"


def draw(kind: str, result: dict[str, Any], ax: Any) -> None:
    from ..plots import INK, SECOND, SERIES, note

    s = result["series"]
    shown = result.get("shown") or {}
    ub = shown.get("ub_m_s") or U
    d_eff = (shown.get("d_eff_mm") or D * 1000.0) / 1000.0
    if kind == "pressure":
        x = [v / D for v in s["p_axis"]["x_m"]]
        ax.plot(x, s["p_axis"]["p_Pa"], color=SERIES, linewidth=1.6, label="Magnusim (Plot over path)")
        fit = shown.get("fit")
        if fit:
            mid = 0.5 * (FIT_FROM_D + FIT_TO_D) * D
            p_mid = fit["slope"] * mid + fit["intercept"]
            g = _REF.value * 0.5 * RHO * ub * ub / d_eff
            xs = [10.0, L / D]
            ax.plot(xs, [p_mid + g * (mid - xx * D) for xx in xs], color=INK, linestyle="--", linewidth=1.2,
                    label="McKeon et al. (2005) gradient (U_b, D_eff)")
            ax.axvspan(FIT_FROM_D, FIT_TO_D, color=SERIES, alpha=0.08, linewidth=0, label="fit window")
        ax.set_xlabel("x / D")
        ax.set_ylabel("p (Pa, = kinematic, rho = 1)")
        ax.legend(loc="upper right")
        note(ax, _err_text(_q(result, "f"), "f") + "\n" + _err_text(_q(result, "f_tau"), "f_tau"))
    elif kind == "centreline":
        x = [v / D for v in s["u_axis"]["x_m"]]
        ax.plot(x, [v / ub for v in s["u_axis"]["U_m_s"]], color=SERIES, linewidth=1.6, label="Magnusim (Plot over path)")
        if "probes" in s:
            ax.plot([v / D for v in s["probes"]["x_m"]], [v / ub for v in s["probes"]["Ux_m_s"]], linestyle="none",
                    marker="o", markersize=5, color=SECOND, label="Point probes")
        ax.axvspan(FIT_FROM_D, FIT_TO_D, color=SERIES, alpha=0.08, linewidth=0, label="fit window")
        ax.set_xlabel("x / D")
        ax.set_ylabel("U_cl / U_b")
        ax.legend(loc="lower right")
    elif kind == "residuals":
        h = s["residuals"]
        for i, key in enumerate(k for k in h if k != "t"):
            ax.semilogy(h["t"], h[key], color=(SERIES, SECOND, INK, "#7a7a76")[i % 4], linewidth=1.2,
                        label=f"{key} (initial residual)")
        ax.axhline(1e-5, color=INK, linestyle=":", linewidth=1.0, label="target 1e-5")
        ax.set_xlabel("iteration")
        ax.set_ylabel("residual")
        ax.legend(loc="upper right", fontsize=7)
