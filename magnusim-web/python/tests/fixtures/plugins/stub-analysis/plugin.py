"""Stub analysis: a toy simulation type the core knows nothing about.

Steady scalar diffusion (OpenFOAM laplacianFoam): T = 1 on the first patch,
0 on the others, conductivity from the study's "diffusivity" setting. It is the
proof that the core creates a study, asks what blocks a run, writes the case
and launches it only through the analysis contract, with no incompressible
code. It imports nothing but magnusim_sdk and cfddesk.registry.
"""

from __future__ import annotations

import re
import shutil
from pathlib import Path
from typing import Any

from magnusim_sdk.foam import write_decompose_par_dict, write_foam_dict, write_vol_field

from cfddesk.registry.analysis import AnalysisType, ResultField
from cfddesk.registry.contract import AnalysisFamily
from cfddesk.registry.schema import SchemaField
from cfddesk.registry.solver import SolverApp

PLUGIN = "stub-analysis"
ANALYSIS = "stub_diffusion_steady"

FAMILY = AnalysisFamily(
    key="stub_diffusion",
    label="Scalar diffusion (stub)",
    title="Scalar diffusion (stub)",
    description="A toy simulation type that tests the analysis contract: steady diffusion of a scalar.",
    tags=("TEST",),
    study_name="Diffusion",
)


def _diffusivity(study: dict[str, Any]) -> float:
    try:
        return float(study.get("diffusivity") or 0)
    except (TypeError, ValueError):
        return 0.0


def validate_ready(ctx: Any) -> list[dict[str, Any]]:
    if not _diffusivity(ctx.study) > 0:
        return [{"message": "Set the diffusivity above 0 m²/s", "fix": {"go": "study"}}]
    return []


def _patch_names(boundary: Path) -> list[str]:
    text = boundary.read_text(encoding="utf-8", errors="replace")
    names = re.findall(r"^\s*([A-Za-z_]\w*)\s*\n\s*\{", text, re.M)
    return [n for n in names if n != "FoamFile"]


def write_case(ctx: Any) -> dict[str, Any]:
    out = Path(ctx.out_dir)
    poly = Path(ctx.mesh_case_dir) / "constant" / "polyMesh"
    shutil.copytree(poly, out / "constant" / "polyMesh", dirs_exist_ok=True)
    patches = _patch_names(out / "constant" / "polyMesh" / "boundary")
    spec = ctx.run_spec
    end = max(1, int(getattr(spec, "end_time", 5) or 5))
    every = max(1, int(getattr(spec, "write_interval", 5) or 5))
    write_vol_field(
        out / "0" / "T",
        object_name="T",
        cls="volScalarField",
        dims="[0 0 0 1 0 0 0]",
        internal="uniform 0",
        patches={
            name: {"type": "fixedValue", "value": "uniform 1" if i == 0 else "uniform 0"}
            for i, name in enumerate(patches)
        },
    )
    write_foam_dict(
        out / "constant" / "transportProperties",
        "dictionary",
        "transportProperties",
        f"DT              {_diffusivity(ctx.simulation or {}):g};",
    )
    write_foam_dict(
        out / "system" / "controlDict",
        "dictionary",
        "controlDict",
        "\n".join(
            [
                "application     laplacianFoam;",
                "startFrom       startTime;",
                "startTime       0;",
                "stopAt          endTime;",
                f"endTime         {end};",
                "deltaT          1;",
                "writeControl    timeStep;",
                f"writeInterval   {every};",
                "writeFormat     ascii;",
                "runTimeModifiable true;",
            ]
        ),
    )
    write_foam_dict(
        out / "system" / "fvSchemes",
        "dictionary",
        "fvSchemes",
        "ddtSchemes { default steadyState; }\n"
        "gradSchemes { default Gauss linear; }\n"
        "divSchemes { default none; }\n"
        "laplacianSchemes { default Gauss linear corrected; }\n"
        "interpolationSchemes { default linear; }\n"
        "snGradSchemes { default corrected; }",
    )
    write_foam_dict(
        out / "system" / "fvSolution",
        "dictionary",
        "fvSolution",
        "solvers { T { solver PCG; preconditioner DIC; tolerance 1e-06; relTol 0; } }\n"
        "SIMPLE { nNonOrthogonalCorrectors 1; }",
    )
    if int(ctx.n_procs or 1) > 1:
        write_decompose_par_dict(out / "system" / "decomposeParDict", int(ctx.n_procs))
    (out / "case.foam").write_text("", encoding="ascii")
    return {"ok": True, "case_dir": str(out), "solver": "laplacianFoam", "n_procs": int(ctx.n_procs or 1), "patches": patches}


def _no_legacy_checks(*_args: Any, **_kwargs: Any) -> list[str]:
    return []


def register(hub: Any) -> None:
    hub.registry("solver").register(
        SolverApp(
            key="laplacianFoam",
            label="laplacianFoam (steady diffusion)",
            application="laplacianFoam",
            time_dependency="steady",
            parallel="mpirun",
            stop_strategy="stopAt_writeNow",
        ),
        plugin=PLUGIN,
    )
    hub.registry("analysis").register(
        AnalysisType(
            key=ANALYSIS,
            label="Scalar diffusion (stub)",
            category="TEST",
            time_dependency="steady",
            fields=("T",),
            turbulence_models=(),
            default_turbulence="",
            bc_types=(),
            material_models=(),
            solver_backends=("laplacianFoam",),
            default_solver="laplacianFoam",
            monitors=(),
            # The results viewer colours by T (in K), the field this analysis writes.
            result_fields=(ResultField("T", "Temperature", "temperature", "scalar"),),
            settings_schema=(
                SchemaField("diffusivity", "Diffusivity", "float", default=0.0, min=0.0, unit="m²/s"),
            ),
            numerics_schema=(),
            control_schema=(
                SchemaField("end_time", "Iterations", "int", default=5, min=1),
                SchemaField("write_interval", "Write interval", "int", default=5, min=1),
            ),
            validate=_no_legacy_checks,
            write_case=write_case,
            family=FAMILY,
            algorithm_label="Laplacian",
            residual_keys=("T",),
            residual_series=({"key": "T", "label": "T", "color": "#b42318", "always": True},),
            x_axis="iterations",
            validate_ready=validate_ready,
            # Its own study and run settings (ui/index.tsx), in the core's panels.
            ui={"study_settings": "stub-analysis.study", "run_settings": "stub-analysis.run"},
        ),
        plugin=PLUGIN,
    )
