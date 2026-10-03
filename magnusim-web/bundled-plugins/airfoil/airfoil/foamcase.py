"""The OpenFOAM 2D case of one angle of attack: its files, its WSL steps, and its results.

A case is a folder in the study (``studies/<sid>/openfoam/run-<n>-a<α>``) that
the host runs once in WSL (``ws.compute.submitOpenFOAM``):

1. ``gmshToFoam mesh.msh``: the C-mesh (:mod:`airfoil.cmesh`), one cell thick;
2. ``extrudeMesh``: the ``front`` patch extruded one layer :data:`SPAN` deep with
   the ``plane`` model, which makes ``front`` and ``back`` the ``empty`` pair of
   a 2D case;
3. ``createPatch -overwrite``: the section's faces (``wing``) become the wall
   ``airfoil`` (``gmshToFoam`` makes every patch a plain ``patch``);
4. ``checkMesh``: its report stays in the case (``log.checkMesh.4``);
5. ``simpleFoam`` with k-ω SST, steady, for the mesh level's iterations (no
   residual targets: see below). A ``forceCoeffs`` function object writes Cl,
   Cd and Cm every iteration, and ``yPlus`` writes y+ on the wall with the last
   frame.

The flow is air (``magnusim_sdk.fluids``) round a section of chord 1 m at the
speed that gives the study's Reynolds number, at the angle of attack: the mesh
does not turn with α, the free stream does. The solver is incompressible and
fully turbulent, so the Mach number and the transition settings are not used.

The numerics were settled on NACA 2412 at Re 1e6: SIMPLEC (``consistent``)
with under-relaxation 0.9 (U) and 0.8 (k, ω), one non-orthogonal correction,
second-order upwind for U and first-order for k and ω. Plain SIMPLE (0.3 on p,
0.7 on the rest) sometimes took a different path from the impulsive start:
the same case on 4 ranks swung to Cl −0.08 and still drifted after 2000
iterations in one run of four. With SIMPLEC every run of α −4°, 0°, 4°, 8° and
12°, Re 1e5 to 3e6 (and 5e7 at 4°), open and closed trailing edges settled
(12° only just: Cl still moves about 0.004 over the last 200 iterations), Cl
at 4° within about 500 iterations to 1e-5 (0.6256 medium, 0.6267 fine); XFOIL with
transition forced at 5 % of the chord gives 0.667 (about 6 % more, as usual
for k-ω SST against a panel code).

Results (:func:`summarize`): the coefficients are the mean of the last
:data:`AVERAGE_LAST` iterations of ``postProcessing/forceCoeffs/0/
coefficient.dat``; a run is *steady* when Cl moved less than
:data:`STEADY_CL` over them. The last iteration's initial residuals
(:func:`final_residuals`) are kept with it, so the page shows how far the
solver got as well as whether Cl settled.

There are no residual targets (``residualControl``): no run met the ones it
had (p 1e-5, U and k/ω 1e-6), so every run went to the end anyway and "met"
never meant anything. Cl settles to 1e-4 while the pressure residual levels
off, at about 6e-4 at 4° and 9e-3 at 0° on NACA 2412, Re 1e6, medium mesh
(measured with the residual field written out: in the far-field blocks next
to the wall layer, over the upper surface at 4° and ahead of the leading edge
at 0°, where those blocks meet the layer at up to 63° of non-orthogonality;
under 3 % of it in the wake). Near stall (12° at Re 1e6) Cl keeps swinging by
about 0.005, and such a run is shown as not steady.
"""

from __future__ import annotations

import math
import re
from typing import Any

from magnusim_sdk import fluids
from magnusim_sdk.foam import foam_header

# SPDX-License-Identifier: GPL-3.0-or-later

APP = "simpleFoam"
MODEL = "k-ω SST"
SPAN = 0.1  # m: the one cell's depth; Aref = chord x span
CHORD = 1.0  # m
AVERAGE_LAST = 200
STEADY_CL = 0.005  # the largest change of Cl over the averaged iterations of a steady run
TURBULENCE_INTENSITY = 0.001  # 0.1 % in the free stream
VISCOSITY_RATIO = 1.0  # νt/ν in the free stream
N_PROCS = 4  # the host clamps it to the PC
MSH_FILE = "mesh.msh"
RE_RANGE = (1.0e5, 5.0e7)
ALPHA_RANGE = (-30.0, 30.0)
COEFFICIENTS_REL = "postProcessing/forceCoeffs/0/coefficient.dat"
SOLVER_LOG = "log.simpleFoam"

# The WSL steps before the solver (compatibility.md, "pre"): the mesh, its 2D
# pair of empty patches, the wall, and a report.
PRE_STEPS: list[dict[str, Any]] = [
    {"tool": "gmshToFoam", "args": [MSH_FILE]},
    {"tool": "extrudeMesh"},
    {"tool": "createPatch", "args": ["-overwrite"]},
    {"tool": "checkMesh"},
]
# What the host shows of the case in 3D: p is kinematic (p/ρ) in simpleFoam.
RESULTS = {"kinematicFields": ["p"], "rho": fluids.RHO_AIR, "frameFields": ["U", "p"]}


class CaseError(ValueError):
    """A case that cannot be written or read (the message says why)."""


def _vec(x: float, y: float) -> str:
    return f"({_num(x)} {_num(y)} 0)"


def _num(v: float) -> str:
    out = f"{v:.10g}"
    return "0" if out in ("-0", "0") else out


def reynolds_reason() -> str:
    """Why a Reynolds number outside :data:`RE_RANGE` is refused."""
    return "OpenFOAM 2D runs fully turbulent (k-ω SST): use a Reynolds number from 1e5 to 5e7."


def flow(re: float, alpha_deg: float) -> dict[str, float]:
    """The free stream for ``re`` at ``alpha_deg``: speed, velocity, k, ω, νt and the force directions."""
    if not (math.isfinite(re) and RE_RANGE[0] <= re <= RE_RANGE[1]):
        raise CaseError(reynolds_reason())
    if not (math.isfinite(alpha_deg) and ALPHA_RANGE[0] <= alpha_deg <= ALPHA_RANGE[1]):
        raise CaseError("The angle of attack must be from −30° to 30°.")
    air = fluids.by_key("air")
    speed = re * air.nu / CHORD
    a = math.radians(alpha_deg)
    k = 1.5 * (speed * TURBULENCE_INTENSITY) ** 2
    nut = VISCOSITY_RATIO * air.nu
    return {
        "nu": air.nu,
        "rho": air.rho,
        "speed": speed,
        "ux": speed * math.cos(a),
        "uy": speed * math.sin(a),
        "k": k,
        "omega": k / nut,
        "nut": nut,
        "lift_x": -math.sin(a),
        "lift_y": math.cos(a),
        "drag_x": math.cos(a),
        "drag_y": math.sin(a),
    }


def _field(cls: str, name: str, dims: str, internal: str, patches: dict[str, str]) -> str:
    body = [f"dimensions      {dims};", "", f"internalField   {internal};", "", "boundaryField", "{"]
    for patch, block in patches.items():
        body.append(f"    {patch}")
        body.append("    {")
        for line in block.strip().splitlines():
            body.append(f"        {line.strip()}")
        body.append("    }")
    body.append("}")
    return foam_header(cls, name) + "\n" + "\n".join(body) + "\n"


EMPTY = "type            empty;"


def case_files(re: float, alpha_deg: float, iterations: int) -> dict[str, str]:
    """Every text file of the case but the mesh, by its path in the case."""
    if not 1 <= int(iterations) <= 100_000:
        raise CaseError("The iteration count must be from 1 to 100000.")
    f = flow(re, alpha_deg)
    u = _vec(f["ux"], f["uy"])
    k, omega, nut = _num(f["k"]), _num(f["omega"]), _num(f["nut"])
    n = int(iterations)
    return {
        "system/controlDict": foam_header("dictionary", "controlDict")
        + f"""
application     {APP};
startFrom       startTime;
startTime       0;
stopAt          endTime;
endTime         {n};
deltaT          1;
writeControl    timeStep;
writeInterval   {n};
purgeWrite      0;
writeFormat     binary;
writePrecision  8;
writeCompression off;
timeFormat      general;
timePrecision   6;
runTimeModifiable true;

functions
{{
    forceCoeffs
    {{
        type            forceCoeffs;
        libs            (forces);
        writeControl    timeStep;
        writeInterval   1;
        log             false;
        patches         (airfoil);
        rho             rhoInf;
        rhoInf          {_num(f["rho"])};
        liftDir         {_vec(f["lift_x"], f["lift_y"])};
        dragDir         {_vec(f["drag_x"], f["drag_y"])};
        CofR            (0.25 0 0);
        pitchAxis       (0 0 -1);
        magUInf         {_num(f["speed"])};
        lRef            {_num(CHORD)};
        Aref            {_num(CHORD * SPAN)};
    }}
    yPlus
    {{
        type            yPlus;
        libs            (fieldFunctionObjects);
        writeControl    writeTime;
    }}
}}
""",
        "system/fvSchemes": foam_header("dictionary", "fvSchemes")
        + """
ddtSchemes
{
    default         steadyState;
}

gradSchemes
{
    default         Gauss linear;
    grad(U)         cellLimited Gauss linear 1;
}

divSchemes
{
    default         none;
    div(phi,U)      bounded Gauss linearUpwind grad(U);
    div(phi,k)      bounded Gauss upwind;
    div(phi,omega)  bounded Gauss upwind;
    div((nuEff*dev2(T(grad(U))))) Gauss linear;
}

laplacianSchemes
{
    default         Gauss linear limited corrected 0.5;
}

interpolationSchemes
{
    default         linear;
}

snGradSchemes
{
    default         limited corrected 0.5;
}

wallDist
{
    method          meshWave;
}
""",
        "system/fvSolution": foam_header("dictionary", "fvSolution")
        + """
solvers
{
    p
    {
        solver          GAMG;
        smoother        GaussSeidel;
        tolerance       1e-08;
        relTol          0.05;
    }

    "(U|k|omega)"
    {
        solver          smoothSolver;
        smoother        symGaussSeidel;
        tolerance       1e-09;
        relTol          0.05;
    }
}

SIMPLE
{
    nNonOrthogonalCorrectors 1;
    consistent      yes;
}

relaxationFactors
{
    equations
    {
        U               0.9;
        ".*"            0.8;
    }
}
""",
        "system/extrudeMeshDict": foam_header("dictionary", "extrudeMeshDict")
        + f"""
constructFrom   patch;
sourceCase      "<case>";
sourcePatches   (front);
exposedPatchName back;
flipNormals     false;
extrudeModel    plane;
nLayers         1;
expansionRatio  1;
linearNormalCoeffs
{{
    thickness       {_num(SPAN)};
}}
mergeFaces      false;
mergeTol        0;
""",
        "system/createPatchDict": foam_header("dictionary", "createPatchDict")
        + """
pointSync       false;

patches
(
    {
        name            airfoil;
        patchInfo
        {
            type            wall;
        }
        constructFrom   patches;
        patches         (wing);
    }
);
""",
        "constant/transportProperties": foam_header("dictionary", "transportProperties")
        + f"\ntransportModel  Newtonian;\n\nnu              {_num(f['nu'])};\n",
        "constant/turbulenceProperties": foam_header("dictionary", "turbulenceProperties")
        + "\nsimulationType  RAS;\n\nRAS\n{\n    RASModel        kOmegaSST;\n    turbulence      on;\n    printCoeffs     on;\n}\n",
        "0/U": _field(
            "volVectorField",
            "U",
            "[0 1 -1 0 0 0 0]",
            f"uniform {u}",
            {
                "airfoil": "type            noSlip;",
                "farfield": f"type            freestreamVelocity;\nfreestreamValue uniform {u};",
                "front": EMPTY,
                "back": EMPTY,
            },
        ),
        "0/p": _field(
            "volScalarField",
            "p",
            "[0 2 -2 0 0 0 0]",
            "uniform 0",
            {
                "airfoil": "type            zeroGradient;",
                "farfield": "type            freestreamPressure;\nfreestreamValue uniform 0;",
                "front": EMPTY,
                "back": EMPTY,
            },
        ),
        "0/k": _field(
            "volScalarField",
            "k",
            "[0 2 -2 0 0 0 0]",
            f"uniform {k}",
            {
                "airfoil": f"type            kqRWallFunction;\nvalue           uniform {k};",
                "farfield": f"type            freestream;\nfreestreamValue uniform {k};",
                "front": EMPTY,
                "back": EMPTY,
            },
        ),
        "0/omega": _field(
            "volScalarField",
            "omega",
            "[0 0 -1 0 0 0 0]",
            f"uniform {omega}",
            {
                "airfoil": f"type            omegaWallFunction;\nvalue           uniform {omega};",
                "farfield": f"type            freestream;\nfreestreamValue uniform {omega};",
                "front": EMPTY,
                "back": EMPTY,
            },
        ),
        "0/nut": _field(
            "volScalarField",
            "nut",
            "[0 2 -1 0 0 0 0]",
            f"uniform {nut}",
            {
                "airfoil": "type            nutUSpaldingWallFunction;\nvalue           uniform 0;",
                "farfield": f"type            calculated;\nvalue           uniform {nut};",
                "front": EMPTY,
                "back": EMPTY,
            },
        ),
    }


def submit_options(case_rel: str) -> dict[str, Any]:
    """What the workspace hands ``ws.compute.submitOpenFOAM`` for this case."""
    return {
        "caseRel": case_rel,
        "app": APP,
        "nProcs": N_PROCS,
        "pre": [{**step, "args": list(step["args"])} if "args" in step else dict(step) for step in PRE_STEPS],
        "results": {key: list(v) if isinstance(v, list) else v for key, v in RESULTS.items()},
    }


# ---------------------------------------------------------------------------
# Results
# ---------------------------------------------------------------------------


def parse_coefficients(text: str) -> list[dict[str, float]]:
    """``coefficient.dat`` rows as ``{iteration, cd, cl, cm}`` (its ``# Time`` header names the columns)."""
    columns: list[str] = []
    rows: list[dict[str, float]] = []
    for raw in str(text or "").splitlines():
        line = raw.strip()
        if not line:
            continue
        if line.startswith("#"):
            words = line.lstrip("#").split()
            if words and words[0] == "Time":
                columns = words
            continue
        if not columns:
            continue
        parts = line.split()
        if len(parts) < len(columns):
            continue
        try:
            values = {name: float(v) for name, v in zip(columns, parts, strict=False)}
        except ValueError:
            continue
        if not all(math.isfinite(values.get(c, math.nan)) for c in ("Time", "Cd", "Cl", "CmPitch")):
            continue
        rows.append({"iteration": values["Time"], "cd": values["Cd"], "cl": values["Cl"], "cm": values["CmPitch"]})
    return rows


_SOLVING = re.compile(r"Solving for (\w+), Initial residual = ([-+0-9.eE]+)")


def final_residuals(log_text: str) -> dict[str, float] | None:
    """The last iteration's largest initial residual of each field in the solver log
    (``U`` its largest component), as the page's residual plot shows them; None
    without a finished iteration."""
    blocks = [b for b in re.split(r"(?m)^Time = ", str(log_text or ""))[1:] if "Solving for" in b]
    out: dict[str, float] = {}
    for name, value in _SOLVING.findall(blocks[-1] if blocks else ""):
        key = "U" if name in ("Ux", "Uy", "Uz") else name
        v = float(value)
        if math.isfinite(v):
            out[key] = max(v, out.get(key, v))
    return out or None


def summarize(rows: list[dict[str, float]], log_text: str = "", last: int = AVERAGE_LAST) -> dict[str, Any]:
    """The run's coefficients: the mean of its last ``last`` iterations, how far Cl moved over them, and whether it is steady."""
    if not rows:
        raise CaseError("The case wrote no force coefficients.")
    tail = rows[-last:]
    out: dict[str, Any] = {key: sum(r[key] for r in tail) / len(tail) for key in ("cl", "cd", "cm")}
    out["cl_cd"] = out["cl"] / out["cd"] if out["cd"] else None
    out["cl_change"] = max(r["cl"] for r in tail) - min(r["cl"] for r in tail)
    out["iterations"] = int(rows[-1]["iteration"])
    out["averaged"] = len(tail)
    out["residuals"] = final_residuals(log_text)
    out["steady"] = len(tail) == last and out["cl_change"] < STEADY_CL
    return out
