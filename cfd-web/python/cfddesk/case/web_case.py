"""Web-UI OpenFOAM case writer — JS writeSolveCase parity (w27/w30).

Kept out of writer.py so the CLI/simpleFoam path stays lean. prepare_run uses
this module exclusively for Phase 1 golden equivalence.
"""
from __future__ import annotations

import json
import math
import re
import shutil
from pathlib import Path
from typing import Any

from cfddesk.case.function_objects import js_to_precision, monitors_functions_text
from cfddesk.case.writer import (
    write_control_dict_transient,
    write_fv_options_limit_u,
    write_fv_schemes_transient,
    write_fv_solution_pimple,
)
from cfddesk.project.web_adapter import (
    FaceProps,
    RunSpec,
    WebBc,
    bc_faces,
    is_pressure_bc,
    is_velocity_inlet,
    is_velocity_outlet,
    is_wall_bc,
    wall_treatment,
)

# ---------------------------------------------------------------------------
# Foam I/O (match JS foamHeader / writeVolField spacing — no C++ banner)
# ---------------------------------------------------------------------------


def _write_bytes(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(text.replace("\r\n", "\n").encode("utf-8"))


def foam_header(cls: str, obj: str) -> str:
    return (
        "FoamFile\n"
        "{\n"
        "    version     2.0;\n"
        "    format      ascii;\n"
        f"    class       {cls};\n"
        f"    object      {obj};\n"
        "}\n"
    )


def write_foam_dict(path: Path, cls: str, obj: str, body: str) -> None:
    _write_bytes(path, foam_header(cls, obj) + "\n" + body.strip() + "\n")


def write_vol_field(
    path: Path,
    *,
    object_name: str,
    cls: str,
    dims: str,
    internal: str,
    patches: dict[str, dict[str, str]],
) -> None:
    lines = [
        foam_header(cls, object_name).rstrip("\n"),
        "",
        f"dimensions      {dims};",
        "",
        f"internalField   {internal};",
        "",
        "boundaryField",
        "{",
    ]
    for name, block in patches.items():
        lines.append(f"    {name}")
        lines.append("    {")
        for k, v in block.items():
            lines.append(f"        {k}          {v};")
        lines.append("    }")
    lines.append("}")
    lines.append("")
    _write_bytes(path, "\n".join(lines))


def js_plain_float(v: float) -> str:
    """Approximate Node's default number→string for Foam dict values."""
    if not math.isfinite(v):
        return "0"
    if v == 0:
        return "0"
    s = format(float(v), ".15f")
    if "." in s:
        s = s.rstrip("0").rstrip(".")
    return s or "0"


# ---------------------------------------------------------------------------
# Turbulence scales (exact w27 kOmegaFromScales)
# ---------------------------------------------------------------------------


def k_omega_from_scales(speed: float, d_hyd: float | None) -> dict[str, float]:
    u = max(abs(float(speed) or 0.0), 0.1)
    intensity = 0.05
    k = 1.5 * (intensity * u) * (intensity * u)
    length = max(0.07 * (float(d_hyd) if d_hyd else 0.0), 1e-3)
    omega = math.sqrt(k) / ((0.09**0.25) * length)
    return {"k": k, "omega": omega, "I": intensity, "L": length}


# ---------------------------------------------------------------------------
# Face / BC helpers (web FaceProps.area_m2)
# ---------------------------------------------------------------------------


def _props_area(fp: FaceProps | None) -> float:
    if fp is None or fp.area_m2 is None:
        return 0.0
    a = float(fp.area_m2)
    return a if math.isfinite(a) else 0.0


def faces_area(faces: list[str], props: dict[str, FaceProps]) -> float:
    return sum(_props_area(props.get(f)) for f in faces or [])


def hydraulic_diameter(faces: list[str], props: dict[str, FaceProps]) -> float | None:
    a = faces_area(faces, props)
    return 2.0 * math.sqrt(a / math.pi) if a > 0 else None


def _bc_dict(bc: WebBc | dict) -> dict[str, Any]:
    if isinstance(bc, WebBc):
        return {
            "name": bc.name,
            "bc_type": bc.bc_type,
            "faces": list(bc.faces),
            "value": bc.value,
            "unit": bc.unit,
            "velocity_type": bc.velocity_type,
            "flow_rate_type": bc.flow_rate_type,
            "direction": bc.direction,
            "vector": bc.vector,
            "wall_type": bc.wall_type,
            **(bc.raw or {}),
        }
    return dict(bc)


def inlet_speed_ms(bc: dict) -> float:
    try:
        v = float(bc.get("value"))
    except (TypeError, ValueError):
        return 1.0
    if not math.isfinite(v):
        return 1.0
    unit = str(bc.get("unit") or "").lower()
    if unit in ("m/s", "m s-1", ""):
        return v
    if unit == "ft/s":
        return v * 0.3048
    if unit == "km/h":
        return v / 3.6
    if unit == "mph":
        return v * 0.44704
    return v


def pressure_pa(bc: dict) -> float:
    try:
        v = float(bc.get("value"))
    except (TypeError, ValueError):
        return 0.0
    if not math.isfinite(v):
        return 0.0
    unit = str(bc.get("unit") or "Pa").lower()
    if unit in ("pa", ""):
        return v
    if unit == "kpa":
        return v * 1e3
    if unit == "bar":
        return v * 1e5
    if unit == "psi":
        return v * 6894.757
    if unit in ("inh2o", "in h2o", "inwc"):
        return v * 249.089
    if unit == "mmh2o":
        return v * 9.80665
    return v


def uses_flow_rate(bc: dict) -> bool:
    if re.search(r"flow\s*rate", str(bc.get("velocity_type") or ""), re.I):
        return True
    return bool(re.search(r"ft3/min|ft³/min|m3/s|m³/s|kg/s|lb/s", str(bc.get("unit") or ""), re.I))


def uses_vector(bc: dict) -> bool:
    return bool(re.search(r"vector", str(bc.get("direction") or ""), re.I)) and isinstance(
        bc.get("vector"), (list, tuple)
    )


def volumetric_m3s(bc: dict) -> float | None:
    try:
        v = float(bc.get("value"))
    except (TypeError, ValueError):
        return None
    if not math.isfinite(v):
        return None
    unit = str(bc.get("unit") or "").lower()
    if "ft" in unit and "min" in unit:
        return v * 0.00047194745
    if "l/min" in unit:
        return v / 60000.0
    if "l/s" in unit:
        return v / 1000.0
    if "m3" in unit or "m³" in unit or "m^3" in unit:
        return v
    return None


def mass_flow_kgs(bc: dict) -> float | None:
    try:
        v = float(bc.get("value"))
    except (TypeError, ValueError):
        return None
    if not math.isfinite(v):
        return None
    unit = str(bc.get("unit") or "").lower()
    if unit == "kg/s":
        return v
    if unit == "lb/s":
        return v * 0.45359237
    if unit == "kg/h":
        return v / 3600.0
    return None


def is_mass_flow(bc: dict) -> bool:
    if re.search(r"mass", str(bc.get("flow_rate_type") or ""), re.I):
        return True
    return mass_flow_kgs(bc) is not None and volumetric_m3s(bc) is None


def inlet_direction(bc: dict) -> list[float] | None:
    if not uses_vector(bc):
        return None
    v = [float(x) or 0.0 for x in (bc.get("vector") or [])[:3]]
    while len(v) < 3:
        v.append(0.0)
    m = math.hypot(v[0], v[1], v[2])
    if not (m > 0):
        return None
    return [x / m for x in v]


def vector_inlet_velocity(bc: dict, face_props: dict[str, FaceProps]) -> dict[str, Any] | None:
    spd = abs(inlet_speed_ms(bc))
    direction = inlet_direction(bc)
    if direction is None:
        return None
    return {
        "U": [d * spd for d in direction],
        "magnitude": spd,
    }


def inlet_ref_speed(bc: dict, face_area: float, rho: float) -> float:
    if uses_flow_rate(bc):
        q = (
            (mass_flow_kgs(bc) or 0.0) / (rho or 1.2)
            if is_mass_flow(bc)
            else (volumetric_m3s(bc) or 0.0)
        )
        n = max(1, len(bc_faces(bc)))
        if face_area > 0:
            return abs(q) * n / face_area
        return max(1.0, abs(q) * 1000.0)
    return abs(inlet_speed_ms(bc))


def resolve_speed_and_dhyd(spec: RunSpec) -> tuple[float, float]:
    """Port of writeSolveCase speedRef / dHyd selection."""
    rho = float(spec.rho) or 1.196
    props = spec.face_props or {}
    speed_ref = 1.0
    d_hyd: float | None = None
    inlets = [(m.get("bc"), m.get("patch")) for m in (spec.mapped or []) if is_velocity_inlet(m.get("bc"))]
    if inlets:
        best = 0.0
        best_area = 0.0
        for bc_raw, _patch in inlets:
            bc = _bc_dict(bc_raw)  # type: ignore[arg-type]
            faces = bc_faces(bc)
            area = faces_area(faces, props)
            s = inlet_ref_speed(bc, area / max(1, len(faces)), rho)
            if s > best:
                best = s
            if area > best_area:
                best_area = area
        speed_ref = max(best, 0.1)
        d_hyd = 2.0 * math.sqrt(best_area / math.pi) if best_area > 0 else None
    else:
        pm = [m.get("bc") for m in (spec.mapped or []) if is_pressure_bc(m.get("bc"))]
        pvals = [pressure_pa(_bc_dict(b)) for b in pm if b]  # type: ignore[arg-type]
        if len(pvals) >= 2:
            dp = max(pvals) - min(pvals)
            speed_ref = max(1.0, math.sqrt((2.0 * abs(dp)) / rho))
        min_area = float("inf")
        for b in pm:
            if not b:
                continue
            a = faces_area(bc_faces(_bc_dict(b)), props)  # type: ignore[arg-type]
            if a > 0 and a < min_area:
                min_area = a
        d_hyd = 2.0 * math.sqrt(min_area / math.pi) if math.isfinite(min_area) else None
    if not d_hyd or not (d_hyd > 0):
        d_hyd = 0.05
    return float(speed_ref), float(d_hyd)


# ---------------------------------------------------------------------------
# Patch role map + field dicts
# ---------------------------------------------------------------------------


def _patch_names(spec: RunSpec, poly_dst: Path | None) -> list[str]:
    """Prefer polyMesh boundary order; else walls + mapped BC order (w27)."""
    names: list[str] = []
    if poly_dst and (poly_dst / "boundary").is_file():
        from cfddesk.project.web_adapter import _parse_boundary_patches

        names = _parse_boundary_patches(poly_dst / "boundary")
    if not names:
        # Invent: walls first (unclaimed mesh default), then mapped patch order
        names = ["walls"]
        for m in spec.mapped or []:
            patch = str(m.get("patch") or "")
            if patch and patch not in names:
                names.append(patch)
        for b in spec.bcs:
            patch = b.patch or b.name
            if patch and patch not in names:
                names.append(patch)
        for n in spec.patches or []:
            if n and n not in names:
                names.append(n)
    elif "walls" not in names:
        names = ["walls"] + names
    seen: set[str] = set()
    out: list[str] = []
    for n in names:
        if n and n not in seen:
            seen.add(n)
            out.append(n)
    return out


def _build_field_patches(
    spec: RunSpec, patch_names: list[str], *, k_str: str, w_str: str
) -> tuple[dict, dict, dict, dict, dict]:
    rho = float(spec.rho) or 1.196
    wall_default = spec.wall_default or "No-slip"
    props = spec.face_props or {}
    role: dict[str, dict[str, Any]] = {}
    for m in spec.mapped or []:
        bc = m.get("bc")
        patch = str(m.get("patch") or "")
        if not bc or not patch:
            continue
        b = _bc_dict(bc)
        if is_velocity_inlet(b):
            role[patch] = {"kind": "inlet", "bc": b}
        elif is_pressure_bc(b):
            role[patch] = {"kind": "pressure", "bc": b}
        elif is_velocity_outlet(b):
            role[patch] = {"kind": "velOutlet", "bc": b}
        elif is_wall_bc(b):
            role[patch] = {"kind": "wall", "bc": b, "treatment": wall_treatment(b)}

    U: dict[str, dict[str, str]] = {}
    p: dict[str, dict[str, str]] = {}
    k: dict[str, dict[str, str]] = {}
    omega: dict[str, dict[str, str]] = {}
    nut: dict[str, dict[str, str]] = {}

    for name in patch_names:
        r = role.get(name)
        kind = r["kind"] if r else "wall"
        if kind == "inlet":
            bc = r["bc"]  # type: ignore[index]
            n_faces = max(1, len(bc_faces(bc)))
            if uses_flow_rate(bc) and is_mass_flow(bc) and mass_flow_kgs(bc) is not None:
                rate = (mass_flow_kgs(bc) or 0.0) * n_faces
                U[name] = {
                    "type": "flowRateInletVelocity",
                    "massFlowRate": f"constant {js_to_precision(rate, 8)}",
                    "rhoInlet": f"{rho}",
                    "extrapolateProfile": "false",
                    "value": "uniform (0 0 0)",
                }
            elif uses_flow_rate(bc) and volumetric_m3s(bc) is not None:
                rate = (volumetric_m3s(bc) or 0.0) * n_faces
                U[name] = {
                    "type": "flowRateInletVelocity",
                    "volumetricFlowRate": f"constant {js_to_precision(rate, 8)}",
                    "extrapolateProfile": "false",
                    "value": "uniform (0 0 0)",
                }
            else:
                spd = abs(inlet_speed_ms(bc))
                vec = vector_inlet_velocity(bc, props) if uses_vector(bc) else None
                if vec:
                    comps = [js_to_precision(c, 8) for c in vec["U"]]
                    U[name] = {
                        "type": "fixedValue",
                        "value": f"uniform ({' '.join(comps)})",
                    }
                else:
                    U[name] = {
                        "type": "surfaceNormalFixedValue",
                        "refValue": f"uniform {js_plain_float(-spd)}",
                        "value": "uniform (0 0 0)",
                    }
            p[name] = {"type": "zeroGradient"}
            k[name] = {"type": "fixedValue", "value": f"uniform {k_str}"}
            omega[name] = {"type": "fixedValue", "value": f"uniform {w_str}"}
            nut[name] = {"type": "calculated", "value": "uniform 0"}
        elif kind == "pressure":
            p_kin = pressure_pa(r["bc"]) / rho  # type: ignore[index]
            U[name] = {"type": "pressureInletOutletVelocity", "value": "uniform (0 0 0)"}
            p[name] = {"type": "fixedValue", "value": f"uniform {js_to_precision(p_kin, 8)}"}
            k[name] = {
                "type": "inletOutlet",
                "inletValue": f"uniform {k_str}",
                "value": f"uniform {k_str}",
            }
            omega[name] = {
                "type": "inletOutlet",
                "inletValue": f"uniform {w_str}",
                "value": f"uniform {w_str}",
            }
            nut[name] = {"type": "calculated", "value": "uniform 0"}
        elif kind == "velOutlet":
            U[name] = {
                "type": "inletOutlet",
                "inletValue": "uniform (0 0 0)",
                "value": "uniform (0 0 0)",
            }
            p[name] = {"type": "zeroGradient"}
            k[name] = {
                "type": "inletOutlet",
                "inletValue": f"uniform {k_str}",
                "value": f"uniform {k_str}",
            }
            omega[name] = {
                "type": "inletOutlet",
                "inletValue": f"uniform {w_str}",
                "value": f"uniform {w_str}",
            }
            nut[name] = {"type": "calculated", "value": "uniform 0"}
        else:
            treatment = r["treatment"] if r and r.get("kind") == "wall" else wall_default
            if treatment == "Slip":
                U[name] = {"type": "slip"}
                p[name] = {"type": "zeroGradient"}
                k[name] = {"type": "zeroGradient"}
                omega[name] = {"type": "zeroGradient"}
                nut[name] = {"type": "calculated", "value": "uniform 0"}
            else:
                U[name] = {"type": "noSlip"}
                p[name] = {"type": "zeroGradient"}
                k[name] = {"type": "kqRWallFunction", "value": f"uniform {k_str}"}
                omega[name] = {"type": "omegaWallFunction", "value": f"uniform {w_str}"}
                nut[name] = {"type": "nutkWallFunction", "value": "uniform 0"}
    return U, p, k, omega, nut


def _steady_control_dict_body(end_time: float, write_interval: float, functions_text: str) -> str:
    return f"""application     simpleFoam;
startFrom       startTime;
startTime       0;
stopAt          endTime;
endTime         {js_plain_float(float(end_time))};
deltaT          1;
writeControl    timeStep;
writeInterval   {js_plain_float(float(write_interval))};
purgeWrite      0;
writeFormat     ascii;
writePrecision  8;
writeCompression off;
timeFormat      general;
timePrecision   6;
runTimeModifiable true;

functions
{{
{functions_text}
}}"""


def _steady_fv_schemes_body() -> str:
    return """ddtSchemes { default steadyState; }
gradSchemes
{
    default         Gauss linear;
    grad(U)         cellLimited Gauss linear 1;
    grad(k)         cellLimited Gauss linear 1;
    grad(omega)     cellLimited Gauss linear 1;
}
divSchemes
{
    default         none;
    div(phi,U)      bounded Gauss linearUpwind grad(U);
    div(phi,k)      bounded Gauss upwind;
    div(phi,omega)  bounded Gauss upwind;
    div((nuEff*dev2(T(grad(U))))) Gauss linear;
}
laplacianSchemes { default Gauss linear limited corrected 0.5; }
interpolationSchemes { default linear; }
snGradSchemes { default limited corrected 0.5; }
wallDist { method meshWave; }"""


def _steady_fv_solution_body() -> str:
    return """solvers
{
    p
    {
        solver          GAMG;
        tolerance       1e-7;
        relTol          0.01;
        smoother        GaussSeidel;
        nCellsInCoarsestLevel 20;
        maxIter         200;
    }
    "(U|k|omega)"
    {
        solver          smoothSolver;
        smoother        symGaussSeidel;
        tolerance       1e-8;
        relTol          0.1;
        maxIter         50;
    }
}
SIMPLE
{
    nNonOrthogonalCorrectors 1;
    consistent      no;
    residualControl { p 1e-4; U 1e-4; "(k|omega)" 1e-4; }
}
relaxationFactors
{
    fields
    {
        p               0.3;
    }
    equations
    {
        U               0.7;
        k               0.7;
        omega           0.7;
    }
}"""


def _copy_polymesh(src_case: Path, out_dir: Path) -> Path | None:
    """Copy constant/polyMesh from mesh case. Returns poly dst or None if absent."""
    candidates = [
        src_case / "constant" / "polyMesh",
        src_case if (src_case / "owner").is_file() else None,
    ]
    poly_src = next((p for p in candidates if p and p.is_dir() and (p / "owner").is_file()), None)
    const = out_dir / "constant"
    const.mkdir(parents=True, exist_ok=True)
    poly_dst = const / "polyMesh"
    if poly_src is None:
        return None
    if poly_dst.exists():
        shutil.rmtree(poly_dst)
    shutil.copytree(poly_src, poly_dst)
    return poly_dst


def _clean_prior_run(out_dir: Path) -> None:
    if not out_dir.is_dir():
        return
    for child in list(out_dir.iterdir()):
        name = child.name
        is_time = child.is_dir() and re.match(r"^\d+(\.\d+)?(?:[eE][+-]?\d+)?$", name) and float(name) > 0
        is_tmp = child.is_dir() and name.startswith(".sync_")
        if is_time or is_tmp:
            shutil.rmtree(child, ignore_errors=True)
    for stale in (
        "postProcessing",
        "log.simpleFoam",
        "log.pimpleFoam",
        "log.decomposePar",
        "log.reconstructPar",
        "log.reconstructPar.live",
        "log.livesync",
    ):
        p = out_dir / stale
        if p.exists():
            if p.is_dir():
                shutil.rmtree(p, ignore_errors=True)
            else:
                p.unlink(missing_ok=True)


def write_web_solve_case(spec: RunSpec, out_dir: Path | str) -> dict[str, Any]:
    """Write a complete run case matching w27 writeSolveCase (steady or transient)."""
    out = Path(out_dir)
    out.mkdir(parents=True, exist_ok=True)
    (out / "0").mkdir(exist_ok=True)
    (out / "constant").mkdir(exist_ok=True)
    (out / "system").mkdir(exist_ok=True)
    _clean_prior_run(out)

    poly_dst = _copy_polymesh(Path(spec.mesh_case_dir), out)
    patch_names = _patch_names(spec, poly_dst)

    speed_ref, d_hyd = resolve_speed_and_dhyd(spec)
    # Prefer RunSpec.speed_for_k when caller already resolved it (> default)
    if spec.speed_for_k and spec.speed_for_k != 1.0:
        speed_ref = float(spec.speed_for_k)
    turb = k_omega_from_scales(speed_ref, d_hyd)
    k_str = js_to_precision(turb["k"], 6)
    w_str = js_to_precision(turb["omega"], 6)

    U, p, k, omega, nut = _build_field_patches(spec, patch_names, k_str=k_str, w_str=w_str)
    write_vol_field(
        out / "0" / "U",
        object_name="U",
        cls="volVectorField",
        dims="[0 1 -1 0 0 0 0]",
        internal="uniform (0 0 0)",
        patches=U,
    )
    write_vol_field(
        out / "0" / "p",
        object_name="p",
        cls="volScalarField",
        dims="[0 2 -2 0 0 0 0]",
        internal="uniform 0",
        patches=p,
    )
    write_vol_field(
        out / "0" / "k",
        object_name="k",
        cls="volScalarField",
        dims="[0 2 -2 0 0 0 0]",
        internal=f"uniform {k_str}",
        patches=k,
    )
    write_vol_field(
        out / "0" / "omega",
        object_name="omega",
        cls="volScalarField",
        dims="[0 0 -1 0 0 0 0]",
        internal=f"uniform {w_str}",
        patches=omega,
    )
    write_vol_field(
        out / "0" / "nut",
        object_name="nut",
        cls="volScalarField",
        dims="[0 2 -1 0 0 0 0]",
        internal="uniform 0",
        patches=nut,
    )

    write_foam_dict(
        out / "constant" / "transportProperties",
        "dictionary",
        "transportProperties",
        f"transportModel  Newtonian;\nnu              [0 2 -1 0 0 0 0] {js_plain_float(float(spec.nu))};",
    )
    write_foam_dict(
        out / "constant" / "turbulenceProperties",
        "dictionary",
        "turbulenceProperties",
        """simulationType  RAS;
RAS
{
    RASModel        kOmegaSST;
    turbulence      on;
    printCoeffs     on;
}""",
    )

    mon_patches = list(spec.monitor_patches or [])
    functions_text = monitors_functions_text(mon_patches, transient=spec.transient)
    is_transient = spec.transient is not None

    if is_transient:
        write_control_dict_transient(
            out / "system" / "controlDict",
            ctrl=spec.transient,  # type: ignore[arg-type]
            functions_text=functions_text,
        )
        write_fv_schemes_transient(out / "system" / "fvSchemes", ctrl=spec.transient)  # type: ignore[arg-type]
        write_fv_solution_pimple(out / "system" / "fvSolution", ctrl=spec.transient)  # type: ignore[arg-type]
    else:
        write_foam_dict(
            out / "system" / "controlDict",
            "dictionary",
            "controlDict",
            _steady_control_dict_body(spec.end_time, spec.write_interval, functions_text),
        )
        write_foam_dict(
            out / "system" / "fvSchemes",
            "dictionary",
            "fvSchemes",
            _steady_fv_schemes_body(),
        )
        write_foam_dict(
            out / "system" / "fvSolution",
            "dictionary",
            "fvSolution",
            _steady_fv_solution_body(),
        )

    u_max = max(50.0, 10.0 * abs(speed_ref))
    write_fv_options_limit_u(out / "system" / "fvOptions", max_u=u_max)

    if int(spec.n_procs) > 1:
        write_foam_dict(
            out / "system" / "decomposeParDict",
            "dictionary",
            "decomposeParDict",
            f"numberOfSubdomains {int(spec.n_procs)};\nmethod          scotch;",
        )

    (out / "case.foam").write_text("", encoding="ascii")

    mapped_meta = []
    for m in spec.mapped or []:
        bc = _bc_dict(m.get("bc") or {})
        faces = bc_faces(bc)
        entry: dict[str, Any] = {
            "name": bc.get("name"),
            "bc_type": bc.get("bc_type"),
            "patch": m.get("patch"),
            "faces": faces,
            "value": bc.get("value"),
            "unit": bc.get("unit") or None,
            "face_area_m2": faces_area(faces, spec.face_props) or None,
        }
        if is_wall_bc(bc):
            entry["wall_type"] = wall_treatment(bc)
        mapped_meta.append(entry)

    sidecar = {
        "endTime": spec.end_time,
        "writeInterval": spec.write_interval,
        "nProcs": int(spec.n_procs),
        "solver": "pimpleFoam" if is_transient else "simpleFoam",
        "time_dependency": "Transient" if is_transient else "Steady-state",
        "nu": float(spec.nu),
        "rho": float(spec.rho),
        "patches": patch_names,
        "wall_default": spec.wall_default,
        "mapped": mapped_meta,
        "monitors": mon_patches,
        "turbulence": {
            "model": "kOmegaSST",
            "intensity": turb["I"],
            "length_scale_m": turb["L"],
            "hydraulic_diameter_m": d_hyd,
            "speed_ref_m_s": speed_ref,
            "k": turb["k"],
            "omega": turb["omega"],
        },
        "n_cells": spec.n_cells,
        "mesh_id": spec.mesh_id,
        "run_id": spec.run_id,
    }
    if is_transient and spec.transient is not None:
        t = spec.transient
        sidecar["transient"] = {
            "end_time": t.end_time,
            "delta_t": t.delta_t,
            "write_interval": t.write_interval,
            "adjust_time_step": t.adjust_time_step,
            "max_co": t.max_co,
            "max_delta_t": t.max_delta_t,
            "time_scheme": t.time_scheme,
            "n_outer_correctors": t.n_outer_correctors,
            "n_correctors": t.n_correctors,
            "n_non_orthogonal_correctors": t.n_non_orthogonal_correctors,
        }
    (out / "w27-case.json").write_text(json.dumps(sidecar, indent=2) + "\n", encoding="utf-8")

    return {
        "ok": True,
        "case_dir": str(out),
        "solver": sidecar["solver"],
        "n_procs": int(spec.n_procs),
        "patches": patch_names,
        "turbulence": sidecar["turbulence"],
        "polyMesh_copied": poly_dst is not None,
    }
