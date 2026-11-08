"""Case 6: the sphere in a uniform stream at Re 100 (3D, steady), on Hex-dominant.

One variant, as the reference data set it: ``re100``, steady and axisymmetric (simpleFoam),
against the drag coefficient Cd 1.09 (±5 %; the mean of the Schiller-Naumann and the Clift,
Grace & Weber correlations, Johnson & Patel's computed 1.08 beside it) and the recirculation
length L/D 0.88 (±7 %; Johnson & Patel, Taneda's measured 0.89 beside it); the separation angle
read from the wall shear stress the run saved, shown without a band.

The domain is a box round the sphere (D = 10 mm at the origin), the box the fluid: 8 D upstream
of the sphere's centre (the design's), 15 D downstream and 15 D to each side (the reference
data's: at least 15 D to each side and about 15 D downstream; blockage 0.09 %). All six sides are
one Freestream (1 m/s along +x, 0 Pa), the sphere a no-slip wall. The mesh: Hex-dominant at
fineness 4 (every side is refined to the walls' level 2), three custom sizes on the sphere, each
with a Refine out to (the design's gap G4), and an Inflate boundary layer on it, whose layers the
run asserts.
"""

from __future__ import annotations

import math
from typing import Any

import numpy as np

from ..extract import arrays, downsample, last_drift
from ..model import QuantitySpec, Tolerance, compare
from ..notes import and_list, precheck_note
from ..refs import read
from .c5_cylinder import closure_point, forces_table

ID = "c6_sphere"
TITLE = "Sphere"
GROUP = "External flow"
VARIANTS = ("re100",)
VARIANT_LABELS = {"re100": "Re = 100, steady, Hex-dominant"}
RE = {"re100": 100}

# The geometry (mm, the sphere's centre at the origin): the box's reach in diameters upstream,
# downstream and to each side.
D_MM = 10.0
UP_D, DOWN_D, HALF_D = 8.0, 15.0, 15.0
D = D_MM / 1000.0
U = 1.0
RHO = 1.0
NU = {v: U * D / re for v, re in RE.items()}
A_REF = math.pi * D * D / 4.0  # the sphere's frontal area
Q_A = 0.5 * RHO * U * U * A_REF

# The mesh: Hex-dominant at fineness 4 (the walls' level 2: the six sides at about 0.38 D), three
# custom sizes on the sphere (each a fraction of D, out to a distance in D from its wall) and an
# Inflate boundary layer of 4 layers, 0.06 D in all (the boundary layer at Re 100 is about
# D / sqrt(Re) = 0.1 D thick). A custom size becomes a level of the background's cell (15.1 mm on
# this box at fineness 4), so the cells come out at D/42, D/21 and D/10.5 (mesh_plan.py shows it
# before Generate). The mesh probes of 2026-11-06: 669 786 cells at fineness 4, 326 107 at 3.
FINENESS = 4
SIZES = (("Sphere", 1.0 / 32.0, 0.25), ("Near wake", 1.0 / 16.0, 1.5), ("Wake", 1.0 / 8.0, 3.0))
LAYERS = {"n_layers": 4, "total_thickness": round(0.06 * D_MM, 6)}
# The iteration limit (the run should stop on its residual targets of 1e-6 before it).
END_TIME = 2000
# The probes: 30 on the axis behind the sphere from 0.55 D to 3 D (the closure point is near
# 1.38 D from the centre).
WAKE_PROBES = 30
WAKE_PROBE_X_D = (0.55, 3.0)
# The axis line (app_sampling) from the sphere's back to 10 D.
WAKE_LINE_TO_D = 10.0
WAKE_LINE_SUBDIV = 1900
# The separation angle: the sphere's faces in bins of this many degrees of the angle from the
# front stagnation point, each bin's tangential wall shear stress their area-weighted mean; the
# attached flow's sign read from 20 to 90 degrees; the same per azimuth sector round the axis.
SEP_BIN_DEG = 2.0
SEP_FRONT = (20.0, 90.0)
SEP_SECTORS = 8

CD_REF = read("sphere_re100_cd.csv")
JP = read("sphere_re100.csv")
SCATTER = read("sphere_re100_scatter.csv")

_CD_HOW = ("the Forces monitor's drag coefficient on the sphere, its last value (the run stops on its residual "
           "targets): the study's reference values, speed 1 m/s, area pi D² / 4, drag along +x; recomputed from its "
           "drag force as a check")
_LD_HOW = ("the recirculation length: x0, where U_x on the axis behind the sphere (y = z = 0, sampled as Plot over path "
           "samples it with the components kept) turns from reversed to forward after the most reversed point, linearly "
           "interpolated between the two samples around it; L/D = (x0 - D/2) / D from the rear stagnation point")


def _specs(variant: str) -> dict[str, QuantitySpec]:
    cd = CD_REF.row(quantity="cd")
    ld = JP.row(quantity="l_over_d")
    return {
        "cd": QuantitySpec(
            key="cd",
            label="Drag coefficient Cd (Re 100)",
            unit="",
            how=_CD_HOW,
            source="route:/api/run/monitors",
            reference=CD_REF.reference(cd["value"], citation=str(cd["source"]),
                                       where=f"Cd {cd['value']:.2f} at Re 100: the reference data's value to use (section 6)"),
            tolerance=Tolerance(locked=True, rel_pct=5.0, note="the reference data's band: resolved computations spread about ±4 %"),
        ),
        "l_over_d": QuantitySpec(
            key="l_over_d",
            label="Recirculation length L/D (Re 100)",
            unit="D",
            how=_LD_HOW,
            source="app_sampling",
            reference=JP.reference(ld["value"], unit="D", citation=str(ld["source"]),
                                   where=f"L/D {ld['value']:.2f} at Re 100: the reference data's value to use (section 6)"),
            tolerance=Tolerance(locked=True, rel_pct=7.0, note="the reference data's band"),
        ),
    }


_BY_VARIANT = {v: _specs(v) for v in VARIANTS}
QUANTITIES: dict[str, QuantitySpec] = dict(_BY_VARIANT["re100"])


def quantities(variant: str) -> list[QuantitySpec]:
    return list(_BY_VARIANT[variant].values())


# The probes of 2026-11-06 at 4 cores, typed: they are not results. The same custom sizes at
# fineness 3 (cells D/34, D/17 and D/8.4) and 5 (D/53, D/26 and D/13, 4 of 4 layers kept), the
# reported mesh 1.26 times finer than the first and the second 1.26 times finer than it; and
# every custom size doubled at fineness 4.
PROBES = {
    "f3": {"cells": 326_107, "cd": 1.0914, "l_over_d": 0.8487, "theta": 53.3},
    "f5": {"cells": 1_359_124, "cd": 1.0929, "l_over_d": 0.8636, "theta": 53.5},
    "x2": {"cells": 166_824, "cd": 1.0853, "l_over_d": 0.8045},
}
RATIO = 1.26
# Full runs of the same settings before the reported one (2026-11-06), typed: they are not
# results. Iterations, Cd, L/D and the worst face's non-orthogonality.
EARLIER = (
    {"iterations": 549, "cd": 1.0925, "l_over_d": 0.8573, "non_ortho": 46.42},
    {"iterations": 548, "cd": 1.0925, "l_over_d": 0.8573, "non_ortho": 46.43},
)


def _richardson(coarse: float, mid: float, fine: float, r: float) -> float | None:
    """The value a mesh-converging series of three (each ``r`` times finer) heads for, or None
    when the differences do not shrink the same way (no order to speak of)."""
    d1, d2 = mid - coarse, fine - mid
    if d1 == 0 or d2 == 0 or (d2 / d1) <= 0 or (d2 / d1) >= 1:
        return None
    order = math.log(d1 / d2) / math.log(r)
    return fine + d2 / (r**order - 1.0)


def _note_mesh_moves(by: dict[str, dict[str, Any]]) -> str | None:
    """How much the probes' meshes move the reported values, and where L/D heads."""
    from ..report import cells_text, num, pct_text, quantity, rel_pct

    res = by.get("re100")
    cd, ld = quantity(res, "cd").get("value"), quantity(res, "l_over_d").get("value")
    if not res or cd is None or ld is None:
        return None
    theta = (res.get("shown") or {}).get("theta_s_deg")
    cells = (res.get("mesh") or {}).get("n_cells")
    f3, f5, x2 = PROBES["f3"], PROBES["f5"], PROBES["x2"]
    text = ("How much the mesh moves the answer (probes of 2026-11-06 at 4 cores, not reported): with the same sizes "
            f"at fineness 3 (cells D/34, D/17 and D/8.4: {cells_text(f3['cells'])} cells) Cd {num(f3['cd'], 5)}, L/D "
            f"{num(f3['l_over_d'], 4)} and the separation angle {num(f3['theta'], 3)}°; at fineness 5 (D/53, D/26 and "
            f"D/13: {cells_text(f5['cells'])} cells, 4 of 4 layers kept) {num(f5['cd'], 5)}, {num(f5['l_over_d'], 4)} "
            f"and {num(f5['theta'], 3)}°, against {num(cd, 5)}, {num(ld, 4)}"
            + (f" and {num(theta, 3)}°" if theta is not None else "")
            + f" on the reported {cells_text(cells)} cells: Cd moves by {pct_text(rel_pct(f5['cd'], cd))} % from the "
            f"reported mesh to one {RATIO:g} times finer, L/D by {pct_text(rel_pct(f5['l_over_d'], ld))} % "
            f"({pct_text(rel_pct(ld, f3['l_over_d']))} % from the coarser one to it)")
    ext = _richardson(f3["l_over_d"], float(ld), f5["l_over_d"], RATIO)
    if ext is not None:
        text += (f"; a Richardson extrapolation of L/D from the three gives about {num(ext, 2)} (rough: three meshes, "
                 "their own order)")
    text += (f". Every custom size doubled at fineness 4 ({cells_text(x2['cells'])} cells) gave Cd {num(x2['cd'], 5)} "
             f"and L/D {num(x2['l_over_d'], 4)} ({and_list([pct_text(rel_pct(x2['cd'], cd)), pct_text(rel_pct(x2['l_over_d'], ld))])} "
             "% from the reported run). The wake's band is a sphere round the sphere (Refine out to), so a finer wake "
             "costs cells upstream as well: the D/21 band, a shell from 0.75 D to 2 D from the centre, holds about "
             f"290 000 cells by its volume, of the reported mesh's {cells_text(cells)}.")
    return text


def _note_repeat(by: dict[str, dict[str, Any]]) -> str | None:
    """What earlier full runs of the same settings gave beside the reported one."""
    from ..report import num, quantity

    res = by.get("re100")
    if not res:
        return None
    r = res.get("run") or {}
    q = (res.get("mesh") or {}).get("quality") or {}
    earlier = and_list([f"Cd {num(e['cd'], 5)}, L/D {num(e['l_over_d'], 4)} after {e['iterations']} iterations (its worst "
                        f"face {num(e['non_ortho'], 4)}°)" for e in EARLIER])
    return (f"{'An earlier full run' if len(EARLIER) == 1 else 'Earlier full runs'} of the same settings (2026-11-06) "
            f"gave {earlier}; the reported run Cd {num(quantity(res, 'cd').get('value'), 5)}, L/D "
            f"{num(quantity(res, 'l_over_d').get('value'), 4)} after {r.get('iterations')} iterations (its worst face "
            f"{num(q.get('max_non_orthogonality'), 4)}°): snappyHexMesh in parallel is not bit for bit the same each "
            "time.")


NOTES = (
    "The values and bands are the reference data's (2026-11-04, section 6): Cd 1.09 ±5 % (the design's ±3 %), the mean "
    "of the Schiller-Naumann (1.0917) and Clift, Grace & Weber (1.0870) correlations, with Johnson & Patel's computed "
    "1.08 beside it; L/D 0.88 ±7 % (Johnson & Patel), compared (the design had it as information, ±10 %), with Taneda's "
    "measured 0.89 beside it; the separation angle shown without a band. The design's box (8 D to each side, 20 D "
    "downstream) is replaced by the reference data's: at least 15 D to each side and about 15 D downstream; upstream "
    "stays the design's 8 D.",
    "All six sides are one Freestream BC (OpenFOAM v2606's freestreamVelocity and freestreamPressure, which blend face "
    "by face between the free stream's value and zero gradient by how the flow meets the face: the velocity held where "
    "it comes in, the pressure, 0 Pa, where it goes out). The sphere is a no-slip wall.",
    "The mesh is Hex-dominant at fineness 4 (its background cells 15.1 to 15.3 mm, about 1.5 D; every side refined to "
    "the walls' level 2, about 0.38 D) with three custom sizes on the sphere, each with Refine out to (gap G4, landed): "
    "D/32 out to 0.25 D, D/16 out to 1.5 D and D/8 out to 3 D, which the mesher's levels make cells of D/42, D/21 and "
    "D/10.5. "
    "Refine out to is a distance from the wall, so each band is a spherical shell round the sphere (upstream too), "
    "not a box along the wake: there is still no box refinement. An Inflate boundary layer of 4 layers, 0.6 mm "
    "(0.06 D) in all, on the sphere; the run asserts that the layers were applied.",
    lambda by: _note_mesh_moves(by),
    lambda by: _note_repeat(by),
    lambda by: precheck_note(by, {"re100": "Re 100"}),
    "Reference confidence: every value is SECONDARY (the compilations arXiv:2309.08882 Table V and the notus-cfd "
    "sphere page; the MFIX-Exa sphere tutorial and python-fluids for the correlations' formulas). Johnson & Patel's "
    "paper was not read: their Cd is quoted as 1.08 by two sources and as 1.086 or 1.112 by single ones, their L/D as "
    "0.88 or 0.86. Schiller & Naumann's citation is from memory (UNCONFIRMED); the correlation values are computed "
    "from their formulas.",
    "L/D is read from U_x on the axis behind the sphere, sampled as Plot over path samples it with the velocity's "
    "components kept (Plot over path gives a vector's magnitude only, gap G2); the 30 axis probes are the "
    "cross-check. The separation angle is read from the wall shear stress the run saved on the sphere: its "
    "component along the meridian, from the front stagnation point towards the rear, averaged over the faces in "
    f"bins of {SEP_BIN_DEG:g} degrees of the angle from the front, turns where the flow separates; the same in "
    f"{SEP_SECTORS} sectors round the axis gives its spread (the faces are the snapped mesh's, not the exact sphere).",
)

# The run stops on its residual targets; one that stops at its iteration limit counts as
# settled only when the drag coefficient moved less than SETTLE_DRIFT over its last 10 %.
SETTLE = ({"monitor": "forces_sphere", "sample": "Cd", "label": "the sphere's drag coefficient"},)
SETTLE_DRIFT = 1e-3


def build_geometry_for(variant: str) -> Any:
    from ..geometry import box_with_sphere

    return box_with_sphere(-UP_D * D_MM, DOWN_D * D_MM, HALF_D * D_MM, D_MM)


def geometry_words(variant: str) -> str:
    return (f"a box x from {-UP_D:g} D to {DOWN_D:g} D and y and z from {-HALF_D:g} D to {HALF_D:g} D round a sphere "
            f"D = {D_MM:g} mm at the origin (cut out: the box is the fluid); blockage (pi D² / 4) / ({2 * HALF_D:g} D)² "
            f"= {100 * math.pi / 4 / (2 * HALF_D) ** 2:.2g} %")


def face_selectors(variant: str) -> dict[str, dict[str, Any]]:
    h = HALF_D * D_MM
    return {
        "inlet": {"plane": {"axis": "x", "at_mm": -UP_D * D_MM, "sign": -1}},
        "outlet": {"plane": {"axis": "x", "at_mm": DOWN_D * D_MM, "sign": 1}},
        "bottom": {"plane": {"axis": "y", "at_mm": -h, "sign": -1}},
        "top": {"plane": {"axis": "y", "at_mm": h, "sign": 1}},
        "front": {"plane": {"axis": "z", "at_mm": -h, "sign": -1}},
        "back": {"plane": {"axis": "z", "at_mm": h, "sign": 1}},
        "sphere": {"surface_type": "Sphere", "count": 1},
    }


def _forces(pid: str, name: str, bc: str) -> dict[str, Any]:
    # The Monitors dialog's Forces record; "@bc:<name>" is that BC's id (the driver fills it in).
    return {"id": pid, "name": name, "monitor_type": "forces", "kind": "Forces", "category": "Boundary data",
            "write_control": "Time step", "faces": [], "results": None, "series": None, "chart_values": None,
            "results_available": False, "boundaries": [f"@bc:{bc}"]}


def wake_probe_points() -> list[list[float]]:
    lo, hi = WAKE_PROBE_X_D
    return [[round(float(x) * D, 7), 0.0, 0.0] for x in np.linspace(lo, hi, WAKE_PROBES)]


def requests(variant: str, *, coarse: bool = False, cores: int = 4) -> dict[str, Any]:
    """What the driver sends, faces as selectors; plan.make_plan resolves them."""
    reference = {"ref_speed": U, "ref_area": A_REF, "ref_length": D, "ref_drag_dir": [1.0, 0.0, 0.0],
                 "ref_lift_dir": [0.0, 1.0, 0.0], "ref_cofr": [0.0, 0.0, 0.0]}
    settings = {"turbulence_model": "laminar", "numerics_preset": "accurate", "residual_u": 1e-6, "residual_p": 1e-6,
                "n_non_orthogonal": 1, **reference, "initial_flow": "inlet"}
    # Coarse: every custom size doubled (one level fewer), the same box, layers and run, so it
    # reads how much the mesh moves the answer.
    k = 2.0 if coarse else 1.0
    refinements: list[dict[str, Any]] = [
        {"name": name, "type": "Surface custom sizing", "faces": ["@sphere"], "sizing": "Custom",
         "default_size": round(k * frac * D_MM, 4), "default_size_unit": "mm",
         "reach": round(reach * D_MM, 6), "reach_unit": "mm"} for name, frac, reach in SIZES]
    refinements.append({"name": "Sphere layers", "type": "Inflate boundary layer", "faces": ["@sphere"], **LAYERS,
                        "total_thickness_unit": "mm"})
    controls = [
        _forces("rc-forces", "Sphere", "Sphere"),
        {"id": "rc-wake", "name": "Wake axis", "monitor_type": "probe", "kind": "Point probe", "category": "Point data",
         "write_control": "Time step", "faces": [], "results": None, "series": None, "chart_values": None,
         "results_available": False, "points": wake_probe_points()},
    ]
    wake_line = [[0.5 * D, 0.0, 0.0], [WAKE_LINE_TO_D * D, 0.0, 0.0]]
    return {
        "project": {"title": f"Validation {ID} {variant}", "description": "", "category": "Other",
                    "units": "Metric", "folder": "My Projects"},
        "study": {"analysis_type": "incompressible_steady", "time_dependency": "Steady-state", "name": f"{ID} {variant}",
                  "settings": settings},
        "material": {"preset": "custom", "name": "Validation fluid", "kinematic_viscosity": NU[variant], "density": RHO,
                     "assigned_volumes": ["Body1"]},
        "bcs": [
            {"name": "Far field", "bc_type": "Freestream", "velocity_input": "Speed and direction", "value": U,
             "unit": "m/s", "vector": [1.0, 0.0, 0.0], "freestream_pressure": 0,
             "faces": ["@inlet", "@outlet", "@bottom", "@top", "@front", "@back"]},
            # A new face-by-face Wall starts Slip: the treatment is always sent.
            {"name": "Sphere", "bc_type": "Wall", "wall_type": "No-slip", "faces": ["@sphere"]},
        ],
        "mesh": {
            "name": "Mesh 1",
            "settings": {
                "fineness": FINENESS,
                "automatic_boundary_layers": False,
                "physics_based_meshing": True,
                "hex_element_core": True,
                "advanced": {"mesh_engine": "snappy_hexdominant"},
            },
            "refinements": refinements,
            "expect": {"layers": True, "n_cells": [300_000, 1_200_000] if not coarse else [80_000, 400_000]},
        },
        "run": {"name": "Validation", "endTime": END_TIME, "writeInterval": END_TIME, "cores": int(cores),
                "result_controls": controls},
        "extract": [
            {"key": "wake_line", "kind": "app_sampling", "fields": ["U", "p"], "points_m": wake_line,
             "subdivisions": WAKE_LINE_SUBDIV},
            # The route's own reading of the same line, a scalar it gives as it is: the check that
            # app_sampling reads what Plot over path reads.
            {"key": "p_wake_line", "kind": "line", "field": "p", "points_m": wake_line, "subdivisions": WAKE_LINE_SUBDIV},
            {"key": "sphere_shear", "kind": "patch", "patch": "sphere", "field": "wallShearStress"},
        ],
        "timeouts_s": {"mesh": 2400, "solve": 3600},
    }


# ---------------------------------------------------------------------------------------- evaluate

def _meridian(sample: dict[str, Any]) -> dict[str, np.ndarray] | None:
    """Each face of the sphere: its angle from the front stagnation point (degrees), its azimuth
    round the x axis (degrees), its area and the wall shear stress's component along the
    meridian, pointing from the front towards the rear (the direction attached flow takes)."""
    if not sample or not sample.get("n") or not all(k in sample for k in ("x", "y", "z")):
        return None
    x, y, z = (np.asarray(sample[k], dtype=float) for k in ("x", "y", "z"))
    tx, ty, tz = (np.asarray(sample[f"wallShearStress_{c}"], dtype=float) for c in "xyz")
    area = np.asarray(sample.get("area") or [1.0] * x.size, dtype=float)
    r = np.sqrt(x * x + y * y + z * z)
    rho = np.hypot(y, z)
    ok = (r > 0) & (rho > 1e-9 * np.maximum(r, 1e-30))
    phi = np.arccos(np.clip(-x[ok] / r[ok], -1.0, 1.0))
    ey, ez = y[ok] / rho[ok], z[ok] / rho[ok]
    # e_phi = (sin phi, cos phi e_rho): along the meridian, from the front towards the rear.
    tang = tx[ok] * np.sin(phi) + (ty[ok] * ey + tz[ok] * ez) * np.cos(phi)
    return {"deg": np.degrees(phi), "azimuth": np.degrees(np.arctan2(z[ok], y[ok])) % 360.0, "area": area[ok],
            "tang": tang}


def _binned(deg: np.ndarray, tang: np.ndarray, area: np.ndarray, width: float) -> tuple[np.ndarray, np.ndarray]:
    edges = np.arange(0.0, 180.0 + width, width)
    idx = np.clip(np.digitize(deg, edges) - 1, 0, edges.size - 2)
    centres, means = [], []
    for i in range(edges.size - 1):
        sel = idx == i
        if sel.any() and area[sel].sum() > 0:
            centres.append(0.5 * (edges[i] + edges[i + 1]))
            means.append(float(np.sum(tang[sel] * area[sel]) / np.sum(area[sel])))
    return np.asarray(centres), np.asarray(means)


def _turn(deg: np.ndarray, tang: np.ndarray) -> float | None:
    """The angle from the front where the binned tangential shear first turns from its sign in the
    attached flow (``SEP_FRONT``) to the other, going towards the rear; None when it never does or
    the front's sign is not one sign."""
    front = tang[(deg >= SEP_FRONT[0]) & (deg <= SEP_FRONT[1])]
    if front.size < 3 or not (np.all(front > 0) or np.all(front < 0)):
        return None
    fwd = tang * (1.0 if front[0] > 0 else -1.0)
    for i in range(1, deg.size):
        if deg[i] > SEP_FRONT[1] and fwd[i - 1] > 0 >= fwd[i]:
            f = fwd[i - 1] / (fwd[i - 1] - fwd[i])
            return float(deg[i - 1] + f * (deg[i] - deg[i - 1]))
    return None


def separation_angle(sample: dict[str, Any] | None) -> dict[str, Any] | None:
    """The separation angle (degrees from the rear stagnation point): where the wall shear stress
    along the meridian, averaged over the sphere's faces in bins of ``SEP_BIN_DEG`` of the angle
    from the front, turns from its attached sign to the other, going from the front towards the
    rear (the zero linearly interpolated between the two bins around it); the same in each of
    ``SEP_SECTORS`` sectors round the axis, for its spread. None when the shear never turns."""
    m = _meridian(sample) if sample else None
    if m is None:
        return None
    deg, tang = _binned(m["deg"], m["tang"], m["area"], SEP_BIN_DEG)
    front = _turn(deg, tang)
    if front is None:
        return None
    sectors = []
    width = 360.0 / SEP_SECTORS
    for s in range(SEP_SECTORS):
        sel = (m["azimuth"] >= s * width) & (m["azimuth"] < (s + 1) * width)
        if sel.sum() < 10:
            continue
        d, t = _binned(m["deg"][sel], m["tang"][sel], m["area"][sel], SEP_BIN_DEG)
        a = _turn(d, t)
        if a is not None:
            sectors.append(180.0 - a)
    out: dict[str, Any] = {"deg": 180.0 - front, "deg_from_front": front, "faces": int(m["deg"].size),
                           "bin_deg": SEP_BIN_DEG, "sectors": [round(v, 3) for v in sectors]}
    if len(sectors) >= 2:
        out["spread_deg"] = float(max(sectors) - min(sectors))
    out["profile"] = {"deg": [round(float(v), 3) for v in deg], "tang": [float(f"{v:.5g}") for v in tang]}
    return out


def _ld(x0: float) -> float:
    return (x0 - 0.5 * D) / D


def _line_x_ux(sample: dict[str, Any] | None) -> tuple[np.ndarray, np.ndarray]:
    if not sample or not sample.get("n_valid"):
        raise ValueError("no samples")
    pts = np.asarray(sample["sample_points"], dtype=float)
    return arrays(pts[:, 0], np.asarray(sample["U_x"], dtype=float))


def evaluate(plan: dict[str, Any], raw: Any) -> dict[str, Any]:
    variant = plan["variant"]
    specs = _BY_VARIANT[variant]
    warnings: list[str] = []
    shown: dict[str, Any] = {}
    series: dict[str, Any] = {}
    values: dict[str, float | None] = {k: None for k in specs}
    details: dict[str, str] = {}
    unc: dict[str, dict[str, Any] | None] = {}

    bal = raw.flow_balance()
    if bal and bal.get("in_m3s"):
        shown["imbalance_pct"] = 100.0 * bal.get("imbalance", 0.0)
    route = raw.line("p_wake_line")
    mine = raw.sample("wake_line")
    if route and route.get("n_valid") and mine and mine.get("p"):
        a, b = np.asarray(route["values"], dtype=float), np.asarray(mine["p"], dtype=float)
        if a.shape == b.shape:
            shown["route_vs_app_sampling_p_max_abs"] = float(np.max(np.abs(a - b)))
            shown["route_p_range"] = [float(a.min()), float(a.max())]
        else:
            warnings.append(f"Plot over path gave {a.size} samples of p on the axis, app_sampling {b.size}")

    f = forces_table(raw, "forces_sphere")
    if not f:
        warnings.append("the Forces monitor on the sphere gave no history")
    else:
        values["cd"] = float(f["Cd"][-1])
        shown["cd_from_fd"] = float(f["Fd_N"][-1]) / Q_A
        shown["cdp"] = float(f["Fdp_N"][-1]) / Q_A
        shown["cdv"] = float(f["Fdv_N"][-1]) / Q_A
        shown["cl_last"] = float(f["Cl"][-1])
        drift = last_drift(f["Cd"].tolist())
        if drift is not None:
            shown["cd_drift_last10_pct"] = 100.0 * drift
        details["cd"] = (f"at iteration {int(f['t'][-1])}; from its drag force {shown['cd_from_fd']:.5g} "
                         f"(F_d / (0.5 rho U² pi D² / 4))")
        ds = downsample(f["t"], f["Cd"], 300)
        series["cd_history"] = {"it": ds["x"], "cd": ds["y"]}
        # Axisymmetric flow pushes the sphere along the stream only: the force across it (y and z)
        # against the drag.
        for mon in raw.monitor_rows():
            if str(mon.get("key") or "") == "forces_sphere":
                last = mon.get("last") or {}
                vec = last.get("F_N") if isinstance(last, dict) else None
                if isinstance(vec, list) and len(vec) == 3 and float(f["Fd_N"][-1]):
                    shown["cross_force_over_drag"] = math.hypot(float(vec[1]), float(vec[2])) / abs(float(f["Fd_N"][-1]))

    try:
        x, ux = _line_x_ux(raw.sample("wake_line"))
        c = closure_point(x, ux)
        keep = x <= 4.0 * D
        ds = downsample(x[keep] / D, ux[keep] / U)
        series["wake_line"] = {"x_over_d": ds["x"], "ux": ds["y"]}
        if c is None:
            warnings.append("U_x on the axis is nowhere reversed behind the sphere, or never turns forward again")
        else:
            values["l_over_d"] = _ld(c["x"])
            unc["l_over_d"] = {"kind": "pct", "value": 100.0 * 0.5 * c["spacing"] / (c["x"] - 0.5 * D),
                               "what": "half the spacing of the two samples around the zero"}
            details["l_over_d"] = (f"x0 = {c['x'] * 1000:.3f} mm ({c['x'] / D:.4f} D from the centre); the most reversed "
                                   f"U_x {c['u_min']:.4g} m/s at {c['x_u_min'] / D:.3f} D")
            shown["u_min_wake"] = c["u_min"]
            shown["x_u_min_over_d"] = c["x_u_min"] / D
    except (ValueError, KeyError):
        warnings.append(f"no U_x line on the axis: {raw.sample_problem('wake_line')}")

    pts = raw.probe_values("Wake axis")
    if pts:
        series["probes_wake"] = {"x_over_d": [p[0] / D for p in pts], "ux": [p[1] / U for p in pts]}
        if len(pts) >= 3:
            pc = closure_point(np.asarray([p[0] for p in pts]), np.asarray([p[1] for p in pts]))
            if pc is not None:
                shown["probes_l_over_d"] = _ld(pc["x"])
    shear = raw.sample("sphere_shear")
    sep = separation_angle(shear)
    if sep is not None:
        shown["theta_s_deg"] = sep["deg"]
        shown["sphere_faces"] = sep["faces"]
        shown["theta_s_sectors_deg"] = sep["sectors"]
        if "spread_deg" in sep:
            shown["theta_s_spread_deg"] = sep["spread_deg"]
        series["shear_profile"] = sep["profile"]
    elif shear is None:
        warnings.append(f"no wall shear stress on the sphere: {raw.sample_problem('sphere_shear')}")
    else:
        warnings.append("the wall shear stress along the sphere never turns from its attached sign: no separation angle")
    rows = [compare(spec, values[k], detail=details.get(k, ""), uncertainty=unc.get(k)) for k, spec in specs.items()]
    return {"quantities": rows, "series": series, "shown": shown, "warnings": warnings}


def setup_words(result: dict[str, Any]) -> str:
    v = str(result.get("variant"))
    return (f"The domain is {geometry_words(v)} (STEP in mm, built with OCP: a box with the sphere cut out); a custom "
            f"fluid with nu = {NU.get(v, 0):g} m²/s and rho = {RHO:g} kg/m³, so Re = U D / nu = {RE.get(v)}; all six "
            f"sides one Freestream of {U:g} m/s along +x and 0 Pa, the sphere a no-slip wall; laminar; the study's "
            "reference values speed 1 m/s, area pi D² / 4 = 7.854e-5 m², length D, drag +x, lift +y, centre of "
            f"rotation the sphere's centre; a Forces monitor on the sphere and {WAKE_PROBES} Point probes on the axis "
            f"behind it; steady (simpleFoam), Accurate numerics, residual targets 1e-6, at most {END_TIME} iterations, "
            "starting from the free stream's velocity.")


def mesh_words(result: dict[str, Any]) -> str:
    mesh = result.get("setup", {}).get("mesh", {})
    fine = (mesh.get("settings") or {}).get("fineness")
    refs = mesh.get("refinements") or []
    sizes = ", ".join(f"{r.get('name')} {r.get('default_size'):g} mm out to {r.get('reach'):g} mm"
                      for r in refs if r.get("type") == "Surface custom sizing")
    lay = next((r for r in refs if r.get("type") == "Inflate boundary layer"), None)
    layers = (f"an Inflate boundary layer of {lay.get('n_layers')} layers, {lay.get('total_thickness'):g} mm in all, on "
              "the sphere" if lay else "no wall layers")
    return (f"Hex-dominant at fineness {fine}, custom sizes on the sphere with Refine out to ({sizes}), {layers}; "
            "1 non-orthogonal corrector")


def _num(v: Any, digits: int = 4) -> str:
    from ..report import num

    return num(v, digits)


def literature_words() -> str:
    """The literature's spread beside the compared values (refs/sphere_re100_scatter.csv)."""
    cds = [float(r["cd"]) for r in SCATTER.rows if isinstance(r.get("cd"), (int, float))]
    lds = [float(r["l_over_d"]) for r in SCATTER.rows if isinstance(r.get("l_over_d"), (int, float))]
    return (f"the resolved computations the reference data list at Re 100: Cd {_num(min(cds))} to {_num(max(cds))}, L/D "
            f"{_num(min(lds))} to {_num(max(lds))} with Taneda's measured 0.89 (refs/sphere_re100_scatter.csv)")


def shown_words(result: dict[str, Any]) -> list[str]:
    s = result.get("shown") or {}
    bits: list[str] = []
    sn = CD_REF.value(quantity="cd_schiller_naumann")
    cgw = CD_REF.value(quantity="cd_clift_grace_weber")
    jp = JP.value(quantity="cd")
    bits.append(f"the correlations at Re 100: Schiller-Naumann {_num(sn, 5)}, Clift, Grace & Weber {_num(cgw, 5)}; "
                f"Johnson & Patel's computed Cd {_num(jp, 3)}")
    if s.get("cdp") is not None:
        bits.append(f"the drag's pressure part Cdp {_num(s['cdp'], 4)} and viscous part Cdv {_num(s['cdv'], 4)}")
    if s.get("cd_from_fd") is not None:
        bits.append(f"Cd from the drag force {_num(s['cd_from_fd'], 5)}; the lift coefficient {_num(s.get('cl_last'), 2)}")
    if s.get("cross_force_over_drag") is not None:
        bits.append(f"the force across the stream {_num(100 * s['cross_force_over_drag'], 2)} % of the drag")
    if s.get("cd_drift_last10_pct") is not None:
        bits.append(f"Cd moved {_num(s['cd_drift_last10_pct'], 2)} % over the last 10 % of iterations")
    if s.get("probes_l_over_d") is not None:
        bits.append(f"the axis probes close the bubble at L/D {_num(s['probes_l_over_d'], 4)} (the cross-check)")
    if s.get("theta_s_deg") is not None:
        sec = s.get("theta_s_sectors_deg") or []
        spread = (f", {len(sec)} sectors round the axis from {_num(min(sec), 3)}° to {_num(max(sec), 3)}°"
                  if len(sec) >= 2 else "")
        ref = JP.value(quantity="theta_s_deg")
        bits.append(f"the separation angle {_num(s['theta_s_deg'], 3)}° from the rear stagnation point, where the wall "
                    f"shear stress along the meridian turns ({_num(s.get('sphere_faces'), 5)} faces in "
                    f"{SEP_BIN_DEG:g}° bins{spread}; Johnson & Patel about {ref:g}°)")
    bits.append(literature_words())
    if s.get("route_vs_app_sampling_p_max_abs") is not None:
        lo, hi = s.get("route_p_range") or [None, None]
        diff = float(s["route_vs_app_sampling_p_max_abs"])
        agree = "agree exactly" if diff == 0 else f"agree within {_num(diff, 2)} Pa"
        bits.append(f"Plot over path's p along the axis and app_sampling's {agree} (p from {_num(lo, 3)} to "
                    f"{_num(hi, 3)} Pa)")
    if s.get("imbalance_pct") is not None:
        bits.append(f"flow out of the far field against in {_num(s['imbalance_pct'], 2)} %")
    return bits


# ---------------------------------------------------------------------------------------- figures

FIGURES = (
    ("wake", "U_x on the axis behind the sphere"),
    ("cd_history", "drag coefficient"),
    ("shear", "wall shear stress along the meridian"),
    ("residuals", "residuals"),
)
_NEEDS = {"wake": "wake_line", "cd_history": "cd_history", "shear": "shear_profile", "residuals": "residuals"}


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
    if kind == "wake":
        w = s["wake_line"]
        ax.plot(w["x_over_d"], w["ux"], color=SERIES, linewidth=1.6, label="U_x / U on the axis (Magnusim)")
        if "probes_wake" in s:
            p = s["probes_wake"]
            ax.plot(p["x_over_d"], p["ux"], "o", color=SECOND, markersize=3.5, label="axis probes")
        ax.axhline(0.0, color=INK, linewidth=0.8)
        q = _q(result, "l_over_d")
        ref = (q.get("reference") or {}).get("value")
        if ref is not None:
            ax.axvline(0.5 + ref, color=INK, linestyle="--", linewidth=1.1, label="reference closure point")
        ax.set_xlabel("x / D (from the sphere's centre)")
        ax.set_ylabel("U_x / U")
        ax.legend(loc="upper left", fontsize=7)
        note(ax, _err_text(q, "L/D") + "\n" + _err_text(_q(result, "cd"), "Cd"))
    elif kind == "cd_history":
        h = s["cd_history"]
        ax.plot(h["it"], h["cd"], color=SERIES, linewidth=1.6, label="Cd (Forces monitor)")
        ref = (_q(result, "cd").get("reference") or {}).get("value")
        if ref is not None:
            ax.axhline(ref, color=INK, linestyle="--", linewidth=1.1, label="reference")
            ax.set_ylim(0.0, 2.0 * ref)
        ax.set_xlabel("iteration")
        ax.set_ylabel("Cd")
        ax.legend(loc="upper right", fontsize=7)
    elif kind == "shear":
        p = s["shear_profile"]
        deg = np.asarray(p["deg"], dtype=float)
        tang = np.asarray(p["tang"], dtype=float)
        # Plotted with the attached flow's sign positive, against the angle from the rear.
        front = tang[(deg >= SEP_FRONT[0]) & (deg <= SEP_FRONT[1])]
        sign = 1.0 if front.size == 0 or front[0] > 0 else -1.0
        ax.plot(180.0 - deg, sign * tang, color=SERIES, linewidth=1.4,
                label=f"wall shear stress along the meridian ({SEP_BIN_DEG:g}° bins, attached > 0)")
        ax.axhline(0.0, color=INK, linewidth=0.8)
        # Room above the curve for the legend and below it for the note.
        lo, hi = float(np.min(sign * tang)), float(np.max(sign * tang))
        span = (hi - lo) or 1.0
        ax.set_ylim(lo - 0.3 * span, hi + 0.35 * span)
        theta = (result.get("shown") or {}).get("theta_s_deg")
        ref = JP.value(quantity="theta_s_deg")
        ax.axvline(ref, color=INK, linestyle="--", linewidth=1.1, label=f"Johnson & Patel, about {ref:g}°")
        ax.set_xlim(180.0, 0.0)
        ax.set_xlabel("angle from the rear stagnation point (degrees)")
        ax.set_ylabel("tau_w (Pa at rho = 1)")
        ax.legend(loc="upper right", fontsize=7)
        if theta is not None:
            note(ax, f"separation {theta:.3g}° from the rear (shown, no band)")
    elif kind == "residuals":
        h = s["residuals"]
        for i, k in enumerate(k for k in h if k != "t"):
            ax.semilogy(h["t"], h[k], color=(SERIES, SECOND, INK)[i % 3], linewidth=1.4, label=f"{k} (initial residual)")
        ax.axhline(1e-6, color=INK, linestyle=":", linewidth=1.0, label="target 1e-6")
        ax.set_xlabel("iteration")
        ax.set_ylabel("residual")
        ax.legend(loc="upper right")
