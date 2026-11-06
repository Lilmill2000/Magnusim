"""Case 5: the circular cylinder in a uniform stream (2D), on Hex-dominant one cell across.

Three variants, as the reference data set them:

- ``re20`` and ``re40``: steady (simpleFoam), against Cd 2.02 and 1.50 and the recirculation
  length L/D 0.93 and 2.24 (both ±5 %); the pressure and viscous parts of the drag and the
  separation angle shown;
- ``re100``: transient (pimpleFoam), the vortex street, against the Strouhal number 0.164
  (±3 %), the mean Cd 1.33 (±5 %), the lift coefficient's rms 0.23 (±15 %) and the mean L/D
  1.41 (±10 %, as information), each over whole shedding periods after the transient.

The domain is what the reference data ask for: 40 D wide (blockage 2.5 %), 15 D upstream of the
cylinder's centre and 30 D after it, D = 10 mm and 5 mm deep in z. Its four sides are one
Freestream (1 m/s along +x, 0 Pa), the cylinder a no-slip wall, the front and the back one
Symmetry, which One cell across (2D) meshes one cell deep and the solve makes the 2D mesh's
empty ends. The mesh rings the cylinder with three custom sizes, each with a Refine out to (the
design's gap G4): D/48 out to 0.5 D, D/24 out to 3 D and D/12 out to 8 D.

The app has no mean or frequency of a monitor over a time window (gap G8): the harness reads the
Forces monitor's history (``extract.settled_window``, ``spectrum_peak``, ``time_mean``).
"""

from __future__ import annotations

import math
from typing import Any

import numpy as np

from ..extract import (
    arrays,
    downsample,
    last_drift,
    settled_window,
    sign_changes,
    spectrum_peak,
    time_mean,
    time_rms,
)
from ..model import QuantitySpec, Tolerance, compare
from ..notes import and_list, precheck_note
from ..refs import read

ID = "c5_cylinder"
TITLE = "Circular cylinder"
GROUP = "External flow"
VARIANTS = ("re20", "re40", "re100")
VARIANT_LABELS = {
    "re20": "Re = 20, steady, Hex-dominant (2D)",
    "re40": "Re = 40, steady, Hex-dominant (2D)",
    "re100": "Re = 100, transient (shedding), Hex-dominant (2D)",
}
RE = {"re20": 20, "re40": 40, "re100": 100}
TRANSIENT = {"re20": False, "re40": False, "re100": True}

# The geometry (mm, the cylinder's centre at the origin): the domain's reach in diameters
# upstream, downstream and to each side, and its depth.
D_MM = 10.0
UP_D, DOWN_D, HALF_D = 15.0, 30.0, 20.0
DEPTH_MM = 5.0
D = D_MM / 1000.0
DEPTH = DEPTH_MM / 1000.0
ZM = DEPTH / 2.0  # mid-depth (m): every line and probe lies there
U = 1.0
RHO = 1.0
NU = {v: U * D / re for v, re in RE.items()}
A_REF = D * DEPTH  # the reference area: the cylinder's frontal area on the 2D mesh's depth
Q_A = 0.5 * RHO * U * U * A_REF

# The mesh: Hex-dominant at fineness 6, One cell across (2D), three custom sizes on the cylinder
# (each a fraction of D, out to a distance in D from its wall). A custom size becomes a level of
# the background's cell (12 mm at fineness 6 on this section), so the cells are D/53, D/27 and
# D/13 (mesh_plan.py shows it before Generate).
FINENESS = 6
SIZES = (("Cylinder", 1.0 / 48.0, 0.5), ("Near wake", 1.0 / 24.0, 3.0), ("Wake", 1.0 / 12.0, 8.0))
# Steady: the iteration limit (each run should stop on its residual targets of 1e-6 before it).
END_TIME = 3000
# Re 100: 300 D/U of flow (about 49 shedding periods at St 0.164), 50 Result frames (a frame
# every 6 D/U; the monitors write at a fiftieth of that, every 0.12 D/U: about 51 samples per
# period), the time step adjusted to a Courant number of 1, second-order backward in time, 2
# pressure correctors and 1 non-orthogonal corrector; the time averages (UMean) from half way.
T_END = 3.0
FRAMES = 50
AVERAGE_FROM = 1.5
# The starting flow of Re 100: Custom, U_y 0.05 m/s across the stream, so the wake starts
# lopsided and sheds within the run instead of waiting for round-off to break its symmetry.
START_UY = 0.05
# The probes: 30 on the wake axis from 0.55 D to 6 D, and one off it for the shedding signal.
WAKE_PROBES = 30
WAKE_PROBE_X_D = (0.55, 6.0)
SHEDDING_PROBE_D = (2.0, 0.5)
# The wake axis line (app_sampling) from the cylinder's back to 10 D.
WAKE_LINE_TO_D = 10.0
WAKE_LINE_SUBDIV = 1900
# The shedding window: settled when the last 5 periods' lift amplitudes agree within 2 %, from
# the first period within 2 % of that, and at least 20 whole periods (the reference data).
SETTLE_REL = 0.02
SETTLE_PERIODS = 5
MIN_PERIODS = 20
# Fewer monitor samples per shedding period than this, and the history is too coarse.
MIN_SAMPLES_PER_PERIOD = 40

STEADY = read("cylinder_re20_re40.csv")
STEADY_SCATTER = read("cylinder_steady_scatter.csv")
RE100 = read("cylinder_re100.csv")
RE100_SCATTER = read("cylinder_re100_scatter.csv")


def _ref100(quantity: str) -> dict[str, Any]:
    return RE100.row(quantity=quantity)


_CD_HOW = ("the Forces monitor's drag coefficient on the cylinder ({what}): the study's reference values, speed 1 m/s, "
           "area D x depth (the 2D mesh's span), drag along +x; recomputed from its drag force as a check")
_LD_STEADY_HOW = ("the recirculation length: x0, where U_x on the wake axis (y = 0 at mid-depth, sampled as Plot over path "
                  "samples it with the components kept) turns from reversed to forward after the most reversed point "
                  "behind the cylinder, linearly interpolated between the two samples around it; L/D = (x0 - D/2) / D "
                  "from the cylinder's back")
_WINDOW_WORDS = ("over the window of whole shedding periods after the transient (from the first period whose lift "
                 "amplitude is within 2 % of the settled one, the last 5 periods' amplitudes agreeing within 2 %; at "
                 "least 20 periods)")


def _specs(variant: str) -> dict[str, QuantitySpec]:
    re = RE[variant]
    tag = f"Re {re}"
    if variant in ("re20", "re40"):
        cd = STEADY.row(re=re, quantity="cd")
        ld = STEADY.row(re=re, quantity="l_over_d")
        return {
            "cd": QuantitySpec(
                key="cd",
                label=f"Drag coefficient Cd ({tag})",
                unit="",
                how=_CD_HOW.format(what="its last value; the run stops on its residual targets"),
                source="route:/api/run/monitors",
                reference=STEADY.reference(cd["value"], citation=str(cd["source"]),
                                           where=f"Re {re}, Cd {cd['value']:.2f}: the reference data's value to use "
                                                 "(section 5a)"),
                tolerance=Tolerance(rel_pct=5.0, note="the reference data's band: the sources' spread and the domain's "
                                    "size"),
            ),
            "l_over_d": QuantitySpec(
                key="l_over_d",
                label=f"Recirculation length L/D ({tag})",
                unit="D",
                how=_LD_STEADY_HOW,
                source="app_sampling",
                reference=STEADY.reference(ld["value"], unit="D", citation=str(ld["source"]),
                                           where=f"Re {re}, L/D {ld['value']:.2f}: the reference data's value to use "
                                                 "(section 5a)"),
                tolerance=Tolerance(rel_pct=5.0, note="the reference data's band"),
            ),
        }
    st, cdm, clr, ldm = (_ref100(q) for q in ("st", "cd_mean", "cl_rms", "l_over_d_mean"))
    return {
        "st": QuantitySpec(
            key="st",
            label=f"Strouhal number St = f D / U ({tag})",
            unit="",
            how=("f, the peak of the lift coefficient's spectrum " + _WINDOW_WORDS + ": the Forces monitor's Cl "
                 "resampled evenly, a Hann window, zero padded 8 times, the peak refined by a parabola through the "
                 "logarithms of its three highest bins; the mean period between the window's up-crossings as the "
                 "cross-check"),
            source="route:/api/run/monitors",
            reference=RE100.reference(st["value"], citation=str(st["source"]), where="St at Re 100 (section 5b)"),
            tolerance=Tolerance(rel_pct=3.0, note="the reference data's band"),
        ),
        "cd_mean": QuantitySpec(
            key="cd_mean",
            label=f"Mean drag coefficient ({tag})",
            unit="",
            how=_CD_HOW.format(what="its time mean " + _WINDOW_WORDS),
            source="route:/api/run/monitors",
            reference=RE100.reference(cdm["value"], citation=str(cdm["source"]), where="the mean Cd at Re 100 (section 5b)"),
            tolerance=Tolerance(rel_pct=5.0, note="the reference data's band"),
        ),
        "cl_rms": QuantitySpec(
            key="cl_rms",
            label=f"Lift coefficient rms ({tag})",
            unit="",
            how=("the root-mean-square of the Forces monitor's lift coefficient about its mean " + _WINDOW_WORDS
                 + ", lift along +y"),
            source="route:/api/run/monitors",
            reference=RE100.reference(clr["value"], citation=str(clr["source"]), where="CL rms at Re 100 (section 5b)"),
            tolerance=Tolerance(rel_pct=15.0, note="the reference data's band: the most domain-sensitive value"),
        ),
        "l_over_d_mean": QuantitySpec(
            key="l_over_d_mean",
            label=f"Mean recirculation length L/D ({tag}, information)",
            unit="D",
            how=("the 30 wake-axis Point probes' U_x (0.55 D to 6 D, y = 0, mid-depth), each a time mean " + _WINDOW_WORDS
                 + "; x0 where that mean turns from reversed to forward, linearly interpolated between the two probes "
                 "around it; L/D = (x0 - D/2) / D"),
            source="route:/api/run/monitors",
            reference=RE100.reference(ldm["value"], unit="D", citation=str(ldm["source"]),
                                      where="the mean L/D at Re 100 (section 5b)"),
            tolerance=Tolerance(rel_pct=10.0, note="the reference data's band, as information"),
        ),
    }


_BY_VARIANT = {v: _specs(v) for v in VARIANTS}
# Every variant's quantities (the report lists their references).
QUANTITIES: dict[str, QuantitySpec] = {f"{k}_{v}": s for v in VARIANTS for k, s in _BY_VARIANT[v].items()}


def quantities(variant: str) -> list[QuantitySpec]:
    return list(_BY_VARIANT[variant].values())


# The probes of 2026-11-06, typed: they are not results. The coarse runs: every custom size
# doubled (a level fewer), 20 102 cells, D/27 at the wall. The finer probe: fineness 7, where the
# same custom sizes come out at D/68, D/34 and D/17, 117 332 cells, at 4 cores.
COARSE_CELLS = 20_102
COARSE: dict[str, dict[str, float]] = {
    "re20": {"cd": 2.0756, "l_over_d": 0.9209},
    "re40": {"cd": 1.5483, "l_over_d": 2.2872},
    "re100": {"st": 0.16455, "cd_mean": 1.3777, "cl_rms": 0.2742, "l_over_d_mean": 1.291},
}
FINER_CELLS = 117_332
FINER: dict[str, float] = {"st": 0.16568, "cd_mean": 1.3573, "cl_rms": 0.2468, "l_over_d_mean": 1.371}
_NAMES = {"cd": "Cd", "l_over_d": "L/D", "st": "St", "cd_mean": "the mean Cd", "cl_rms": "CL rms",
          "l_over_d_mean": "the mean L/D"}


def _moves(probe: dict[str, float], res: dict[str, Any]) -> tuple[list[float], list[float]] | None:
    """The reported values of ``probe``'s keys and how far the probe's are from them (%)."""
    from ..report import quantity, rel_pct

    mine: list[float] = []
    for k in probe:
        x = quantity(res, k).get("value")
        if x is None:
            return None
        mine.append(float(x))
    return mine, [rel_pct(probe[k], x) for k, x in zip(probe, mine, strict=True)]


def _note_mesh_moves(by: dict[str, dict[str, Any]]) -> str | None:
    """How much the coarse and finer probes' meshes move the reported values."""
    from ..report import cells_text, num, pct_text

    bits = []
    steady_worst = 0.0
    for v in ("re20", "re40", "re100"):
        res = by.get(v)
        got = _moves(COARSE[v], res) if res else None
        if not res or not got:
            continue
        mine, pcts = got
        if v != "re100":
            steady_worst = max(steady_worst, *pcts)
        probe = and_list([f"{_NAMES[k]} {num(x, 5)}" for k, x in COARSE[v].items()])
        bits.append(f"at Re {RE[v]} {probe} against {and_list([num(x, 5) for x in mine])} on "
                    f"{cells_text((res.get('mesh') or {}).get('n_cells'))} cells ({and_list([pct_text(x) for x in pcts])} %)")
    if not bits:
        return None
    text = ("How much the mesh moves the answer (the coarse runs of 2026-11-06, every custom size doubled: a level "
            f"fewer, {cells_text(COARSE_CELLS)} cells, D/27 at the wall; not reported): " + "; ".join(bits) + ".")
    if by.get("re20") and by.get("re40") and steady_worst < 1.0:
        text += f" The steady values move by at most {pct_text(steady_worst)} %: they are converged in the mesh."
    res = by.get("re100")
    got = _moves(FINER, res) if res else None
    if got:
        _mine, pcts = got
        probe = and_list([f"{_NAMES[k]} {num(x, 5)}" for k, x in FINER.items()])
        text += (" A finer mesh at Re 100 (fineness 7, where the same custom sizes come out at D/68, D/34 and D/17: "
                 f"{cells_text(FINER_CELLS)} cells; a probe at 4 cores, not reported) gave {probe} "
                 f"({and_list([pct_text(x) for x in pcts])} % from the reported run).")
    return text


def _signed(q: dict[str, Any]) -> str:
    from ..report import pct_text

    rel = (q.get("error") or {}).get("rel_pct")
    return "-" if rel is None else f"{pct_text(abs(rel))} % {'above' if rel >= 0 else 'below'}"


def _note_domain(by: dict[str, dict[str, Any]]) -> str | None:
    """Where the values sit against their references, and what of it the domain may be."""
    from ..report import quantity

    text = ""
    steady = [quantity(by.get(v), "cd") for v in ("re20", "re40")]
    if all(q.get("error") for q in steady):
        text += (f"The steady drag coefficients sit {_signed(steady[0])} and {_signed(steady[1])} the reference values "
                 "while the mesh hardly moves them; what is left is the domain (40 D wide, its sides a Freestream) and "
                 "the reference's own spread: Fornberg's large-domain 2.000 and 1.498 against the finite-box results of "
                 "2.06 and 1.54 (Linnick & Fasel, Taira & Colonius), within 1 % of these values. ")
    res = by.get("re100")
    if res:
        cd, st, cl = quantity(res, "cd_mean"), quantity(res, "st"), quantity(res, "cl_rms")
        if cd.get("error") and st.get("error"):
            text += f"At Re 100 the mean Cd is {_signed(cd)} and St {_signed(st)} the references. "
        if cl.get("error"):
            text += (f"CL rms is {_signed(cl)} its reference. The reference data's one domain test moved CL rms the "
                     "most of the three values it reports (by 7.6 %, from 6.25 % to 3.1 % blockage, where it gave "
                     "0.236, 2.6 % above 0.23), and this domain's 2.5 % blockage is smaller than either, so blockage as "
                     "that test measured it does not account for the excess here. ")
    if not text:
        return None
    return (text + "The domain's share is not measured here: the reference data expect +1 to 3 % on Cd and St unless "
            "the domain is at least 40 D wide with slip or symmetry sides (their judgement), and this one is 40 D wide "
            "with Freestream sides.")


def _note_start(by: dict[str, dict[str, Any]]) -> str:
    """Re 100's start and its sampling: the samples a shedding period from its own run."""
    from ..report import num

    per = ((by.get("re100") or {}).get("shown") or {}).get("samples_per_period")
    return ("Re 100 starts from a Custom starting flow, U = (1, 0.05, 0) m/s everywhere, so the wake is lopsided from "
            "the start and the shedding begins within the run (a symmetric start waits for round-off). The run is "
            "300 D/U long (3 s), with 50 Result frames; the monitors write at a fiftieth of the frame interval "
            "(Incompressible Flow's rule), every 0.0012 s"
            + (f", {num(per, 3)} samples a shedding period in the reported run" if per else "")
            + "; the time step is adjusted to a Courant number of 1, second-order backward in time, 2 pressure "
            "correctors, 1 non-orthogonal corrector.")


NOTES = (
    "The values and bands are the reference data's (2026-11-04, section 5): Cd 2.02 and 1.50 at Re 20 and 40 with "
    "±5 % (the design's ±3 %), L/D 0.93 and 2.24 with ±5 %; at Re 100 St 0.164 ±3 %, the mean Cd 1.33 ±5 %, CL rms "
    "0.23 ±15 % and the mean L/D 1.41 ±10 % as information. The design's domain (10 D to each side, 10 D upstream, "
    "25 D downstream: 5 % blockage) is replaced by the reference data's: at least 40 D wide (2.5 %), about 15 D "
    "upstream and 30 D or more downstream (their judgement numbers, built on one published blockage test).",
    "The four sides are one Freestream BC (OpenFOAM v2606's freestreamVelocity and freestreamPressure, which blend "
    "face by face, by how the velocity there meets the face, between the free stream's value and zero gradient: the "
    "velocity held where the flow comes straight in, the pressure (0 Pa) where it goes straight out, half of each on "
    "the two sides along the stream), not the slip or symmetry sides of the reference data's domain advice. The "
    "cylinder is a no-slip wall; the front and back one Symmetry, the 2D mesh's ends, solved empty.",
    "One cell across (2D): the part is meshed one cell deep between its front and back, so the solution is exactly "
    "2D. The forces are on the cylinder's 5 mm span, so the reference area is D x 5 mm = 5e-5 m²; the Forces "
    "monitor's coefficients are per unit span as the references' are.",
    "The mesh is Hex-dominant at fineness 6 with three custom sizes on the cylinder's wall, each with Refine out to "
    "(gap G4, landed): D/48 out to 0.5 D, D/24 out to 3 D and D/12 out to 8 D, which the mesher's levels make "
    "cells of D/53, D/27 and D/13 (the background 1.2 D, the sides 0.3 D). Refine out to is a distance from the "
    "wall, so each band is a ring round the cylinder (upstream too), not a box along the wake: there is still no "
    "box refinement. No wall layers: the cells are D/53 up to the wall.",
    lambda by: _note_mesh_moves(by),
    lambda by: _note_domain(by),
    lambda by: _note_start(by),
    "The app has no mean or frequency of a monitor over a time window (gap G8): the harness reads them from the "
    "Forces monitor's history. The lift coefficient's whole periods run from one rise through its mean to the "
    "next; the window starts at the first period whose amplitude is within 2 % of the settled amplitude (the mean of "
    "the last 5 periods', which must agree within 2 %), and needs at least 20 whole periods (the reference data); a "
    "run that does not get there is not settled and gives no values. St is the peak of the spectrum over the window, "
    "the mean period between its up-crossings the cross-check; Cd, CL rms and the probes' U_x are time means over "
    "the same whole periods (time integrals: the monitors' samples are not evenly spaced).",
    "The steady runs' L/D is read from U_x on the wake axis at mid-depth, sampled as Plot over path samples it with "
    "the velocity's components kept (Plot over path gives a vector's magnitude only, gap G2), the 30 wake-axis "
    "probes as the cross-check; Re 100's mean L/D from the probes' time means over the window, with the run's UMean "
    "(the app's own time average from 1.5 s, not whole periods) along the same line beside it.",
    lambda by: precheck_note(by, {v: f"Re {RE[v]}" for v in VARIANTS}),
    "Reference confidence: every value is SECONDARY (read in compilations: arXiv:2205.15886, arXiv:1906.05387, "
    "arXiv:2303.09262, arXiv:1612.08356, Legendre et al. 2009), except Gautier et al.'s Re 40 values (1.4931, "
    "2.2360), read in their arXiv paper (CONFIRMED). The compilations disagree on Tritton's measured Cd (2.09 or "
    "2.22 at Re 20), so it is not used.",
)

# A steady run that stops at its iteration limit counts as settled only when these histories
# moved less than SETTLE_DRIFT over its last 10 % of iterations.
SETTLE = ({"monitor": "forces_cylinder", "sample": "Cd", "label": "the cylinder's drag coefficient"},)
SETTLE_DRIFT = 1e-3


def build_geometry_for(variant: str) -> Any:
    from ..geometry import slab_with_hole

    return slab_with_hole(-UP_D * D_MM, DOWN_D * D_MM, -HALF_D * D_MM, HALF_D * D_MM, DEPTH_MM, D_MM)


def geometry_words(variant: str) -> str:
    return (f"a box x from {-UP_D:g} D to {DOWN_D:g} D and y from {-HALF_D:g} D to {HALF_D:g} D round a circular cylinder "
            f"D = {D_MM:g} mm along z at the origin (cut out: the box is the fluid), {DEPTH_MM:g} mm deep in z (one cell "
            f"across); blockage D / {2 * HALF_D:g} D = {100 / (2 * HALF_D):.3g} %")


def face_selectors(variant: str) -> dict[str, dict[str, Any]]:
    return {
        "inlet": {"plane": {"axis": "x", "at_mm": -UP_D * D_MM, "sign": -1}},
        "outlet": {"plane": {"axis": "x", "at_mm": DOWN_D * D_MM, "sign": 1}},
        "bottom": {"plane": {"axis": "y", "at_mm": -HALF_D * D_MM, "sign": -1}},
        "top": {"plane": {"axis": "y", "at_mm": HALF_D * D_MM, "sign": 1}},
        "front": {"plane": {"axis": "z", "at_mm": 0.0, "sign": -1}},
        "back": {"plane": {"axis": "z", "at_mm": DEPTH_MM, "sign": 1}},
        "cylinder": {"surface_type": "Cylinder", "count": 1},
    }


def _probe(pid: str, name: str, points: list[list[float]]) -> dict[str, Any]:
    return {"id": pid, "name": name, "monitor_type": "probe", "kind": "Point probe", "category": "Point data",
            "write_control": "Time step", "faces": [], "results": None, "series": None, "chart_values": None,
            "results_available": False, "points": points}


def _forces(pid: str, name: str, bc: str) -> dict[str, Any]:
    # The Monitors dialog's Forces record; "@bc:<name>" is that BC's id (the driver fills it in).
    return {"id": pid, "name": name, "monitor_type": "forces", "kind": "Forces", "category": "Boundary data",
            "write_control": "Time step", "faces": [], "results": None, "series": None, "chart_values": None,
            "results_available": False, "boundaries": [f"@bc:{bc}"]}


def wake_probe_points() -> list[list[float]]:
    lo, hi = WAKE_PROBE_X_D
    return [[round(float(x) * D, 7), 0.0, ZM] for x in np.linspace(lo, hi, WAKE_PROBES)]


def requests(variant: str, *, coarse: bool = False, cores: int = 4) -> dict[str, Any]:
    """What the driver sends, faces as selectors; plan.make_plan resolves them."""
    transient = TRANSIENT[variant]
    reference = {"ref_speed": U, "ref_area": A_REF, "ref_length": D, "ref_drag_dir": [1.0, 0.0, 0.0],
                 "ref_lift_dir": [0.0, 1.0, 0.0], "ref_cofr": [0.0, 0.0, ZM]}
    if transient:
        settings: dict[str, Any] = {"turbulence_model": "laminar", **reference, "initial_flow": "custom",
                                    "initial_ux": U, "initial_uy": START_UY, "initial_uz": 0.0}
    else:
        settings = {"turbulence_model": "laminar", "numerics_preset": "accurate", "residual_u": 1e-6, "residual_p": 1e-6,
                    "n_non_orthogonal": 1, **reference, "initial_flow": "inlet"}
    # Coarse: every custom size doubled (one level fewer: a quarter of the cells), the same domain
    # and the same run, so it reads how much the mesh moves the answer.
    k = 2.0 if coarse else 1.0
    refinements = [{"name": name, "type": "Surface custom sizing", "faces": ["@cylinder"], "sizing": "Custom",
                    "default_size": round(k * frac * D_MM, 4), "default_size_unit": "mm",
                    "reach": round(reach * D_MM, 6), "reach_unit": "mm"} for name, frac, reach in SIZES]
    wake_line = [[0.5 * D, 0.0, ZM], [WAKE_LINE_TO_D * D, 0.0, ZM]]
    controls = [
        _forces("rc-forces", "Cylinder", "Cylinder"),
        _probe("rc-wake", "Wake axis", wake_probe_points()),
        _probe("rc-shedding", "Shedding", [[SHEDDING_PROBE_D[0] * D, SHEDDING_PROBE_D[1] * D, ZM]]),
    ]
    if transient:
        run: dict[str, Any] = {
            "name": "Validation", "cores": int(cores), "result_controls": controls,
            "transient": {"end_time": T_END, "write_count": FRAMES, "time_step_mode": "adjustable", "max_co": 1.0,
                          "time_scheme": "backward", "n_outer_correctors": 1, "n_correctors": 2,
                          "n_non_orth_correctors": 1, "average_from": AVERAGE_FROM},
        }
    else:
        run = {"name": "Validation", "endTime": END_TIME, "writeInterval": END_TIME, "cores": int(cores),
               "result_controls": controls}
    extract: list[dict[str, Any]] = [
        {"key": "wake_line", "kind": "app_sampling", "fields": ["U", "p"], "points_m": wake_line,
         "subdivisions": WAKE_LINE_SUBDIV},
        # The route's own reading of the same line, a scalar it gives as it is: the check that
        # app_sampling reads what Plot over path reads.
        {"key": "p_wake_line", "kind": "line", "field": "p", "points_m": wake_line, "subdivisions": WAKE_LINE_SUBDIV},
    ]
    if transient:
        extract.append({"key": "umean_line", "kind": "app_sampling", "fields": ["UMean"], "points_m": wake_line,
                        "subdivisions": WAKE_LINE_SUBDIV})
    else:
        extract.append({"key": "cylinder_shear", "kind": "patch", "patch": "cylinder", "field": "wallShearStress"})
    return {
        "project": {"title": f"Validation {ID} {variant}", "description": "", "category": "Other",
                    "units": "Metric", "folder": "My Projects"},
        "study": {
            "analysis_type": "incompressible_transient" if transient else "incompressible_steady",
            "time_dependency": "Transient" if transient else "Steady-state",
            "name": f"{ID} {variant}",
            "settings": settings,
        },
        "material": {"preset": "custom", "name": "Validation fluid", "kinematic_viscosity": NU[variant], "density": RHO,
                     "assigned_volumes": ["Body1"]},
        "bcs": [
            {"name": "Far field", "bc_type": "Freestream", "velocity_input": "Speed and direction", "value": U,
             "unit": "m/s", "vector": [1.0, 0.0, 0.0], "freestream_pressure": 0,
             "faces": ["@inlet", "@outlet", "@bottom", "@top"]},
            # A new face-by-face Wall starts Slip: the treatment is always sent.
            {"name": "Cylinder", "bc_type": "Wall", "wall_type": "No-slip", "faces": ["@cylinder"]},
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
            "refinements": refinements,
            # The plan's own: the 2D mesh's depth axis, for its estimate (mesh_plan.py).
            "two_d_axis": "z",
            "expect": {"layers": False, "n_cells": [40_000, 160_000] if not coarse else [8_000, 50_000]},
        },
        "run": run,
        "extract": extract,
        "timeouts_s": {"mesh": 2400, "solve": 9000 if transient else 3600},
    }


# ---------------------------------------------------------------------------------------- evaluate

FORCE_KEYS = ("Cd", "Cl", "Fd_N", "Fl_N", "Fdp_N", "Fdv_N")


def forces_table(raw: Any, key: str = "forces_cylinder") -> dict[str, np.ndarray]:
    """The Forces monitor's history: ``t`` and each of ``FORCE_KEYS`` at the steps where all are
    numbers, in time order (an empty dict when it has none)."""
    for mon in raw.monitor_rows():
        if str(mon.get("key") or "") != key:
            continue
        rows = []
        for r in mon.get("series") or []:
            if not isinstance(r, dict):
                continue
            vals = [r.get("t"), *(r.get(k) for k in FORCE_KEYS)]
            if any(v is None for v in vals):
                continue
            try:
                nums = [float(v) for v in vals if v is not None]
            except (TypeError, ValueError):
                continue
            if all(math.isfinite(v) for v in nums):
                rows.append(nums)
        if not rows:
            return {}
        a = np.asarray(sorted(rows), dtype=float)
        out = {"t": a[:, 0]}
        out.update({k: a[:, i + 1] for i, k in enumerate(FORCE_KEYS)})
        return out
    return {}


def probe_histories(raw: Any, name: str) -> list[dict[str, Any]]:
    """Each point of a Point probe: its ``point`` and its history (``t``, ``ux``, ``uy``), in the
    probe's own order."""
    import re

    slug = re.sub(r"[^a-z0-9]+", "_", name.lower()).strip("_")
    out = []
    for mon in raw.monitor_rows():
        key = str(mon.get("key") or "")
        if not key.startswith(f"probes_{slug}_") or mon.get("outside"):
            continue
        ts, ux, uy = [], [], []
        for r in mon.get("series") or []:
            u = r.get("U") if isinstance(r, dict) else None
            if isinstance(u, list) and len(u) >= 2 and r.get("t") is not None:
                ts.append(float(r["t"]))
                ux.append(float(u[0]))
                uy.append(float(u[1]))
        if ts:
            idx = int(key.rsplit("_", 1)[-1])
            out.append({"index": idx, "point": mon.get("point"), "t": np.asarray(ts), "ux": np.asarray(ux),
                        "uy": np.asarray(uy)})
    return sorted(out, key=lambda p: p["index"])


def closure_point(x: np.ndarray, ux: np.ndarray) -> dict[str, Any] | None:
    """Where U_x on the wake axis turns forward again after the most reversed point behind the
    cylinder (``x`` from its back): ``x``, the spacing of the two samples around it; None when
    nothing is reversed or it never turns forward."""
    xa, ua = arrays(x, ux)
    if xa.size < 3 or not (ua < 0).any():
        return None
    i_min = int(np.argmin(ua))
    rise = [c for c in sign_changes(xa[i_min:], ua[i_min:]) if c["rising"]]
    if not rise:
        return None
    c = rise[0]
    return {"x": float(c["x"]), "spacing": float(c["x_after"] - c["x_before"]), "u_min": float(ua[i_min]),
            "x_u_min": float(xa[i_min])}


def separation_angle(sample: dict[str, Any] | None) -> dict[str, Any] | None:
    """The separation angle on the cylinder's upper half, from the rear stagnation point
    (degrees): where the wall shear stress along the wall (the tangential component of the
    saved wallShearStress) turns from its sign on the front of the cylinder, where the flow is
    attached (100 to 160 degrees from the rear), to the other, going from the front towards the
    rear; the zero linearly interpolated between the two face centres around it."""
    if not sample or not sample.get("n") or "y" not in sample:
        return None
    x = np.asarray(sample["x"], dtype=float)
    y = np.asarray(sample["y"], dtype=float)
    tx = np.asarray(sample["wallShearStress_x"], dtype=float)
    ty = np.asarray(sample["wallShearStress_y"], dtype=float)
    up = y > 0
    phi = np.arctan2(y[up], x[up])
    tang = -tx[up] * np.sin(phi) + ty[up] * np.cos(phi)
    deg = np.degrees(phi)
    order = np.argsort(-deg)  # from the front (180) to the rear (0)
    deg, tang = deg[order], tang[order]
    front = tang[(deg >= 100) & (deg <= 160)]
    if front.size == 0 or not (np.all(front > 0) or np.all(front < 0)):
        return None
    fwd = tang * (1.0 if front[0] > 0 else -1.0)
    # From the front towards the rear: the first turn from attached to reversed.
    for i in range(1, deg.size):
        if deg[i] < 160 and fwd[i - 1] > 0 >= fwd[i]:
            f = fwd[i - 1] / (fwd[i - 1] - fwd[i])
            return {"deg": float(deg[i - 1] + f * (deg[i] - deg[i - 1])), "faces": int(deg.size)}
    return None


def _ld(x0: float) -> float:
    return (x0 - 0.5 * D) / D


def _line_x_ux(sample: dict[str, Any] | None, field: str = "U") -> tuple[np.ndarray, np.ndarray]:
    if not sample or not sample.get("n_valid"):
        raise ValueError("no samples")
    pts = np.asarray(sample["sample_points"], dtype=float)
    return arrays(pts[:, 0], np.asarray(sample[f"{field}_x"], dtype=float))


def _probe_closure(points: list[tuple[float, float]]) -> dict[str, Any] | None:
    if len(points) < 3:
        return None
    xs = np.asarray([p[0] for p in points])
    us = np.asarray([p[1] for p in points])
    return closure_point(xs, us)


def _common(raw: Any, shown: dict[str, Any], warnings: list[str]) -> None:
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
            warnings.append(f"Plot over path gave {a.size} samples of p on the wake axis, app_sampling {b.size}")


def evaluate(plan: dict[str, Any], raw: Any) -> dict[str, Any]:
    variant = plan["variant"]
    if TRANSIENT[variant]:
        return _evaluate_transient(plan, raw)
    return _evaluate_steady(plan, raw)


def _evaluate_steady(plan: dict[str, Any], raw: Any) -> dict[str, Any]:
    variant = plan["variant"]
    specs = _BY_VARIANT[variant]
    warnings: list[str] = []
    shown: dict[str, Any] = {}
    series: dict[str, Any] = {}
    values: dict[str, float | None] = {k: None for k in specs}
    details: dict[str, str] = {}
    unc: dict[str, dict[str, Any] | None] = {}
    _common(raw, shown, warnings)

    f = forces_table(raw)
    if not f:
        warnings.append("the Forces monitor on the cylinder gave no history")
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
                         f"(F_d / (0.5 rho U² D depth))")
        ds = downsample(f["t"], f["Cd"], 300)
        series["cd_history"] = {"it": ds["x"], "cd": ds["y"]}

    try:
        x, ux = _line_x_ux(raw.sample("wake_line"))
        c = closure_point(x, ux)
        keep = x <= 6.0 * D
        ds = downsample(x[keep] / D, ux[keep] / U)
        series["wake_line"] = {"x_over_d": ds["x"], "ux": ds["y"]}
        if c is None:
            warnings.append("U_x on the wake axis is nowhere reversed behind the cylinder, or never turns forward again")
        else:
            values["l_over_d"] = _ld(c["x"])
            unc["l_over_d"] = {"kind": "pct", "value": 100.0 * 0.5 * c["spacing"] / (c["x"] - 0.5 * D),
                               "what": "half the spacing of the two samples around the zero"}
            details["l_over_d"] = (f"x0 = {c['x'] * 1000:.3f} mm ({c['x'] / D:.4f} D from the centre); the most reversed "
                                   f"U_x {c['u_min']:.4g} m/s at {c['x_u_min'] / D:.3f} D")
            shown["u_min_wake"] = c["u_min"]
            shown["x_u_min_over_d"] = c["x_u_min"] / D
    except (ValueError, KeyError):
        warnings.append(f"no U_x line on the wake axis: {raw.sample_problem('wake_line')}")

    pts = raw.probe_values("Wake axis")
    if pts:
        pc = _probe_closure(pts)
        series["probes_wake"] = {"x_over_d": [p[0] / D for p in pts], "ux": [p[1] / U for p in pts]}
        if pc is not None:
            shown["probes_l_over_d"] = _ld(pc["x"])
    sep = separation_angle(raw.sample("cylinder_shear"))
    if sep is not None:
        shown["theta_s_deg"] = sep["deg"]
        shown["cylinder_faces_upper"] = sep["faces"]
    elif raw.sample("cylinder_shear") is None:
        warnings.append(f"no wall shear stress on the cylinder: {raw.sample_problem('cylinder_shear')}")
    rows = [compare(spec, values[k], detail=details.get(k, ""), uncertainty=unc.get(k)) for k, spec in specs.items()]
    return {"quantities": rows, "series": series, "shown": shown, "warnings": warnings}


def _evaluate_transient(plan: dict[str, Any], raw: Any) -> dict[str, Any]:
    variant = plan["variant"]
    specs = _BY_VARIANT[variant]
    warnings: list[str] = []
    shown: dict[str, Any] = {}
    series: dict[str, Any] = {}
    values: dict[str, float | None] = {k: None for k in specs}
    details: dict[str, str] = {}
    unc: dict[str, dict[str, Any] | None] = {}
    out: dict[str, Any] = {"series": series, "shown": shown, "warnings": warnings}
    _common(raw, shown, warnings)

    f = forces_table(raw)
    if not f or f["t"].size < 20:
        warnings.append("the Forces monitor on the cylinder gave no history")
        out["quantities"] = [compare(spec, None) for spec in specs.values()]
        return out
    t = f["t"]
    ds_t = downsample(t, f["Cl"], 1500)
    keep_idx = np.searchsorted(t, np.asarray(ds_t["x"]))
    keep_idx = np.clip(keep_idx, 0, t.size - 1)
    series["forces_history"] = {"t": ds_t["x"], "cl": ds_t["y"],
                                "cd": [float(f"{v:.7g}") for v in f["Cd"][keep_idx].tolist()]}
    dts = np.diff(t)
    shown["monitor_dt_median_s"] = float(np.median(dts)) if dts.size else None
    shown["monitor_samples"] = int(t.size)
    shown["t_last_s"] = float(t[-1])

    win = settled_window(t, f["Cl"], rel=SETTLE_REL, n_check=SETTLE_PERIODS, min_periods=MIN_PERIODS)
    shown["window"] = {k: win.get(k) for k in ("t0", "t1", "n_periods", "period", "period_spread", "amplitude",
                                                "spread_last", "level")}
    shown["periods_in_run"] = len(win.get("periods_all") or [])
    amps_all = win.get("periods_all") or []
    series["cl_amplitudes"] = {"t": [round(p["t0"], 6) for p in amps_all],
                               "amplitude": [float(f"{p['amplitude']:.6g}") for p in amps_all]}
    if not win["settled"]:
        out["not_settled"] = f"the lift coefficient's shedding did not settle within the run: {win['reason']}"
        warnings.append(out["not_settled"])
        out["quantities"] = [compare(spec, None) for spec in specs.values()]
        return out
    t0, t1 = float(win["t0"]), float(win["t1"])
    series["window"] = [t0, t1]
    n_per = int(win["n_periods"])
    samples_per = np.mean([p["n"] for p in win["periods"]])
    shown["samples_per_period"] = float(samples_per)
    if samples_per < MIN_SAMPLES_PER_PERIOD:
        warnings.append(f"the Forces monitor wrote {samples_per:.3g} samples a shedding period, fewer than "
                        f"{MIN_SAMPLES_PER_PERIOD}: its history resolves the period coarsely")

    # St: the spectrum's peak; the mean period between up-crossings as the cross-check.
    sp = spectrum_peak(t, f["Cl"], t0, t1)
    values["st"] = sp["f"] * D / U
    shown["st_from_period"] = (1.0 / win["period"]) * D / U
    unc["st"] = {"kind": "pct", "value": 100.0 * abs(values["st"] - shown["st_from_period"]) / shown["st_from_period"],
                 "what": "its difference from the mean period's St"}
    details["st"] = (f"f = {sp['f']:.5g} Hz over {n_per} whole periods, t = {t0:.4g} to {t1:.4g} s ({(t1 - t0) * U / D:.4g} "
                     f"D/U); the spectrum's bins {sp['df']:.3g} Hz apart; the mean period {win['period']:.5g} s gives "
                     f"St {shown['st_from_period']:.5g}")
    band = sp["freq"] <= 4.0 * sp["f"]
    dsp = downsample(sp["freq"][band] / sp["f"], sp["mag"][band], 400)
    series["spectrum"] = {"f_over_f0": dsp["x"], "mag": dsp["y"], "f0_hz": sp["f"]}

    cd_mean = time_mean(t, f["Cd"], t0, t1)
    values["cd_mean"] = cd_mean
    shown["cd_from_fd_mean"] = time_mean(t, f["Fd_N"], t0, t1) / Q_A
    shown["cdp_mean"] = time_mean(t, f["Fdp_N"], t0, t1) / Q_A
    shown["cdv_mean"] = time_mean(t, f["Fdv_N"], t0, t1) / Q_A
    details["cd_mean"] = (f"over the same {n_per} periods; from its drag force {shown['cd_from_fd_mean']:.5g}; pressure "
                          f"part {shown['cdp_mean']:.4g}, viscous {shown['cdv_mean']:.4g}")
    cl_mean = time_mean(t, f["Cl"], t0, t1)
    values["cl_rms"] = time_rms(t, f["Cl"], t0, t1, about=cl_mean)
    shown["cl_mean"] = cl_mean
    shown["cl_amplitude"] = float(np.mean([p["amplitude"] for p in win["periods"]]))
    details["cl_rms"] = (f"about its mean {cl_mean:.3g}; its amplitude (half its peak-to-peak, per period) "
                         f"{shown['cl_amplitude']:.4g}")
    cd_amp = []
    for p in win["periods"]:
        sel = (t >= p["t0"]) & (t <= p["t1"])
        if sel.sum() >= 3:
            cd_amp.append(0.5 * float(f["Cd"][sel].max() - f["Cd"][sel].min()))
    if cd_amp:
        shown["cd_amplitude"] = float(np.mean(cd_amp))

    # The mean wake: each wake-axis probe's U_x averaged over the window.
    probes = probe_histories(raw, "Wake axis")
    means = []
    for p in probes:
        pt = p.get("point") or []
        if len(pt) < 1 or p["t"].size < 2 or p["t"][0] > t0 or p["t"][-1] < t1:
            continue
        means.append((float(pt[0]), time_mean(p["t"], p["ux"], t0, t1)))
    means.sort()
    if means:
        series["wake_mean"] = {"x_over_d": [m[0] / D for m in means], "ux": [float(f"{m[1] / U:.6g}") for m in means]}
        c = _probe_closure(means)
        if c is None:
            warnings.append("the wake-axis probes' mean U_x is nowhere reversed, or never turns forward again")
        else:
            values["l_over_d_mean"] = _ld(c["x"])
            unc["l_over_d_mean"] = {"kind": "pct", "value": 100.0 * 0.5 * c["spacing"] / (c["x"] - 0.5 * D),
                                    "what": "half the spacing of the two probes around the zero"}
            details["l_over_d_mean"] = (f"x0 = {c['x'] * 1000:.3f} mm ({c['x'] / D:.4f} D from the centre) between probes "
                                        f"{c['spacing'] / D:.3f} D apart; {len(means)} probes")
    else:
        warnings.append("the wake-axis probes gave no history over the window")
    # The run's own time average (UMean, from Average from to the end) along the wake axis.
    try:
        x, um = _line_x_ux(raw.sample("umean_line"), "UMean")
        cu = closure_point(x, um)
        keep = x <= 6.0 * D
        dsu = downsample(x[keep] / D, um[keep] / U)
        series["umean_line"] = {"x_over_d": dsu["x"], "ux": dsu["y"]}
        if cu is not None:
            shown["umean_l_over_d"] = _ld(cu["x"])
        avg_from = float(((plan.get("run") or {}).get("transient") or {}).get("average_from") or 0.0)
        shown["average_from_s"] = avg_from
        if avg_from < t0:
            warnings.append(f"UMean averages from t = {avg_from:g} s, before the settled window starts (t = {t0:.4g} s): "
                            "it holds part of the transient")
    except (ValueError, KeyError):
        warnings.append(f"no UMean line on the wake axis: {raw.sample_problem('umean_line')}")
    # The shedding probe's U_y: the same frequency, read off another signal.
    sh = probe_histories(raw, "Shedding")
    if sh and sh[0]["t"].size > 8 and sh[0]["t"][0] <= t0 and sh[0]["t"][-1] >= t1:
        try:
            spp = spectrum_peak(sh[0]["t"], sh[0]["uy"], t0, t1)
            shown["st_from_probe"] = spp["f"] * D / U
        except ValueError:
            pass
    out["quantities"] = [compare(spec, values[k], detail=details.get(k, ""), uncertainty=unc.get(k))
                         for k, spec in specs.items()]
    return out


def setup_words(result: dict[str, Any]) -> str:
    v = str(result.get("variant"))
    re = RE.get(v)
    common = (f"The domain is {geometry_words(v)} (STEP in mm, built with OCP: a box with the cylinder cut out); a custom fluid with "
              f"nu = {NU.get(v, 0):g} m²/s and rho = {RHO:g} kg/m³, so Re = U D / nu = {re}; the four sides one Freestream "
              f"of {U:g} m/s along +x and 0 Pa, the cylinder a no-slip wall, the front and back one Symmetry (the 2D mesh's "
              "ends, solved empty); laminar; the study's reference values speed 1 m/s, area D x depth = 5e-5 m², length "
              "D, drag +x, lift +y; a Forces monitor on the cylinder, 30 Point probes on the wake axis and one at "
              "(2 D, 0.5 D)")
    if TRANSIENT.get(v):
        return (common + f"; transient (pimpleFoam), {T_END:g} s ({T_END * U / D:g} D/U), {FRAMES} Result frames, the "
                "time step adjusted to Courant 1, backward in time, 2 pressure correctors and 1 non-orthogonal corrector, "
                f"time averages from {AVERAGE_FROM:g} s; starting flow Custom U = ({U:g}, {START_UY:g}, 0) m/s.")
    return (common + f"; steady (simpleFoam), Accurate numerics, residual targets 1e-6, at most {END_TIME} iterations, "
            "starting from the free stream's velocity.")


def mesh_words(result: dict[str, Any]) -> str:
    mesh = result.get("setup", {}).get("mesh", {})
    fine = (mesh.get("settings") or {}).get("fineness")
    refs = mesh.get("refinements") or []
    sizes = ", ".join(f"{r.get('name')} {r.get('default_size'):g} mm out to {r.get('reach'):g} mm" for r in refs)
    return (f"Hex-dominant at fineness {fine}, One cell across (2D) on, custom sizes on the cylinder with Refine out to "
            f"({sizes}), no wall layers; 1 non-orthogonal corrector")


def _span(table: Any, column: str, **match: Any) -> tuple[float, float] | None:
    vals = [float(r[column]) for r in table.rows
            if isinstance(r.get(column), (int, float)) and all(r.get(k) == v for k, v in match.items())]
    return (min(vals), max(vals)) if vals else None


def literature_words(variant: str) -> str:
    """The 2D literature's spread beside the compared values (refs/cylinder_*_scatter.csv)."""
    from ..report import num

    def rng(sp: tuple[float, float] | None, digits: int = 4, unit: str = "") -> str:
        return "-" if sp is None else f"{num(sp[0], digits)} to {num(sp[1], digits)}{unit}"

    if TRANSIENT.get(variant):
        return (f"the 2D computations the reference data list at Re 100: St {rng(_span(RE100_SCATTER, 'st'))}, mean Cd "
                f"{rng(_span(RE100_SCATTER, 'cd_mean'))}, CL rms {rng(_span(RE100_SCATTER, 'cl_rms'))}, mean L/D "
                f"{rng(_span(RE100_SCATTER, 'l_over_d_mean'))} (refs/cylinder_re100_scatter.csv)")
    re = RE[variant]
    return (f"the literature the reference data list at Re {re}: Cd {rng(_span(STEADY_SCATTER, 'cd', re=re))}, L/D "
            f"{rng(_span(STEADY_SCATTER, 'l_over_d', re=re))}, the separation angle "
            f"{rng(_span(STEADY_SCATTER, 'theta_s_deg', re=re), 3, '°')} (refs/cylinder_steady_scatter.csv)")


def shown_words(result: dict[str, Any]) -> list[str]:
    from ..report import num

    s = result.get("shown") or {}
    v = str(result.get("variant"))
    bits: list[str] = []
    if TRANSIENT.get(v):
        w = s.get("window") or {}
        if w.get("t0") is not None:
            bits.append(f"the shedding window t = {num(w['t0'], 4)} to {num(w['t1'], 4)} s, {w.get('n_periods')} whole periods "
                        f"of {num(w.get('period'), 5)} s (the periods within {num(100 * (w.get('period_spread') or 0), 2)} % "
                        f"of each other), the last 5 lift amplitudes within {num(100 * (w.get('spread_last') or 0), 2)} %")
        if s.get("samples_per_period") is not None:
            bits.append(f"{num(s['samples_per_period'], 3)} monitor samples a period (every {num(s.get('monitor_dt_median_s'), 3)} s)")
        if s.get("st_from_period") is not None:
            bits.append(f"St from the mean period {num(s['st_from_period'], 5)}"
                        + (f", from the shedding probe's U_y spectrum {num(s['st_from_probe'], 5)}" if s.get("st_from_probe") else ""))
        if s.get("cdp_mean") is not None:
            bits.append(f"the mean drag's pressure part {num(s['cdp_mean'], 4)} and viscous part {num(s['cdv_mean'], 4)} "
                        "(Park et al. 0.99 and 0.34)")
        if s.get("cl_amplitude") is not None:
            bits.append(f"the lift coefficient's amplitude {num(s['cl_amplitude'], 4)} (Park et al. 0.332), its mean "
                        f"{num(s.get('cl_mean'), 2)}")
        if s.get("cd_amplitude") is not None:
            bits.append(f"the drag coefficient's fluctuation amplitude {num(s['cd_amplitude'], 3)} (Park et al. 0.0091)")
        if s.get("cd_from_fd_mean") is not None:
            bits.append(f"the mean Cd from the drag force {num(s['cd_from_fd_mean'], 5)}")
        if s.get("umean_l_over_d") is not None:
            bits.append(f"the run's UMean (from {num(s.get('average_from_s'), 3)} s) closes the bubble at L/D "
                        f"{num(s['umean_l_over_d'], 4)}")
    else:
        if s.get("cdp") is not None:
            bits.append(f"the drag's pressure part Cdp {num(s['cdp'], 4)} and viscous part Cdv {num(s['cdv'], 4)}")
        if s.get("cd_from_fd") is not None:
            bits.append(f"Cd from the drag force {num(s['cd_from_fd'], 5)}; the lift coefficient {num(s.get('cl_last'), 2)}")
        if s.get("cd_drift_last10_pct") is not None:
            bits.append(f"Cd moved {num(s['cd_drift_last10_pct'], 2)} % over the last 10 % of iterations")
        if s.get("probes_l_over_d") is not None:
            bits.append(f"the wake-axis probes close the bubble at L/D {num(s['probes_l_over_d'], 4)} (the cross-check)")
        if s.get("theta_s_deg") is not None:
            ref = {"re20": "Dennis & Chang 43.7°", "re40": "Gautier et al. 53.6°"}.get(v, "")
            bits.append(f"the separation angle {num(s['theta_s_deg'], 3)}° from the rear stagnation point, where the wall "
                        f"shear stress along the wall turns ({ref})")
    if v in VARIANTS:
        bits.append(literature_words(v))
    if s.get("route_vs_app_sampling_p_max_abs") is not None:
        lo, hi = s.get("route_p_range") or [None, None]
        bits.append(f"Plot over path's p along the wake axis and app_sampling's agree within "
                    f"{num(s['route_vs_app_sampling_p_max_abs'], 2)} Pa (p from {num(lo, 3)} to {num(hi, 3)} Pa)")
    if s.get("imbalance_pct") is not None:
        bits.append(f"flow out of the far field against in {num(s['imbalance_pct'], 2)} %")
    return bits


# ---------------------------------------------------------------------------------------- figures

FIGURES = (
    ("wake", "U_x on the wake axis"),
    ("cd_history", "drag coefficient"),
    ("forces_history", "Cl and Cd"),
    ("spectrum", "lift spectrum"),
    ("wake_mean", "mean wake U_x"),
    ("residuals", "residuals"),
)
_NEEDS = {"wake": "wake_line", "cd_history": "cd_history", "forces_history": "forces_history", "spectrum": "spectrum",
          "wake_mean": "wake_mean", "residuals": "residuals"}


def has_figure(kind: str, result: dict[str, Any]) -> bool:
    if kind == "residuals" and TRANSIENT.get(str(result.get("variant"))):
        return False
    if kind == "wake" and TRANSIENT.get(str(result.get("variant"))):
        return False
    return _NEEDS[kind] in (result.get("series") or {})


def _q(result: dict[str, Any], key: str) -> dict[str, Any]:
    return next((q for q in result.get("quantities") or [] if q["key"] == key), {})


def _err_text(q: dict[str, Any], name: str) -> str:
    if q.get("value") is None:
        return f"{name}: no value"
    return f"{name} {q['value']:.4g} (reference {q['reference']['value']:g}, {q['error']['rel_pct']:+.2f} %)"


def _wake_ref(ax: Any, ref: float | None, label: str) -> None:
    from ..plots import INK

    if ref is not None:
        ax.axvline(0.5 + ref, color=INK, linestyle="--", linewidth=1.1, label=label)


def _band(lo: float, hi: float, at: tuple[float, float]) -> tuple[float, float]:
    """Axis limits that put the values from ``lo`` to ``hi`` at the fractions ``at`` of the axis."""
    span = (hi - lo) or 1.0
    full = span / (at[1] - at[0])
    bottom = lo - at[0] * full
    return bottom, bottom + full


def _draw_forces(result: dict[str, Any], ax: Any) -> None:
    """Cl over time in the upper part of the axes, Cd in a panel below, the averaging window
    shaded in both."""
    from ..plots import INK, SECOND, SERIES, SURFACE, style

    s = result["series"]
    h = s["forces_history"]
    t = np.asarray(h["t"], dtype=float)
    cl = np.asarray(h["cl"], dtype=float)
    cd = np.asarray(h["cd"], dtype=float)
    lo, hi = s.get("window") or [None, None]
    a = float(np.max(np.abs(cl))) if cl.size else 1.0
    ax.plot(t, cl, color=SERIES, linewidth=0.9, label="Cl")
    if lo is not None:
        ax.axvspan(lo, hi, color=INK, alpha=0.07, linewidth=0, label="averaging window")
    ax.set_ylim(*_band(-a, a, (0.46, 0.86)))
    ax.set_yticks([v for v in np.round(np.linspace(-a, a, 5), 2)])
    ax.set_ylabel("Cl")
    ax.set_xlabel("t (s)")
    ax.legend(loc="upper right", fontsize=7, ncol=2)
    ax.text(0.01, 0.985, _err_text(_q(result, "st"), "St") + "\n" + _err_text(_q(result, "cl_rms"), "CL rms"),
            transform=ax.transAxes, ha="left", va="top", fontsize=7, color=INK)
    sub = ax.inset_axes([0.0, 0.0, 1.0, 0.38], sharex=ax)
    style(sub)
    sub.patch.set_facecolor(SURFACE)
    sub.patch.set_alpha(1.0)
    sub.plot(t, cd, color=SECOND, linewidth=0.9, label="Cd")
    if lo is not None:
        sub.axvspan(lo, hi, color=INK, alpha=0.07, linewidth=0)
    ref = (_q(result, "cd_mean").get("reference") or {}).get("value")
    if ref is not None:
        sub.axhline(ref, color=INK, linestyle="--", linewidth=1.0, label="reference mean Cd")
    late = cd[t >= 0.1 * (t[-1] if t.size else 1.0)] if cd.size else cd
    if late.size:
        c_lo, c_hi = float(late.min()), float(late.max())
        if ref is not None:
            c_lo, c_hi = min(c_lo, ref), max(c_hi, ref)
        sub.set_ylim(*_band(c_lo, c_hi, (0.08, 0.6)))
    sub.set_ylabel("Cd")
    sub.tick_params(labelbottom=False)
    sub.legend(loc="upper right", fontsize=7, ncol=2)
    sub.text(0.01, 0.97, _err_text(_q(result, "cd_mean"), "mean Cd"), transform=sub.transAxes, ha="left", va="top",
             fontsize=7, color=INK)


def draw(kind: str, result: dict[str, Any], ax: Any) -> None:
    from ..plots import INK, SECOND, SERIES, note

    s = result["series"]
    if kind == "wake":
        w = s["wake_line"]
        ax.plot(w["x_over_d"], w["ux"], color=SERIES, linewidth=1.6, label="U_x / U on the axis (Magnusim)")
        if "probes_wake" in s:
            p = s["probes_wake"]
            ax.plot(p["x_over_d"], p["ux"], "o", color=SECOND, markersize=3.5, label="wake-axis probes")
        ax.axhline(0.0, color=INK, linewidth=0.8)
        q = _q(result, "l_over_d")
        _wake_ref(ax, (q.get("reference") or {}).get("value"), "reference closure point")
        ax.set_xlabel("x / D (from the cylinder's centre)")
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
    elif kind == "forces_history":
        _draw_forces(result, ax)
    elif kind == "spectrum":
        p = s["spectrum"]
        ax.plot(p["f_over_f0"], p["mag"], color=SERIES, linewidth=1.4, label="|Cl| spectrum over the window")
        ref = (_q(result, "st").get("reference") or {}).get("value")
        st = _q(result, "st").get("value")
        if ref is not None and st:
            ax.axvline(ref / st, color=INK, linestyle="--", linewidth=1.1, label="reference St")
        ax.set_xlabel(f"f / f0 (f0 = {p['f0_hz']:.4g} Hz)")
        ax.set_ylabel("magnitude (peak = 1)")
        ax.legend(loc="upper right", fontsize=7)
        note(ax, _err_text(_q(result, "st"), "St"))
    elif kind == "wake_mean":
        w = s["wake_mean"]
        ax.plot(w["x_over_d"], w["ux"], "o-", color=SERIES, markersize=3.5, linewidth=1.2,
                label="mean U_x / U, wake-axis probes over the window")
        if "umean_line" in s:
            u = s["umean_line"]
            ax.plot(u["x_over_d"], u["ux"], color=SECOND, linewidth=1.0, label="the run's UMean on the axis")
        ax.axhline(0.0, color=INK, linewidth=0.8)
        q = _q(result, "l_over_d_mean")
        _wake_ref(ax, (q.get("reference") or {}).get("value"), "reference mean closure point")
        ax.set_xlabel("x / D (from the cylinder's centre)")
        ax.set_ylabel("U_x / U")
        ax.legend(loc="upper left", fontsize=7)
        note(ax, _err_text(q, "mean L/D"))
    elif kind == "residuals":
        h = s["residuals"]
        for i, k in enumerate(k for k in h if k != "t"):
            ax.semilogy(h["t"], h[k], color=(SERIES, SECOND, INK)[i % 3], linewidth=1.4, label=f"{k} (initial residual)")
        ax.axhline(1e-6, color=INK, linestyle=":", linewidth=1.0, label="target 1e-6")
        ax.set_xlabel("iteration")
        ax.set_ylabel("residual")
        ax.legend(loc="upper right")
