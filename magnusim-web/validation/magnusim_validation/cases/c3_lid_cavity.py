"""Case 3: the lid-driven square cavity at Re = 100 and Re = 1000 (2D), on Hex-dominant one
cell across.

A square box 100 × 100 mm in x-y and 10 mm deep in z; its lid (y = 100 mm) slides in +x at
1 m/s, the other three sides are no-slip walls, and its front and back (z = 0, 10 mm) carry one
Symmetry. Hex-dominant's One cell across (2D) meshes it one cell deep, so the flow is exactly
2D (the design's slab of 40 mm cost several hundred times the cells and was 2D only near its
symmetry planes). A custom fluid with nu = 1e-3 or 1e-4 m²/s and rho = 1 kg/m³: Re = U L / nu =
100 or 1000. Nothing flows in or out: the moving lid drives the flow (gap G1, fixed).

Compared: u along the vertical centreline and v along the horizontal one at Ghia et al.'s
stations (Tables I and II), their extrema against Botella and Peyret, and the primary vortex
(the stream function's minimum and its centre) against Marchi et al. The profiles are sampled
as Plot over path samples them, with the velocity's components kept (``app_sampling``: the
route gives a vector's magnitude only, gap G2); a Plot over path of the pressure on the same
line checks that the two read the same.
"""

from __future__ import annotations

from typing import Any

import numpy as np

from ..extract import extremum, grid_minimum, interp_at, rms, stream_function
from ..model import QuantitySpec, Tolerance, compare
from ..refs import read

ID = "c3_lid_cavity"
TITLE = "Lid-driven cavity"
GROUP = "Internal flow"
VARIANTS = ("re100", "re1000")
VARIANT_LABELS = {"re100": "Re = 100, Hex-dominant (2D)", "re1000": "Re = 1000, Hex-dominant (2D)"}
RE = {"re100": 100, "re1000": 1000}

L_MM = 100.0
DEPTH_MM = 10.0
L = L_MM / 1000.0
ZM = DEPTH_MM / 2000.0  # mid-depth (m): every line and probe lies there
U = 1.0
RHO = 1.0
NU = {v: U * L / re for v, re in RE.items()}
# The mesh: Hex-dominant at fineness 7 (its background cell is the section's diagonal over 64),
# one custom size on every wall reaching across the whole cavity: a uniform 2D mesh finer than
# Ghia et al.'s 129 × 129 grid.
FINENESS = 7
CELL_MM = 0.6
REACH_MM = 50.0
END_TIME = {"re100": 3000, "re1000": 8000}
# The profiles: 201 samples along each centreline (as Plot over path samples them), and the
# stream function from u on 99 vertical lines at x = L/100, 2 L/100, ... of 201 samples each.
LINE_SUBDIV = 200
PSI_LINES = 99

GEOMETRY_WORDS = (f"square cavity {L_MM:g} × {L_MM:g} mm in x-y, {DEPTH_MM:g} mm deep in z (one cell across), "
                  "the lid at y = 100 mm")
FACE_SELECTORS: dict[str, dict[str, Any]] = {
    "lid": {"plane": {"axis": "y", "at_mm": L_MM, "sign": 1}},
    "bottom": {"plane": {"axis": "y", "at_mm": 0.0, "sign": -1}},
    "left": {"plane": {"axis": "x", "at_mm": 0.0, "sign": -1}},
    "right": {"plane": {"axis": "x", "at_mm": L_MM, "sign": 1}},
    "front": {"plane": {"axis": "z", "at_mm": 0.0, "sign": -1}},
    "back": {"plane": {"axis": "z", "at_mm": DEPTH_MM, "sign": 1}},
}

GHIA_U = read("ghia_1982_table1_u.csv")
GHIA_V = read("ghia_1982_table2_v.csv")
BOTELLA = read("botella_peyret_1998_extrema.csv")
MARCHI = read("marchi_2009_vortex.csv")


def stations(table: Any, coord: str, col: str) -> tuple[np.ndarray, np.ndarray]:
    """A Ghia table's interior stations (its two wall points left out: there the value is the
    wall's, not the solution's) and their values, in the order of the coordinate."""
    pts = [(float(r[coord]), float(r[col])) for r in table.rows if 0.0 < float(r[coord]) < 1.0]
    pts.sort()
    return np.asarray([p[0] for p in pts]), np.asarray([p[1] for p in pts])


def _specs(variant: str) -> dict[str, QuantitySpec]:
    re = RE[variant]
    tag = f"Re {re}"
    rms_tol = 0.01 if re == 100 else 0.02
    u_st, _ = stations(GHIA_U, "y", f"u_re{re}")
    v_st, _ = stations(GHIA_V, "x", f"v_re{re}")
    line_how = (
        f"sampled as Plot over path samples a line ({LINE_SUBDIV + 1} samples, the field averaged to the mesh's points, "
        f"the wall's own value on the walls) with the velocity's components kept, on the run's saved U, at mid-depth"
    )
    out: dict[str, QuantitySpec] = {}
    for comp, table, line, st in (("u", GHIA_U, "vertical", u_st), ("v", GHIA_V, "horizontal", v_st)):
        where_line = "x = 0.5 L, y from 0 to L" if comp == "u" else "y = 0.5 L, x from 0 to L"
        which = "Table I" if comp == "u" else "Table II"
        out[f"{comp}_rms"] = QuantitySpec(
            key=f"{comp}_rms",
            label=f"{comp}/U_lid on the {line} centreline, RMS difference from Ghia et al. ({tag})",
            unit="U_lid",
            how=(f"{comp}/U_lid along the {line} centreline ({where_line}), {line_how}, linearly interpolated at Ghia "
                 f"et al.'s {len(st)} interior stations; the root mean square of the differences"),
            source="app_sampling",
            reference=table.reference(0.0, unit="U_lid", where=f"{which} at its {len(st)} interior stations (the RMS of "
                                      "the differences from them, zero for a perfect match)"),
            tolerance=Tolerance(abs_tol=rms_tol, note="the reference data's target RMS"),
        )
        out[f"{comp}_maxdiff"] = QuantitySpec(
            key=f"{comp}_maxdiff",
            label=f"{comp}/U_lid on the {line} centreline, largest difference from Ghia et al. ({tag})",
            unit="U_lid",
            how="the largest |difference| at the same stations, as for the RMS",
            source="app_sampling",
            reference=table.reference(0.0, unit="U_lid", where=f"{which} at its {len(st)} interior stations (the largest "
                                      "difference from them, zero for a perfect match)"),
            tolerance=Tolerance(abs_tol=0.03, note="the reference data's largest difference; Ghia et al. themselves are "
                                "about 0.003 (Re 100) and 0.012 (Re 1000) off the converged values"),
        )
    for key, comp, line, kind in (("u_min", "u", "vertical", "min"), ("v_max", "v", "horizontal", "max"),
                                  ("v_min", "v", "horizontal", "min")):
        row = BOTELLA.row(re=re, quantity=key)
        along = "y" if comp == "u" else "x"
        out[key] = QuantitySpec(
            key=key,
            label=f"{comp}_{kind} / U_lid on the {line} centreline ({tag})",
            unit="",
            how=(f"the {'lowest' if kind == 'min' else 'highest'} sample of {comp}/U_lid along the {line} centreline "
                 f"({line_how}), refined by the parabola through it and its two neighbours"),
            source="app_sampling",
            reference=BOTELLA.reference(float(row["value"]), where=f"the {comp}_{kind} of {tag}, at {along} = {row['at']:g} L"),
            tolerance=Tolerance(rel_pct=3.0, note="the reference data's band for the extrema"),
        )
    psi_how = (f"psi = the integral of u dy from the floor, on {PSI_LINES} vertical lines at x = L/100 to 99 L/100 (u "
               f"sampled as for the centrelines, {LINE_SUBDIV + 1} samples each, trapezoid rule), over U_lid L; its "
               "lowest value refined by a quadratic surface through the 3 × 3 samples around it")
    out["psi_min"] = QuantitySpec(
        key="psi_min",
        label=f"Primary vortex, psi_min / (U_lid L) ({tag})",
        unit="",
        how=psi_how,
        source="app_sampling",
        reference=MARCHI.reference(MARCHI.value(re=re, quantity="psi_min"), where=f"psi_min of {tag}"),
        tolerance=Tolerance(rel_pct=2.0, note="the reference data's band for psi_min"),
    )
    for key, axis in (("vortex_x", "x"), ("vortex_y", "y")):
        out[key] = QuantitySpec(
            key=key,
            label=f"Primary vortex centre, {axis} / L ({tag})",
            unit="L",
            how=f"where psi is lowest (as for psi_min), its {axis} over L",
            source="app_sampling",
            reference=MARCHI.reference(MARCHI.value(re=re, quantity=key), unit="L", where=f"the vortex centre's {axis} of {tag}"),
            tolerance=Tolerance(abs_tol=0.01, note="the reference data's band for the vortex centre"),
        )
    return out


_BY_VARIANT = {v: _specs(v) for v in VARIANTS}
# Every variant's quantities (the report lists their references).
QUANTITIES: dict[str, QuantitySpec] = {f"{k}_{v}": s for v in VARIANTS for k, s in _BY_VARIANT[v].items()}


def quantities(variant: str) -> list[QuantitySpec]:
    return list(_BY_VARIANT[variant].values())


NOTES = (
    "One cell across (2D): the cavity is meshed one cell deep between its front and back, both on one Symmetry, so "
    "the solution is exactly 2D. The design's 40 mm slab is not needed (it cost several hundred times the cells and "
    "its middle was coarser than its ends), and there is nothing to measure between mid-depth and the symmetry "
    "planes: the design's second pair of lines at a quarter of the depth is left out.",
    "The mesh is one Hex-dominant custom size of 0.6 mm on all four walls with Refine out to 50 mm (half the cavity), "
    "so the whole cavity is meshed at that size's level (about 0.55 mm, L/181), and a band a few cells deep along the "
    "walls at the walls' own level of fineness 7 (about 0.28 mm): finer than Ghia et al.'s uniform 129 × 129 grid. "
    "No wall layers: the cells are that fine up to the walls.",
    "The profiles are read as Plot over path reads a line, with the velocity's components kept (the route gives a "
    "vector's magnitude only). A Plot over path of the pressure along the vertical centreline is compared with the "
    "same samples of the pressure here: they must agree (shown with each run).",
    "Ghia et al.'s profile values are the community's reference at fixed stations; at Re 1000 their own solution is "
    "under-resolved, 1 to 3 % below the converged extrema of Botella and Peyret (1998), so the extrema are compared "
    "with those, and the primary vortex with Marchi et al. (2009).",
    "The Point probes at Ghia et al.'s stations are a cross-check (shown): they read the value at each point "
    "(OpenFOAM's cellPoint interpolation, gap G3, fixed).",
)

# A steady run that stops at its iteration limit counts as settled only when these histories
# moved less than SETTLE_DRIFT over its last 10 % of iterations.
SETTLE = (
    {"monitor": "probes_vertical_centreline_8", "sample": "U", "component": 0,
     "label": "U_x at the vertical centreline's probe at y = 0.5 L"},
    {"monitor": "probes_horizontal_centreline_8", "sample": "U", "component": 1,
     "label": "U_y at the horizontal centreline's probe at x = 0.5 L"},
)
SETTLE_DRIFT = 1e-3


def build_geometry() -> Any:
    from ..geometry import box

    return box(L_MM, L_MM, DEPTH_MM)


def _probe(pid: str, name: str, points: list[list[float]]) -> dict[str, Any]:
    return {"id": pid, "name": name, "monitor_type": "probe", "kind": "Point probe", "category": "Point data",
            "write_control": "Time step", "faces": [], "results": None, "series": None, "chart_values": None,
            "results_available": False, "points": points}


def requests(variant: str, *, coarse: bool = False, cores: int = 4) -> dict[str, Any]:
    """What the driver sends, faces as selectors; plan.make_plan resolves them."""
    re = RE[variant]
    end_time = END_TIME[variant] // (4 if coarse else 1)
    u_st, _ = stations(GHIA_U, "y", f"u_re{re}")
    v_st, _ = stations(GHIA_V, "x", f"v_re{re}")
    vertical = [[0.5 * L, 0.0, ZM], [0.5 * L, L, ZM]]
    horizontal = [[0.0, 0.5 * L, ZM], [L, 0.5 * L, ZM]]
    psi_paths = [[[L * i / (PSI_LINES + 1), 0.0, ZM], [L * i / (PSI_LINES + 1), L, ZM]] for i in range(1, PSI_LINES + 1)]
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
            },
        },
        "material": {"preset": "custom", "name": "Validation fluid", "kinematic_viscosity": NU[variant], "density": RHO,
                     "assigned_volumes": ["Body1"]},
        "bcs": [
            {"name": "Lid", "bc_type": "Wall", "wall_type": "Moving", "wall_velocity": [U, 0.0, 0.0],
             "faces": ["@lid"]},
            # A new face-by-face Wall starts Slip: the treatment is always sent.
            {"name": "Walls", "bc_type": "Wall", "wall_type": "No-slip", "faces": ["@bottom", "@left", "@right"]},
            {"name": "Sides", "bc_type": "Symmetry", "faces": ["@front", "@back"]},
        ],
        "mesh": {
            "name": "Mesh 1",
            "settings": {
                "fineness": FINENESS - (2 if coarse else 0),
                "automatic_boundary_layers": False,
                "physics_based_meshing": True,
                "hex_element_core": True,
                "advanced": {"mesh_engine": "snappy_hexdominant"},
                "mesher_settings": {"one_cell_across": True},
            },
            "refinements": [{"name": "Cavity", "type": "Surface custom sizing", "faces": ["@lid", "@bottom", "@left", "@right"],
                             "sizing": "Custom", "default_size": CELL_MM * (2 if coarse else 1), "default_size_unit": "mm",
                             "reach": REACH_MM, "reach_unit": "mm"}],
            # The plan's own: the 2D mesh's depth axis, for its estimate (mesh_plan.py).
            "two_d_axis": "z",
            "expect": {"layers": False, "n_cells": [15_000, 80_000] if not coarse else [2_000, 30_000]},
        },
        "run": {"name": "Validation", "endTime": end_time, "writeInterval": end_time, "cores": int(cores),
                "result_controls": [
                    _probe("rc-vertical", "Vertical centreline", [[0.5 * L, round(y * L, 6), ZM] for y in u_st]),
                    _probe("rc-horizontal", "Horizontal centreline", [[round(x * L, 6), 0.5 * L, ZM] for x in v_st]),
                ]},
        "extract": [
            {"key": "u_vertical", "kind": "app_sampling", "fields": ["U", "p"], "points_m": vertical,
             "subdivisions": LINE_SUBDIV - 1},
            {"key": "v_horizontal", "kind": "app_sampling", "fields": ["U"], "points_m": horizontal,
             "subdivisions": LINE_SUBDIV - 1},
            {"key": "psi_lines", "kind": "app_sampling", "fields": ["U"], "paths_m": psi_paths,
             "subdivisions": LINE_SUBDIV - 1},
            # The route's own reading of the same line, a scalar it gives as it is: the check
            # that app_sampling reads what Plot over path reads.
            {"key": "p_vertical", "kind": "line", "field": "p", "points_m": vertical, "subdivisions": LINE_SUBDIV - 1},
        ],
        "timeouts_s": {"mesh": 1800, "solve": 5400},
    }


# ---------------------------------------------------------------------------------------- evaluate

def _line(sample: dict[str, Any] | None, axis: int, comp: str) -> tuple[np.ndarray, np.ndarray]:
    """A sampled line's coordinate on ``axis`` over L and a component over U_lid."""
    if not sample or not sample.get("n_valid"):
        raise ValueError("no samples")
    pts = np.asarray(sample["sample_points"], dtype=float)
    return pts[:, axis] / L, np.asarray(sample[comp], dtype=float) / U


def evaluate(plan: dict[str, Any], raw: Any) -> dict[str, Any]:
    variant = plan["variant"]
    re = RE[variant]
    specs = _BY_VARIANT[variant]
    warnings: list[str] = []
    shown: dict[str, Any] = {}
    series: dict[str, Any] = {}
    values: dict[str, float | None] = {k: None for k in specs}
    details: dict[str, str] = {}

    for comp, key, axis, table, coord in (("u", "u_vertical", 1, GHIA_U, "y"), ("v", "v_horizontal", 0, GHIA_V, "x")):
        sample = raw.sample(key)
        try:
            s, val = _line(sample, axis, "U_x" if comp == "u" else "U_y")
        except (ValueError, KeyError):
            warnings.append(f"no {comp} profile: {raw.sample_problem(key)}")
            continue
        series[f"{comp}_profile"] = {"s": [float(f"{v:.6g}") for v in s.tolist()],
                                     comp: [float(f"{v:.6g}") for v in val.tolist()]}
        st, ref = stations(table, coord, f"{comp}_re{re}")
        at = interp_at(s, val, st)
        if np.isnan(at).any():
            warnings.append(f"the {comp} profile does not reach every one of Ghia et al.'s stations")
        else:
            diff = at - ref
            values[f"{comp}_rms"] = rms(diff)
            k = int(np.argmax(np.abs(diff)))
            values[f"{comp}_maxdiff"] = float(abs(diff[k]))
            details[f"{comp}_maxdiff"] = f"at {coord} = {st[k]:.4f} L: {at[k]:+.4f} against {ref[k]:+.4f}"
            details[f"{comp}_rms"] = f"over {len(st)} stations, the largest at {coord} = {st[k]:.4f} L"
            series[f"{comp}_stations"] = {"s": st.tolist(), "ghia": ref.tolist(), "magnusim": [float(f"{v:.6g}") for v in at]}
        for qkey, kind in ((("u_min", "min"),) if comp == "u" else (("v_max", "max"), ("v_min", "min"))):
            ext = extremum(s, val, kind=kind)
            values[qkey] = ext["value"]
            ref_at = float(BOTELLA.row(re=re, quantity=qkey)["at"])
            details[qkey] = f"at {coord} = {ext['x']:.4f} L (Botella and Peyret {ref_at:g} L)"
            shown[f"{qkey}_at"] = ext["x"]

    # The primary vortex from the stream function on the vertical lines.
    psi_doc = raw.sample("psi_lines")
    paths = (psi_doc or {}).get("paths") or []
    if len(paths) == PSI_LINES and all(p.get("n_valid") for p in paths):
        ys = np.linspace(0.0, 1.0, LINE_SUBDIV + 1)
        xs, u_rows = [], []
        for p in paths:
            pts = np.asarray(p["sample_points"], dtype=float)
            xs.append(float(pts[0, 0]) / L)
            u_rows.append(interp_at(pts[:, 1] / L, np.asarray(p["U_x"], dtype=float) / U, ys))
        u_grid = np.asarray(u_rows)
        if np.isnan(u_grid).any():
            warnings.append("the stream function's lines do not cover the cavity from floor to lid")
        else:
            psi = stream_function(xs, ys, u_grid)
            m = grid_minimum(xs, ys, psi)
            values["psi_min"], values["vortex_x"], values["vortex_y"] = m["value"], m["x"], m["y"]
            lid_psi = psi[:, -1]
            shown["psi_at_lid_max_abs"] = float(np.max(np.abs(lid_psi)))
            details["psi_min"] = (f"at ({m['x']:.4f}, {m['y']:.4f}) L; psi at the lid (zero for a closed cavity) within "
                                  f"{shown['psi_at_lid_max_abs']:.1e} on every line")
    else:
        warnings.append(f"no stream function: {raw.sample_problem('psi_lines')}")

    # The route against app_sampling on the same line: the pressure, a scalar both read as it is.
    route = raw.line("p_vertical")
    mine = raw.sample("u_vertical")
    if route and route.get("n_valid") and mine and mine.get("p"):
        a, b = np.asarray(route["values"], dtype=float), np.asarray(mine["p"], dtype=float)
        if a.shape == b.shape:
            shown["route_vs_app_sampling_p_max_abs"] = float(np.max(np.abs(a - b)))
            shown["route_p_range"] = [float(a.min()), float(a.max())]
        else:
            warnings.append(f"Plot over path gave {a.size} samples of p, app_sampling {b.size}")
    # The probes (the value at each point): their RMS difference from Ghia et al.
    for comp, name, axis, table, coord in (("u", "Vertical centreline", 1, GHIA_U, "y"),
                                           ("v", "Horizontal centreline", 0, GHIA_V, "x")):
        pv = raw.probe_values(name, component=0 if comp == "u" else 1, axis=axis)
        st, ref = stations(table, coord, f"{comp}_re{re}")
        if len(pv) == len(st):
            got = np.asarray([v for _, v in pv]) / U
            shown[f"probe_{comp}_rms"] = rms(got - ref)
            series[f"{comp}_probes"] = {"s": [x / L for x, _ in pv], comp: got.tolist()}
        elif pv:
            warnings.append(f"{len(pv)} of the {len(st)} {comp} probes read")
    rows = [compare(spec, values[k], detail=details.get(k, "")) for k, spec in specs.items()]
    return {"quantities": rows, "series": series, "shown": shown, "warnings": warnings}


def setup_words(result: dict[str, Any]) -> str:
    v = result.get("variant")
    nu = NU.get(str(v))
    return (
        f"A {GEOMETRY_WORDS} (STEP in mm, built with OCP); a custom fluid with nu = {nu:g} m²/s and rho = {RHO:g} kg/m³, "
        f"so Re = U_lid L / nu = {RE.get(str(v))}; the lid a moving wall at {U:g} m/s along +x, the floor and the two "
        f"sides no-slip walls, the front and back one Symmetry; nothing flows in or out; laminar, steady (simpleFoam), "
        f"Accurate numerics, residual targets 1e-6, at most {END_TIME.get(str(v))} iterations."
    )


def mesh_words(result: dict[str, Any]) -> str:
    mesh = result.get("setup", {}).get("mesh", {})
    fine = (mesh.get("settings") or {}).get("fineness")
    ref = (mesh.get("refinements") or [{}])[0]
    return (f"Hex-dominant at fineness {fine}, One cell across (2D) on, a custom size of {ref.get('default_size'):g} mm "
            f"on the lid and the three walls with Refine out to {ref.get('reach'):g} mm (the whole cavity), no wall layers; "
            "1 non-orthogonal corrector")


def shown_words(result: dict[str, Any]) -> list[str]:
    from ..report import num

    s = result.get("shown") or {}
    bits: list[str] = []
    if s.get("route_vs_app_sampling_p_max_abs") is not None:
        lo, hi = s.get("route_p_range") or [None, None]
        bits.append(f"Plot over path's p along the vertical centreline and app_sampling's agree within "
                    f"{num(s['route_vs_app_sampling_p_max_abs'], 2)} Pa (p from {num(lo, 3)} to {num(hi, 3)} Pa)")
    if s.get("psi_at_lid_max_abs") is not None:
        bits.append(f"psi at the lid within {num(s['psi_at_lid_max_abs'], 2)} U_lid L of zero on every line (the "
                    "cavity is closed: the flow up and down each line balances)")
    for comp in ("u", "v"):
        if s.get(f"probe_{comp}_rms") is not None:
            bits.append(f"the Point probes' {comp}/U_lid at Ghia et al.'s stations within an RMS {num(s[f'probe_{comp}_rms'], 3)} "
                        "of them")
    return bits


# ---------------------------------------------------------------------------------------- figures

FIGURES = (
    ("u_profile", "u on the vertical centreline"),
    ("v_profile", "v on the horizontal centreline"),
    ("residuals", "residuals"),
)
_NEEDS = {"u_profile": "u_profile", "v_profile": "v_profile", "residuals": "residuals"}


def has_figure(kind: str, result: dict[str, Any]) -> bool:
    return _NEEDS[kind] in (result.get("series") or {})


def _q(result: dict[str, Any], key: str) -> dict[str, Any]:
    return next((q for q in result.get("quantities") or [] if q["key"] == key), {})


def _v(result: dict[str, Any], key: str, ref: bool = False) -> float:
    """A quantity's value (or its reference's) for a figure's text; NaN when it has none."""
    q = _q(result, key)
    v = (q.get("reference") or {}).get("value") if ref else q.get("value")
    return float("nan") if v is None else float(v)


def draw(kind: str, result: dict[str, Any], ax: Any) -> None:
    from ..plots import INK, SECOND, SERIES, note

    s = result["series"]
    if kind in ("u_profile", "v_profile"):
        comp = kind[0]
        prof = s[kind]
        st = s.get(f"{comp}_stations")
        if comp == "u":
            ax.plot(prof["u"], prof["s"], color=SERIES, linewidth=1.6, label="Magnusim (sampled as Plot over path)")
            if st:
                ax.plot(st["ghia"], st["s"], linestyle="none", marker="o", markersize=5, markerfacecolor="none",
                        markeredgecolor=INK, label="Ghia et al. (1982), Table I")
            if f"{comp}_probes" in s:
                ax.plot(s["u_probes"]["u"], s["u_probes"]["s"], linestyle="none", marker="x", markersize=4,
                        color=SECOND, label="Point probes")
            ax.set_xlabel("u / U_lid at x = 0.5 L")
            ax.set_ylabel("y / L")
            ax.legend(loc="lower right", fontsize=8)
            text = [f"RMS difference {_v(result, 'u_rms'):.4f} U_lid",
                    f"u_min {_v(result, 'u_min'):.4f} (Botella and Peyret {_v(result, 'u_min', ref=True):.4f})"]
            ax.text(0.04, 0.96, "\n".join(text), transform=ax.transAxes, ha="left", va="top", fontsize=8, color=INK,
                    bbox={"boxstyle": "round,pad=0.35", "facecolor": "white", "edgecolor": "#d9d8d4"})
        else:
            ax.plot(prof["s"], prof["v"], color=SERIES, linewidth=1.6, label="Magnusim (sampled as Plot over path)")
            if st:
                ax.plot(st["s"], st["ghia"], linestyle="none", marker="o", markersize=5, markerfacecolor="none",
                        markeredgecolor=INK, label="Ghia et al. (1982), Table II")
            if f"{comp}_probes" in s:
                ax.plot(s["v_probes"]["s"], s["v_probes"]["v"], linestyle="none", marker="x", markersize=4,
                        color=SECOND, label="Point probes")
            ax.set_xlabel("x / L")
            ax.set_ylabel("v / U_lid at y = 0.5 L")
            ax.legend(loc="lower left", fontsize=8)
            note(ax, f"RMS difference {_v(result, 'v_rms'):.4f} U_lid\n"
                     f"v_max {_v(result, 'v_max'):.4f}, v_min {_v(result, 'v_min'):.4f}")
    elif kind == "residuals":
        h = s["residuals"]
        for i, key in enumerate(k for k in h if k != "t"):
            ax.semilogy(h["t"], h[key], color=(SERIES, SECOND, INK)[i % 3], linewidth=1.4, label=f"{key} (initial residual)")
        ax.axhline(1e-6, color=INK, linestyle=":", linewidth=1.0, label="target 1e-6")
        ax.set_xlabel("iteration")
        ax.set_ylabel("residual")
        ax.legend(loc="upper right")
