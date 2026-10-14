"""Stub conjugate heat transfer: the host's multi-region solve path (host API 1.8).

A test analysis, loaded only by its own tests and servers. A study holds a fluid
and a solid material (one per group of bodies); its mesh has one cellZone per
region (HT2). The case it writes is the HT0 ``cht_steady`` set-up, cut down:
- one unsplit ``constant/polyMesh``, split by the WSL step its ``w27-case.json``
  names (``splitMeshRegions -cellZones -overwrite``) before the solver;
- its ``regions`` listed in ``w27-case.json`` and ``constant/regionProperties``;
- no top-level ``0/`` field; ``0/<region>/``, ``constant/<region>/`` and
  ``system/<region>/`` written before the split (the split keeps them);
- the fluid is air (incompressible perfect gas, laminar) in a closed box with
  gravity, every outer wall at 300 K; the solid's outer walls are at 350 K; the
  interfaces ``<a>_to_<b>`` are coupled
  (``compressible::turbulentTemperatureRadCoupledMixed``, both sides);
- ``chtMultiRegionSimpleFoam`` for a few iterations, read by the SDK's
  ``RegionProgressParser`` (residuals ``<region>:<field>``);
- a ``volFieldValue`` (max T) per region and a probe of T in the solid at the
  mesh's middle, so both multi-region postProcessing path shapes are written;
- its own prepare job (``stub-cht.write_run_case``, ``jobs/write_run_case.py``)
  takes ``restart``, so a run can continue: the case keeps its saved times and
  its split mesh, runs on to the new end, and its sidecar still names the split
  (the runner never runs a continued run's ``pre_steps``).

It needs no boundary condition from the user: every outer wall of a region gets
its role's wall. It imports nothing but magnusim_sdk and cfddesk.registry.
"""

from __future__ import annotations

import json
import re
import shutil
import struct
from pathlib import Path
from typing import Any

from magnusim_sdk.foam import write_foam_dict, write_vol_field

from cfddesk.registry import AnalysisType, MaterialModel, SchemaField
from cfddesk.registry.analysis import ResultField
from cfddesk.registry.contract import AnalysisFamily, LaunchSpec, LogParserRef
from cfddesk.registry.jobs import JobKind
from cfddesk.registry.solver import SolverApp

PLUGIN = "stub-cht"
ANALYSIS = "stub_cht_steady"
SOLVER = "chtMultiRegionSimpleFoam"
PREPARE_JOB = "stub-cht.write_run_case"
PARSER = LogParserRef("magnusim_sdk.progress", "RegionProgressParser")
T_FLUID_WALL = 300.0
T_SOLID_WALL = 350.0
P_REF = 1e5

FAMILY = AnalysisFamily(
    key="stub_cht",
    label="Conjugate heat (stub)",
    title="Conjugate heat (stub)",
    description="A test simulation type: a fluid and a solid region solved together.",
    tags=("TEST",),
    study_name="Conjugate heat",
)

FLUID = MaterialModel(
    key="stub_cht_fluid",
    label="Fluid",
    role="fluid",
    properties_schema=(
        SchemaField("cp", "(cp) Specific heat", "float", default=1005.0, min=0, quantity="specific_heat"),
    ),
    library=({"key": "air", "name": "Air", "values": {"cp": 1005.0}, "library": "AIR", "codes": ("AIR", "DEFAULT")},),
    record_keys={"cp": ("specific_heat", "cp")},
)

SOLID = MaterialModel(
    key="stub_cht_solid",
    label="Solid",
    role="solid",
    properties_schema=(
        SchemaField("k", "(k) Thermal conductivity", "float", default=167.0, min=0, quantity="thermal_conductivity"),
    ),
    library=(
        {"key": "aluminium", "name": "Aluminium 6061", "values": {"k": 167.0}, "library": "AL6061", "codes": ("AL6061", "DEFAULT")},
    ),
    record_keys={"k": ("thermal_conductivity", "k")},
)

NO_REGIONS = "Mesh the study with a fluid and a solid material first (the mesh has no regions)."


def validate_ready(ctx: Any) -> list[dict[str, Any]]:
    roles = {
        (FLUID.role if m.get("material_model") == FLUID.key else SOLID.role)
        for m in (getattr(ctx, "materials", ()) or ())
        if m.get("assigned_volumes") and m.get("material_model") in (FLUID.key, SOLID.key)
    }
    if roles != {"fluid", "solid"}:
        return [{"message": "Give one body a fluid material and another a solid one", "fix": {"go": "study"}}]
    return []


def _regions(ctx: Any) -> list[dict[str, Any]]:
    mesh = getattr(getattr(ctx, "inputs", None), "mesh", None) or {}
    rows = [r for r in (mesh.get("regions") or []) if isinstance(r, dict) and r.get("name")]
    if {r.get("role") for r in rows} != {"fluid", "solid"}:
        raise ValueError(NO_REGIONS)
    return rows


def _solid_conductivity(ctx: Any, region: dict[str, Any]) -> float:
    bodies = set(region.get("bodies") or ())
    doc = getattr(getattr(ctx, "inputs", None), "materials", None) or {}
    for rec in (doc.get("materials") if isinstance(doc, dict) else None) or ():
        if rec.get("material_model") == SOLID.key and bodies & set(rec.get("assigned_volumes") or ()):
            for key in ("thermal_conductivity", "k"):
                try:
                    return float(rec[key])
                except (KeyError, TypeError, ValueError):
                    continue
    return 167.0


def _mesh_middle(poly: Path) -> tuple[float, float, float] | None:
    """The middle of the mesh's bounding box (its points file, ascii or binary), else None."""
    try:
        raw = (poly / "points").read_bytes()
    except OSError:
        return None
    head = re.search(rb"\n(\d+)\s*\(", raw)
    if not head:
        return None
    n = int(head.group(1))
    if re.search(rb"format\s+binary", raw[: head.start()]):
        width = 4 if re.search(rb"scalar\s*=\s*32", raw[: head.start()]) else 8
        body = raw[head.end() : head.end() + n * 3 * width]
        if len(body) < n * 3 * width:
            return None
        flat = struct.unpack(f"<{n * 3}{'f' if width == 4 else 'd'}", body)
        cols = [flat[i::3] for i in range(3)]
    else:
        pts = re.findall(rb"\(\s*([-0-9.eE+]+)\s+([-0-9.eE+]+)\s+([-0-9.eE+]+)\s*\)", raw[head.end() :])
        if not pts:
            return None
        cols = [[float(p[i]) for p in pts] for i in range(3)]
    return (
        (min(cols[0]) + max(cols[0])) / 2,
        (min(cols[1]) + max(cols[1])) / 2,
        (min(cols[2]) + max(cols[2])) / 2,
    )


def _dict(path: Path, obj: str, body: str) -> None:
    write_foam_dict(path, "dictionary", obj, body)


def _interfaces(name: str, names: list[str]) -> list[str]:
    return [f"{name}_to_{other}" for other in names if other != name]


def _coupled(kappa: str, value: float) -> dict[str, str]:
    return {
        "type": "compressible::turbulentTemperatureRadCoupledMixed",
        "Tnbr": "T",
        "kappaMethod": kappa,
        "qr": "none",
        "qrNbr": "none",
        "value": f"uniform {value:g}",
    }


def _write_fluid(out: Path, name: str, names: list[str]) -> None:
    faces = _interfaces(name, names)
    write_vol_field(
        out / "0" / name / "T", object_name="T", cls="volScalarField", dims="[0 0 0 1 0 0 0]",
        internal=f"uniform {T_FLUID_WALL:g}",
        patches={'".*"': {"type": "fixedValue", "value": f"uniform {T_FLUID_WALL:g}"},
                 **{f: _coupled("fluidThermo", T_FLUID_WALL) for f in faces}},
    )
    write_vol_field(
        out / "0" / name / "U", object_name="U", cls="volVectorField", dims="[0 1 -1 0 0 0 0]",
        internal="uniform (0 0 0)", patches={'".*"': {"type": "noSlip"}},
    )
    for field, kind in (("p", "calculated"), ("p_rgh", "fixedFluxPressure")):
        write_vol_field(
            out / "0" / name / field, object_name=field, cls="volScalarField", dims="[1 -1 -2 0 0 0 0]",
            internal=f"uniform {P_REF:g}", patches={'".*"': {"type": kind, "value": "$internalField"}},
        )
    _dict(out / "constant" / name / "thermophysicalProperties", "thermophysicalProperties", """\
thermoType
{
    type            heRhoThermo;
    mixture         pureMixture;
    transport       const;
    thermo          hConst;
    equationOfState incompressiblePerfectGas;
    specie          specie;
    energy          sensibleEnthalpy;
}
mixture
{
    specie          { molWeight 28.96; }
    thermodynamics  { Cp 1005; Hf 0; }
    transport       { mu 1.846e-05; Pr 0.707; }
    equationOfState { pRef 1e5; }
}""")
    _dict(out / "constant" / name / "turbulenceProperties", "turbulenceProperties", "simulationType laminar;")
    _dict(out / "system" / name / "fvSchemes", "fvSchemes", """\
ddtSchemes { default steadyState; }
gradSchemes { default Gauss linear; }
divSchemes
{
    default none;
    div(phi,U) bounded Gauss upwind;
    div(phi,h) bounded Gauss upwind;
    div(phi,K) bounded Gauss upwind;
    div(((rho*nuEff)*dev2(T(grad(U))))) Gauss linear;
}
laplacianSchemes { default Gauss linear limited corrected 0.5; }
interpolationSchemes { default linear; }
snGradSchemes { default limited corrected 0.5; }""")
    _dict(out / "system" / name / "fvSolution", "fvSolution", """\
solvers
{
    rho { solver PCG; preconditioner DIC; tolerance 1e-7; relTol 0; }
    p_rgh { solver GAMG; smoother GaussSeidel; tolerance 1e-7; relTol 0.01; }
    "(U|h)" { solver PBiCGStab; preconditioner DILU; tolerance 1e-7; relTol 0.1; }
}
SIMPLE
{
    momentumPredictor yes;
    nNonOrthogonalCorrectors 1;
    pRefCell 0;
    pRefValue 1e5;
    residualControl { default 1e-6; }
}
relaxationFactors
{
    fields { rho 1; p_rgh 0.7; }
    equations { U 0.3; h 0.7; }
}""")


def _write_solid(out: Path, name: str, names: list[str], kappa: float) -> None:
    write_vol_field(
        out / "0" / name / "T", object_name="T", cls="volScalarField", dims="[0 0 0 1 0 0 0]",
        internal=f"uniform {T_SOLID_WALL:g}",
        patches={'".*"': {"type": "fixedValue", "value": f"uniform {T_SOLID_WALL:g}"},
                 **{f: _coupled("solidThermo", T_SOLID_WALL) for f in _interfaces(name, names)}},
    )
    # A solid region needs its p (HT0): calculated.
    write_vol_field(
        out / "0" / name / "p", object_name="p", cls="volScalarField", dims="[1 -1 -2 0 0 0 0]",
        internal=f"uniform {P_REF:g}", patches={'".*"': {"type": "calculated", "value": "$internalField"}},
    )
    _dict(out / "constant" / name / "thermophysicalProperties", "thermophysicalProperties", f"""\
thermoType
{{
    type            heSolidThermo;
    mixture         pureMixture;
    transport       constIso;
    thermo          hConst;
    equationOfState rhoConst;
    specie          specie;
    energy          sensibleEnthalpy;
}}
mixture
{{
    specie          {{ molWeight 26.98; }}
    transport       {{ kappa {kappa:g}; }}
    thermodynamics  {{ Hf 0; Cp 896; }}
    equationOfState {{ rho 2700; }}
}}""")
    _dict(out / "system" / name / "fvSchemes", "fvSchemes", """\
ddtSchemes { default steadyState; }
gradSchemes { default Gauss linear; }
divSchemes { default none; }
laplacianSchemes { default Gauss linear limited corrected 0.5; }
interpolationSchemes { default linear; }
snGradSchemes { default limited corrected 0.5; }""")
    _dict(out / "system" / name / "fvSolution", "fvSolution", """\
solvers
{
    h { solver PCG; preconditioner DIC; tolerance 1e-8; relTol 0.01; }
}
SIMPLE
{
    nNonOrthogonalCorrectors 1;
    residualControl { default 1e-6; }
}
relaxationFactors { equations { h 1; } }""")


def _int(value: Any, default: int) -> int:
    try:
        return max(1, int(value))
    except (TypeError, ValueError):
        return default


def _latest_saved(out: Path) -> int:
    """The case's latest saved iteration (0 when it has none)."""
    times = [int(p.name) for p in out.iterdir() if p.is_dir() and p.name.isdigit()] if out.is_dir() else []
    return max(times, default=0)


def write_case(ctx: Any) -> dict[str, Any]:
    out = Path(ctx.out_dir)
    regions = _regions(ctx)
    names = [str(r["name"]) for r in regions]
    poly = Path(ctx.mesh_case_dir) / "constant" / "polyMesh"
    shutil.copytree(poly, out / "constant" / "polyMesh", dirs_exist_ok=True)
    study = getattr(getattr(ctx, "inputs", None), "run", None) or {}
    spec = getattr(ctx, "run_spec", None)
    end = _int(study.get("endTime") if isinstance(study, dict) else None, _int(getattr(spec, "end_time", None), 20))
    every = _int(study.get("writeInterval") if isinstance(study, dict) else None, _int(getattr(spec, "write_interval", None), end))
    restart = getattr(getattr(ctx, "inputs", None), "restart", None)
    if isinstance(restart, dict):
        # Continue: the saved times and the split mesh stay; the new end is written.
        start = _latest_saved(out)
        end = max(start + 1, int(float(restart["end_time"])))
        every = end - start
    fluids = [r["name"] for r in regions if r["role"] == "fluid"]
    solids = [r["name"] for r in regions if r["role"] == "solid"]
    for r in regions:
        if r["role"] == "fluid":
            _write_fluid(out, r["name"], names)
        else:
            _write_solid(out, r["name"], names, _solid_conductivity(ctx, r))
    _dict(out / "constant" / "regionProperties", "regionProperties",
          f"regions ( fluid ({' '.join(fluids)}) solid ({' '.join(solids)}) );")
    write_foam_dict(out / "constant" / "g", "uniformDimensionedVectorField", "g",
                    "dimensions      [0 1 -2 0 0 0 0];\nvalue           (0 -9.81 0);")
    functions = [
        f"""    Tmax_{r}
    {{
        type            volFieldValue;
        libs            (fieldFunctionObjects);
        region          {r};
        regionType      all;
        operation       max;
        fields          (T);
        writeFields     false;
    }}"""
        for r in names
    ]
    middle = _mesh_middle(out / "constant" / "polyMesh")
    if middle is not None and solids:
        functions.append(f"""    probes_{solids[0]}
    {{
        type            probes;
        libs            (sampling);
        region          {solids[0]};
        fields          (T);
        probeLocations  (({middle[0]:.9g} {middle[1]:.9g} {middle[2]:.9g}));
        writeControl    timeStep;
        writeInterval   1;
    }}""")
    _dict(out / "system" / "controlDict", "controlDict", "\n".join([
        f"application     {SOLVER};",
        "startFrom       latestTime;",
        "startTime       0;",
        "stopAt          endTime;",
        f"endTime         {end};",
        "deltaT          1;",
        "writeControl    timeStep;",
        f"writeInterval   {every};",
        "writeFormat     ascii;",
        "writePrecision  8;",
        "runTimeModifiable true;",
        "functions",
        "{",
        *functions,
        "}",
    ]))
    # The top-level dictionaries a multi-region solver still reads (each region has its own).
    _dict(out / "system" / "fvSchemes", "fvSchemes",
          "ddtSchemes {} gradSchemes {} divSchemes {} laplacianSchemes {} interpolationSchemes {} snGradSchemes {}")
    _dict(out / "system" / "fvSolution", "fvSolution", "PIMPLE { nOuterCorrectors 1; }")
    (out / "case.foam").write_text("", encoding="ascii")
    sidecar = {
        "solver": SOLVER,
        "regions": [{"name": r["name"], "role": r["role"]} for r in regions],
        "pre_steps": [{"tool": "splitMeshRegions", "args": ["-cellZones", "-overwrite"]}],
        "kinematic_fields": [],
    }
    (out / "w27-case.json").write_text(json.dumps(sidecar, indent=2) + "\n", encoding="utf-8")
    report: dict[str, Any] = {"ok": True, "case_dir": str(out), "solver": SOLVER, "n_procs": int(ctx.n_procs or 1), "regions": names}
    if isinstance(restart, dict):
        report["restart"] = {"from_time": _latest_saved(out), "end_time": end}
    return report


def launch(solver_key: str | None = None, **_ignored: Any) -> LaunchSpec:
    """chtMultiRegionSimpleFoam, its case written by this plugin's own prepare job."""
    return LaunchSpec(
        app=SOLVER,
        keep_frames="latest",
        process_names=(SOLVER,),
        stop_strategy="stopAt_writeNow",
        parallel=True,
        log_parser=PARSER,
        frame_fields=("T",),
        kinematic_fields=(),
        prepare_job=PREPARE_JOB,
    )


def register(hub: Any) -> None:
    # The run's case writer; its `restart` param continues a run from its latest saved time.
    hub.register_job(
        JobKind(PREPARE_JOB, "jobs/write_run_case.py", "study", ("run_id", "mesh_id", "n_procs", "restart"), python="core"),
        plugin=PLUGIN,
        package_dir=Path(__file__).resolve().parent,
    )
    materials = hub.registry("material")
    materials.register(FLUID, plugin=PLUGIN)
    materials.register(SOLID, plugin=PLUGIN)
    hub.registry("solver").register(
        SolverApp(
            key=SOLVER,
            label="chtMultiRegionSimpleFoam (steady conjugate heat transfer)",
            application=SOLVER,
            time_dependency="steady",
            parallel="mpirun",
            stop_strategy="stopAt_writeNow",
        ),
        plugin=PLUGIN,
    )
    hub.registry("analysis").register(
        AnalysisType(
            key=ANALYSIS,
            label="Conjugate heat (stub)",
            category="test",
            time_dependency="steady",
            fields=("T", "U", "p_rgh", "p"),
            material_models=(FLUID.key, SOLID.key),
            region_roles=("fluid", "solid"),
            solver_backends=(SOLVER,),
            default_solver=SOLVER,
            result_fields=(
                ResultField("T", "Temperature", "temperature", "scalar"),
                ResultField("U", "Velocity", "velocity", "vector", magnitude_label="Velocity magnitude"),
            ),
            # T is in every region's folder of a written frame.
            frame_fields=("T",),
            kinematic_fields=(),
            control_schema=(
                SchemaField("end_time", "Iterations", "int", default=20, min=1),
                SchemaField("write_interval", "Write interval", "int", default=20, min=1),
            ),
            write_case=write_case,
            family=FAMILY,
            algorithm_label="SIMPLE",
            residual_keys=("U", "h", "p_rgh"),
            residual_series=(
                {"key": "U", "label": "U", "color": "#1570ef", "fields": ["Ux", "Uy", "Uz"], "always": True},
                {"key": "h", "label": "h", "color": "#b42318", "always": True},
                {"key": "p_rgh", "label": "p_rgh", "color": "#6941c6", "always": True},
            ),
            x_axis="iterations",
            log_parser=PARSER,
            validate_ready=validate_ready,
            launch=launch,
        ),
        plugin=PLUGIN,
    )
