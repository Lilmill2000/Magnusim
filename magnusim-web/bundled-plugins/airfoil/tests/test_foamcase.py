"""The OpenFOAM 2D case (airfoil.foamcase): its dictionaries, its WSL steps, and how its result is read."""

from __future__ import annotations

import math
import re
from pathlib import Path

import pytest
from magnusim_sdk import fluids

from airfoil import foamcase

# Air from the SDK's fluid library (the case writer's own source), and the speed it
# gives at Re 1e6 on the 1 m chord.
NU = fluids.by_key("air").nu
U_RE1E6 = 1e6 * NU / foamcase.CHORD

FIXTURES = Path(__file__).resolve().parent / "fixtures" / "openfoam"

# The host's table of WSL steps (docs/plugins/compatibility.md, "pre"): the arguments
# each tool may take. Anything else is refused with pre_not_allowed before WSL.
HOST_STEPS = {
    "gmshToFoam": lambda args: len(args) in (1, 2) and args[-1].endswith(".msh") and (len(args) == 1 or args[0] == "-keepOrientation"),
    "extrudeMesh": lambda args: args == [],
    "createPatch": lambda args: args in ([], ["-overwrite"]),
    "checkMesh": lambda args: set(args) <= {"-allGeometry", "-allTopology"} and len(set(args)) == len(args),
}


def _entry(text: str, key: str) -> str:
    m = re.search(rf"^\s*{re.escape(key)}\s+([^;]+);", text, re.M)
    assert m, f"{key} missing"
    return m.group(1).strip()


def _vector(text: str) -> tuple[float, ...]:
    return tuple(float(v) for v in text.strip("()").split())


def test_the_steps_are_the_hosts_and_make_the_2d_mesh():
    assert [s["tool"] for s in foamcase.PRE_STEPS] == ["gmshToFoam", "extrudeMesh", "createPatch", "checkMesh"]
    for step in foamcase.PRE_STEPS:
        assert HOST_STEPS[step["tool"]](list(step.get("args", []))), step
        assert not step.get("parallel")
    files = foamcase.case_files(1e6, 4.0, 2000)
    # Each step finds its dictionary in the case (gmshToFoam its .msh, written beside them).
    assert foamcase.PRE_STEPS[0]["args"] == [foamcase.MSH_FILE]
    extrude = files["system/extrudeMeshDict"]
    assert _entry(extrude, "constructFrom") == "patch"
    assert _entry(extrude, "sourceCase") == '"<case>"'
    assert _entry(extrude, "sourcePatches") == "(front)"
    assert _entry(extrude, "exposedPatchName") == "back"
    # plane: one layer, and extrudeMesh makes front and back the empty pair.
    assert _entry(extrude, "extrudeModel") == "plane"
    assert _entry(extrude, "nLayers") == "1"
    assert float(_entry(extrude.split("linearNormalCoeffs")[1], "thickness")) == foamcase.SPAN
    patch = files["system/createPatchDict"]
    assert re.search(r"name\s+airfoil;\s*patchInfo\s*\{\s*type\s+wall;\s*\}\s*constructFrom\s+patches;\s*patches\s+\(wing\);", patch)


def test_the_solver_is_simplefoam_with_k_omega_sst_and_stop_saves_a_frame():
    files = foamcase.case_files(1e6, 4.0, 2000)
    control = files["system/controlDict"]
    assert _entry(control, "application") == foamcase.APP == "simpleFoam"
    assert _entry(control, "endTime") == "2000"
    assert _entry(control, "writeInterval") == "2000"
    # The host's Stop writes the latest time through these (compatibility.md).
    assert _entry(control, "stopAt") == "endTime"
    assert _entry(control, "runTimeModifiable") == "true"
    assert _entry(control, "writeCompression") == "off"
    turbulence = files["constant/turbulenceProperties"]
    assert _entry(turbulence, "simulationType") == "RAS"
    assert _entry(turbulence, "RASModel") == "kOmegaSST"
    assert float(_entry(files["constant/transportProperties"], "nu")) == pytest.approx(NU)
    # Every field names the four patches the steps leave, front and back empty.
    for name in ("U", "p", "k", "omega", "nut"):
        text = files[f"0/{name}"]
        for patch in ("airfoil", "farfield", "front", "back"):
            assert re.search(rf"^\s{{4}}{patch}\s*$", text, re.M), (name, patch)
        assert len(re.findall(r"type\s+empty;", text)) == 2
    assert re.search(r"airfoil\s*\{\s*type\s+noSlip;", files["0/U"])
    assert "freestreamVelocity" in files["0/U"] and "freestreamPressure" in files["0/p"]
    assert "omegaWallFunction" in files["0/omega"]
    # The numerics that settle on the C-mesh, run after run (see the module's notes).
    solution = files["system/fvSolution"]
    assert _entry(solution, "consistent") == "yes"
    assert _entry(solution, "nNonOrthogonalCorrectors") == "1"
    assert "fields" not in solution.split("relaxationFactors")[1]
    assert re.search(r"U\s+0\.9;", solution) and re.search(r'"\.\*"\s+0\.8;', solution)
    schemes = files["system/fvSchemes"]
    assert _entry(schemes, "div(phi,U)") == "bounded Gauss linearUpwind grad(U)"
    assert _entry(schemes, "div(phi,omega)") == "bounded Gauss upwind"


@pytest.mark.parametrize("alpha", [-4.0, 0.0, 4.0, 12.5])
def test_the_free_stream_turns_with_alpha_and_the_forces_follow_it(alpha):
    files = foamcase.case_files(1e6, alpha, 100)
    a = math.radians(alpha)
    u = _vector(_entry(files["0/U"], "internalField").removeprefix("uniform").strip())
    assert u[0] == pytest.approx(U_RE1E6 * math.cos(a)) and u[1] == pytest.approx(U_RE1E6 * math.sin(a)) and u[2] == 0
    fc = files["system/controlDict"].split("type            forceCoeffs;")[1].split("yPlus")[0]
    lift, drag = _vector(_entry(fc, "liftDir")), _vector(_entry(fc, "dragDir"))
    assert drag[:2] == pytest.approx((math.cos(a), math.sin(a)))
    assert lift[:2] == pytest.approx((-math.sin(a), math.cos(a)))
    assert sum(x * y for x, y in zip(lift, drag, strict=True)) == pytest.approx(0, abs=1e-12)
    # Cm about the quarter chord, nose up positive (as XFOIL): about -z.
    assert _vector(_entry(fc, "CofR")) == (0.25, 0, 0)
    assert _vector(_entry(fc, "pitchAxis")) == (0, 0, -1)
    assert float(_entry(fc, "magUInf")) == pytest.approx(U_RE1E6)
    assert float(_entry(fc, "Aref")) == pytest.approx(foamcase.CHORD * foamcase.SPAN)
    assert _entry(fc, "patches") == "(airfoil)"


def test_the_reynolds_number_sets_the_speed_and_its_range_is_honest():
    assert foamcase.flow(3e6, 0)["speed"] == pytest.approx(3 * U_RE1E6)
    f = foamcase.flow(1e6, 0)
    assert f["k"] == pytest.approx(1.5 * (U_RE1E6 * 0.001) ** 2)
    assert f["omega"] == pytest.approx(f["k"] / NU)
    for re_ in (5e4, 1e8, math.nan):
        with pytest.raises(foamcase.CaseError, match="fully turbulent"):
            foamcase.flow(re_, 4)
    with pytest.raises(foamcase.CaseError, match="−30° to 30°"):
        foamcase.flow(1e6, 31)
    with pytest.raises(foamcase.CaseError, match="iteration"):
        foamcase.case_files(1e6, 4, 0)


def test_submit_options_are_the_bridge_call_and_a_copy():
    opts = foamcase.submit_options("openfoam/run-1-a4")
    assert opts == {
        "caseRel": "openfoam/run-1-a4",
        "app": "simpleFoam",
        "nProcs": 4,
        "pre": [
            {"tool": "gmshToFoam", "args": ["mesh.msh"]},
            {"tool": "extrudeMesh"},
            {"tool": "createPatch", "args": ["-overwrite"]},
            {"tool": "checkMesh"},
        ],
        "results": {"kinematicFields": ["p"], "rho": 1.204, "frameFields": ["U", "p"]},
    }
    opts["pre"][0]["args"].append("x")
    opts["results"]["kinematicFields"].append("U")
    assert foamcase.PRE_STEPS[0]["args"] == ["mesh.msh"]
    assert foamcase.RESULTS["kinematicFields"] == ["p"]


def test_the_coefficients_of_a_real_run_are_read_and_averaged():
    """tests/fixtures/openfoam/coefficient.dat: the last 300 iterations of a real run of this
    case (NACA 2412, Re 1e6, α 4°, medium mesh, OpenFOAM v2606), with the header forceCoeffs writes."""
    rows = foamcase.parse_coefficients((FIXTURES / "coefficient.dat").read_text(encoding="utf-8"))
    assert len(rows) == 300
    assert rows[0]["iteration"] == 1201 and rows[-1]["iteration"] == 1500
    got = foamcase.summarize(rows)
    assert got["iterations"] == 1500 and got["averaged"] == 200
    assert got["cl"] == pytest.approx(0.6256, abs=1e-4)
    assert got["cd"] == pytest.approx(0.01343, abs=1e-5)
    assert got["cm"] == pytest.approx(-0.0433, abs=1e-4)
    assert got["cl_cd"] == pytest.approx(got["cl"] / got["cd"])
    assert got["steady"] is True and 0 < got["cl_change"] < foamcase.STEADY_CL
    assert got["residuals"] is None  # no log given


def test_the_last_iterations_residuals_are_read_from_the_solver_log():
    """tests/fixtures/openfoam/log.simpleFoam: the last iterations of a real run (NACA 2412,
    Re 1e6, α 4°, medium mesh): the residuals the page shows next to "steady"."""
    log = (FIXTURES / "log.simpleFoam").read_text(encoding="utf-8")
    got = foamcase.final_residuals(log)
    # Iteration 1500: p's first corrector, U's larger component (Uy), k and ω.
    assert got == {"U": 9.2789487e-05, "p": 0.0016067593, "omega": 6.452585e-09, "k": 9.8085266e-06}
    rows = [{"iteration": float(i), "cl": 0.6256, "cd": 0.0134, "cm": -0.043} for i in range(1301, 1501)]
    assert foamcase.summarize(rows, log)["residuals"] == got
    assert foamcase.final_residuals("") is None
    assert foamcase.final_residuals("Time = 1\n\nExecutionTime = 1 s\n") is None


def test_the_solver_runs_every_iteration_with_no_residual_targets():
    """No run met the old targets (p 1e-5, U and k/ω 1e-6): p levels off at 5e-4 to 1e-2."""
    sim = foamcase.case_files(1e6, 4, 1500)["system/fvSolution"].split("SIMPLE")[1]
    assert "residualControl" not in sim
    assert "consistent      yes;" in sim and "nNonOrthogonalCorrectors 1;" in sim
    assert "endTime         1500;" in foamcase.case_files(1e6, 4, 1500)["system/controlDict"]


def test_a_run_whose_lift_still_moves_is_not_steady_and_an_empty_one_is_refused():
    rows = [{"iteration": float(i), "cl": 0.5 + 0.001 * i, "cd": 0.01, "cm": -0.05} for i in range(1, 301)]
    got = foamcase.summarize(rows)
    assert got["steady"] is False and got["cl_change"] == pytest.approx(0.199)
    short = foamcase.summarize(rows[:50])
    assert short["steady"] is False and short["averaged"] == 50
    with pytest.raises(foamcase.CaseError, match="no force coefficients"):
        foamcase.summarize([])
    assert foamcase.parse_coefficients("1 2 3\n") == []  # no header: not read
    assert "residuals_met" not in foamcase.summarize(rows)
