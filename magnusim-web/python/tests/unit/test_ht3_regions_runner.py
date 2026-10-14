"""HT3: a multi-region case (conjugate heat transfer) on the step-list runner.

The case's ``w27-case.json`` lists its ``regions`` ([{name, role}], host API 1.8).
``-region <name>`` must name one of them; ``foam_pre.sh`` brings each region's
folders back after ``splitMeshRegions`` (and drops ``cellToRegion``); ``solve.sh``
needs every region's mesh, decomposes and reconstructs with ``-allRegions`` and
counts a frame written when every region holds a frame field; the relay writes
each region's ``decomposeParDict``. The two scripts run in bash with a stand-in
``openfoam2606`` that acts the tools out on the folders.
"""

from __future__ import annotations

import json
import os
import re
import subprocess
from pathlib import Path
from types import SimpleNamespace
from typing import Any

import pytest

from cfddesk.wsl import foam_relay
from cfddesk.wsl.foam_case import (
    FoamCaseError,
    case_region_names,
    case_regions,
    check_case_local,
    check_results,
    check_steps,
    region_frame_problem,
    region_name_ok,
    region_without_frame_field,
    regions_word_list,
    render_foam_pre,
)
from cfddesk.wsl.solve_run import render_solve_script
from tests.unit.test_h15_foam_case import write_cavity
from tests.unit.test_h15_relay import (
    JOB,
    FakeSolveHub,
    Recorder,
    _builtin_shape,
    evt,
    make_solve_run,
    make_solve_spec,
    run,
    solve_deps,
)
from tests.unit.test_solve_sh_restart import BASH, _posix

REGIONS = [{"name": "air", "role": "fluid"}, {"name": "aluminium_6061", "role": "solid"}]


def _sidecar(case: Path, **doc: Any) -> None:
    (case / "w27-case.json").write_text(json.dumps(doc), encoding="utf-8")


def _code(fn, *args, **kwargs) -> tuple[str, str]:
    with pytest.raises(FoamCaseError) as err:
        fn(*args, **kwargs)
    return err.value.code, err.value.error


# ---------------------------------------------------------------------------
# The regions a case lists
# ---------------------------------------------------------------------------


def test_case_regions(tmp_path: Path):
    assert case_regions(tmp_path) == []
    _sidecar(tmp_path, solver="x")
    assert case_regions(tmp_path) == []
    _sidecar(tmp_path, regions=REGIONS)
    assert case_regions(tmp_path) == REGIONS
    assert case_region_names(tmp_path) == ["air", "aluminium_6061"]


@pytest.mark.parametrize(
    "regions",
    [
        "air",
        [{"name": "air"}],
        [{"name": "air", "role": "gas"}],
        [{"name": "1air", "role": "fluid"}],
        [{"name": "air;rm", "role": "fluid"}],
        [{"name": "polyMesh", "role": "fluid"}],
        [{"name": "processor0", "role": "solid"}],
        [{"name": f"r{i}", "role": "solid"} for i in range(33)],
    ],
)
def test_case_regions_that_are_not_valid(tmp_path: Path, regions: Any):
    _sidecar(tmp_path, regions=regions)
    assert _code(case_regions, tmp_path) == ("not_a_case", "w27-case.json: regions must be a list of {name, role}")


def test_a_region_listed_twice(tmp_path: Path):
    _sidecar(tmp_path, regions=[REGIONS[0], {"name": "air", "role": "solid"}])
    assert _code(case_regions, tmp_path) == ("not_a_case", "w27-case.json: region air is listed twice")


def test_regions_that_differ_only_in_case_are_one_folder(tmp_path: Path):
    """Air and air are one folder on Windows (NTFS): the gate, the scripts' list and
    every reader refuse them as one region listed twice."""
    _sidecar(tmp_path, regions=[{"name": "Air", "role": "fluid"}, {"name": "air", "role": "solid"}])
    assert _code(case_regions, tmp_path) == (
        "not_a_case",
        "w27-case.json: regions Air and air differ only in case (one folder on Windows)",
    )
    with pytest.raises(ValueError, match="listed twice"):
        regions_word_list(["Air", "air"])
    from cfddesk.results.regions import case_regions as results_regions

    assert results_regions(tmp_path) == []


def test_extra_keys_in_a_region_row_are_ignored(tmp_path: Path):
    """RunInputs.mesh.regions rows carry {name, role, bodies, cells}: a writer that
    copies them as they are is not refused, and only name and role are kept."""
    rows = [{**REGIONS[0], "bodies": ["Body1"], "cells": 32}, {**REGIONS[1], "bodies": ["Body2"], "cells": 32}]
    _sidecar(tmp_path, regions=rows)
    assert case_regions(tmp_path) == REGIONS


@pytest.mark.parametrize("text", ["\ufeff{\"regions\": []}", "{\"regions\": [", ""])
def test_an_unreadable_sidecar_lists_no_regions_outside_core_solves(tmp_path: Path, text: str):
    """A sidecar with a byte-order mark, half written or empty: a core solve's is
    refused (as before), any other case's lists no regions and its check goes on."""
    (tmp_path / "w27-case.json").write_bytes(text.encode("utf-8"))
    assert _code(case_regions, tmp_path) == ("not_a_case", "w27-case.json could not be read")
    assert case_regions(tmp_path, strict=False) == []
    case = write_cavity(tmp_path / "case")
    (case / "w27-case.json").write_bytes(text.encode("utf-8"))
    assert check_case_local(case, None, [{"tool": "blockMesh"}], None)["ok"] is True


def test_a_malformed_regions_key_is_not_judged_outside_core_solves(tmp_path: Path):
    """A case that is not a core solve's (a plugin case, a meshing plan) may have a
    sidecar with a regions key of its own: it has no regions then, and only a step
    that needs them (-region, -allRegions) is refused. A core solve's is refused."""
    case = write_cavity(tmp_path / "case")
    (case / "constant" / "polyMesh").mkdir(parents=True, exist_ok=True)
    _sidecar(case, regions="air")
    assert check_case_local(case, None, [{"tool": "blockMesh"}], None)["ok"] is True
    assert _code(check_case_local, case, None, [{"tool": "checkMesh", "args": ["-region", "air"]}], None)[1] == (
        "Step 1 (checkMesh): the case lists no regions (w27-case.json regions)"
    )
    assert _code(case_regions, case) == ("not_a_case", "w27-case.json: regions must be a list of {name, role}")


def test_one_name_rule_for_the_runner_and_the_results(tmp_path: Path):
    """The runner and the results read regions by one function: a list one refuses
    the other shows as no regions."""
    from cfddesk.results.regions import case_regions as results_regions

    for rows in (
        [{"name": "g", "role": "fluid"}],
        [{"name": "fvSchemes", "role": "solid"}],
        [{"name": "Processor1", "role": "solid"}],
        [{"name": f"r{i}", "role": "solid"} for i in range(33)],
        [{"name": "Air", "role": "fluid"}, {"name": "air", "role": "solid"}],
    ):
        _sidecar(tmp_path, regions=rows)
        assert _code(case_regions, tmp_path)[0] == "not_a_case"
        assert results_regions(tmp_path) == []
    _sidecar(tmp_path, regions=REGIONS)
    assert results_regions(tmp_path) == REGIONS == case_regions(tmp_path)


def test_a_region_named_as_a_file_of_the_case(tmp_path: Path):
    """A region is a folder in constant/, system/ and 0/: one named as a file there
    (in any case) is refused for a core solve, and is no region elsewhere."""
    case = write_cavity(tmp_path / "case")
    (case / "system" / "Heat").write_text("x", encoding="utf-8")
    _sidecar(case, regions=[{"name": "heat", "role": "fluid"}])
    assert _code(case_regions, case) == ("not_a_case", "w27-case.json: a region is named as the case's file system/Heat")
    assert case_regions(case, strict=False) == []
    # A folder of that name is the region's own.
    (case / "system" / "Heat").unlink()
    (case / "system" / "heat").mkdir()
    assert case_region_names(case) == ["heat"]


def test_region_names_from_long_or_equal_material_names_end():
    """Materials whose names make the same long word (63, 64, 80 characters): each
    gets its own name of at most 64 characters, and the search always ends."""
    from cfddesk.project.regions import region_name

    for length in (62, 63, 64, 80):
        taken: set[str] = set()
        names = [region_name("a" * length, taken) for _ in range(12)]
        assert len(set(names)) == 12, names
        assert all(region_name_ok(n) and len(n) <= 64 for n in names), names
        assert names[1].endswith("_2") and names[11].endswith("_12")
    taken = set()
    assert [region_name(n, taken) for n in ("Constant", "VTK", "postProcessing", "Lagrangian")] == [
        "r_constant", "r_vtk", "r_postprocessing", "r_lagrangian"
    ]


@pytest.mark.parametrize(
    "name",
    ["constant", "System", "lagrangian", "vtk", "postProcessing", "dynamicCode", "MRFProperties",
     "thermophysicalTransport", "combustionProperties"],
)
def test_case_folder_and_dictionary_names_are_not_regions(tmp_path: Path, name: str):
    assert not region_name_ok(name)
    _sidecar(tmp_path, regions=[{"name": name, "role": "fluid"}])
    assert _code(case_regions, tmp_path)[0] == "not_a_case"


def test_region_properties_without_sidecar_regions_is_refused(tmp_path: Path):
    """A case with constant/regionProperties but no regions read from w27-case.json
    (none listed, or a list the runner does not take): a solver run is refused in
    plain words instead of running it as one region."""
    case = write_cavity(tmp_path / "case")
    (case / "constant" / "polyMesh").mkdir(parents=True, exist_ok=True)
    (case / "constant" / "regionProperties").write_text("regions ( fluid (air) solid () );\n", encoding="utf-8")
    want = (
        "not_a_case",
        "constant/regionProperties is there, but w27-case.json lists no regions (a multi-region case lists them in its regions)",
    )
    assert _code(check_case_local, case, "pimpleFoam", [], None) == want
    _sidecar(case, regions="air")
    assert _code(check_case_local, case, "pimpleFoam", [], None) == want
    # No solver (a meshing plan): not read.
    assert check_case_local(case, None, [{"tool": "blockMesh"}], None)["ok"] is True
    # Listed: the regionProperties rule applies.
    _sidecar(case, regions=[REGIONS[0]])
    assert check_case_local(case, "pimpleFoam", [], None)["ok"] is True


def test_the_mesh_never_names_a_region_as_a_case_file():
    from cfddesk.project.regions import region_name

    taken: set[str] = set()
    names = [region_name(n, taken) for n in ("G", "fvSchemes", "Processor A", "Air", "air", "x" * 80)]
    assert names[:5] == ["r_g", "r_fvschemes", "r_processor_a", "air", "air_2"]
    assert all(region_name_ok(n) for n in names)


def test_region_properties_must_list_the_case_regions(tmp_path: Path):
    """-allRegions and the solver read constant/regionProperties, not the sidecar:
    it must list the same regions with the same roles."""
    case = write_cavity(tmp_path / "case")
    (case / "constant" / "polyMesh").mkdir(parents=True, exist_ok=True)
    _sidecar(case, regions=REGIONS)
    rp = case / "constant" / "regionProperties"
    assert _code(check_case_local, case, "pimpleFoam", [], None) == (
        "not_a_case",
        "constant/regionProperties is missing or has no regions entry (the case lists regions in w27-case.json)",
    )
    rp.write_text("// x\nregions ( fluid (air) solid (copper) );\n", encoding="utf-8")
    assert _code(check_case_local, case, "pimpleFoam", [], None)[1] == (
        "constant/regionProperties does not list the case's regions: air (fluid) aluminium_6061 (solid)"
    )
    rp.write_text("regions\n(\n    fluid (air)\n    solid (aluminium_6061)\n);\n", encoding="utf-8")
    assert check_case_local(case, "pimpleFoam", [], None)["ok"] is True
    # Roles count too.
    rp.write_text("regions ( fluid (air aluminium_6061) solid () );\n", encoding="utf-8")
    assert _code(check_case_local, case, "pimpleFoam", [], None)[0] == "not_a_case"
    # A plan without a solver or -allRegions does not read it.
    rp.unlink()
    assert check_case_local(case, None, [{"tool": "checkMesh", "args": ["-region", "air"]}], None)["ok"] is True
    assert _code(check_case_local, case, None, [{"tool": "checkMesh", "args": ["-allRegions"]}], None)[0] == "not_a_case"


def test_region_names():
    assert region_name_ok("air") and region_name_ok("Heat_sink2")
    for bad in ("", "2a", "a-b", "a b", "uniform", "cellToRegion", "processor1", "a" * 65, None, 3):
        assert not region_name_ok(bad)


# ---------------------------------------------------------------------------
# -region <name> in the steps
# ---------------------------------------------------------------------------


def test_region_values_against_the_case_regions():
    steps = [{"tool": "changeDictionary", "args": ["-region", "air"]}]
    assert check_steps(steps, ["air", "solid"])[0]["args"] == ["-region", "air"]
    assert _code(check_steps, steps, ["solid"]) == ("pre_not_allowed", "Step 1 (changeDictionary): air is not one of the case's regions")
    assert _code(check_steps, steps, []) == (
        "pre_not_allowed",
        "Step 1 (changeDictionary): the case lists no regions (w27-case.json regions)",
    )
    # Not known yet (the writer has not run): the form only.
    assert check_steps(steps)[0]["args"] == ["-region", "air"]


@pytest.mark.parametrize("tool", ["changeDictionary", "createPatch"])
def test_region_edits_cannot_run_in_parallel(tool: str):
    """Their -region edits land in processor*/0/<region>: reconstructParMesh brings
    back the mesh only, so they would be lost."""
    steps = [{"tool": "decomposePar"}, {"tool": tool, "args": ["-region", "air"], "parallel": True}, {"tool": "reconstructParMesh"}]
    assert _code(check_steps, steps, ["air"]) == (
        "pre_not_allowed",
        f"Step 2 ({tool}): with -region it runs serially only (reconstructParMesh brings back only the mesh)",
    )
    serial = [{"tool": tool, "args": ["-region", "air"]}]
    assert check_steps(serial, ["air"])[0]["parallel"] is False


@pytest.mark.parametrize("tool", ["decomposePar", "reconstructParMesh", "checkMesh"])
def test_all_regions_needs_the_case_regions(tool: str):
    steps = [{"tool": "decomposePar"}, {"tool": "reconstructParMesh"}] if tool != "checkMesh" else []
    at = {"decomposePar": 0, "reconstructParMesh": 1}.get(tool)
    if at is None:
        steps = [{"tool": tool, "args": ["-allRegions"]}]
        at = 0
    else:
        steps[at]["args"] = ["-allRegions"]
    assert "-allRegions" in check_steps(steps, ["air", "solid"])[at]["args"]
    # Not known yet (the writer has not run): allowed until they are.
    assert "-allRegions" in check_steps(steps)[at]["args"]
    assert _code(check_steps, steps, []) == (
        "pre_not_allowed",
        f"Step {at + 1} ({tool}): -allRegions needs the case's regions (w27-case.json regions)",
    )


def _case(tmp_path: Path) -> Path:
    case = write_cavity(tmp_path / "case")
    return case


def test_check_case_reads_the_regions_and_each_regions_dictionary(tmp_path: Path):
    case = _case(tmp_path)
    pre = [{"tool": "blockMesh"}, {"tool": "changeDictionary", "args": ["-region", "air"]}]
    # No regions listed: -region names none of them.
    assert _code(check_case_local, case, None, pre, None) == (
        "not_a_case",
        "system/air/changeDictionaryDict is missing (step 2, changeDictionary needs it)",
    )
    (case / "system" / "air").mkdir()
    (case / "system" / "air" / "changeDictionaryDict").write_text("x", encoding="utf-8")
    assert _code(check_case_local, case, None, pre, None)[1] == (
        "Step 2 (changeDictionary): the case lists no regions (w27-case.json regions)"
    )
    _sidecar(case, regions=REGIONS)
    out = check_case_local(case, None, pre, None)
    assert out["steps"][1] == {"tool": "changeDictionary", "args": ["-region", "air"], "parallel": False}
    _sidecar(case, regions=[REGIONS[1]])
    assert _code(check_case_local, case, None, pre, None)[1] == "Step 2 (changeDictionary): air is not one of the case's regions"
    # A regions key that is not valid: no regions (only a core solve's is judged).
    _sidecar(case, regions="air")
    assert _code(check_case_local, case, None, pre, None)[1] == (
        "Step 2 (changeDictionary): the case lists no regions (w27-case.json regions)"
    )


def test_frame_fields_of_a_multi_region_case(tmp_path: Path):
    case = tmp_path
    for region, fields in (("air", ("T", "U")), ("aluminium_6061", ("T",))):
        (case / "0" / region).mkdir(parents=True)
        for f in fields:
            (case / "0" / region / f).write_text("x", encoding="utf-8")
    names = ["air", "aluminium_6061"]
    out = check_results({"kinematicFields": [], "frameFields": ["T", "U"]}, case, names)
    assert out["frame_fields"] == ["T", "U"]
    with pytest.raises(FoamCaseError) as err:
        check_results({"kinematicFields": [], "frameFields": ["p"]}, case, names)
    assert err.value.error == "results.frameFields: 0/<region>/p is not in the case"
    with pytest.raises(FoamCaseError) as err:
        check_results({"kinematicFields": [], "frameFields": ["T"]}, case)
    assert err.value.error == "results.frameFields: 0/T is not in the case"


def test_frame_fields_the_solid_has_none_of_are_refused(tmp_path: Path):
    """frameFields U and p_rgh are the fluid's only: solve.sh would count no saved
    time as a frame (each needs one in every region), the run would end "done" with
    no results. The gate says which region has none."""
    case = tmp_path
    for region, fields in (("air", ("T", "U", "p_rgh")), ("aluminium_6061", ("T", "p"))):
        (case / "0" / region).mkdir(parents=True)
        for f in fields:
            (case / "0" / region / f).write_text("x", encoding="utf-8")
    names = ["air", "aluminium_6061"]
    with pytest.raises(FoamCaseError) as err:
        check_results({"kinematicFields": [], "frameFields": ["U", "p_rgh"]}, case, names)
    assert err.value.code == "bad_request"
    assert err.value.error == (
        "results.frameFields: 0/aluminium_6061/ holds none of the frame fields (U, p_rgh): "
        "a saved time needs one in every region"
    )
    assert region_without_frame_field(case, ["U", "p_rgh"], names) == "aluminium_6061"
    assert region_without_frame_field(case, ["U", "T"], names) is None
    assert region_frame_problem(case, ["T"], names) is None
    # One region: the rule is the one it always was (the field in 0/).
    assert region_without_frame_field(case, ["U"], []) is None


def test_the_legacy_frame_fields_follow_the_region_rule_too(tmp_path: Path):
    """No frameFields (a case before API 1.1): U and p. A solid with neither (its
    p not written) is refused as the explicit list is."""
    case = tmp_path
    for region, fields in (("air", ("U", "p")), ("aluminium_6061", ("T",))):
        (case / "0" / region).mkdir(parents=True)
        for f in fields:
            (case / "0" / region / f).write_text("x", encoding="utf-8")
    names = ["air", "aluminium_6061"]
    with pytest.raises(FoamCaseError) as err:
        check_results({"kinematicFields": []}, case, names)
    assert err.value.error == (
        "results.frameFields: 0/aluminium_6061/ holds none of the frame fields (U, p): a saved time needs one in every region"
    )
    (case / "0" / "aluminium_6061" / "p").write_text("x", encoding="utf-8")
    assert check_results({"kinematicFields": []}, case, names)["frame_fields"] == ["U", "p"]


# ---------------------------------------------------------------------------
# Rendering
# ---------------------------------------------------------------------------


def test_render_with_regions():
    kw = {"dst": "/d/cfddesk-x", "win_out": "/w", "token": "0a1b2c3d", "n_procs": 1,
          "steps": check_steps([{"tool": "splitMeshRegions", "args": ["-cellZones"]}])}
    assert 'REGIONS=""' in render_foam_pre(**kw)
    text = render_foam_pre(**kw, regions=["air", "aluminium_6061"])
    assert 'REGIONS="air aluminium_6061"' in text and "__REGIONS__" not in text
    assert "STEP_1=(splitMeshRegions -cellZones -overwrite)" in text
    for bad in (["a b"], ["$(x)"], ["air", "air"]):
        with pytest.raises(ValueError):
            render_foam_pre(**kw, regions=bad)
    skw = {"dst": "/d", "win_out": "/w", "n_procs": 2, "run_id": "r1", "app": "chtMultiRegionSimpleFoam", "frame_fields": ("T",)}
    assert 'REGIONS=""' in render_solve_script(**skw)
    body = render_solve_script(**skw, regions=("air", "aluminium_6061"))
    assert 'REGIONS="air aluminium_6061"' in body and "__REGIONS__" not in body
    with pytest.raises(ValueError):
        render_solve_script(**skw, regions=("a'b",))


# ---------------------------------------------------------------------------
# foam_pre.sh and solve.sh in bash, with a stand-in OpenFOAM
# ---------------------------------------------------------------------------

needs_bash = pytest.mark.skipif(BASH is None, reason="needs a POSIX bash")

# foam_pre.sh runs `openfoam2606 <tool> <args>`; solve.sh runs `openfoam2606 bash -c "cd '<case>' && <cmd>"`.
STAND_IN = r"""#!/usr/bin/env bash
if [ "$1" != "bash" ]; then
  echo "$*" >> "$CALLS"
  case "$1" in
    splitMeshRegions)
      for g in $RG; do
        mkdir -p "constant/$g/polyMesh" "system/$g" "0/$g"
        echo "$g mesh" > "constant/$g/polyMesh/owner"
        [ -f "system/$g/fvSchemes" ] || echo dummy > "system/$g/fvSchemes"
        echo c > "0/$g/cellToRegion"
      done
      echo c > constant/cellToRegion; echo c > 0/cellToRegion ;;
  esac
  exit 0
fi
cmd="$3"
echo "$cmd" >> "$CALLS"
cd "$(echo "$cmd" | sed -E "s/^cd '([^']*)'.*/\1/")" || exit 9
times() {
  for d in "$1"/[0-9]*; do [ -d "$d" ] && basename "$d"; done | sort -g
}
latest_in() { times "$1" | tail -n 1; }
write_time() {  # write_time <folder>: T in every region, U in the fluid (one region: T and U)
  if [ -z "$RG" ]; then mkdir -p "$1"; echo "T $1" > "$1/T"; echo "U $1" > "$1/U"; return; fi
  for g in $RG; do mkdir -p "$1/$g"; echo "T $1" > "$1/$g/T"; done
  echo "U $1" > "$1/air/U"
}
case "$cmd" in
  *decomposePar*)
    rm -rf processor*
    for r in $(seq 0 $((NP - 1))); do
      for g in $RG; do [ -f "system/$g/decomposeParDict" ] || echo "no system/$g/decomposeParDict" >> "$CALLS"; done
      mkdir -p "processor$r/constant"
      if [[ "$cmd" == *-latestTime* ]]; then list=$(latest_in .); else list=$(times .); fi
      for t in $list; do cp -r "$t" "processor$r/$t"; done
      echo "processor$r: $(echo $list)" >> "$CALLS.decomposed"
    done ;;
  *mpirun*)
    [ -n "${NOWRITE:-}" ] && exit 0
    t=$(latest_in processor0)
    for k in 1 2 3; do
      [ "$k" = 3 ] && [ -z "${SLOW:-}" ] && break
      n=$((t + k))
      for r in $(seq 0 $((NP - 1))); do write_time "processor$r/$n"; done
      echo "Time = $n"
      # Slow: the live sync (every 2 s) rebuilds the finished frames meanwhile.
      [ -n "${SLOW:-}" ] && [ "$k" = 2 ] && sleep 5
    done ;;
  *reconstructPar*)
    only=""
    if [[ "$cmd" == *"-time '"* ]]; then only=$(echo "$cmd" | sed -E "s/.*-time '([^']*)'.*/\1/" | tr ',' ' '); fi
    for t in $(times processor0); do
      [ "$t" = "0" ] && continue
      if [ -n "$only" ] && [[ " $only " != *" $t "* ]]; then continue; fi
      if [ -n "$only" ] && [ -n "${HALF_LIVE:-}" ]; then
        # A live rebuild cut short: one region's field only.
        mkdir -p "$t/air"; cp "processor0/$t/air/T" "$t/air/T"; continue
      fi
      [ -d "$t" ] || cp -r "processor0/$t" "$t"
    done ;;
  *)
    [ -n "${NOWRITE:-}" ] && exit 0
    t=$(latest_in .)
    for k in 1 2; do n=$((t + k)); write_time "$n"; echo "Time = $n"; done
    # A time only one region wrote is not a frame.
    if [ -n "${PARTIAL:-}" ]; then mkdir -p 9/air; echo "T" > 9/air/T; fi ;;
esac
exit 0
"""


def _bin(tmp_path: Path) -> str:
    stub = tmp_path / "bin"
    stub.mkdir(exist_ok=True)
    (stub / "openfoam2606").write_bytes(STAND_IN.encode("utf-8"))
    (stub / "openfoam2606").chmod(0o755)
    bin_dir = _posix(stub)
    if re.match(r"^[A-Za-z]:/", bin_dir):
        bin_dir = "/" + bin_dir[0].lower() + bin_dir[2:]
    return bin_dir


def _bash(tmp_path: Path, script: Path, env: dict[str, str]) -> subprocess.CompletedProcess:
    assert BASH is not None
    return subprocess.run(
        [BASH, "-c", f'PATH="{_bin(tmp_path)}:$PATH" exec bash "{_posix(script)}"'],
        stdin=subprocess.DEVNULL, capture_output=True, text=True, env={**os.environ, **env}, timeout=120,
    )


def _events(out: str) -> list[dict[str, Any]]:
    return [json.loads(line.split(" ", 1)[1]) for line in out.splitlines() if line.startswith("MAGNUSIM_EVENT ")]


RG = "air aluminium_6061"


@needs_bash
def test_foam_pre_brings_each_region_back(tmp_path: Path):
    win = tmp_path / "case"
    (win / "constant" / "polyMesh").mkdir(parents=True)
    (win / "constant" / "polyMesh" / "owner").write_text("unsplit\n", encoding="utf-8")
    (win / "constant" / "air").mkdir()
    (win / "constant" / "air" / "thermophysicalProperties").write_text("air thermo\n", encoding="utf-8")
    (win / "system" / "air").mkdir(parents=True)
    (win / "system" / "air" / "fvSchemes").write_text("written\n", encoding="utf-8")
    (win / "system" / "controlDict").write_text("x\n", encoding="utf-8")
    (win / "0" / "air").mkdir(parents=True)
    (win / "0" / "air" / "T").write_text("air T\n", encoding="utf-8")
    calls = tmp_path / "calls.txt"
    script = tmp_path / "pre.sh"
    script.write_bytes(render_foam_pre(
        dst=_posix(tmp_path / "wsl" / "cfddesk-pf-x-0a1b2c3d"), win_out=_posix(win), token="0a1b2c3d", n_procs=1,
        steps=check_steps([{"tool": "splitMeshRegions", "args": ["-cellZones"]}]), regions=RG.split(),
    ).encode("utf-8"))
    proc = _bash(tmp_path, script, {"CALLS": _posix(calls), "RG": RG})
    assert proc.returncode == 0, proc.stdout + proc.stderr
    assert _events(proc.stdout)[-1] == {**_events(proc.stdout)[-1], "event": "result", "ok": True}
    assert calls.read_text(encoding="utf-8").splitlines() == ["splitMeshRegions -cellZones -overwrite"]
    for g in RG.split():
        assert (win / "constant" / g / "polyMesh" / "owner").read_text(encoding="utf-8") == f"{g} mesh\n"
        assert not (win / "0" / g / "cellToRegion").exists()
    # No step writes system/<region>/: only what the writer put there is there.
    assert not (win / "system" / "aluminium_6061").exists()
    # What the writer put there stays; the unsplit mesh stays.
    assert (win / "constant" / "air" / "thermophysicalProperties").read_text(encoding="utf-8") == "air thermo\n"
    assert (win / "system" / "air" / "fvSchemes").read_text(encoding="utf-8") == "written\n"
    assert (win / "0" / "air" / "T").read_text(encoding="utf-8") == "air T\n"
    assert (win / "constant" / "polyMesh" / "owner").read_text(encoding="utf-8") == "unsplit\n"
    assert not (win / "0" / "cellToRegion").exists() and not (win / "constant" / "cellToRegion").exists()
    assert not list(win.rglob(".magnusim-*.part"))


def _seed_regions(win: Path) -> None:
    for g in RG.split():
        (win / "constant" / g / "polyMesh").mkdir(parents=True)
        (win / "0" / g).mkdir(parents=True)
        (win / "0" / g / "T").write_text("T 0\n", encoding="utf-8")
        (win / "system" / g).mkdir(parents=True)
        (win / "system" / g / "decomposeParDict").write_text("n\n", encoding="utf-8")
    (win / "0" / "air" / "U").write_text("U 0\n", encoding="utf-8")
    (win / "constant" / "polyMesh").mkdir(parents=True)


def _solve(tmp_path: Path, win: Path, *, n_procs: int, keep: str = "all", tag: str = "s", frames: tuple[str, ...] = ("T", "U"),
           rg: str = RG, restart: bool = False, **env: str) -> tuple[subprocess.CompletedProcess, list[str]]:
    calls = tmp_path / f"calls-{tag}.txt"
    script = tmp_path / f"solve-{tag}.sh"
    script.write_bytes(render_solve_script(
        dst=_posix(tmp_path / "wsl" / f"cfddesk-w27-{tag}"), win_out=_posix(win), n_procs=n_procs,
        app="chtMultiRegionSimpleFoam", run_id=tag, keep_frames=keep, frame_fields=frames, regions=rg.split(),
        restart=restart,
    ).encode("utf-8"))
    proc = _bash(tmp_path, script, {"CALLS": _posix(calls), "RG": rg, "NP": str(n_procs), **env})
    return proc, calls.read_text(encoding="utf-8").splitlines() if calls.is_file() else []


def _tools(calls: list[str]) -> list[str]:
    return [c.split("&& ", 1)[1] for c in calls if "&& " in c]


@needs_bash
@pytest.mark.parametrize("n_procs", [1, 2])
def test_a_multi_region_solve_brings_back_every_regions_frames(tmp_path: Path, n_procs: int):
    win = tmp_path / "case"
    _seed_regions(win)
    proc, calls = _solve(tmp_path, win, n_procs=n_procs, PARTIAL="1")
    assert proc.returncode == 0, proc.stdout + proc.stderr
    assert _events(proc.stdout)[-1]["ok"] is True
    for t in ("1", "2"):
        for g in RG.split():
            assert (win / t / g / "T").read_text(encoding="utf-8") .startswith("T ")
        assert (win / t / "air" / "U").is_file() and not (win / t / "aluminium_6061" / "U").exists()
    tools = [c.split("&& ", 1)[1] for c in calls if "&& " in c]
    if n_procs > 1:
        assert "decomposePar -allRegions -force" in tools
        assert "reconstructPar -allRegions -noZero -newTimes" in tools
        assert not [c for c in calls if c.startswith("no system/")]
    else:
        assert not any("decomposePar" in c or "reconstructPar" in c for c in tools)
        # A time only one region wrote never reaches Windows.
        assert not (win / "9").exists()


@needs_bash
def test_a_steady_multi_region_solve_keeps_the_latest_frame(tmp_path: Path):
    win = tmp_path / "case"
    _seed_regions(win)
    proc, calls = _solve(tmp_path, win, n_procs=2, keep="latest", tag="l")
    assert proc.returncode == 0, proc.stdout + proc.stderr
    assert "reconstructPar -allRegions -latestTime" in [c.split("&& ", 1)[1] for c in calls if "&& " in c]
    assert (win / "2" / "aluminium_6061" / "T").is_file()


@needs_bash
def test_a_region_without_its_mesh_stops_the_solve(tmp_path: Path):
    win = tmp_path / "case"
    _seed_regions(win)
    (win / "constant" / "aluminium_6061" / "polyMesh").rmdir()
    proc, calls = _solve(tmp_path, win, n_procs=1, tag="m")
    assert proc.returncode == 46
    evs = _events(proc.stdout)
    assert {"event": "error", "code": 46, "error": f"missing constant/aluminium_6061/polyMesh in {_posix(win)}"} in evs
    assert calls == []


# ---------------------------------------------------------------------------
# The relay
# ---------------------------------------------------------------------------

REGION_TOOL = """import json, os
from pathlib import Path
case = Path(os.environ['MAGNUSIM_CASE_DIR'])
doc = json.loads(os.environ['FAKE_SIDECAR'])
(case / 'w27-case.json').write_text(json.dumps(doc))
# Each region's start fields (p in every region by default, as a CHT case has).
zero = json.loads(os.environ.get('FAKE_ZERO') or 'null')
rows = doc.get('regions') if isinstance(doc.get('regions'), list) else []
# constant/regionProperties as the writer lists its regions (or FAKE_REGION_PROPERTIES).
roles = {'fluid': [], 'solid': []}
for row in rows:
    if isinstance(row, dict) and row.get('role') in roles and isinstance(row.get('name'), str):
        roles[row['role']].append(row['name'])
rp = os.environ.get('FAKE_REGION_PROPERTIES') or 'regions ( fluid (%s) solid (%s) );' % (' '.join(roles['fluid']), ' '.join(roles['solid']))
if rows:
    (case / 'constant').mkdir(parents=True, exist_ok=True)
    (case / 'constant' / 'regionProperties').write_text(rp)
for row in rows:
    name = row.get('name') if isinstance(row, dict) else None
    if not isinstance(name, str) or '/' in name or ' ' in name:
        continue
    for field in (zero or {}).get(name, ['p']):
        (case / '0' / name).mkdir(parents=True, exist_ok=True)
        (case / '0' / name / field).write_text('x')
"""


def _region_run(tmp_path: Path, monkeypatch: pytest.MonkeyPatch, sidecar: dict[str, Any], *, n_procs: int = 1,
                zero: dict[str, list[str]] | None = None, solver: dict[str, Any] | None = None,
                seed: Any = None, pre: list[str] | None = None,
                pre_code: int = 0) -> tuple[int, list[dict[str, Any]], Recorder, SimpleNamespace]:
    tools = tmp_path / "tools"
    tools.mkdir()
    (tools / "fake_prepare.py").write_text(REGION_TOOL, encoding="utf-8")
    monkeypatch.setattr(foam_relay, "PY_TOOLS", tools)
    monkeypatch.setenv("FAKE_SIDECAR", json.dumps(sidecar))
    monkeypatch.setenv("FAKE_ZERO", json.dumps(zero))
    hub = FakeSolveHub(jobs={"solve.prepare": ("builtin", SimpleNamespace(tool="fake_prepare.py", python="core"))})
    r = make_solve_run(tmp_path)
    if seed is not None:
        seed(r.case)
    rec = Recorder(pre=pre if pre is not None else [
        evt(event="stage", stage="pre_copy_in", t_wall=100.0),
        evt(event="pre", tool="splitMeshRegions", index=1, exit_code=0, parallel=False, n_procs=1),
        evt(event="result", ok=True, exit_code=0, t_wall=101.5),
    ], pre_code=pre_code)
    deps, _ = solve_deps(rec, hub)
    prepare = {**_builtin_shape(), "env": {"MAGNUSIM_PLUGIN_KEY": "builtin", "MAGNUSIM_JOB_ID": JOB, "MAGNUSIM_CASE_DIR": str(r.case)}}
    extra = {"solver": solver} if solver is not None else {}
    code, evs = run(make_solve_spec(r, prepare=prepare, n_procs=n_procs, **extra), r.root, deps)
    return code, evs, rec, r


SPLIT = [{"tool": "splitMeshRegions", "args": ["-cellZones", "-overwrite"]}]


def test_the_relay_hands_the_regions_to_both_scripts(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    seen: dict[str, Any] = {}
    real = foam_relay.render_foam_pre

    def spy(**kw: Any) -> str:
        seen.update(kw)
        return real(**kw)

    monkeypatch.setattr(foam_relay, "render_foam_pre", spy)
    code, evs, rec, r = _region_run(tmp_path, monkeypatch, {"pre_steps": SPLIT, "regions": REGIONS}, n_procs=2)
    assert code == 0, evs
    assert seen["regions"] == ["air", "aluminium_6061"]
    (_n, kw), = [c for c in rec.calls if c[0] == "start_solve"]
    assert kw["regions"] == ("air", "aluminium_6061")
    # n > 1: every region has its own decomposeParDict, as decomposePar -allRegions needs.
    for g in ("air", "aluminium_6061"):
        assert "numberOfSubdomains 2;" in (r.case / "system" / g / "decomposeParDict").read_text(encoding="utf-8")


def test_a_case_of_one_region_passes_no_regions(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    code, evs, rec, r = _region_run(tmp_path, monkeypatch, {"pre_steps": SPLIT}, n_procs=2)
    assert code == 0, evs
    (_n, kw), = [c for c in rec.calls if c[0] == "start_solve"]
    assert "regions" not in kw
    assert not [p for p in (r.case / "system").iterdir() if p.is_dir()]


def test_a_region_step_must_name_a_listed_region(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    steps = [*SPLIT, {"tool": "checkMesh", "args": ["-region", "copper"]}]
    code, evs, rec, _r = _region_run(tmp_path, monkeypatch, {"pre_steps": steps, "regions": REGIONS})
    assert code == 2
    assert {"event": "refused", "code": "pre_not_allowed", "error": "Step 2 (checkMesh): copper is not one of the case's regions"} in evs
    assert "start_solve" not in rec.names()


def test_a_core_solve_whose_frame_fields_miss_a_region_is_refused(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    """The solver's frame fields (U, p) are in no file of the solid's 0/: refused
    before the solver (after the steps, which may write 0/<region>/), the WSL copy of
    the steps removed, nothing solved."""
    zero = {"air": ["U", "p"], "aluminium_6061": ["T"]}
    code, evs, rec, _r = _region_run(tmp_path, monkeypatch, {"pre_steps": SPLIT, "regions": REGIONS}, zero=zero)
    assert code == 2
    assert {
        "event": "refused",
        "code": "not_a_case",
        "error": "0/aluminium_6061/ holds none of the frame fields (U, p): a saved time needs one in every region",
    } in evs
    assert "start_solve" not in rec.names()
    assert rec.names().count("remove_case") == 1


def _saved_times(case: Path) -> None:
    """A run that solved to 3 on the split mesh: every region's mesh and fields back."""
    for g in ("air", "aluminium_6061"):
        (case / "constant" / g / "polyMesh").mkdir(parents=True)
        (case / "3" / g).mkdir(parents=True)
        (case / "3" / g / "p").write_text("x", encoding="utf-8")
    (case / "log.pimpleFoam").write_text("Time = 3\n", encoding="utf-8")


def test_a_continued_multi_region_run_skips_its_pre_steps(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    """Continue (solver.restart) of a case whose sidecar still names its split: the
    split mesh is already back and its saved times are on it, so its pre_steps do
    not run (they would refuse the case for its saved times, or redo the split);
    the solve starts in restart mode with the regions."""
    from tests.unit.test_h15_relay import SOLVER

    sidecar = {"pre_steps": SPLIT, "regions": REGIONS}
    code, evs, rec, _r = _region_run(
        tmp_path, monkeypatch, sidecar, solver={**SOLVER, "analysis": "flow_steady", "restart": True}, seed=_saved_times
    )
    assert code == 0, evs
    assert not [e for e in evs if e.get("event") == "refused"]
    assert not [argv for name, argv in rec.calls if name == "popen" and argv[:1] == ["wsl"]]
    (_n, kw), = [c for c in rec.calls if c[0] == "start_solve"]
    assert kw["restart"] is True and kw["regions"] == ("air", "aluminium_6061")


def test_a_fresh_multi_region_run_still_runs_its_pre_steps(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    code, evs, rec, _r = _region_run(tmp_path, monkeypatch, {"pre_steps": SPLIT, "regions": REGIONS})
    assert code == 0, evs
    assert len([argv for name, argv in rec.calls if name == "popen" and argv[:1] == ["wsl"]]) == 1
    (_n, kw), = [c for c in rec.calls if c[0] == "start_solve"]
    assert "restart" not in kw


def test_bad_regions_are_refused_before_wsl(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    code, evs, rec, _r = _region_run(tmp_path, monkeypatch, {"pre_steps": SPLIT, "regions": [{"name": "a b", "role": "fluid"}]})
    assert code == 2
    assert {"event": "refused", "code": "not_a_case", "error": "w27-case.json: regions must be a list of {name, role}"} in evs
    assert not [argv for name, argv in rec.calls if name == "popen" and argv[:1] == ["wsl"]]


# ---------------------------------------------------------------------------
# Review fixes: the scripts in bash
# ---------------------------------------------------------------------------


def _wsl_left(tmp_path: Path, tag: str) -> bool:
    return (tmp_path / "wsl" / f"cfddesk-w27-{tag}").exists()


@needs_bash
def test_solve_sh_keeps_the_wsl_case_when_no_frame_came_back(tmp_path: Path):
    """frameFields U only (the fluid's): no saved time has a frame field in every
    region, so none comes back to Windows. The ext4 copy holds the only results: it
    stays (the server's sweep removes it a day later), with a warning."""
    win = tmp_path / "case"
    _seed_regions(win)
    proc, _calls = _solve(tmp_path, win, n_procs=1, keep="latest", tag="u", frames=("U",))
    assert proc.returncode == 0, proc.stdout + proc.stderr
    evs = _events(proc.stdout)
    assert not (win / "2").exists()
    assert _wsl_left(tmp_path, "u"), "the only results were deleted"
    assert (tmp_path / "wsl" / "cfddesk-w27-u" / "2" / "aluminium_6061" / "T").is_file()
    assert {
        "event": "warning",
        "code": "frame_not_back",
        "message": "The latest saved time (2) did not come back to Windows (it lacks a frame field); the WSL copy of the case is kept",
    } in evs
    assert not [e for e in evs if e.get("stage") == "cleanup"]
    # T in every region: the frame comes back and the copy goes.
    win2 = tmp_path / "case2"
    _seed_regions(win2)
    proc, _calls = _solve(tmp_path, win2, n_procs=1, keep="latest", tag="t", frames=("T",))
    assert proc.returncode == 0, proc.stdout + proc.stderr
    assert (win2 / "2" / "aluminium_6061" / "T").is_file() and not _wsl_left(tmp_path, "t")
    assert "frame_not_back" not in proc.stdout


@needs_bash
def test_solve_sh_one_region_cleans_up_as_before(tmp_path: Path):
    win = tmp_path / "one"
    (win / "constant" / "polyMesh").mkdir(parents=True)
    (win / "0").mkdir()
    proc, _calls = _solve(tmp_path, win, n_procs=1, keep="latest", tag="o", rg="")
    assert proc.returncode == 0, proc.stdout + proc.stderr
    assert (win / "2" / "T").is_file() and not _wsl_left(tmp_path, "o")
    assert "frame_not_back" not in proc.stdout


def test_the_cleanup_needs_the_latest_frame_back():
    """The rendered script never removes the WSL copy unless the latest saved time
    came back as a frame (one region or several)."""
    for regions in ((), ("air", "solid")):
        body = render_solve_script(dst="/d/cfddesk-w27-r", win_out="/w", n_procs=1, app="simpleFoam", run_id="r",
                                   frame_fields=("U",), regions=regions)
        guard = 'if [ -n "$LATEST_SAVED" ] && ! _has_frame "$WIN_OUT/$LATEST_SAVED"; then\n  FRAME_BACK=0'
        assert guard in body
        cleanup = body.index('rm -rf -- "$DST"')
        gate = 'if [ "$EC" -eq 0 ] && [ "$COPY_OK" -eq 1 ] && [ "$FRAME_BACK" -eq 1 ]; then'
        assert body.index(guard) < body.rindex(gate, 0, cleanup)
        assert body.count('rm -rf -- "$DST"') == 1


@needs_bash
@pytest.mark.parametrize("rg", ["", RG])
@pytest.mark.parametrize("keep", ["all", "latest"])
def test_the_exact_commands_of_a_parallel_solve(tmp_path: Path, rg: str, keep: str):
    """n = 2: the commands bash runs. One region: the commands it always ran (no
    -allRegions anywhere in the script); several: each with -allRegions."""
    win = tmp_path / "case"
    if rg:
        _seed_regions(win)
    else:
        (win / "constant" / "polyMesh").mkdir(parents=True)
        (win / "0").mkdir()
    proc, calls = _solve(tmp_path, win, n_procs=2, keep=keep, tag="x", rg=rg)
    assert proc.returncode == 0, proc.stdout + proc.stderr
    flag = " -allRegions" if rg else ""
    recon = f"reconstructPar{flag} -noZero -newTimes" if keep == "all" else f"reconstructPar{flag} -latestTime"
    assert [t for t in _tools(calls) if "Par" in t and "-time" not in t] == [f"decomposePar{flag} -force", recon]
    if not rg:
        body = render_solve_script(dst="/d", win_out="/w", n_procs=2, app="simpleFoam", run_id="r", keep_frames=keep,
                                   frame_fields=("U", "p"))
        assert "allRegions" not in body


@needs_bash
def test_a_multi_region_restart_decomposes_the_latest_time_only(tmp_path: Path):
    win = tmp_path / "case"
    _seed_regions(win)
    for g in RG.split():
        (win / "5" / g).mkdir(parents=True)
        (win / "5" / g / "T").write_text("T 5\n", encoding="utf-8")
    (win / "log.chtMultiRegionSimpleFoam").write_text("part 1\n", encoding="utf-8")
    proc, calls = _solve(tmp_path, win, n_procs=2, keep="latest", tag="r", restart=True)
    assert proc.returncode == 0, proc.stdout + proc.stderr
    assert "decomposePar -allRegions -force -latestTime" in _tools(calls)
    assert (tmp_path / "calls-r.txt.decomposed").read_text(encoding="utf-8").splitlines() == ["processor0: 5", "processor1: 5"]
    assert (win / "7" / "aluminium_6061" / "T").is_file() and (win / "5" / "air" / "T").is_file()
    assert (win / "log.chtMultiRegionSimpleFoam.1").read_text(encoding="utf-8") == "part 1\n"


@needs_bash
def test_live_frames_and_a_half_rebuilt_frame(tmp_path: Path):
    """A parallel multi-region run: the live sync rebuilds finished frames with one
    reconstructPar -allRegions -noZero -time '<list>'; a frame it left half rebuilt
    (one region only) is removed before the last reconstructPar, which rebuilds it
    whole, so every frame reaches Windows in every region."""
    win = tmp_path / "case"
    _seed_regions(win)
    proc, calls = _solve(tmp_path, win, n_procs=2, keep="all", tag="h", SLOW="1", HALF_LIVE="1")
    assert proc.returncode == 0, proc.stdout + proc.stderr
    tools = _tools(calls)
    assert "reconstructPar -allRegions -noZero -time '1'" in tools
    assert tools[-1] == "reconstructPar -allRegions -noZero -newTimes"
    for t in ("1", "2", "3"):
        assert (win / t / "aluminium_6061" / "T").is_file() and (win / t / "air" / "U").is_file(), t


def _pre(tmp_path: Path, win: Path, regions: list[str], rg: str, tag: str) -> tuple[subprocess.CompletedProcess, list[dict[str, Any]]]:
    script = tmp_path / f"pre-{tag}.sh"
    script.write_bytes(render_foam_pre(
        dst=_posix(tmp_path / "wsl" / f"cfddesk-pf-x-0a1b2c3d-{tag}"), win_out=_posix(win), token="0a1b2c3d", n_procs=1,
        steps=check_steps([{"tool": "splitMeshRegions", "args": ["-cellZones"]}]), regions=regions,
    ).encode("utf-8"))
    proc = _bash(tmp_path, script, {"CALLS": _posix(tmp_path / f"calls-{tag}.txt"), "RG": rg})
    return proc, _events(proc.stdout)


def _unsplit(win: Path) -> None:
    (win / "constant" / "polyMesh").mkdir(parents=True)
    (win / "system").mkdir(parents=True)
    (win / "system" / "controlDict").write_text("x\n", encoding="utf-8")
    (win / "0").mkdir()


@needs_bash
def test_foam_pre_of_one_region_keeps_cell_to_region(tmp_path: Path):
    win = tmp_path / "case"
    _unsplit(win)
    proc, _evs = _pre(tmp_path, win, [], "", "o")
    assert proc.returncode == 0, proc.stdout + proc.stderr
    assert (win / "0" / "cellToRegion").is_file()


@needs_bash
def test_foam_pre_needs_every_listed_region_from_the_split(tmp_path: Path):
    """The split made air only (its cellZones named otherwise): exit 46 names the
    missing region, and a mesh of it from an earlier attempt is not taken for it."""
    win = tmp_path / "case"
    _unsplit(win)
    (win / "constant" / "aluminium_6061" / "polyMesh").mkdir(parents=True)
    (win / "constant" / "aluminium_6061" / "polyMesh" / "owner").write_text("stale\n", encoding="utf-8")
    proc, evs = _pre(tmp_path, win, RG.split(), "air", "m")
    assert proc.returncode == 46
    assert {
        "event": "error",
        "code": 46,
        "region": "aluminium_6061",
        "error": "The steps made no constant/aluminium_6061/polyMesh (the case lists region aluminium_6061)",
    } in evs
    assert evs[-1]["event"] == "result" and evs[-1]["ok"] is False
    assert evs[-1]["region"] == "aluminium_6061" and evs[-1]["exit_code"] == 46
    # Nothing came back.
    assert not (win / "constant" / "air").exists()
    # Both made: both come back, the stale one replaced.
    proc, evs = _pre(tmp_path, win, RG.split(), RG, "b")
    assert proc.returncode == 0, proc.stdout + proc.stderr
    assert (win / "constant" / "aluminium_6061" / "polyMesh" / "owner").read_text(encoding="utf-8") == "aluminium_6061 mesh\n"


def test_foam_pre_drops_the_region_meshes_before_a_split_only():
    kw = {"dst": "/d/cfddesk-x", "win_out": "/w", "token": "0a1b2c3d", "n_procs": 1, "regions": ["air"]}
    steps = check_steps([{"tool": "splitMeshRegions"}, {"tool": "checkMesh", "args": ["-region", "air"]}], ["air"])
    split = render_foam_pre(**kw, steps=steps)
    assert split.index("\n_drop_region_meshes\n") < split.index("STEP_1=(splitMeshRegions")
    assert split.count("\n_drop_region_meshes\n") == 1
    other = render_foam_pre(**kw, steps=check_steps([{"tool": "checkMesh", "args": ["-region", "air"]}], ["air"]))
    assert "\n_drop_region_meshes\n" not in other


# ---------------------------------------------------------------------------
# Review fixes: the relay
# ---------------------------------------------------------------------------


def test_the_relay_refuses_a_region_named_as_a_case_file(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    """n > 1 writes system/<region>/decomposeParDict: a region named as a file there
    is refused at the gate with its name, never a relay failure."""

    def seed(case: Path) -> None:
        (case / "system" / "mydict").write_text("x", encoding="utf-8")

    rows = [{"name": "mydict", "role": "fluid"}, REGIONS[1]]
    code, evs, rec, _r = _region_run(tmp_path, monkeypatch, {"pre_steps": SPLIT, "regions": rows}, n_procs=2, seed=seed)
    assert code == 2
    assert {"event": "refused", "code": "not_a_case", "error": "w27-case.json: a region is named as the case's file system/mydict"} in evs
    assert not [argv for name, argv in rec.calls if name == "popen" and argv[:1] == ["wsl"]]


def test_the_relay_refuses_region_properties_that_do_not_match(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setenv("FAKE_REGION_PROPERTIES", "regions ( fluid (air) solid (copper) );")
    code, evs, rec, _r = _region_run(tmp_path, monkeypatch, {"pre_steps": SPLIT, "regions": REGIONS})
    assert code == 2
    assert {
        "event": "refused",
        "code": "not_a_case",
        "error": "constant/regionProperties does not list the case's regions: air (fluid) aluminium_6061 (solid)",
    } in evs
    assert "start_solve" not in rec.names()


# ---------------------------------------------------------------------------
# Second review: the WSL copy's cleanup in every shape, saved-time order, the
# missing region named to the host
# ---------------------------------------------------------------------------


def _one_region(win: Path, *times: str) -> None:
    (win / "constant" / "polyMesh").mkdir(parents=True)
    (win / "0").mkdir()
    for t in times:
        (win / t).mkdir()
        for f in ("T", "U"):
            (win / t / f).write_text(f"{f} {t}\n", encoding="utf-8")


@needs_bash
def test_one_region_whose_latest_time_has_no_frame_field_keeps_its_copy(tmp_path: Path):
    """One region, frame field k (never written): nothing comes back, the WSL copy
    stays with its saved times, and the warning says so."""
    win = tmp_path / "case"
    _one_region(win)
    proc, _calls = _solve(tmp_path, win, n_procs=1, keep="latest", tag="k", frames=("k",), rg="")
    assert proc.returncode == 0, proc.stdout + proc.stderr
    assert not (win / "2").exists()
    assert (tmp_path / "wsl" / "cfddesk-w27-k" / "2" / "T").is_file()
    assert [e["code"] for e in _events(proc.stdout) if e["event"] == "warning"] == ["frame_not_back"]
    assert not [e for e in _events(proc.stdout) if e.get("stage") == "cleanup"]


@needs_bash
@pytest.mark.parametrize("rg", ["", RG])
@pytest.mark.parametrize("keep", ["all", "latest"])
def test_a_parallel_run_cleans_up_once_its_latest_frame_is_back(tmp_path: Path, rg: str, keep: str):
    win = tmp_path / "case"
    if rg:
        _seed_regions(win)
    else:
        _one_region(win)
    proc, _calls = _solve(tmp_path, win, n_procs=2, keep=keep, tag="c", rg=rg)
    assert proc.returncode == 0, proc.stdout + proc.stderr
    latest = win / "2" / ("aluminium_6061" if rg else "") / "T"
    assert latest.is_file()
    assert not _wsl_left(tmp_path, "c")
    assert [e for e in _events(proc.stdout) if e.get("stage") == "cleanup"]
    assert "frame_not_back" not in proc.stdout


@needs_bash
@pytest.mark.parametrize("rg", ["", RG])
def test_a_run_that_saved_no_time_cleans_up(tmp_path: Path, rg: str):
    """Only 0/ in the case (the solver saved nothing): nothing to lose, the copy goes."""
    win = tmp_path / "case"
    if rg:
        _seed_regions(win)
    else:
        _one_region(win)
    proc, _calls = _solve(tmp_path, win, n_procs=1, keep="latest", tag="z", rg=rg, NOWRITE="1")
    assert proc.returncode == 0, proc.stdout + proc.stderr
    assert not _wsl_left(tmp_path, "z")
    assert "frame_not_back" not in proc.stdout


@needs_bash
@pytest.mark.parametrize("n_procs", [1, 2])
def test_a_restart_that_saves_nothing_new_cleans_up(tmp_path: Path, n_procs: int):
    """Continued, the solver saves nothing new: the latest saved time is the one the
    run continued from, already on Windows; the copy goes, the time stays."""
    win = tmp_path / "case"
    _one_region(win, "5")
    proc, _calls = _solve(tmp_path, win, n_procs=n_procs, keep="latest", tag="n", rg="", restart=True, NOWRITE="1")
    assert proc.returncode == 0, proc.stdout + proc.stderr
    assert (win / "5" / "T").read_text(encoding="utf-8") == "T 5\n"
    assert not _wsl_left(tmp_path, "n")
    assert "frame_not_back" not in proc.stdout


@needs_bash
def test_saved_times_are_listed_in_numeric_order(tmp_path: Path):
    """_list_times sorts the folder names as numbers, exponents too (5e-05 is
    before 0.0001); the latest is the largest."""
    body = render_solve_script(dst="/d/cfddesk-w27-r", win_out="/w", n_procs=1, app="simpleFoam", run_id="r", frame_fields=("U",))
    start = body.index("_list_times() {")
    func = body[start : body.index("\n}\n", start) + 3]
    root = tmp_path / "times"
    names = ["0", "0.00015", "5e-05", "0.0001", "1e-3", "0.002", "2", "10", "1.5e+1"]
    for n in names:
        (root / n).mkdir(parents=True)
    script = tmp_path / "list.sh"
    script.write_bytes((func + f'_list_times "{_posix(root)}"\n').encode("utf-8"))
    assert BASH is not None
    out = subprocess.run([BASH, _posix(script)], capture_output=True, text=True, timeout=60)
    assert out.returncode == 0, out.stderr
    assert out.stdout.split() == ["5e-05", "0.0001", "0.00015", "1e-3", "0.002", "2", "10", "1.5e+1"]


def test_the_relay_names_the_region_the_steps_made_no_mesh_for(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    """foam_pre.sh's exit 46 for a listed region: the relay's pre outcome names it
    (Node words it); a name that is not one of the case's regions is left out."""
    pre = [
        evt(event="stage", stage="pre_copy_in", t_wall=100.0),
        evt(event="pre", tool="splitMeshRegions", index=1, exit_code=0, parallel=False, n_procs=1),
        evt(event="error", code=46, region="aluminium_6061", error="The steps made no constant/aluminium_6061/polyMesh"),
        evt(event="result", ok=False, exit_code=46, region="aluminium_6061", t_wall=101.5),
    ]
    code, evs, rec, _r = _region_run(tmp_path, monkeypatch, {"pre_steps": SPLIT, "regions": REGIONS}, pre=pre, pre_code=46)
    assert code == 46
    end = [e for e in evs if e.get("event") == "relay_end"][-1]
    assert end["outcome"] == {"ok": False, "phase": "pre", "exit_code": 46, "tool": None, "index": None, "region": "aluminium_6061"}
    assert "start_solve" not in rec.names()
    bad = [*pre[:3], evt(event="result", ok=False, exit_code=46, region="copper", t_wall=101.5)]
    (tmp_path / "b").mkdir()
    code, evs, _rec, _r = _region_run(tmp_path / "b", monkeypatch, {"pre_steps": SPLIT, "regions": REGIONS}, pre=bad, pre_code=46)
    end = [e for e in evs if e.get("event") == "relay_end"][-1]
    assert code == 46 and "region" not in end["outcome"]
