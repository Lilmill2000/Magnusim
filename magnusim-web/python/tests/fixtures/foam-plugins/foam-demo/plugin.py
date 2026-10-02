"""Foam demo (gate:h15-*): a plugin that writes its own OpenFOAM case and runs it
through the host (compute.submitOpenFOAM in its workspace).

- ``write_cavity({case, end_time, write_interval, write_format, broken?, study_id?})``
  writes the lid-driven cavity (20x20x1 blockMesh, pimpleFoam, laminar) into its
  own folder: ``case`` is relative to the study ``study_id`` when given, else to
  the plugin's folder in the project (``studies/<sid>/cases/c1``). ``broken``
  writes a blockMeshDict that blockMesh refuses.
- ``slow({seconds})`` sleeps on the plugin lane (tests hold the lane with it).
- The JobKind ``foam_demo_write_mesh_case`` (core interpreter, standard library
  only) writes a small meshing case into ``MAGNUSIM_CASE_DIR``: the prepare step
  of a step-list run.
- A ``solve.parse_line`` listener appends ``<owner> <line>`` to the file named by
  ``MAGNUSIM_TEST_HOOK_LOG`` when that is set.
"""

from __future__ import annotations

import os
import time
from pathlib import Path

from cfddesk.registry.hooks import get_hooks
from cfddesk.registry.jobs import JobKind

PLUGIN = "foam-demo"


def _header(cls: str, obj: str, location: str = "") -> str:
    where = f'    location    "{location}";\n' if location else ""
    return (
        "FoamFile\n{\n    version     2.0;\n    format      ascii;\n"
        f"    class       {cls};\n{where}    object      {obj};\n}}\n\n"
    )


def _num(value: object, default: float) -> float:
    try:
        out = float(str(value))
    except (TypeError, ValueError):
        return default
    return out if out > 0 else default


def cavity_files(*, end_time: float, write_interval: float, write_format: str, broken: bool) -> dict[str, str]:
    """The case's files, by path inside the case."""
    fmt = "binary" if str(write_format) == "binary" else "ascii"
    last_vertex = "99" if broken else "7"
    files = {
        "system/controlDict": _header("dictionary", "controlDict", "system")
        + "application     pimpleFoam;\n"
        "startFrom       startTime;\n"
        "startTime       0;\n"
        "stopAt          endTime;\n"
        f"endTime         {end_time:g};\n"
        "deltaT          0.005;\n"
        "writeControl    runTime;\n"
        f"writeInterval   {write_interval:g};\n"
        "purgeWrite      0;\n"
        f"writeFormat     {fmt};\n"
        "writePrecision  6;\n"
        "writeCompression off;\n"
        "timeFormat      general;\n"
        "timePrecision   6;\n"
        "runTimeModifiable true;\n",
        "system/blockMeshDict": _header("dictionary", "blockMeshDict", "system")
        + "convertToMeters 0.1;\n\n"
        "vertices\n(\n    (0 0 0)\n    (1 0 0)\n    (1 1 0)\n    (0 1 0)\n"
        "    (0 0 0.1)\n    (1 0 0.1)\n    (1 1 0.1)\n    (0 1 0.1)\n);\n\n"
        f"blocks\n(\n    hex (0 1 2 3 4 5 6 {last_vertex}) (20 20 1) simpleGrading (1 1 1)\n);\n\n"
        "edges\n(\n);\n\n"
        "boundary\n(\n"
        "    movingWall\n    {\n        type wall;\n        faces\n        (\n            (3 7 6 2)\n        );\n    }\n"
        "    fixedWalls\n    {\n        type wall;\n        faces\n        (\n            (0 4 7 3)\n"
        "            (2 6 5 1)\n            (1 5 4 0)\n        );\n    }\n"
        "    frontAndBack\n    {\n        type empty;\n        faces\n        (\n            (0 3 2 1)\n"
        "            (4 5 6 7)\n        );\n    }\n);\n\n"
        "mergePatchPairs\n(\n);\n",
        "system/fvSchemes": _header("dictionary", "fvSchemes", "system")
        + "ddtSchemes\n{\n    default         Euler;\n}\n\n"
        "gradSchemes\n{\n    default         Gauss linear;\n}\n\n"
        "divSchemes\n{\n    default         none;\n    div(phi,U)      Gauss linear;\n"
        "    div((nuEff*dev2(T(grad(U))))) Gauss linear;\n}\n\n"
        "laplacianSchemes\n{\n    default         Gauss linear orthogonal;\n}\n\n"
        "interpolationSchemes\n{\n    default         linear;\n}\n\n"
        "snGradSchemes\n{\n    default         orthogonal;\n}\n",
        "system/fvSolution": _header("dictionary", "fvSolution", "system")
        + "solvers\n{\n"
        "    p\n    {\n        solver          PCG;\n        preconditioner  DIC;\n"
        "        tolerance       1e-06;\n        relTol          0.05;\n    }\n\n"
        "    pFinal\n    {\n        $p;\n        relTol          0;\n    }\n\n"
        '    "(U|UFinal)"\n    {\n        solver          smoothSolver;\n'
        "        smoother        symGaussSeidel;\n        tolerance       1e-05;\n        relTol          0;\n    }\n}\n\n"
        "PIMPLE\n{\n    nOuterCorrectors 1;\n    nCorrectors     2;\n"
        "    nNonOrthogonalCorrectors 0;\n    pRefCell        0;\n    pRefValue       0;\n}\n",
        "constant/transportProperties": _header("dictionary", "transportProperties", "constant")
        + "transportModel  Newtonian;\n\nnu              0.01;\n",
        "constant/turbulenceProperties": _header("dictionary", "turbulenceProperties", "constant")
        + "simulationType  laminar;\n",
        "0/U": _header("volVectorField", "U", "0")
        + "dimensions      [0 1 -1 0 0 0 0];\n\ninternalField   uniform (0 0 0);\n\n"
        "boundaryField\n{\n"
        "    movingWall\n    {\n        type            fixedValue;\n        value           uniform (1 0 0);\n    }\n"
        "    fixedWalls\n    {\n        type            noSlip;\n    }\n"
        "    frontAndBack\n    {\n        type            empty;\n    }\n}\n",
        "0/p": _header("volScalarField", "p", "0")
        + "dimensions      [0 2 -2 0 0 0 0];\n\ninternalField   uniform 0;\n\n"
        "boundaryField\n{\n"
        "    movingWall\n    {\n        type            zeroGradient;\n    }\n"
        "    fixedWalls\n    {\n        type            zeroGradient;\n    }\n"
        "    frontAndBack\n    {\n        type            empty;\n    }\n}\n",
    }
    return files


def _write_cavity(params: dict, scope: dict) -> dict:
    data = scope.get("data")
    if data is None:
        return {"ok": False, "error": "this call has no open project"}
    case = str(params.get("case") or "").strip().strip("/")
    sid = str(params.get("study_id") or "").strip()
    if not case:
        return {"ok": False, "error": "case is required"}
    base = f"studies/{sid}/{case}" if sid else case
    files = cavity_files(
        end_time=_num(params.get("end_time"), 0.5),
        write_interval=_num(params.get("write_interval"), 0.1),
        write_format=str(params.get("write_format") or "binary"),
        broken=bool(params.get("broken")),
    )
    for rel, text in files.items():
        data.write_bytes(f"{base}/{rel}", text.encode("utf-8"))
    return {"ok": True, "case": base, "files": sorted(files)}


def _slow(params: dict, scope: dict) -> dict:
    del scope
    seconds = min(_num(params.get("seconds"), 1.0), 60.0)
    time.sleep(seconds)
    return {"ok": True, "slept": seconds}


def _on_parse_line(*, ctx=None, lines=(), events=(), dropped=0, **_ignored) -> None:
    del events, dropped
    path = os.environ.get("MAGNUSIM_TEST_HOOK_LOG")
    if not path:
        return
    owner = getattr(ctx, "owner", "?")
    with open(path, "a", encoding="utf-8") as fh:
        for line in lines:
            fh.write(f"{owner} {line}\n")


def register(hub):
    hub.register_method(PLUGIN, "write_cavity", _write_cavity)
    hub.register_method(PLUGIN, "slow", _slow)
    hub.register_job(
        JobKind("foam_demo_write_mesh_case", "jobs/write_mesh_case.py", "project", ("sleep", "fail"), python="core"),
        plugin=PLUGIN,
        package_dir=Path(__file__).resolve().parent,
    )
    get_hooks().on("solve.parse_line", _on_parse_line, plugin=PLUGIN)
    return None
