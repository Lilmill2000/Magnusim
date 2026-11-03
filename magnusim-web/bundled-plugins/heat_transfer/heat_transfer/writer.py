"""The OpenFOAM case of a Heat Transfer run: buoyant flow of one fluid.

buoyantSimpleFoam (steady) or buoyantPimpleFoam (transient), OpenFOAM ESI v2606:

- ``constant/thermophysicalProperties``: heRhoThermo, pureMixture, const
  transport, hConst, sensibleEnthalpy and the study's equation of state
  (incompressiblePerfectGas with pRef = the operating pressure, Boussinesq
  with rho0 / T0 / beta, or rhoConst); a transient run adds ``dpdt no``.
- ``constant/turbulenceProperties`` (laminar or RAS) and ``constant/g``.
- ``0/``: U and the turbulence fields from Incompressible Flow's exported flow
  BCs (incompressible_flow.flow_bcs), and T, p_rgh, p and alphat written here.
  Pressure is gauge (0 at the operating pressure): the operating pressure
  only enters the perfect gas density through pRef.
- ``system/``: fvSchemes and fvSolution for buoyant SIMPLE or PIMPLE, and
  controlDict with the function objects of heat_transfer.functions.

The case's ``w27-case.json`` records what was written (the fluid, the density
model, gravity, each boundary's thermal condition, the monitors' plans and the
energy balance's patches): heat_transfer.results reads it back.
"""

from __future__ import annotations

import dataclasses
import json
import math
import re
import shutil
from pathlib import Path
from typing import Any

from magnusim_sdk.foam import (
    js_plain_float,
    write_decompose_par_dict,
    write_foam_dict,
    write_vol_field,
)

from .bcs import FIXED_T, HEAT_FLUX, HTC, backflow_temperature, inlet_temperature, wall_thermal
from .functions import OPENING_KINDS, functions_text, plan_monitors
from .materials import R_UNIVERSAL, FluidProps
from .physics import EQUATION_OF_STATE, solved_turbulence_fields
from .runspec import HtSpec
from .settle import plan_settle, settle_functions_text
from .transient import TransientControl, foam_num

_TIME_NAME = re.compile(r"^\d+(\.\d+)?(?:[eE][+-]?\d+)?$")
_LOG_PART = re.compile(r"^log\.(buoyantSimpleFoam|buoyantPimpleFoam|chtMultiRegionSimpleFoam|chtMultiRegionFoam)\.\d+$")
PRT = 0.85


def num(x: float) -> str:
    """A number as the case writes it: up to 8 significant digits, no trailing zeros."""
    x = float(x)
    if x == 0 or not math.isfinite(x):
        return "0"
    return f"{x:.8g}"


def reference_density(fluid: FluidProps, density: str, t_ref: float, p_op: float) -> float:
    """The fluid's density at the reference temperature, as the solver computes it."""
    if density == "perfect_gas":
        return p_op * fluid.molar_mass / (R_UNIVERSAL * t_ref)
    return fluid.rho


# ---------------------------------------------------------------------------
# constant/
# ---------------------------------------------------------------------------


def thermophysical_text(fluid: FluidProps, *, density: str, t_ref: float, p_op: float, transient: bool) -> str:
    eos = EQUATION_OF_STATE[density]
    if density == "perfect_gas":
        eos_dict = f"equationOfState {{ pRef {num(p_op)}; }}"
    elif density == "boussinesq":
        eos_dict = f"equationOfState {{ rho0 {num(fluid.rho)}; T0 {num(t_ref)}; beta {num(fluid.beta)}; }}"
    else:
        eos_dict = f"equationOfState {{ rho {num(fluid.rho)}; }}"
    # dpdt no: the pressure work term off. Transient runs with incompressible
    # perfect gas diverge with it on (HT0); the others lose nothing.
    dpdt = "\n\ndpdt            no;" if transient else ""
    return f"""thermoType
{{
    type            heRhoThermo;
    mixture         pureMixture;
    transport       const;
    thermo          hConst;
    equationOfState {eos};
    specie          specie;
    energy          sensibleEnthalpy;
}}

mixture
{{
    specie          {{ molWeight {num(fluid.molar_mass)}; }}
    thermodynamics  {{ Cp {num(fluid.cp)}; Hf 0; }}
    transport       {{ mu {num(fluid.mu)}; Pr {num(fluid.prandtl)}; }}
    {eos_dict}
}}{dpdt}"""


def turbulence_text(model: str) -> str:
    if model == "laminar":
        return "simulationType  laminar;"
    return f"""simulationType  RAS;

RAS
{{
    RASModel        {model};
    turbulence      on;
    printCoeffs     off;
}}"""


# ---------------------------------------------------------------------------
# system/
# ---------------------------------------------------------------------------

_SCHEMES: dict[str, dict[str, str]] = {
    # Robust: the energy equation second order (bounded TVD), turbulence first
    # order, strongly limited gradients. Accurate: everything second order,
    # lighter limiting, full non-orthogonal correction. grad(h) is never limited:
    # limitedLinear bounds h itself, and a limited grad(h) makes that limiter flip
    # from one iteration to the next, so h stalls near a residual of 1e-3 (a heated
    # pipe kept a 4 % heat imbalance; 0.02 % with grad(h) unlimited).
    "robust": {
        "grad": "cellLimited Gauss linear 1",
        "energy": "Gauss limitedLinear 1",
        "K": "Gauss upwind",
        "turb": "Gauss upwind",
        "laplacian": "Gauss linear limited corrected 0.5",
        "sn_grad": "limited corrected 0.5",
    },
    "accurate": {
        "grad": "cellMDLimited Gauss linear 0.5",
        "energy": "Gauss limitedLinear 1",
        "K": "Gauss limitedLinear 1",
        "turb": "Gauss limitedLinear 1",
        "laplacian": "Gauss linear corrected",
        "sn_grad": "corrected",
    },
}


def fv_schemes_text(*, model: str, numerics: str, transient: TransientControl | None) -> str:
    s = _SCHEMES.get(numerics) or _SCHEMES["robust"]
    bounded = "" if transient is not None else "bounded "
    if transient is None:
        ddt = "steadyState"
    else:
        ddt = "backward" if transient.time_scheme == "backward" else "Euler"
    grads = "".join(f"    {'grad(' + f + ')':<15} {s['grad']};\n" for f in solved_turbulence_fields(model))
    divs = "".join(f"    {'div(phi,' + f + ')':<15} {bounded}{s['turb']};\n" for f in solved_turbulence_fields(model))
    return f"""ddtSchemes {{ default {ddt}; }}
gradSchemes
{{
    default         Gauss linear;
    grad(U)         {s["grad"]};
    grad(h)         Gauss linear;
{grads}}}
divSchemes
{{
    default         none;
    div(phi,U)      {bounded}Gauss linearUpwind grad(U);
    div(phi,h)      {bounded}{s["energy"]};
    div(phi,K)      {bounded}{s["K"]};
{divs}    div(((rho*nuEff)*dev2(T(grad(U))))) Gauss linear;
}}
laplacianSchemes {{ default {s["laplacian"]}; }}
interpolationSchemes {{ default linear; }}
snGradSchemes {{ default {s["sn_grad"]}; }}
wallDist {{ method meshWave; }}"""


def _eq_regex(model: str) -> str:
    return '"(' + "|".join(("U", "h", *solved_turbulence_fields(model))) + ')"'


def fv_solution_text(
    *,
    model: str,
    residual: float,
    n_non_orth: int,
    transient: TransientControl | None,
    residual_control: bool = True,
    relax: tuple[float, float, float] = (0.7, 0.3, 0.5),
) -> str:
    eq = _eq_regex(model)
    turb = solved_turbulence_fields(model)
    if transient is None:
        res = f"p_rgh {num(residual)}; U {num(residual)}; h {num(residual)};"
        if turb:
            res += ' "(' + "|".join(turb) + f')" {num(max(residual, 1e-4))};'
        residual_line = f"    residualControl {{ {res} }}\n" if residual_control else ""
        relax_u, relax_p, relax_h = (num(r) for r in relax)
        turb_relax = f'        "({"|".join(turb)})" {relax_u};\n' if turb else ""
        return f"""solvers
{{
    p_rgh
    {{
        solver          GAMG;
        smoother        GaussSeidel;
        tolerance       1e-7;
        relTol          0.01;
        maxIter         200;
    }}
    {eq}
    {{
        solver          PBiCGStab;
        preconditioner  DILU;
        tolerance       1e-8;
        relTol          0.1;
    }}
}}

SIMPLE
{{
    momentumPredictor yes;
    nNonOrthogonalCorrectors {int(n_non_orth)};
    pRefCell        0;
    pRefValue       0;
{residual_line}}}

relaxationFactors
{{
    fields
    {{
        rho             1;
        p_rgh           {relax_p};
    }}
    equations
    {{
        U               {relax_u};
        h               {relax_h};
{turb_relax}    }}
}}"""
    final = eq[:-1] + 'Final"'
    return f"""solvers
{{
    "rho.*"
    {{
        solver          diagonal;
    }}
    p_rgh
    {{
        solver          GAMG;
        smoother        GaussSeidel;
        tolerance       1e-7;
        relTol          0.01;
        maxIter         200;
    }}
    p_rghFinal
    {{
        $p_rgh;
        tolerance       1e-6;
        relTol          0;
    }}
    {eq}
    {{
        solver          PBiCGStab;
        preconditioner  DILU;
        tolerance       1e-8;
        relTol          0.1;
    }}
    {final}
    {{
        $U;
        relTol          0;
    }}
}}

PIMPLE
{{
    momentumPredictor yes;
    nOuterCorrectors {int(transient.n_outer_correctors)};
    nCorrectors     {int(transient.n_correctors)};
    nNonOrthogonalCorrectors {int(n_non_orth)};
    pRefCell        0;
    pRefValue       0;
}}

relaxationFactors
{{
    equations
    {{
        ".*"            1;
    }}
}}"""


def control_dict_text(
    *,
    app: str,
    spec: HtSpec,
    functions: str,
    restart_from: float | None,
    max_di: float | None = None,
) -> str:
    restart = restart_from is not None
    t = spec.transient
    if t is None:
        span = float(spec.end_time) - float(restart_from or 0)
        every = min(float(spec.write_interval), span) if span > 0 else float(spec.write_interval)
        return f"""application     {app};
startFrom       {"latestTime" if restart else "startTime"};
startTime       0;
stopAt          endTime;
endTime         {js_plain_float(float(spec.end_time))};
deltaT          1;
writeControl    {"runTime" if restart else "timeStep"};
writeInterval   {js_plain_float(every)};
purgeWrite      0;
writeFormat     binary;
writePrecision  8;
writeCompression off;
timeFormat      general;
timePrecision   6;
runTimeModifiable true;

functions
{{
{functions}
}}"""
    return f"""application     {app};
startFrom       {"latestTime" if restart else "startTime"};
startTime       0;
stopAt          endTime;
endTime         {foam_num(t.end_time)};
deltaT          {foam_num(t.delta_t)};
writeControl    {"adjustableRunTime" if t.adjust_time_step else "runTime"};
writeInterval   {foam_num(t.write_interval)};
purgeWrite      0;
writeFormat     binary;
writePrecision  8;
writeCompression off;
timeFormat      general;
timePrecision   8;
runTimeModifiable true;

adjustTimeStep  {"yes" if t.adjust_time_step else "no"};
maxCo           {foam_num(t.max_co)};{f"{chr(10)}maxDi           {foam_num(max_di)};" if max_di is not None else ""}
maxDeltaT       {foam_num(t.max_delta_t)};

functions
{{
{functions}
}}"""


# ---------------------------------------------------------------------------
# 0/
# ---------------------------------------------------------------------------


def thermal_entries(
    flow: Any, spec: HtSpec, *, turbulent: bool
) -> tuple[dict[str, dict[str, dict[str, str]]], dict[str, dict[str, Any]]]:
    """T, p_rgh, p and alphat entries per patch, and each patch's thermal condition."""
    from incompressible_flow.flow_bcs import boundary_pressure_pa

    T: dict[str, dict[str, str]] = {}
    p_rgh: dict[str, dict[str, str]] = {}
    p: dict[str, dict[str, str]] = {}
    alphat: dict[str, dict[str, str]] = {}
    meta: dict[str, dict[str, Any]] = {}
    for name in flow.patch_names:
        kind = flow.kinds.get(name, "wall")
        rec = flow.records.get(name) or {}
        p[name] = {"type": "calculated", "value": "uniform 0"}
        alphat[name] = {"type": "calculated", "value": "uniform 0"}
        if kind == "symmetry":
            for d in (T, p_rgh, p, alphat):
                d[name] = {"type": "symmetry"}
            meta[name] = {"kind": kind}
            continue
        if kind in ("inlet", "total_pressure"):
            t_in = inlet_temperature(rec)
            meta[name] = {"kind": kind, "T_K": t_in}
            if kind == "inlet":
                T[name] = {"type": "fixedValue", "value": f"uniform {num(t_in)}"}
                p_rgh[name] = {"type": "fixedFluxPressure", "value": "uniform 0"}
            else:
                p0 = boundary_pressure_pa(rec)
                T[name] = {"type": "inletOutlet", "inletValue": f"uniform {num(t_in)}", "value": f"uniform {num(t_in)}"}
                p_rgh[name] = {"type": "prghTotalPressure", "p0": f"uniform {num(p0)}", "value": f"uniform {num(p0)}"}
                meta[name]["p0_Pa"] = p0
            continue
        if kind in ("pressure", "velocity_outlet", "freestream"):
            t_back = backflow_temperature(rec)
            meta[name] = {"kind": kind, "T_K": t_back}
            T[name] = {"type": "inletOutlet", "inletValue": f"uniform {num(t_back)}", "value": f"uniform {num(t_back)}"}
            if kind == "pressure":
                pa = boundary_pressure_pa(rec)
                p_rgh[name] = {"type": "prghPressure", "p": f"uniform {num(pa)}", "value": f"uniform {num(pa)}"}
                meta[name]["p_Pa"] = pa
            elif kind == "freestream":
                pa = boundary_pressure_pa(rec)
                p_rgh[name] = {"type": "freestreamPressure", "freestreamValue": f"uniform {num(pa)}", "value": f"uniform {num(pa)}"}
                meta[name]["p_Pa"] = pa
            else:
                p_rgh[name] = {"type": "fixedFluxPressure", "value": "uniform 0"}
            continue
        # A wall (a BC's or one no BC claims).
        w = wall_thermal(rec)
        meta[name] = {"kind": "wall", "wall": flow.wall_motion.get(name, "no_slip"), **w}
        p_rgh[name] = {"type": "fixedFluxPressure", "value": "uniform 0"}
        start = num(spec.physics.start_temperature())
        if w["mode"] == FIXED_T:
            T[name] = {"type": "fixedValue", "value": f"uniform {num(w['T'])}"}
        elif w["mode"] == HEAT_FLUX:
            T[name] = {
                "type": "externalWallHeatFluxTemperature",
                "mode": "flux",
                "q": f"uniform {num(w['q'])}",
                "kappaMethod": "fluidThermo",
                "value": f"uniform {start}",
            }
        elif w["mode"] == HTC:
            T[name] = {
                "type": "externalWallHeatFluxTemperature",
                "mode": "coefficient",
                "h": f"uniform {num(w['h'])}",
                "Ta": f"constant {num(w['Ta'])}",
                "kappaMethod": "fluidThermo",
                "value": f"uniform {start}",
            }
        else:
            T[name] = {"type": "zeroGradient"}
        nut = (flow.turbulence.get("nut") or {}).get(name) or {}
        if turbulent and "WallFunction" in str(nut.get("type") or ""):
            alphat[name] = {"type": "compressible::alphatJayatillekeWallFunction", "Prt": num(PRT), "value": "uniform 0"}
    return {"T": T, "p_rgh": p_rgh, "p": p, "alphat": alphat}, meta


# ---------------------------------------------------------------------------
# The case
# ---------------------------------------------------------------------------


def _is_frame(folder: Path, regions: list[str]) -> bool:
    """A saved time with its frame: T and U (one region), or T in every region's folder."""
    if regions:
        return all((folder / r / "T").is_file() for r in regions)
    return (folder / "T").is_file() and (folder / "U").is_file()


def case_regions(out_dir: Path) -> list[str]:
    """The regions a run's case was written with (its ``w27-case.json``), [] for one region."""
    try:
        doc = json.loads((out_dir / "w27-case.json").read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return []
    rows = doc.get("regions") if isinstance(doc, dict) else None
    return [str(r["name"]) for r in rows if isinstance(r, dict) and r.get("name")] if isinstance(rows, list) else []


def latest_saved_time(out_dir: Path) -> float | None:
    """The latest saved time (> 0) of a run's case whose frame has T and U (in a case of
    several regions: T in every region), or None."""
    best: float | None = None
    if not out_dir.is_dir():
        return None
    regions = case_regions(out_dir)
    for child in out_dir.iterdir():
        if not (child.is_dir() and _TIME_NAME.match(child.name)):
            continue
        t = float(child.name)
        if t > 0 and _is_frame(child, regions) and (best is None or t > best):
            best = t
    return best


def _clean_prior_run(out_dir: Path, *, keep_times: bool) -> None:
    if not out_dir.is_dir():
        return
    for child in list(out_dir.iterdir()):
        name = child.name
        is_time = child.is_dir() and _TIME_NAME.match(name) and float(name) > 0
        is_tmp = child.is_dir() and (name.startswith(".sync_") or name.startswith(".frame-"))
        if is_tmp or (is_time and not keep_times):
            shutil.rmtree(child, ignore_errors=True)
        elif not keep_times and child.is_file() and _LOG_PART.match(name):
            child.unlink(missing_ok=True)
    if keep_times:
        return
    for stale in (
        "postProcessing",
        "log.buoyantSimpleFoam",
        "log.buoyantPimpleFoam",
        "log.chtMultiRegionSimpleFoam",
        "log.chtMultiRegionFoam",
        "log.decomposePar",
        "log.reconstructPar",
        "log.reconstructPar.live",
        "log.livesync",
    ):
        path = out_dir / stale
        if path.is_dir():
            shutil.rmtree(path, ignore_errors=True)
        elif path.exists():
            path.unlink(missing_ok=True)


def _copy_polymesh(src_case: Path, out_dir: Path) -> Path | None:
    candidates = [src_case / "constant" / "polyMesh", src_case if (src_case / "owner").is_file() else None]
    poly_src = next((c for c in candidates if c and c.is_dir() and (c / "owner").is_file()), None)
    const = out_dir / "constant"
    const.mkdir(parents=True, exist_ok=True)
    poly_dst = const / "polyMesh"
    if poly_src is None:
        return None
    if poly_dst.exists():
        shutil.rmtree(poly_dst)
    shutil.copytree(poly_src, poly_dst)
    return poly_dst


def solver_app(spec: HtSpec) -> str:
    """buoyantSimpleFoam / buoyantPimpleFoam, or with a solid body chtMultiRegionSimpleFoam /
    chtMultiRegionFoam (the solver follows the study's materials)."""
    from .contract import STEADY_SOLVER, TRANSIENT_SOLVER

    if spec.cht:
        from .cht_writer import solver_app as cht_app

        return cht_app(spec)
    return TRANSIENT_SOLVER if spec.transient is not None else STEADY_SOLVER


def _clean_regions(out: Path) -> None:
    """What a conjugate heat transfer case written here before left: its regions'
    folders and its regionProperties (a case of one region must not have them)."""
    (out / "constant" / "regionProperties").unlink(missing_ok=True)
    for folder in ("constant", "system", "0"):
        root = out / folder
        if not root.is_dir():
            continue
        for child in list(root.iterdir()):
            if child.is_dir() and child.name not in ("polyMesh", "triSurface"):
                shutil.rmtree(child, ignore_errors=True)


def health_hints(
    spec: HtSpec,
    *,
    app: str,
    model: str,
    records: dict[str, dict[str, Any]] | None,
    speed_ref: float | None,
    max_di: float | None = None,
) -> dict[str, Any]:
    """The run's ``health_hints`` (RH1, magnusim_sdk.health): the solver mode, Courant
    setting, reference speed, linear solver caps (p_rgh 200; the rest OpenFOAM's 1000), no
    velocity limit, and a fixed inflow only when every opening that brings flow in holds a
    fixed velocity (never for natural convection)."""
    t = spec.transient
    n_outer = max(1, int(t.n_outer_correctors)) if t is not None else None
    if t is not None:
        mode = "PISO" if (n_outer or 1) <= 1 else "PIMPLE"
    else:
        mode = "SIMPLE"
    final = 0.0 if t is not None else None
    linsolve: dict[str, dict[str, Any]] = {
        "p_rgh": {"max_iter": 200, "tol": 1e-7, "rel_tol": 0.01, "final_rel_tol": final if final is not None else 0.01}
    }
    for f in ("U", "h", *solved_turbulence_fields(model)):
        linsolve[f] = {"max_iter": 1000, "tol": 1e-8, "rel_tol": 0.1, "final_rel_tol": final if final is not None else 0.1}
    inlets = 0
    driven = False
    for rec in (records or {}).values():
        kind = str(rec.get("bc_type") or "").strip().lower()
        if kind in ("velocity inlet",):
            if rec.get("time_varying") and t is not None:
                driven = True
            inlets += 1
        elif "pressure" in kind and "inlet" in kind:
            driven = True
    hints: dict[str, Any] = {
        "app": app,
        "mode": mode,
        "n_outer": n_outer,
        "n_correctors": max(1, int(t.n_correctors)) if t is not None else None,
        "max_co": float(t.max_co) if t is not None and t.adjust_time_step else None,
        "end_time": float(spec.end_time),
        "average_from": None,
        "uref": float(speed_ref) if speed_ref else None,
        "uref_source": "inlet" if inlets else None,
        "fixed_inflow": bool(inlets) and not driven,
        "turbulence": model,
        "limiter": None,
        "linsolve": linsolve,
        "monitors": None,
    }
    if max_di is not None:
        hints["max_di"] = float(max_di)
    return hints


def write_case(spec: HtSpec, out_dir: Path | str) -> dict[str, Any]:
    """Write the whole case into ``out_dir``; the report the core records."""
    from incompressible_flow.flow_bcs import flow_patches

    out = Path(out_dir)
    for sub in ("0", "constant", "system"):
        (out / sub).mkdir(parents=True, exist_ok=True)
    restart_from: float | None = None
    if spec.restart:
        restart_from = latest_saved_time(out)
        if restart_from is None:
            return {"ok": False, "error": "This run has no saved result to continue from."}
        if bool(case_regions(out)) != spec.cht:
            was = "conjugate heat transfer" if not spec.cht else "buoyant flow of one fluid"
            return {
                "ok": False,
                "error": (
                    f"This run solved {was}, and the study's materials have changed since (the solver follows "
                    "them): start a new run."
                ),
            }
        if float(spec.end_time) <= restart_from:
            return {
                "ok": False,
                "error": f"The new end ({js_plain_float(float(spec.end_time))}) must be after the last saved time ({js_plain_float(restart_from)}).",
            }
        if spec.transient is not None:
            span = float(spec.end_time) - restart_from
            every = float(spec.transient.write_interval)
            n = max(1, math.ceil(span / every - 1e-9))
            every = float(f"{span / n:.12g}")
            spec = dataclasses.replace(spec, transient=dataclasses.replace(spec.transient, write_interval=every), write_interval=every)
    _clean_prior_run(out, keep_times=restart_from is not None)
    if spec.cht:
        from .cht_writer import write_cht_case

        return write_cht_case(spec, out, restart_from=restart_from)
    if restart_from is None:
        _clean_regions(out)

    kept = out / "constant" / "polyMesh"
    poly_dst = kept if restart_from is not None and (kept / "owner").is_file() else _copy_polymesh(Path(spec.mesh_case_dir), out)

    ph = spec.physics
    fluid = spec.fluid
    if fluid is None:
        return {"ok": False, "error": "Assign a fluid to a volume first"}
    density = spec.density_model
    rho_ref = reference_density(fluid, density, ph.reference_temperature, ph.operating_pressure)
    model = ph.turbulence_model
    turbulent = model != "laminar"
    flow = flow_patches(
        spec.inputs,
        nu=fluid.mu / rho_ref,
        rho=rho_ref,
        turbulence_model=model,
        poly_mesh=poly_dst,
        compressible=True,
    )
    th, meta = thermal_entries(flow, spec, turbulent=turbulent)
    t0 = num(ph.start_temperature())

    # Fields of a previous model or run in this folder.
    for stale in ("k", "omega", "epsilon", "nut", "nuTilda", "R", "alphat", "phi"):
        (out / "0" / stale).unlink(missing_ok=True)
    write_vol_field(out / "0" / "U", object_name="U", cls="volVectorField", dims="[0 1 -1 0 0 0 0]",
                    internal="uniform (0 0 0)", patches=flow.U)
    write_vol_field(out / "0" / "T", object_name="T", cls="volScalarField", dims="[0 0 0 1 0 0 0]",
                    internal=f"uniform {t0}", patches=th["T"])
    write_vol_field(out / "0" / "p_rgh", object_name="p_rgh", cls="volScalarField", dims="[1 -1 -2 0 0 0 0]",
                    internal="uniform 0", patches=th["p_rgh"])
    write_vol_field(out / "0" / "p", object_name="p", cls="volScalarField", dims="[1 -1 -2 0 0 0 0]",
                    internal="uniform 0", patches=th["p"])
    dims = {"k": "[0 2 -2 0 0 0 0]", "omega": "[0 0 -1 0 0 0 0]", "epsilon": "[0 2 -3 0 0 0 0]", "nut": "[0 2 -1 0 0 0 0]"}
    if turbulent:
        write_vol_field(out / "0" / "alphat", object_name="alphat", cls="volScalarField", dims="[1 -1 -1 0 0 0 0]",
                        internal="uniform 0", patches=th["alphat"])
        for name, patches in flow.turbulence.items():
            write_vol_field(out / "0" / name, object_name=name, cls="volScalarField", dims=dims[name],
                            internal=flow.turbulence_internal[name], patches=patches)

    wall_patches = [n for n in flow.patch_names if flow.kinds.get(n) == "wall"]
    opening_patches = [n for n in flow.patch_names if flow.kinds.get(n) in OPENING_KINDS]
    if poly_dst and (poly_dst / "boundary").is_file():
        from magnusim_sdk.foam import parse_boundary_patch_types
        from magnusim_sdk.gmsh_helpers import apply_boundary_patch_types

        types = {n: "wall" for n in wall_patches}
        types.update({n: "symmetry" for n in flow.patch_names if flow.kinds.get(n) == "symmetry"})
        for pname, ptype in parse_boundary_patch_types(poly_dst / "boundary").items():
            if pname not in types and ptype in ("symmetry", "wall"):
                types[pname] = "patch"
        apply_boundary_patch_types(poly_dst / "boundary", types)

    transient = spec.transient is not None
    write_foam_dict(out / "constant" / "thermophysicalProperties", "dictionary", "thermophysicalProperties",
                    thermophysical_text(fluid, density=density, t_ref=ph.reference_temperature,
                                        p_op=ph.operating_pressure, transient=transient))
    write_foam_dict(out / "constant" / "turbulenceProperties", "dictionary", "turbulenceProperties", turbulence_text(model))
    g = ph.g()
    write_foam_dict(out / "constant" / "g", "uniformDimensionedVectorField", "g",
                    f"dimensions      [0 1 -2 0 0 0 0];\nvalue           ({num(g[0])} {num(g[1])} {num(g[2])});")
    # A case written before by another solver may hold its own files here.
    for stale in ("transportProperties", "momentumTransport", "physicalProperties"):
        (out / "constant" / stale).unlink(missing_ok=True)
    (out / "system" / "fvOptions").unlink(missing_ok=True)

    from .runspec import convergence_stops_off

    stops_off = convergence_stops_off(spec)
    plans = plan_monitors(spec, flow)
    settle = None if stops_off else plan_settle(spec, plans)
    functions = functions_text(
        wall_patches=wall_patches, opening_patches=opening_patches, monitor_plans=plans, t_ref=ph.reference_temperature
    )
    stop_text = settle_functions_text(settle)
    if stop_text:
        functions += "\n" + stop_text
    app = solver_app(spec)
    write_foam_dict(out / "system" / "controlDict", "dictionary", "controlDict",
                    control_dict_text(app=app, spec=spec, functions=functions, restart_from=restart_from))
    write_foam_dict(out / "system" / "fvSchemes", "dictionary", "fvSchemes",
                    fv_schemes_text(model=model, numerics=ph.numerics, transient=spec.transient))
    write_foam_dict(out / "system" / "fvSolution", "dictionary", "fvSolution",
                    fv_solution_text(model=model, residual=ph.residual, n_non_orth=ph.n_non_orthogonal,
                                     transient=spec.transient, residual_control=not stops_off,
                                     relax=(ph.relax_u, ph.relax_p, ph.relax_h)))
    if int(spec.n_procs) > 1:
        write_decompose_par_dict(out / "system" / "decomposeParDict", int(spec.n_procs))
    else:
        (out / "system" / "decomposeParDict").unlink(missing_ok=True)
    (out / "case.foam").write_text("", encoding="ascii")

    mapped = []
    for patch, rec in flow.records.items():
        faces = [str(f) for f in rec.get("faces") or []]
        area = sum(float((spec.face_props.get(f) or {}).get("area_m2") or 0) for f in faces) or None
        mapped.append({
            "id": rec.get("id"),
            "name": rec.get("name"),
            "bc_type": rec.get("bc_type"),
            "patch": patch,
            "faces": faces,
            "face_area_m2": area,
            **meta.get(patch, {}),
        })
    sidecar: dict[str, Any] = {
        "endTime": spec.end_time,
        "writeInterval": spec.write_interval,
        "nProcs": int(spec.n_procs),
        "solver": app,
        "time_dependency": "Transient" if transient else "Steady-state",
        "rho": rho_ref,
        "nu": fluid.mu / rho_ref,
        # p and p_rgh are written in Pa (not divided by the density).
        "kinematic_fields": [],
        "patches": flow.patch_names,
        "mapped": mapped,
        "thermal": meta,
        "wall_patches": wall_patches,
        "opening_patches": opening_patches,
        "ht_monitors": plans,
        "fluid": {**dataclasses.asdict(fluid), "prandtl": fluid.prandtl},
        "density_model": density,
        "gravity_m_s2": list(g),
        "operating_pressure_Pa": ph.operating_pressure,
        "reference_temperature_K": ph.reference_temperature,
        "initial_temperature_K": ph.start_temperature(),
        "turbulence": {"model": model, "speed_ref_m_s": flow.speed_ref, "hydraulic_diameter_m": flow.hydraulic_diameter,
                       **({"k": flow.scales["k"], "omega": flow.scales["omega"]} if turbulent else {})},
        "numerics": {"preset": ph.numerics, "residual": ph.residual, "n_non_orthogonal": ph.n_non_orthogonal,
                     "relax_u": ph.relax_u, "relax_p_rgh": ph.relax_p, "relax_h": ph.relax_h},
        "n_cells": spec.n_cells,
        "mesh_id": spec.mesh_id,
        "run_id": spec.run_id,
    }
    if settle is not None:
        sidecar["settle"] = settle
    if transient and spec.transient is not None:
        sidecar["transient"] = dataclasses.asdict(spec.transient)
    sidecar["health_hints"] = health_hints(spec, app=app, model=model, records=flow.records, speed_ref=flow.speed_ref)
    if restart_from is not None:
        sidecar["restart"] = {"from_time": restart_from, "end_time": float(spec.end_time)}
        if stops_off:
            sidecar["restart"]["stops_off"] = True
    (out / "w27-case.json").write_text(json.dumps(sidecar, indent=2) + "\n", encoding="utf-8")
    report: dict[str, Any] = {
        "ok": True,
        "case_dir": str(out),
        "solver": app,
        "n_procs": int(spec.n_procs),
        "patches": flow.patch_names,
        "polyMesh_copied": poly_dst is not None,
        "health_hints": sidecar["health_hints"],
    }
    if restart_from is not None:
        report["restart"] = dict(sidecar["restart"])
    return report

