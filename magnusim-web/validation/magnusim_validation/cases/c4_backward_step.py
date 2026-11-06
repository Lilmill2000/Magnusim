"""Case 4: the laminar backward-facing step (2D), on Hex-dominant one cell across.

Two variants, as the reference data set them:

- ``re100``: Armaly et al.'s expansion ratio 1.942 (step S = 4.9 mm, inlet channel h = 5.2 mm,
  channel after the step H = 10.1 mm) at Re_D = 100, against their measured primary
  reattachment x1/S = 3.00 (Fig. 14, digitised). The experiment was two-dimensional below
  Re_D about 400, so not at the design's Re 389.
- ``re800``: Gartling's expansion ratio 2 (h = S = H/2, H = 10 mm) at Re_D = 800, against his
  primary reattachment x_r/S = 12.20 and the top wall's bubble (separation 9.70 S,
  reattachment 20.96 S), with the literature's scatter (11.5 to 12.2 S) shown.

Re_D = U_b 2h / nu, U_b the mean inlet velocity (Armaly's definition, for expansion ratio 2
equal to Gartling's U_b H / nu). The app has no profile inlet (gap G10): a uniform 1 m/s inlet
feeds an upstream channel of 10 h (``re100``) or 10 H (``re800``), and the profile reaching the
step (at x = -1 h) is shown against the parabola. The outlet lies 30 H after the step
(Gartling's domain). The part is one body, two boxes fused and unified, 5 mm deep in z;
Hex-dominant's One cell across (2D) meshes it one cell deep between its front and back, one
Symmetry, which the solve makes the 2D mesh's empty ends.

Compared: where the floor's wall shear stress (x component, as the run saved it) turns from
reversed to forward after the step, and on ``re800`` where the top wall's turns reversed and
forward again. Cross-checked by U_x on lines 0.02 S from the floor and from the top, sampled as
Plot over path samples them with the velocity's components kept (``app_sampling``).
"""

from __future__ import annotations

from typing import Any

import numpy as np

from ..extract import arrays, downsample, sign_changes
from ..model import QuantitySpec, Tolerance, compare
from ..notes import and_list, checkmesh_words, precheck_note, run_words
from ..refs import read

ID = "c4_backward_step"
TITLE = "Backward-facing step"
GROUP = "Internal flow"
VARIANTS = ("re100", "re800")
VARIANT_LABELS = {
    "re100": "Re_D = 100 (Armaly et al.), Hex-dominant (2D)",
    "re800": "Re_D = 800 (Gartling), Hex-dominant (2D)",
}
RE = {"re100": 100, "re800": 800}

# The geometry (mm): the step S, the inlet channel h and the channel after the step H, the
# upstream channel's length and the length after the step.
GEOM: dict[str, dict[str, float]] = {
    "re100": {"S": 4.9, "h": 5.2, "H": 10.1, "up": 52.0, "down": 303.0},
    "re800": {"S": 5.0, "h": 5.0, "H": 10.0, "up": 100.0, "down": 300.0},
}
DEPTH_MM = 5.0
ZM = DEPTH_MM / 2000.0  # mid-depth (m): every line and probe lies there
U = 1.0
RHO = 1.0
NU = {v: U * 2.0 * g["h"] / 1000.0 / RE[v] for v, g in GEOM.items()}
# The mesh: Hex-dominant at fineness 10 (its finest): the part is about 35 to 40 times longer than
# high, and its background block keeps at least 8 cells across the height, so a lower fineness
# makes the background cells several times longer than high (fineness 5: 5 to 6 times, 10:
# 1.7 to 1.9); then one custom size on every wall with Refine out to half the height, so the whole
# channel is meshed at that size's level.
FINENESS = 10
CELL_MM = 0.3
# Iteration limits (each run should stop on its residual targets of 1e-6 before them).
END_TIME = {"re100": 4000, "re800": 6000}
# SIMPLEC at Re_D 800 (the study's SIMPLEC setting, with its own relaxation): with SIMPLE at
# 0.7 / 0.3 the coarse run never settled (its U residual flat near 0.05 from iteration 600 to its
# limit of 6000, the inlet pressure swinging ±0.75 %, a wave train along the channel after the
# step); with SIMPLEC the same mesh met its targets of 1e-6 in 1131 iterations.
SIMPLEC = {"re100": False, "re800": True}
# The lines: U_x 0.02 S from the floor and from the top, and the profile reaching the step.
LINE_GAP_S = 0.02
LINE_SUBDIV = 2000
PROFILE_SUBDIV = 100
PROFILE_AT_H = -1.0  # x of the inlet profile, in inlet channel heights h
# Where the flow along each wall is surely forward (attached), as a fraction of the length after
# the step: the wall shear stress's sign there is what "forward" is.
FORWARD_WINDOW = (0.6, 0.9)
# The figures' range of x/S.
PLOT_TO_S = {"re100": 12.0, "re800": 32.0}


def _selectors(g: dict[str, float]) -> dict[str, dict[str, Any]]:
    return {
        "inlet": {"plane": {"axis": "x", "at_mm": -g["up"], "sign": -1}},
        "outlet": {"plane": {"axis": "x", "at_mm": g["down"], "sign": 1}},
        "floor": {"plane": {"axis": "y", "at_mm": 0.0, "sign": -1}},
        "top": {"plane": {"axis": "y", "at_mm": g["H"], "sign": 1}},
        "inlet_floor": {"plane": {"axis": "y", "at_mm": g["S"], "sign": -1}},
        "step": {"plane": {"axis": "x", "at_mm": 0.0, "sign": -1}},
        "front": {"plane": {"axis": "z", "at_mm": 0.0, "sign": -1}},
        "back": {"plane": {"axis": "z", "at_mm": DEPTH_MM, "sign": 1}},
    }


ARMALY = read("armaly_1983_fig14_x1.csv")
GARTLING = read("gartling_1990_re800.csv")
SCATTER = read("bfs_re800_scatter.csv")

_SHEAR_HOW = (
    "the x component of the wall shear stress the run saved on the {wall} (wallShearStress, one face per x on the "
    "2D mesh), its sign in the attached flow far after the step ({lo:g} to {hi:g} of the length after it) taken as "
    "forward; {what}, the zero linearly interpolated between the two face centres around it; over the step height S"
)


def _specs(variant: str) -> dict[str, QuantitySpec]:
    re = RE[variant]
    tag = f"Re_D {re}"
    lo, hi = FORWARD_WINDOW
    if variant == "re100":
        return {
            "x1_over_s": QuantitySpec(
                key="x1_over_s",
                label=f"Primary reattachment on the floor, x1/S ({tag})",
                unit="S",
                how=_SHEAR_HOW.format(wall="floor after the step", lo=lo, hi=hi, what=(
                    "x1 where it turns from reversed to forward at the end of its longest reversed stretch, the primary "
                    "eddy from the step's foot (a corner eddy's forward flow at the foot, if any, is passed over)")),
                source="case_file:<latest>/wallShearStress",
                reference=ARMALY.reference(ARMALY.row(re=100)["x1_over_s"], unit="S",
                                           where="Fig. 14 at Re = 100, the measured primary reattachment x1/S"),
                tolerance=Tolerance(rel_pct=10.0, note="the reference data's band: the experiment, the digitising and the "
                                    "expansion ratio"),
            )
        }
    row = {q: GARTLING.row(quantity=q) for q in ("lower_reattachment", "upper_separation", "upper_reattachment")}
    band10 = Tolerance(rel_pct=10.0, note="the reference data's band for the top wall's bubble (reported only)")
    return {
        "xr_over_s": QuantitySpec(
            key="xr_over_s",
            label=f"Primary reattachment on the floor, x_r/S ({tag})",
            unit="S",
            how=_SHEAR_HOW.format(wall="floor after the step", lo=lo, hi=hi, what=(
                "x_r where it turns from reversed to forward at the end of its longest reversed stretch, the primary "
                "eddy from the step's foot (a corner eddy's forward flow at the foot, if any, is passed over)")),
            source="case_file:<latest>/wallShearStress",
            reference=GARTLING.reference(row["lower_reattachment"]["x_over_s"], unit="S",
                                         where=f"Tables II and III, the lower-wall reattachment x = "
                                               f"{row['lower_reattachment']['x_over_h']:.2f} H"),
            tolerance=Tolerance(rel_pct=7.0, note="the reference data's band: the literature's scatter is about 6 %"),
        ),
        "xs_top_over_s": QuantitySpec(
            key="xs_top_over_s",
            label=f"Top wall's bubble, separation x_s/S ({tag})",
            unit="S",
            how=_SHEAR_HOW.format(wall="top wall after the step", lo=lo, hi=hi, what=(
                "x_s where it turns from forward to reversed at the start of its longest reversed stretch after the "
                "step (the bubble)")),
            source="case_file:<latest>/wallShearStress",
            reference=GARTLING.reference(row["upper_separation"]["x_over_s"], unit="S",
                                         where=f"Tables II and III, the upper-wall separation x = "
                                               f"{row['upper_separation']['x_over_h']:.2f} H"),
            tolerance=band10,
        ),
        "xr_top_over_s": QuantitySpec(
            key="xr_top_over_s",
            label=f"Top wall's bubble, reattachment x_r2/S ({tag})",
            unit="S",
            how=_SHEAR_HOW.format(wall="top wall after the step", lo=lo, hi=hi, what=(
                "x_r2 where it turns forward again at the end of that stretch")),
            source="case_file:<latest>/wallShearStress",
            reference=GARTLING.reference(row["upper_reattachment"]["x_over_s"], unit="S",
                                         where=f"Tables II and III, the upper-wall reattachment x = "
                                               f"{row['upper_reattachment']['x_over_h']:.2f} H"),
            tolerance=band10,
        ),
    }


_BY_VARIANT = {v: _specs(v) for v in VARIANTS}
# Every variant's quantities (the report lists their references).
QUANTITIES: dict[str, QuantitySpec] = {f"{k}_{v}": s for v in VARIANTS for k, s in _BY_VARIANT[v].items()}


def quantities(variant: str) -> list[QuantitySpec]:
    return list(_BY_VARIANT[variant].values())


_SCATTER_XR = [float(r["xr_over_s"]) for r in SCATTER.rows]
SCATTER_RANGE = (min(_SCATTER_XR), max(_SCATTER_XR))

# The coarse runs of 2026-11-06 (the custom size doubled to 0.6 mm: level 3; not reported), typed:
# they are not results. Re_D 800's ran with SIMPLEC, as the case does.
COARSE = {
    "re100": {"cells": 45_663, "x1_over_s": 2.852},
    "re800": {"cells": 42_989, "xr_over_s": 11.48, "xs_top_over_s": 9.03, "xr_top_over_s": 20.33},
}


def _note_checkmesh(by: dict[str, dict[str, Any]]) -> str | None:
    """What checkMesh said of the reported meshes."""
    bits = [f"at Re_D {RE[v]} {checkmesh_words(by[v])}" for v in VARIANTS if v in by]
    return ("The reported meshes, " + " and ".join(bits) + ".") if bits else None


def _note_mesh_moves(by: dict[str, dict[str, Any]]) -> str | None:
    """How much the coarse runs' mesh moves the reported values."""
    from ..report import cells_text, num, pct_text, quantity, rel_pct

    parts = []
    worst800 = 0.0
    for v in VARIANTS:
        res = by.get(v)
        if not res:
            continue
        keys = [k for k in COARSE[v] if k != "cells"]
        got = [quantity(res, k).get("value") for k in keys]
        if any(x is None for x in got):
            continue
        mine = [float(x) for x in got if x is not None]
        pcts = [rel_pct(COARSE[v][k], x) for k, x in zip(keys, mine, strict=True)]
        if v == "re800":
            worst800 = max(pcts)
        names = {"x1_over_s": "x1/S", "xr_over_s": "x_r/S", "xs_top_over_s": "x_s/S", "xr_top_over_s": "x_r2/S"}
        coarse = and_list([f"{names[k]} {num(COARSE[v][k], 4)}" for k in keys])
        parts.append(f"at Re_D {RE[v]}, {coarse} on {cells_text(COARSE[v]['cells'])} cells against "
                     f"{and_list([num(x, 4) for x in mine])} on {cells_text((res.get('mesh') or {}).get('n_cells'))} "
                     f"({and_list([pct_text(x) for x in pcts])} %)")
    if not parts:
        return None
    text = ("How much the mesh moves the answer (the coarse runs of 2026-11-06, the custom size doubled to 0.6 mm: "
            "level 3, a quarter of the cells; not reported): " + "; ".join(parts))
    if worst800 >= 1.0:
        text += (f": at Re_D 800 the values still move by up to {pct_text(worst800)} % for one level, so they are not "
                 "converged in the mesh to better than that")
    return text + "."


def _note_simplec(by: dict[str, dict[str, Any]]) -> str:
    """Why Re_D 800 solves with SIMPLEC, and how the reported run ended."""
    text = ("SIMPLEC at Re_D 800 (the study's own setting, its relaxation the app's). With SIMPLE at 0.7 / 0.3 the "
            "coarse run of 2026-11-06 never settled: its U residual stayed near 0.05 from iteration 600 to its limit "
            "of 6000, the inlet pressure swung by ±0.75 % and a train of waves ran along the channel after the step "
            "(U_y up to 0.03 m/s on its centreline, 30 to 60 S); Run health read the pressure residual as stalled. "
            "With SIMPLEC the same mesh met its targets in 1131 iterations.")
    res = by.get("re800")
    if res:
        text += f" The reported run {run_words(res, residual='U')}."
    return text


NOTES = (
    "Where the design and the reference data differ, the reference data win: the first variant runs at Re_D = 100 "
    "against Armaly et al.'s measured x1/S = 3.00 (±10 %), not at the design's Re 389 (the experiment turns "
    "three-dimensional near Re_D 400, where a 2D solution and the measurement part), and the second against "
    "Gartling's x_r/S = 12.20 with ±7 % (the design's ±3 %) and the top wall's bubble with ±10 % (the design's ±5 %).",
    "Re_D = U_b 2h / nu with U_b the mean inlet velocity and h the inlet channel's height (Armaly et al.'s definition; "
    "for expansion ratio 2 it equals Gartling's U_b H / nu). The first variant has Armaly et al.'s expansion ratio "
    "1.942, the second Gartling's 2: the reference data note that a code giving 3.00 at Re 100 for ratio 2 suggests "
    "the difference is within a few per cent at Re 100, on one source.",
    "The app has no profile (parabolic) inlet (gap G10): a uniform 1 m/s inlet feeds an upstream channel of 10 h "
    "(Re_D 100; a channel develops in about 2.4 h there, Durst et al. 2005) or 10 H = 20 h (Re_D 800; about 17.7 h), "
    "so the flow reaching the step is the developed channel's. The profile at x = -1 h is shown against the "
    "parabola 6 eta (1 - eta) U_b (Gartling's inlet) with each run: what is left of the uniform inlet there, and the "
    "step's own pull on the flow just before it.",
    "The outlet lies 30 H after the step, as the reference data ask (Gartling's domain; his paper is about the "
    "outflow boundary's effect). A 0 Pa pressure outlet; every wall no-slip; nothing else.",
    "One cell across (2D): the part is meshed one cell deep between its front and back, both on one Symmetry, which "
    "the solve makes the 2D mesh's empty ends, so the solution is exactly 2D. The wall shear stress then has one "
    "face per x on each wall, so no averaging across the depth is needed (the design's slab read the faces in the "
    "middle half of its depth).",
    "The mesh is Hex-dominant at fineness 10 with one custom size of 0.3 mm on every wall and Refine out to half the "
    "height, so every cell of the channel has that size's level (4): cells 0.17 to 0.20 mm along x and 0.10 mm "
    "across (S/26 to S/28 along, S/47 to S/48 across). No wall layers: the cells are that fine up to the walls. "
    "Fineness 10 because the part is long and thin (35 to 40 times longer than high, an app gap of Hex-dominant): its "
    "background block keeps at least 8 cells across the height (170 × 8 here) while it sizes them along the length "
    "from the part's diagonal, so at fineness 5 its cells would be 5 to 6 times longer than high (54 × 8), at 10 "
    "about 1.7 to 1.9.",
    lambda by: _note_checkmesh(by),
    lambda by: _note_mesh_moves(by),
    lambda by: _note_simplec(by),
    lambda by: precheck_note(by, {v: f"Re_D {RE[v]}" for v in VARIANTS}),
    "Reading the wall shear stress: OpenFOAM's wallShearStress carries the sign of its own convention, so on each "
    "wall its sign in the attached flow far after the step (from 0.6 to 0.9 of the length after it, where U_x 0.02 S "
    "from the wall must be forward too) is taken as forward. The reattachment is where the floor's turns from "
    "reversed to forward at the end of its longest reversed stretch, the primary eddy; a corner eddy at the step's "
    "foot is passed over (its end is shown when there is one), and a value within 1e-6 of the largest counts as "
    "zero (a wall's own zero is no sign). The top wall's bubble is its longest reversed stretch after the step. U_x on "
    "a line 0.02 S from the wall, sampled as Plot over path samples it with the components kept, crosses zero near "
    "the same places: shown as the cross-check.",
    "Gartling's values are SECONDARY (his Tables II and III as the MFIX-Exa tutorial reproduces them; the paper was "
    f"not read). Ten 2D solutions at Re 800 put the primary reattachment between {SCATTER_RANGE[0]:.2f} and "
    f"{SCATTER_RANGE[1]:.2f} S (about 6 %) and the top bubble's length between 10.6 and 11.5 S "
    "(validation/refs/bfs_re800_scatter.csv): the band of ±7 % is that scatter's size.",
    "Armaly et al.'s Fig. 14 value is CONFIRMED in the primary source but digitised (about ±0.05 in x1/S); the "
    "experiment's own uncertainty is not stated. At Re_D 100 the flow was two-dimensional and 2D computations "
    "matched it.",
)

# A steady run that stops at its iteration limit counts as settled only when these histories
# moved less than SETTLE_DRIFT over its last 10 % of iterations.
SETTLE = (
    {"monitor": "mon_inlet", "sample": "p_Pa", "label": "the inlet's area-averaged pressure"},
    {"monitor": "probes_bubble_1", "sample": "U", "component": 0,
     "label": "U_x in the floor's bubble (the first Bubble probe)"},
)
SETTLE_DRIFT = 1e-3


def build_geometry_for(variant: str) -> Any:
    from ..geometry import step_channel

    g = GEOM[variant]
    return step_channel(g["up"], g["down"], g["S"], g["H"], DEPTH_MM)


def geometry_words(variant: str) -> str:
    g = GEOM[variant]
    return (f"backward-facing step channel: an inlet channel h = {g['h']:g} mm high and {g['up']:g} mm long on top of "
            f"a step S = {g['S']:g} mm, then a channel H = {g['H']:g} mm high and {g['down']:g} mm ({g['down'] / g['H']:g} H) "
            f"long after it (expansion ratio {g['H'] / g['h']:.4g}), {DEPTH_MM:g} mm deep in z (one cell across)")


def face_selectors(variant: str) -> dict[str, dict[str, Any]]:
    return _selectors(GEOM[variant])


def _probe(pid: str, name: str, points: list[list[float]]) -> dict[str, Any]:
    return {"id": pid, "name": name, "monitor_type": "probe", "kind": "Point probe", "category": "Point data",
            "write_control": "Time step", "faces": [], "results": None, "series": None, "chart_values": None,
            "results_available": False, "points": points}


def _bubble_points(variant: str) -> list[list[float]]:
    """The Bubble probes: one in the floor's bubble (half its reference length from the step,
    0.1 S up) and, on ``re800``, one in the top wall's (midway along it, 0.1 S down)."""
    g = GEOM[variant]
    s, h_top = g["S"] / 1000.0, g["H"] / 1000.0
    if variant == "re100":
        return [[round(1.5 * s, 6), round(0.1 * s, 6), ZM]]
    return [[round(6.0 * s, 6), round(0.1 * s, 6), ZM], [round(15.0 * s, 6), round(h_top - 0.1 * s, 6), ZM]]


def requests(variant: str, *, coarse: bool = False, cores: int = 4) -> dict[str, Any]:
    """What the driver sends, faces as selectors; plan.make_plan resolves them."""
    g = GEOM[variant]
    s, h, big_h, down = g["S"] / 1000.0, g["h"] / 1000.0, g["H"] / 1000.0, g["down"] / 1000.0
    # Coarse: the custom size doubled (one level fewer: half the cells along and across), the same
    # fineness (a lower one makes the background cells longer than high, not coarser across) and
    # the same iteration limit (a run stops on its residual targets), so it reads how much the
    # mesh moves the answer.
    end_time = END_TIME[variant]
    gap = LINE_GAP_S * s
    floor_line = [[0.0, gap, ZM], [down, gap, ZM]]
    top_line = [[0.0, big_h - gap, ZM], [down, big_h - gap, ZM]]
    profile = [[PROFILE_AT_H * h, s, ZM], [PROFILE_AT_H * h, big_h, ZM]]
    walls = ["@floor", "@top", "@inlet_floor", "@step"]
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
                "n_non_orthogonal": 1,
                **({"simplec": True} if SIMPLEC[variant] else {}),
            },
        },
        "material": {"preset": "custom", "name": "Validation fluid", "kinematic_viscosity": NU[variant], "density": RHO,
                     "assigned_volumes": ["Body1"]},
        "bcs": [
            {"name": "Inlet", "bc_type": "Velocity inlet", "velocity_type": "Fixed", "value": U, "unit": "m/s",
             "direction": "Normal to face", "faces": ["@inlet"]},
            {"name": "Outlet", "bc_type": "Pressure", "pressure_type": "Fixed value", "value": 0, "unit": "Pa",
             "faces": ["@outlet"]},
            # A new face-by-face Wall starts Slip: the treatment is always sent. The floor and the
            # top are BCs of their own, so their patches are named (floor, top).
            {"name": "Floor", "bc_type": "Wall", "wall_type": "No-slip", "faces": ["@floor"]},
            {"name": "Top", "bc_type": "Wall", "wall_type": "No-slip", "faces": ["@top"]},
            {"name": "Step walls", "bc_type": "Wall", "wall_type": "No-slip", "faces": ["@inlet_floor", "@step"]},
            {"name": "Sides", "bc_type": "Symmetry", "faces": ["@front", "@back"]},
        ],
        "mesh": {
            "name": "Mesh 1",
            "settings": {
                "fineness": FINENESS,
                "automatic_boundary_layers": False,
                "physics_based_meshing": True,
                "hex_element_core": True,
                "advanced": {"mesh_engine": "snappy_hexdominant"},
                "mesher_settings": {"one_cell_across": True},
            },
            "refinements": [{"name": "Channel", "type": "Surface custom sizing", "faces": walls, "sizing": "Custom",
                             "default_size": CELL_MM * (2 if coarse else 1), "default_size_unit": "mm",
                             "reach": round(g["H"] / 2.0, 6), "reach_unit": "mm"}],
            # The plan's own: the 2D mesh's depth axis, for its estimate (mesh_plan.py).
            "two_d_axis": "z",
            "expect": {"layers": False, "n_cells": [80_000, 400_000] if not coarse else [5_000, 120_000]},
        },
        "run": {"name": "Validation", "endTime": end_time, "writeInterval": end_time, "cores": int(cores),
                "result_controls": [_probe("rc-bubble", "Bubble", _bubble_points(variant))]},
        "extract": [
            {"key": "floor_shear", "kind": "patch", "patch": "floor", "field": "wallShearStress"},
            {"key": "top_shear", "kind": "patch", "patch": "top", "field": "wallShearStress"},
            {"key": "floor_line", "kind": "app_sampling", "fields": ["U", "p"], "points_m": floor_line,
             "subdivisions": LINE_SUBDIV},
            {"key": "top_line", "kind": "app_sampling", "fields": ["U"], "points_m": top_line, "subdivisions": LINE_SUBDIV},
            {"key": "inlet_profile", "kind": "app_sampling", "fields": ["U"], "points_m": profile,
             "subdivisions": PROFILE_SUBDIV},
            # The route's own reading of the floor line, a scalar it gives as it is: the check that
            # app_sampling reads what Plot over path reads.
            {"key": "p_floor_line", "kind": "line", "field": "p", "points_m": floor_line, "subdivisions": LINE_SUBDIV},
        ],
        "timeouts_s": {"mesh": 2400, "solve": 5400},
    }


# ---------------------------------------------------------------------------------------- evaluate

def wall_profile(sample: dict[str, Any] | None, *, x_min: float | None = None) -> tuple[np.ndarray, np.ndarray]:
    """A wall's x component of the wall shear stress (Pa: the saved kinematic value times rho)
    against x (m), one value per x (faces whose centres share an x averaged by area), sorted by
    x; only x >= ``x_min`` when given."""
    if not sample or not sample.get("n"):
        raise ValueError("no faces")
    x = np.asarray(sample["x"], dtype=float)
    t = np.asarray(sample["wallShearStress_x"], dtype=float) * RHO
    a = np.asarray(sample["area"], dtype=float)
    keep = np.isfinite(x) & np.isfinite(t) & np.isfinite(a) & (a > 0)
    if x_min is not None:
        keep &= x >= x_min
    x, t, a = x[keep], t[keep], a[keep]
    if x.size < 3:
        raise ValueError(f"{x.size} faces")
    order = np.argsort(x, kind="stable")
    x, t, a = x[order], t[order], a[order]
    xs, ts = [], []
    i = 0
    tol = 1e-9 * max(1.0, float(np.abs(x).max()))
    while i < x.size:
        j = i
        while j + 1 < x.size and x[j + 1] - x[i] <= tol:
            j += 1
        w = a[i : j + 1]
        xs.append(float(x[i]))
        ts.append(float(np.sum(t[i : j + 1] * w) / np.sum(w)))
        i = j + 1
    return np.asarray(xs), np.asarray(ts)


def forward_sign(x: np.ndarray, t: np.ndarray, lo: float, hi: float) -> float | None:
    """The sign (+1 or -1) of ``t`` over ``lo <= x <= hi``, where the flow along the wall is
    attached; None when it is not one sign there."""
    w = t[(x >= lo) & (x <= hi)]
    if w.size == 0 or not (np.all(w > 0) or np.all(w < 0)):
        return None
    return 1.0 if w[0] > 0 else -1.0


# The floor's primary eddy starts at the step's foot, after a corner eddy at most this many S long.
MAIN_EDDY_FROM_S = 2.0
# A value this small against the series' largest is round-off (a wall's own zero), not a sign.
ROUND_OFF = 1e-6


def reversed_stretches(x: np.ndarray, fwd: np.ndarray) -> dict[str, Any]:
    """Where a wall's forward-signed shear (or near-wall U_x) is reversed: every reversed stretch
    (``stretches``: its ``start``, None when it is reversed from the first sample; its ``end``,
    None when it is reversed to the last; the spacing of the two samples around its end), and
    the longest of them (``start``, ``end``, ``end_spacing``): the primary eddy on the floor, the
    bubble on the top wall. The shorter ones (a corner eddy's reversed flow, a Moffatt eddy at
    the step's foot) are counted, not used. Values within ``ROUND_OFF`` of the largest count as
    zero (a wall's own zero is not a sign)."""
    a = np.asarray(fwd, dtype=float)
    big = float(np.max(np.abs(a))) if a.size else 0.0
    a = np.where(np.abs(a) <= ROUND_OFF * big, 0.0, a)
    changes = sign_changes(x, a)
    nonzero = a[a != 0]
    stretches: list[dict[str, Any]] = []
    cur: dict[str, Any] | None = {"start": None, "end": None, "end_spacing": None} if nonzero.size and nonzero[0] < 0 else None
    for c in changes:
        if not c["rising"]:
            cur = {"start": c["x"], "end": None, "end_spacing": None}
        elif cur is not None:
            cur["end"], cur["end_spacing"] = c["x"], c["x_after"] - c["x_before"]
            stretches.append(cur)
            cur = None
    if cur is not None:
        stretches.append(cur)
    out: dict[str, Any] = {"start": None, "end": None, "end_spacing": None, "changes": changes, "stretches": stretches,
                           "reversed_at_first": bool(nonzero.size and nonzero[0] < 0), "any_reversed": bool(stretches)}
    if not stretches:
        return out
    lo, hi = float(np.min(x)), float(np.max(x))

    def length(st: dict[str, Any]) -> float:
        return (hi if st["end"] is None else st["end"]) - (lo if st["start"] is None else st["start"])

    main = max(stretches, key=length)
    out.update({k: main[k] for k in ("start", "end", "end_spacing")})
    out["others"] = [st for st in stretches if st is not main]
    return out


def _line_x_ux(sample: dict[str, Any] | None) -> tuple[np.ndarray, np.ndarray]:
    if not sample or not sample.get("n_valid"):
        raise ValueError("no samples")
    pts = np.asarray(sample["sample_points"], dtype=float)
    return arrays(pts[:, 0], np.asarray(sample["U_x"], dtype=float))


def _pct(spacing: float | None, x: float | None) -> float | None:
    if spacing is None or not x:
        return None
    return 100.0 * 0.5 * spacing / abs(x)


def evaluate(plan: dict[str, Any], raw: Any) -> dict[str, Any]:
    variant = plan["variant"]
    g = GEOM[variant]
    s_m, h_m, big_h, down = g["S"] / 1000.0, g["h"] / 1000.0, g["H"] / 1000.0, g["down"] / 1000.0
    specs = _BY_VARIANT[variant]
    warnings: list[str] = []
    shown: dict[str, Any] = {}
    series: dict[str, Any] = {}
    values: dict[str, float | None] = {k: None for k in specs}
    details: dict[str, str] = {}
    unc: dict[str, dict[str, Any] | None] = {}
    lo, hi = FORWARD_WINDOW[0] * down, FORWARD_WINDOW[1] * down

    # The bulk speed and the Reynolds number as meshed (the inlet's flow and area).
    q_in, a_in = raw.patch_flow("inlet"), raw.patch_area("inlet")
    ub = U
    if q_in and a_in:
        ub = q_in / a_in
        h_mesh = a_in / (DEPTH_MM / 1000.0)
        shown.update({"ub_m_s": ub, "h_mesh_mm": h_mesh * 1000.0, "re_d_eff": ub * 2.0 * h_mesh / NU[variant]})
    else:
        warnings.append("no inlet flow or area from the monitors: U_b is the nominal 1 m/s")
    bal = raw.flow_balance()
    if bal and bal.get("in_m3s"):
        shown["imbalance_pct"] = 100.0 * bal.get("imbalance", 0.0)
    p_in = raw.patch_pressure("inlet")
    if p_in is not None:
        shown["inlet_p_Pa"] = p_in
    dyn = RHO * ub * ub

    # U_x on the lines 0.02 S from the floor and from the top: the cross-check, and what says
    # which sign of each wall's shear stress is forward.
    lines: dict[str, tuple[np.ndarray, np.ndarray]] = {}
    for key, name in (("floor_line", "floor"), ("top_line", "top")):
        try:
            lines[name] = _line_x_ux(raw.sample(key))
        except (ValueError, KeyError):
            warnings.append(f"no U_x line near the {name}: {raw.sample_problem(key)}")

    def wall(key: str, name: str) -> tuple[np.ndarray, np.ndarray] | None:
        try:
            x, t = wall_profile(raw.sample(key), x_min=0.0)
        except (ValueError, KeyError) as e:
            warnings.append(f"no wall shear stress on the {name}: {raw.sample_problem(key) if raw.sample(key) is None else e}")
            return None
        where = f"between {FORWARD_WINDOW[0]:g} and {FORWARD_WINDOW[1]:g} of the length after the step"
        sign = forward_sign(x, t, lo, hi)
        if sign is None:
            warnings.append(f"the {name}'s wall shear stress is not of one sign {where}, so which sign is forward is unknown")
            return None
        # The flow there must be forward for its sign to be forward's: U_x near the wall says so.
        if name in lines:
            lx, lu = lines[name]
            far = lu[(lx >= lo) & (lx <= hi)]
            if far.size == 0 or not np.all(far > 0):
                warnings.append(f"U_x 0.02 S from the {name} is not forward everywhere {where}, so which sign of its wall "
                                "shear stress is forward is unknown (the flow there is not attached)")
                return None
        else:
            warnings.append(f"the {name}'s wall shear stress taken as forward {where} without the near-wall line's check")
        shown[f"{name}_tau_forward_sign"] = sign
        shown[f"{name}_faces"] = int(x.size)
        fwd = t * sign
        keep = x <= PLOT_TO_S[variant] * s_m
        ds = downsample(x[keep] / s_m, 2.0 * fwd[keep] / dyn)
        series[f"{name}_cf"] = {"x_over_s": ds["x"], "cf": ds["y"]}
        return x, fwd

    floor = wall("floor_shear", "floor")
    if floor is not None:
        x, fwd = floor
        st = reversed_stretches(x, fwd)
        key = "x1_over_s" if variant == "re100" else "xr_over_s"
        if st["end"] is None:
            warnings.append("the floor's flow does not turn forward again after the step" if st["any_reversed"]
                            else "the floor's flow is nowhere reversed after the step")
        else:
            values[key] = st["end"] / s_m
            unc[key] = {"kind": "pct", "value": _pct(st["end_spacing"], st["end"]),
                        "what": "half the spacing of the two face centres around the zero"}
            details[key] = (f"x = {st['end'] * 1000:.3f} mm ({st['end'] / big_h:.3f} H) between face centres "
                            f"{st['end_spacing'] * 1000:.3f} mm apart; {x.size} floor faces")
            if st["start"] is not None:
                shown["corner_eddy_end_over_s"] = st["start"] / s_m
                if st["start"] > MAIN_EDDY_FROM_S * s_m:
                    warnings.append(f"the floor's longest reversed stretch starts {st['start'] / s_m:.3g} S after the step, "
                                    f"more than {MAIN_EDDY_FROM_S:g} S: it may not be the step's own eddy")
            shown["floor_sign_changes"] = len(st["changes"])
            shown["floor_other_reversed_over_s"] = [
                [None if o["start"] is None else o["start"] / s_m, None if o["end"] is None else o["end"] / s_m]
                for o in st.get("others") or []]
    top = wall("top_shear", "top")
    if top is not None:
        x, fwd = top
        st = reversed_stretches(x, fwd)
        shown["top_reversed"] = st["any_reversed"]
        if variant == "re800":
            if st["start"] is None or st["end"] is None:
                warnings.append("no bubble on the top wall after the step" if not st["any_reversed"]
                                else "the top wall's reversed flow does not start and end after the step")
            else:
                values["xs_top_over_s"] = st["start"] / s_m
                values["xr_top_over_s"] = st["end"] / s_m
                unc["xr_top_over_s"] = {"kind": "pct", "value": _pct(st["end_spacing"], st["end"]),
                                        "what": "half the spacing of the two face centres around the zero"}
                shown["top_bubble_over_s"] = (st["end"] - st["start"]) / s_m
                details["xs_top_over_s"] = f"x = {st['start'] * 1000:.3f} mm ({st['start'] / big_h:.3f} H)"
                details["xr_top_over_s"] = f"x = {st['end'] * 1000:.3f} mm ({st['end'] / big_h:.3f} H)"
        elif st["any_reversed"]:
            shown["top_reversed_from_over_s"] = (st["start"] / s_m) if st["start"] is not None else 0.0

    for name, (x, ux) in lines.items():
        st = reversed_stretches(x, ux)
        if name == "floor":
            keep = x <= PLOT_TO_S[variant] * s_m
            ds = downsample(x[keep] / s_m, ux[keep] / ub)
            series["floor_line"] = {"x_over_s": ds["x"], "ux": ds["y"]}
            if st["end"] is not None:
                shown["line_floor_reattachment_over_s"] = st["end"] / s_m
        else:
            if st["start"] is not None and st["end"] is not None:
                shown["line_top_separation_over_s"] = st["start"] / s_m
                shown["line_top_reattachment_over_s"] = st["end"] / s_m
            shown["line_top_reversed"] = st["any_reversed"]

    # The profile reaching the step, against the developed channel's parabola.
    prof = raw.sample("inlet_profile")
    if prof and prof.get("n_valid"):
        pts = np.asarray(prof["sample_points"], dtype=float)
        eta, u = arrays((pts[:, 1] - s_m) / h_m, np.asarray(prof["U_x"], dtype=float))
        if eta.size >= 3:
            para = 6.0 * eta * (1.0 - eta)
            dev = u / ub - para
            shown["profile_u_max_over_ub"] = float(np.max(u)) / ub
            shown["profile_max_dev"] = float(np.max(np.abs(dev)))
            series["inlet_profile"] = {"eta": [float(f"{v:.6g}") for v in eta.tolist()],
                                       "u": [float(f"{v:.6g}") for v in (u / ub).tolist()]}
    else:
        warnings.append(f"no profile reaching the step: {raw.sample_problem('inlet_profile')}")

    # The route against app_sampling on the floor line: the pressure, a scalar both read as it is.
    route = raw.line("p_floor_line")
    mine = raw.sample("floor_line")
    if route and route.get("n_valid") and mine and mine.get("p"):
        a, b = np.asarray(route["values"], dtype=float), np.asarray(mine["p"], dtype=float)
        if a.shape == b.shape:
            shown["route_vs_app_sampling_p_max_abs"] = float(np.max(np.abs(a - b)))
            shown["route_p_range"] = [float(a.min()), float(a.max())]
        else:
            warnings.append(f"Plot over path gave {a.size} samples of p, app_sampling {b.size}")
    # The Bubble probes (the value at each point).
    probes = []
    for mon in raw.monitor_rows():
        k = str(mon.get("key") or "")
        if k.startswith("probes_bubble_"):
            u_vec = (raw._last_point(mon) or {}).get("U")
            if isinstance(u_vec, list) and u_vec:
                probes.append(float(u_vec[0]))
    if probes:
        shown["bubble_probes_ux"] = probes
    rows = [compare(spec, values[k], detail=details.get(k, ""), uncertainty=unc.get(k)) for k, spec in specs.items()]
    return {"quantities": rows, "series": series, "shown": shown, "warnings": warnings}


def setup_words(result: dict[str, Any]) -> str:
    v = str(result.get("variant"))
    re = RE.get(v)
    return (
        f"A {geometry_words(v)} (STEP in mm, built with OCP: two boxes fused and unified); a custom fluid with "
        f"nu = {NU.get(v, 0):g} m²/s and rho = {RHO:g} kg/m³, so Re_D = U_b 2h / nu = {re}; a uniform velocity inlet of "
        f"{U:g} m/s normal to the face, a 0 Pa pressure outlet, every wall no-slip (the floor after the step and the top "
        "wall BCs of their own), the front and back one Symmetry (the 2D mesh's ends, solved empty); laminar, steady "
        f"(simpleFoam{', SIMPLEC' if SIMPLEC.get(v) else ''}), Accurate numerics, residual targets 1e-6, at most "
        f"{END_TIME.get(v)} iterations."
    )


def mesh_words(result: dict[str, Any]) -> str:
    mesh = result.get("setup", {}).get("mesh", {})
    fine = (mesh.get("settings") or {}).get("fineness")
    ref = (mesh.get("refinements") or [{}])[0]
    return (f"Hex-dominant at fineness {fine}, One cell across (2D) on, a custom size of {ref.get('default_size'):g} mm "
            f"on every wall with Refine out to {ref.get('reach'):g} mm (half the height: the whole channel), no wall "
            "layers; 1 non-orthogonal corrector")


def shown_words(result: dict[str, Any]) -> list[str]:
    from ..report import num

    s = result.get("shown") or {}
    v = str(result.get("variant"))
    bits: list[str] = []
    if s.get("ub_m_s") is not None:
        bits.append(f"the inlet channel as meshed {num(s['h_mesh_mm'], 5)} mm high, U_b {num(s['ub_m_s'], 5)} m/s, so "
                    f"Re_D {num(s['re_d_eff'], 5)}")
    if s.get("line_floor_reattachment_over_s") is not None:
        bits.append(f"U_x 0.02 S above the floor turns forward again at {num(s['line_floor_reattachment_over_s'], 4)} S "
                    "(the cross-check)")
    if s.get("corner_eddy_end_over_s") is not None:
        bits.append(f"a corner eddy at the step's foot, its forward flow on the floor to {num(s['corner_eddy_end_over_s'], 3)} S")
    if v == "re800":
        if s.get("top_bubble_over_s") is not None:
            bits.append(f"the top wall's bubble {num(s['top_bubble_over_s'], 4)} S long (Gartling 11.26 S; the literature "
                        "10.6 to 11.5 S)")
        if s.get("line_top_separation_over_s") is not None:
            bits.append(f"U_x 0.02 S below the top reversed from {num(s['line_top_separation_over_s'], 4)} to "
                        f"{num(s['line_top_reattachment_over_s'], 4)} S (the cross-check)")
    elif s.get("top_reversed") is not None:
        bits.append("no reversed flow on the top wall (Armaly et al.'s upper bubble appears near Re_D 400)"
                    if not s["top_reversed"] else
                    f"reversed flow on the top wall from {num(s.get('top_reversed_from_over_s'), 3)} S")
    if s.get("profile_max_dev") is not None:
        bits.append(f"the profile at x = -1 h: u_max {num(s['profile_u_max_over_ub'], 4)} U_b (the parabola 1.5), within "
                    f"{num(s['profile_max_dev'], 2)} U_b of 6 eta (1 - eta) U_b everywhere")
    if s.get("route_vs_app_sampling_p_max_abs") is not None:
        lo, hi = s.get("route_p_range") or [None, None]
        bits.append(f"Plot over path's p along the floor line and app_sampling's agree within "
                    f"{num(s['route_vs_app_sampling_p_max_abs'], 2)} Pa (p from {num(lo, 3)} to {num(hi, 3)} Pa)")
    if s.get("inlet_p_Pa") is not None:
        bits.append(f"the inlet's area-averaged pressure {num(s['inlet_p_Pa'], 4)} Pa"
                    + (f", flow out against in {num(s['imbalance_pct'], 2)} %" if s.get("imbalance_pct") is not None else ""))
    return bits


# ---------------------------------------------------------------------------------------- figures

FIGURES = (
    ("wall_shear", "wall shear stress"),
    ("near_floor", "U_x near the floor"),
    ("inlet_profile", "inlet profile"),
    ("residuals", "residuals"),
)
_NEEDS = {"wall_shear": "floor_cf", "near_floor": "floor_line", "inlet_profile": "inlet_profile", "residuals": "residuals"}


def has_figure(kind: str, result: dict[str, Any]) -> bool:
    return _NEEDS[kind] in (result.get("series") or {})


def _q(result: dict[str, Any], key: str) -> dict[str, Any]:
    return next((q for q in result.get("quantities") or [] if q["key"] == key), {})


def _err_text(q: dict[str, Any], name: str) -> str:
    if q.get("value") is None:
        return f"{name}: no value"
    return f"{name} {q['value']:.4g} S (reference {q['reference']['value']:g}, {q['error']['rel_pct']:+.2f} %)"


def draw(kind: str, result: dict[str, Any], ax: Any) -> None:
    from ..plots import INK, SECOND, SERIES

    s = result["series"]
    v = str(result.get("variant"))
    if kind == "wall_shear":
        f = s["floor_cf"]
        ax.plot(f["x_over_s"], f["cf"], color=SERIES, linewidth=1.6, label="floor (Magnusim)")
        if "top_cf" in s:
            t = s["top_cf"]
            ax.plot(t["x_over_s"], t["cf"], color=SECOND, linewidth=1.3, label="top wall (Magnusim)")
        ax.axhline(0.0, color=INK, linewidth=0.8)
        key = "x1_over_s" if v == "re100" else "xr_over_s"
        ref = (_q(result, key).get("reference") or {}).get("value")
        if ref is not None:
            ax.axvline(ref, color=INK, linestyle="--", linewidth=1.1,
                       label="Armaly et al. (1983), x1/S" if v == "re100" else "Gartling (1990), x_r/S")
        if v == "re800":
            ax.axvspan(*SCATTER_RANGE, color=INK, alpha=0.08, linewidth=0, label="2D literature, x_r/S")
            for k in ("xs_top_over_s", "xr_top_over_s"):
                r = (_q(result, k).get("reference") or {}).get("value")
                if r is not None:
                    ax.axvline(r, color=SECOND, linestyle=":", linewidth=1.1,
                               label="Gartling (1990), top bubble" if k == "xs_top_over_s" else None)
        ax.set_xlabel("x / S (from the step)")
        ax.set_ylabel("2 tau_x / (rho U_b²), forward > 0")
        lo, hi = ax.get_ylim()
        ax.set_ylim(lo, hi + 0.45 * (hi - lo))  # room for the legend above the curves
        ax.legend(loc="upper right", fontsize=7)
        text = [_err_text(_q(result, key), "x1/S" if v == "re100" else "x_r/S")]
        if v == "re800":
            text += [_err_text(_q(result, "xs_top_over_s"), "x_s/S"), _err_text(_q(result, "xr_top_over_s"), "x_r2/S")]
        # Upper left, in the room made above the curves (the top wall's curve runs along the bottom right).
        ax.text(0.02, 0.97, "\n".join(text), transform=ax.transAxes, ha="left", va="top", fontsize=8, color=INK,
                bbox={"boxstyle": "round,pad=0.35", "facecolor": "white", "edgecolor": "#d9d8d4"})
    elif kind == "near_floor":
        f = s["floor_line"]
        ax.plot(f["x_over_s"], f["ux"], color=SERIES, linewidth=1.6, label="U_x / U_b, 0.02 S above the floor")
        ax.axhline(0.0, color=INK, linewidth=0.8)
        key = "x1_over_s" if v == "re100" else "xr_over_s"
        val = _q(result, key).get("value")
        if val is not None:
            ax.axvline(val, color=SERIES, linestyle=":", linewidth=1.1, label="reattachment from the wall shear stress")
        ax.set_xlabel("x / S (from the step)")
        ax.set_ylabel("U_x / U_b")
        ax.legend(loc="lower right", fontsize=7)
    elif kind == "inlet_profile":
        p = s["inlet_profile"]
        eta = np.linspace(0.0, 1.0, 101)
        ax.plot(p["u"], p["eta"], color=SERIES, linewidth=1.6, label="Magnusim at x = -1 h")
        ax.plot(6.0 * eta * (1.0 - eta), eta, color=INK, linestyle="--", linewidth=1.1,
                label="developed: 6 eta (1 - eta) U_b")
        ax.set_xlabel("u / U_b")
        ax.set_ylabel("eta = (y - S) / h")
        ax.legend(loc="lower right", fontsize=7)
    elif kind == "residuals":
        h = s["residuals"]
        for i, k in enumerate(k for k in h if k != "t"):
            ax.semilogy(h["t"], h[k], color=(SERIES, SECOND, INK)[i % 3], linewidth=1.4, label=f"{k} (initial residual)")
        ax.axhline(1e-6, color=INK, linestyle=":", linewidth=1.0, label="target 1e-6")
        ax.set_xlabel("iteration")
        ax.set_ylabel("residual")
        ax.legend(loc="upper right")
