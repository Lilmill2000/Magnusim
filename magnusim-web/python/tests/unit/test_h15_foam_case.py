"""H15: the case checks of plugin OpenFOAM cases, the one WSL step table and foam_pre.sh.

gate:h15-app-allowlist (Python half), gate:h15-submit-openfoam (the checks).
"""

from __future__ import annotations

import importlib.util
import json
import os
import stat
import sys
import time
from pathlib import Path
from types import SimpleNamespace

import pytest

from cfddesk.wsl import foam_case
from cfddesk.wsl.foam_case import (
    STEP_TABLE,
    FoamCaseError,
    check_case_local,
    check_case_paths,
    check_steps,
    is_link,
    plugin_case_id_ok,
    render_foam_pre,
    temp_path_problem,
    wsl_path_problem,
    wsl_root_ok,
)

FIXTURES = Path(__file__).resolve().parents[1] / "fixtures"
VECTORS = json.loads((FIXTURES / "foam-pre-vectors.json").read_text(encoding="utf-8"))["vectors"]
FOAM_DEMO = FIXTURES / "foam-plugins" / "foam-demo"


def _foam_demo():
    spec = importlib.util.spec_from_file_location("h15_foam_demo_plugin", FOAM_DEMO / "plugin.py")
    assert spec is not None and spec.loader is not None
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def write_cavity(case: Path, *, write_format: str = "binary", broken: bool = False, end_time: float = 0.5) -> Path:
    for rel, text in _foam_demo().cavity_files(
        end_time=end_time, write_interval=0.1, write_format=write_format, broken=broken
    ).items():
        target = case / rel
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(text, encoding="utf-8", newline="\n")
    return case


RESULTS = {"rho": 1, "kinematicFields": ["p"]}
PRE = [{"tool": "blockMesh"}]


def _code(fn, *args, **kwargs) -> tuple[str, str]:
    with pytest.raises(FoamCaseError) as err:
        fn(*args, **kwargs)
    return err.value.code, err.value.error


def _edit(path: Path, old: str, new: str) -> None:
    text = path.read_text(encoding="utf-8")
    assert old in text
    path.write_text(text.replace(old, new), encoding="utf-8", newline="\n")


# ---------------------------------------------------------------------------
# The step table (vectors)
# ---------------------------------------------------------------------------


@pytest.mark.parametrize("vector", VECTORS, ids=[v["name"] for v in VECTORS])
def test_step_vectors(vector):
    if "error" in vector:
        code, text = _code(check_steps, vector["pre"])
        assert (code, text) == ("pre_not_allowed", vector["error"])
    else:
        assert check_steps(vector["pre"]) == vector["steps"]


def test_vectors_cover_every_row_flag_and_parallel_tool():
    ok = [v for v in VECTORS if "steps" in v]
    tools = {s["tool"] for v in ok for s in v["pre"]}
    assert tools == set(STEP_TABLE)
    given = {a for v in ok for s in v["pre"] for a in s.get("args", []) if a.startswith("-")}
    every_flag = {f for rule in STEP_TABLE.values() for f in rule.flags}
    assert every_flag <= given
    parallel_ok = {s["tool"] for v in ok for s in v["pre"] if s.get("parallel")}
    assert parallel_ok == {t for t, rule in STEP_TABLE.items() if rule.parallel}
    refused = {t for v in VECTORS if "error" in v and "cannot run in parallel" in v["error"] for t in [v["error"].split("(")[1].split(")")[0]]}
    assert refused == {t for t, rule in STEP_TABLE.items() if not rule.parallel}


def test_the_table_is_the_contracts():
    assert {t: sorted(r.flags) for t, r in STEP_TABLE.items()} == {
        "blockMesh": [],
        "gmshToFoam": ["-keepOrientation"],
        "surfaceFeatureExtract": [],
        "snappyHexMesh": ["-overwrite"],
        "extrudeMesh": [],
        "changeDictionary": [],
        "createPatch": ["-overwrite"],
        "checkMesh": ["-allGeometry", "-allTopology"],
        "renumberMesh": ["-overwrite"],
        "decomposePar": ["-force"],
        "reconstructParMesh": ["-constant"],
    }
    assert {t for t, r in STEP_TABLE.items() if r.parallel} == {
        "snappyHexMesh",
        "changeDictionary",
        "createPatch",
        "checkMesh",
        "renumberMesh",
    }
    assert {t: r.host_adds for t, r in STEP_TABLE.items() if r.host_adds} == {
        "snappyHexMesh": ("-overwrite",),
        "createPatch": ("-overwrite",),
        "renumberMesh": ("-overwrite",),
        "decomposePar": ("-force",),
        "reconstructParMesh": ("-constant",),
    }


# ---------------------------------------------------------------------------
# Names and paths
# ---------------------------------------------------------------------------


def test_wsl_root_rule():
    assert wsl_root_ok("/home/u/cases")
    assert wsl_root_ok("/tmp/magnusim-e2e-x-1/cases")
    for bad in ("", "home/u/cases", "/home/u/cases/", "/home//cases", "/home/./cases", "/home/../cases",
                "/home/u/__APP__/cases", "/home/u/c$ses", "/home/u/c`s", '/home/u/"c', "/home/u\\c",
                "/home/u/it's", "/home/u/\x07", "/" + "a" * 200, None, 5):
        assert not wsl_root_ok(bad), bad


def test_wsl_path_and_temp_rules(tmp_path: Path):
    assert wsl_path_problem("/mnt/c/Users/x/proj's/case") is None
    assert wsl_path_problem("/mnt/c/Users/$x/case") == "The projects folder path has a character the WSL scripts cannot take: $"
    assert wsl_path_problem("/mnt/c/p/__APP__/c") == "The case path has a name the WSL scripts cannot take: __APP__"
    assert wsl_path_problem('/mnt/c/a"b') is not None and wsl_path_problem("/mnt/c/a`b") is not None
    quoted = tmp_path / "it's"
    quoted.mkdir()
    assert temp_path_problem(quoted) == "The temp folder path has a character the WSL scripts cannot take: '"
    dollar = tmp_path / "a$b"
    dollar.mkdir()
    assert temp_path_problem(dollar) == "The temp folder path has a character the WSL scripts cannot take: $"
    assert temp_path_problem(tmp_path) is None


def test_plugin_case_ids():
    assert plugin_case_id_ok("cfddesk-pf-foam-demo-st-1-0a1b2c3d", "0a1b2c3d")
    assert not plugin_case_id_ok("cfddesk-pf-foam-demo-st-1-0a1b2c3d", "ffffffff")  # not its token
    assert not plugin_case_id_ok("cfddesk-pf-Foam-demo-st-1-0a1b2c3d", "0a1b2c3d")  # not a slug
    assert not plugin_case_id_ok("cfddesk-w27-run-1-0a1b2c3d", "0a1b2c3d")
    assert not plugin_case_id_ok("cfddesk-pf-foam_demo-st-1-0a1b2c3d", "0a1b2c3d")
    assert not plugin_case_id_ok("cfddesk-pf-x-0a1b2c3d/..", "0a1b2c3d")
    assert not plugin_case_id_ok("cfddesk-pf-x-0a1b2c3", "0a1b2c3")


def test_link_rule_by_reparse_tag(monkeypatch: pytest.MonkeyPatch):
    def st(tag: int) -> SimpleNamespace:
        return SimpleNamespace(st_reparse_tag=tag, st_mode=stat.S_IFDIR)

    monkeypatch.setattr(foam_case.sys, "platform", "win32")
    assert is_link(st(stat.IO_REPARSE_TAG_SYMLINK), False)  # type: ignore[arg-type]
    assert is_link(st(stat.IO_REPARSE_TAG_MOUNT_POINT), False)  # type: ignore[arg-type]
    # OneDrive cloud files and other tags are allowed.
    assert not is_link(st(0x9000001A), False)  # type: ignore[arg-type]
    assert not is_link(st(0), True)  # type: ignore[arg-type]
    monkeypatch.setattr(foam_case.sys, "platform", "linux")
    assert is_link(st(0), True)  # type: ignore[arg-type]
    assert not is_link(st(0), False)  # type: ignore[arg-type]


def _junction(target: Path, link: Path) -> None:
    if sys.platform == "win32":
        import _winapi

        _winapi.CreateJunction(str(target), str(link))
    else:
        os.symlink(target, link, target_is_directory=True)


def test_a_real_junction_or_link_inside_is_refused(tmp_path: Path):
    case = write_cavity(tmp_path / "case")
    other = tmp_path / "elsewhere"
    (other / "deep").mkdir(parents=True)
    _junction(other, case / "constant" / "linked")
    code, text = _code(check_case_paths, case)
    assert code == "invalid_path"
    assert text == "The case has a link or junction inside: constant/linked"
    assert str(tmp_path) not in text


def test_the_case_folder_itself_a_junction_is_refused(tmp_path: Path):
    real = write_cavity(tmp_path / "real")
    _junction(real, tmp_path / "case")
    assert _code(check_case_paths, tmp_path / "case") == ("invalid_path", "The case folder is a link or junction")


# ---------------------------------------------------------------------------
# check_case_local
# ---------------------------------------------------------------------------


def test_a_good_case(tmp_path: Path):
    case = write_cavity(tmp_path / "c1")
    out = check_case_local(case, "pimpleFoam", PRE, RESULTS, stop_strategy="stopAt_writeNow")
    assert out["ok"] is True
    assert out["write_format"] == "binary"
    assert out["steps"] == [{"tool": "blockMesh", "args": [], "parallel": False}]
    assert out["results"] == {"rho": 1, "kinematic_fields": ["p"], "frame_fields": ["U", "p"]}
    # A case path may hold a quote: WIN_OUT is always double-quoted.
    quoted = write_cavity(tmp_path / "it's" / "c1")
    assert check_case_local(quoted, "pimpleFoam", PRE, RESULTS)["ok"] is True


def test_not_found_and_path_characters(tmp_path: Path):
    assert _code(check_case_local, tmp_path / "nope", "pimpleFoam", PRE, RESULTS)[0] == "not_found"
    dollar = write_cavity(tmp_path / "a$b" / "c1")
    assert _code(check_case_local, dollar, "pimpleFoam", PRE, RESULTS) == (
        "invalid_path",
        "The projects folder path has a character the WSL scripts cannot take: $",
    )
    placeholder = write_cavity(tmp_path / "cases" / "__APP__")
    assert _code(check_case_local, placeholder, "pimpleFoam", PRE, RESULTS) == (
        "invalid_path",
        "The case path has a name the WSL scripts cannot take: __APP__",
    )


def test_not_a_case(tmp_path: Path):
    case = write_cavity(tmp_path / "c1")
    control = case / "system" / "controlDict"
    assert _code(check_case_local, case, "simpleFoam", PRE, RESULTS) == (
        "not_a_case",
        "system/controlDict: application is not simpleFoam",
    )
    _edit(control, "stopAt          endTime;\n", "")
    assert _code(check_case_local, case, "pimpleFoam", PRE, RESULTS, stop_strategy="stopAt_writeNow")[1].startswith(
        "system/controlDict needs a stopAt line"
    )
    # A sigterm app needs neither line.
    assert check_case_local(case, "pimpleFoam", PRE, RESULTS, stop_strategy="sigterm")["ok"]
    _edit(control, "startTime       0;\n", "startTime       0;\nstopAt endTime;\n")
    _edit(control, "runTimeModifiable true;", "runTimeModifiable false;")
    assert _code(check_case_local, case, "pimpleFoam", PRE, RESULTS, stop_strategy="stopAt_writeNow")[1].startswith(
        "system/controlDict needs runTimeModifiable true"
    )
    _edit(control, "runTimeModifiable false;", "runTimeModifiable yes;")
    _edit(control, "writeCompression off;", "writeCompression on;")
    assert _code(check_case_local, case, "pimpleFoam", PRE, RESULTS) == (
        "not_a_case",
        "system/controlDict: writeCompression must be off",
    )
    _edit(control, "writeCompression on;", "writeCompression off;")
    # Without a mesh, a step must make one.
    assert _code(check_case_local, case, "pimpleFoam", [{"tool": "checkMesh"}], RESULTS) == (
        "not_a_case",
        "constant/polyMesh is missing, and no step makes a mesh (blockMesh or gmshToFoam)",
    )
    (case / "constant" / "polyMesh").mkdir()
    assert check_case_local(case, "pimpleFoam", [{"tool": "checkMesh"}], RESULTS)["ok"]
    assert check_case_local(case, "pimpleFoam", [], RESULTS)["ok"]
    (case / "system" / "blockMeshDict").unlink()
    assert _code(check_case_local, case, "pimpleFoam", PRE, RESULTS) == (
        "not_a_case",
        "system/blockMeshDict is missing (step 1, blockMesh needs it)",
    )
    assert _code(check_case_local, case, "pimpleFoam", [{"tool": "gmshToFoam", "args": ["mesh/part.msh"]}], RESULTS) == (
        "not_a_case",
        "mesh/part.msh is missing (step 1, gmshToFoam needs it)",
    )
    (case / "mesh").mkdir()
    (case / "mesh" / "part.msh").write_text("$MeshFormat\n", encoding="utf-8")
    assert check_case_local(case, "pimpleFoam", [{"tool": "gmshToFoam", "args": ["mesh/part.msh"]}], RESULTS)["ok"]
    control.unlink()
    assert _code(check_case_local, case, "pimpleFoam", [], RESULTS) == ("not_a_case", "system/controlDict is missing")


def test_control_dict_reads_the_top_level_only(tmp_path: Path):
    case = write_cavity(tmp_path / "c1")
    control = case / "system" / "controlDict"
    _edit(control, "application     pimpleFoam;", "// application pimpleFoam;\n/* application pimpleFoam; */\nfunctions\n{\n    application pimpleFoam;\n}\napplication icoFoam;")
    assert _code(check_case_local, case, "pimpleFoam", PRE, RESULTS)[1] == "system/controlDict: application is not pimpleFoam"


def test_has_results(tmp_path: Path):
    for name in (".magnusim-ran", "0.1", "processor0", "1e-05"):
        case = write_cavity(tmp_path / name.replace(".", "_") / "c1")
        target = case / name
        if name == ".magnusim-ran":
            target.write_text("{}", encoding="utf-8")
        else:
            target.mkdir()
        assert _code(check_case_local, case, "pimpleFoam", PRE, RESULTS) == (
            "has_results",
            "This case already ran. Write a new case folder for each run.",
        ), name
    # The check after a prepare step ignores this run's own marker.
    case = write_cavity(tmp_path / "own" / "c1")
    (case / ".magnusim-ran").write_text("{}", encoding="utf-8")
    assert check_case_local(case, "pimpleFoam", PRE, RESULTS, own_marker=True)["ok"]
    # 0 and 0.orig are not results.
    case = write_cavity(tmp_path / "zero" / "c1")
    (case / "0.orig").mkdir()
    assert check_case_local(case, "pimpleFoam", PRE, RESULTS)["ok"]


def test_app_and_steps(tmp_path: Path):
    case = write_cavity(tmp_path / "c1")
    assert _code(check_case_local, case, "simpleFoam; rm -rf ~", PRE, RESULTS) == (
        "app_not_allowed",
        "The app must be a plain program name",
    )
    assert _code(check_case_local, case, "pimpleFoam", [{"tool": "blockMesh"}, {"tool": "createPatch", "args": ["-dict"]}], RESULTS) == (
        "not_a_case",
        "system/createPatchDict is missing (step 2, createPatch needs it)",
    )
    (case / "system" / "createPatchDict").write_text("x", encoding="utf-8")
    assert _code(check_case_local, case, "pimpleFoam", [{"tool": "blockMesh"}, {"tool": "createPatch", "args": ["-dict"]}], RESULTS) == (
        "pre_not_allowed",
        "Step 2 (createPatch): -dict is not allowed",
    )


def test_results_rules(tmp_path: Path):
    case = write_cavity(tmp_path / "c1")

    def bad(results):
        return _code(check_case_local, case, "pimpleFoam", PRE, results)

    assert bad({"rho": 1}) == ("bad_request", "results.kinematicFields is required (it may be empty)")
    assert bad("x")[0] == "bad_request"
    assert bad({"kinematicFields": [], "extra": 1})[0] == "bad_request"
    for rho in (None, 0, -1, float("nan"), float("inf"), True, "1"):
        assert bad({"rho": rho, "kinematicFields": ["p"]}) == (
            "bad_request",
            "results.rho must be a number above 0 when kinematicFields lists a field",
        ), rho
    for name in ("a b", "__x", "p__q", "1p", "", "x" * 65):
        assert bad({"kinematicFields": [name]})[0] == "bad_request", name
        assert bad({"kinematicFields": [], "frameFields": [name]})[0] == "bad_request", name
    # rho may be left out when no field is kinematic.
    assert check_case_local(case, "pimpleFoam", PRE, {"kinematicFields": []})["results"]["rho"] is None
    # A case that names no frame fields (written before API 1.1) frames U and p, as it always did.
    assert check_case_local(case, "pimpleFoam", PRE, {"kinematicFields": []})["results"]["frame_fields"] == ["U", "p"]
    assert bad({"kinematicFields": [], "frameFields": ["T"]}) == ("bad_request", "results.frameFields: 0/T is not in the case")
    assert bad({"kinematicFields": [], "frameFields": []})[0] == "bad_request"
    for name in "abcdefghi":
        (case / "0" / name).write_text("x", encoding="utf-8")
    assert bad({"kinematicFields": [], "frameFields": list("abcdefghi")})[0] == "bad_request"
    assert check_case_local(case, "pimpleFoam", PRE, {"kinematicFields": [], "frameFields": list("abcdefgh")})["results"]["frame_fields"] == list("abcdefgh")
    (case / "0" / "U").unlink()
    assert bad({"kinematicFields": []}) == ("bad_request", "results.frameFields is required: 0/U and 0/p are not both in the case")


def test_a_plan_with_no_solver(tmp_path: Path):
    case = tmp_path / "mesh"
    (case / "system").mkdir(parents=True)
    (case / "system" / "blockMeshDict").write_text("x", encoding="utf-8")
    # Every OpenFOAM utility reads system/controlDict.
    assert _code(check_case_local, case, None, PRE, None) == ("not_a_case", "system/controlDict is missing")
    (case / "system" / "controlDict").write_text(
        "application snappyHexMesh;\nwriteCompression on;\n", encoding="utf-8"
    )
    # No application, writeCompression or results rule without a solver.
    out = check_case_local(case, None, PRE, {"nonsense": True})
    assert out == {"ok": True, "steps": [{"tool": "blockMesh", "args": [], "parallel": False}], "write_format": None, "results": None}
    # WSL steps need a mesh in the end; a plan with no step and no solver needs none.
    assert _code(check_case_local, case, None, [{"tool": "checkMesh"}], None)[0] == "not_a_case"
    assert check_case_local(case, None, [], None)["steps"] == []


# ---------------------------------------------------------------------------
# foam_pre.sh
# ---------------------------------------------------------------------------

MESH_PLAN = check_steps(
    [
        {"tool": "blockMesh"},
        {"tool": "surfaceFeatureExtract"},
        {"tool": "decomposePar"},
        {"tool": "snappyHexMesh", "parallel": True},
        {"tool": "reconstructParMesh"},
        {"tool": "checkMesh"},
    ]
)
DST = "/home/u/cases/cfddesk-pf-foam-demo-st-1-0a1b2c3d"
WIN = "/mnt/c/p/proj/plugins/foam-demo/studies/st-1/cases/c1"


def _render(steps, n=2, **kw):
    args = {"dst": DST, "win_out": WIN, "token": "0a1b2c3d", "steps": steps, "n_procs": n}
    args.update(kw)
    return render_foam_pre(**args)


def test_the_template():
    raw = foam_case.foam_pre_template_path().read_bytes()
    assert not raw.startswith(b"\xef\xbb\xbf") and b"\r\n" not in raw
    text = raw.decode("utf-8")
    for token in ("__DST__", "__WIN_OUT__", "__TOKEN__", "__STEPS__"):
        # Once each, never in a comment: a multi-line value there would run as code.
        assert text.count(token) == 1, token
    code = "\n".join(line for line in text.splitlines() if not line.lstrip().startswith("#"))
    for token in ("__DST__", "__WIN_OUT__", "__TOKEN__", "__STEPS__"):
        assert token in code
    assert "bash -c" not in code
    assert 'mkdir -p "$WIN_OUT"' not in code
    assert 'rm -rf "$DST"' in code and 'mkdir -p "$DST"' in code and 'cp -a "$WIN_OUT/." "$DST/"' in code
    assert ".magnusim-polyMesh.part" in code and ".magnusim-0.part" in code
    assert 'if [ -d "$DST/0" ]; then' in code
    assert '[ -e "$WIN_OUT/.magnusim-stop" ]' in code
    # The marker is checked after each step too (in _step_done), not only before it.
    step_done = code.split("_step_done() {", 1)[1].split("\n}\n", 1)[0]
    assert "_stop_check" in step_done
    assert "processor" not in code
    # A result time folder after a step: exit 50; no mesh after the steps: exit 46.
    assert "_fail 50" in code and "_fail 46" in code
    assert '\\"event\\":\\"result\\",\\"ok\\":true' in code


def test_render_parallel_and_serial():
    two = _render(MESH_PLAN, n=2)
    for token in ("__DST__", "__WIN_OUT__", "__TOKEN__", "__STEPS__"):
        assert token not in two
    assert 'DST="/home/u/cases/cfddesk-pf-foam-demo-st-1-0a1b2c3d"' in two
    assert f'WIN_OUT="{WIN}"' in two and 'TOKEN="0a1b2c3d"' in two
    assert "STEP_1=(blockMesh)" in two
    assert "STEP_3=(decomposePar -force)" in two
    assert "STEP_4=(mpirun --oversubscribe -np 2 snappyHexMesh -overwrite -parallel)" in two
    assert "STEP_5=(reconstructParMesh -constant)" in two
    assert '( cd "$DST" && openfoam2606 "${STEP_4[@]}" ) > "log.snappyHexMesh.4" 2>&1' in two
    assert "_step_done 4 snappyHexMesh $? true 2" in two
    assert "_step_done 6 checkMesh $? false 1" in two
    # Before each step and (in _step_done) after it.
    assert two.count("_stop_check\nSTEP_") == len(MESH_PLAN)
    one = _render(MESH_PLAN, n=1)
    assert "_step_skipped 3 decomposePar" in one and "_step_skipped 5 reconstructParMesh" in one
    assert "STEP_3=" not in one and "STEP_5=" not in one
    assert "STEP_4=(snappyHexMesh -overwrite)" in one
    assert "_step_done 4 snappyHexMesh $? false 1" in one
    assert "=(mpirun" not in one


def test_render_is_one_pass_and_quotes_every_argument():
    steps = [{"tool": "gmshToFoam", "args": ["__WIN_OUT__", "a b;$(x)"], "parallel": False}]
    text = _render(steps, n=1)
    # An inserted value is never scanned again.
    assert "STEP_1=(gmshToFoam __WIN_OUT__ 'a b;$(x)')" in text
    with pytest.raises(ValueError):
        _render(steps, n=1, win_out="/mnt/c/$x")
    with pytest.raises(ValueError):
        _render(steps, n=1, dst="/home/__TOKEN__/x")
    with pytest.raises(ValueError):
        _render(steps, n=1, token="nothex!!")
    with pytest.raises(ValueError):
        _render([{"tool": "rm", "args": [], "parallel": False}], n=1)


def test_render_never_scans_an_inserted_value_again(monkeypatch: pytest.MonkeyPatch):
    # Past the value checks, a value that names another placeholder stays as it is.
    monkeypatch.setattr(foam_case, "wsl_path_problem", lambda *a, **k: None)
    text = _render([], n=1, dst="__WIN_OUT__", win_out="__STEPS__")
    assert 'DST="__WIN_OUT__"' in text and 'WIN_OUT="__STEPS__"' in text


# ---------------------------------------------------------------------------
# foam.check_case (the registry check on top)
# ---------------------------------------------------------------------------


@pytest.fixture
def registry(monkeypatch: pytest.MonkeyPatch, tmp_path: Path):
    from cfddesk.registry import reset_for_tests

    monkeypatch.setenv("MAGNUSIM_PLUGINS_DIR", str(tmp_path / "no-user-plugins"))
    reset_for_tests()
    yield
    reset_for_tests()


def test_foam_check_case_rpc(registry, tmp_path: Path):
    from cfddesk.worker.foam_methods import foam_check_case

    case = write_cavity(tmp_path / "c1")
    out = foam_check_case(case_dir=str(case), app="pimpleFoam", pre=PRE, results=RESULTS)
    assert out["ok"] is True, out
    launch = out["launch"]
    assert launch["app"] == "pimpleFoam" and launch["process_names"] == ["pimpleFoam"]
    assert launch["keep_frames"] == ("all" if launch["time_dependency"] == "transient" else "latest")
    assert launch["parallel"] in ("mpirun", "none") and launch["frame_fields"] == ["U", "p"]
    assert launch["stop_strategy"] in ("stopAt_writeNow", "sigterm")
    assert out["write_format"] == "binary"
    # The app checks come first: an unregistered or shell-like app is app_not_allowed
    # whatever the case says.
    _edit(case / "system" / "controlDict", "application     pimpleFoam;", "application     icoFoam;")
    assert foam_check_case(case_dir=str(case), app="icoFoam", pre=PRE, results=RESULTS) == {
        "ok": False,
        "code": "app_not_allowed",
        "error": "icoFoam is not a registered solver",
    }
    assert foam_check_case(case_dir=str(case), app="simpleFoam; rm -rf ~", pre=PRE, results=RESULTS)["code"] == "app_not_allowed"
    assert foam_check_case(case_dir=str(tmp_path / "gone"), app="pimpleFoam", pre=PRE, results=RESULTS)["code"] == "not_found"


def test_the_foam_fixture_plugins_load(monkeypatch: pytest.MonkeyPatch, tmp_path: Path):
    """foam-plugins load on their own (before the workspace script exists, L16)."""
    import shutil

    from cfddesk.registry import load_all, reset_for_tests
    from cfddesk.registry.discovery import plugin_catalog

    plugins = tmp_path / "plugins"
    shutil.copytree(FIXTURES / "foam-plugins", plugins, ignore=shutil.ignore_patterns("cavity.js", "cavity.css"))
    monkeypatch.setenv("MAGNUSIM_PLUGINS_DIR", str(plugins))
    reset_for_tests()
    try:
        hub = load_all(force=True)
        assert {"foam-demo", "foam-idle"} <= set(hub.manifests)
        assert not [f for f in hub.failures if f["key"].startswith("foam-")]
        demo = hub.manifests["foam-demo"]
        assert demo.name == "Foam demo" and demo.api_version == "1.3"
        assert [(w.key, w.entry) for w in demo.workspaces] == [("cavity", "workspace/index.html")]
        assert [(k.key, k.title, k.workspace) for k in demo.study_kinds] == [("cavity_case", "Cavity case", "cavity")]
        assert hub.manifests["foam-idle"].name == "Foam idle"
        job = hub.registry("job").get("foam_demo_write_mesh_case")
        assert (job.tool, job.python, job.args_from_params) == ("jobs/write_mesh_case.py", "core", ("sleep", "fail"))
        assert hub.registry("job").owner("foam_demo_write_mesh_case") == "foam-demo"
        from cfddesk.registry.hooks import get_hooks

        assert [p for p, _ in get_hooks().listeners("solve.parse_line")] == ["foam-demo"]
        rows = {r["key"]: r for r in plugin_catalog()}
        assert rows["foam-demo"]["status"] == "enabled" and rows["foam-idle"]["status"] == "enabled"
        page = (plugins / "foam-demo" / "workspace" / "index.html").read_text(encoding="utf-8")
        assert page.lower().startswith("<!doctype html>") and '<div id="root">' in page
        assert '<script type="module" src="./cavity.js">' in page
    finally:
        reset_for_tests()


def test_the_boundary_check_reads_the_h15_fixture_plugins():
    import plugin_boundary

    report = plugin_boundary.run(Path(__file__).resolve().parents[3])
    assert report["ok"], report["problems"]
    assert {
        "python/tests/fixtures/foam-plugins/foam-demo",
        "python/tests/fixtures/foam-plugins/foam-idle",
        "python/tests/fixtures/hook-plugins/hook-demo",
        "python/tests/fixtures/hook-plugins/hook-reserved",
    } <= set(report["plugins"])


def test_the_cavity_writer_and_slow_methods(tmp_path: Path):
    from magnusim_sdk.data import PluginData

    mod = _foam_demo()
    project = tmp_path / "proj"
    project.mkdir()
    data = PluginData(project, "foam-demo")
    sid = data.create_study("cavity_case", "Cavity case 1")["id"]
    out = mod._write_cavity({"case": "cases/c1", "study_id": sid, "end_time": 2, "write_interval": 0.5, "write_format": "ascii"}, {"data": data})
    assert out["ok"] is True and out["case"] == f"studies/{sid}/cases/c1"
    case = data.root / "studies" / sid / "cases" / "c1"
    control = (case / "system" / "controlDict").read_text(encoding="utf-8")
    assert "endTime         2;" in control and "writeInterval   0.5;" in control and "writeFormat     ascii;" in control
    assert check_case_local(case, "pimpleFoam", PRE, RESULTS, stop_strategy="stopAt_writeNow")["write_format"] == "ascii"
    broken = mod._write_cavity({"case": f"studies/{sid}/cases/c5", "broken": True}, {"data": data})
    assert broken["ok"] and "(0 1 2 3 4 5 6 99)" in (data.root / "studies" / sid / "cases" / "c5" / "system" / "blockMeshDict").read_text(encoding="utf-8")
    assert mod._write_cavity({"case": "x"}, {})["ok"] is False
    t0 = time.time()
    assert mod._slow({"seconds": 0.2}, {})["ok"] is True and time.time() - t0 >= 0.2


def test_the_cavity_results_fixture():
    """foam-results/cavity-2d (h15-plugin-results): ascii, five frames, the mesh, w27-case.json."""
    root = FIXTURES / "foam-results" / "cavity-2d"
    doc = json.loads((root / "w27-case.json").read_text(encoding="utf-8"))
    assert doc["rho"] == 1000 and doc["kinematic_fields"] == ["p"] and doc["frame_fields"] == ["U", "p"]
    frames = sorted(p.name for p in root.iterdir() if p.is_dir() and p.name[0].isdigit() and p.name != "0")
    assert frames == ["0.1", "0.2", "0.3", "0.4", "0.5"]
    for name in frames:
        for field in ("U", "p"):
            text = (root / name / field).read_text(encoding="utf-8")
            assert "format      ascii;" in text and "nonuniform" in text
    for name in ("points", "faces", "owner", "neighbour", "boundary"):
        assert (root / "constant" / "polyMesh" / name).is_file()
    assert "regenerate" in (root / "README.md").read_text(encoding="utf-8").lower()
    assert not [p for p in root.rglob(".magnusim*")]
