"""Mesh goldens: what each mesher writes on this PC before WSL takes over.

The Standard and Hex-dominant meshers are moving out of the core into a bundled
plugin (and cfMesh may follow). These goldens pin their case files so a move
cannot change a mesh without a test saying so. Each mesher runs its own
command line on the elbow fixture (inlet face 10, outlet face 13), single
threaded so gmsh is repeatable:

- Standard: ``tools/generate_standard.py --prepare-only``
- Hex-dominant: ``tools/generate_snappy.py --render-only`` (after the Body1 STL
  the app makes with ``convert_step_to_stl.py --cad-quality``)
- cfMesh: ``generate_cfmesh_standard.main()`` with its WSL step stopped (its
  code stays as it is; it is the frozen legacy path)

Two layers per case, in ``tests/fixtures/mesh-goldens/<case>/``:

- text files every platform must match (the OpenFOAM dictionaries, patch types);
- ``<platform>.json``: what one platform's gmsh/OCC builds (Windows and Linux
  place nodes differently): the host log, a fingerprint of each mesh and STL,
  and file hashes. A platform without its record checks the text only.

Refresh after a deliberate mesher change: ``CFDDESK_UPDATE_GOLDEN=1 pytest
tests/unit/test_mesh_goldens.py``, then review ``git diff``.
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
from collections import Counter
from collections.abc import Sequence
from pathlib import Path
from typing import Any

import pytest

from tests.conftest import FIXTURES

PY = Path(__file__).resolve().parents[2]
WEB = PY.parent
TOOLS = PY / "tools"
GOLDEN = FIXTURES / "mesh-goldens"
ELBOW = FIXTURES / "elbow.step"
ROUND = FIXTURES / "geometry" / "transient-test.step"
PLATFORM = "win32" if sys.platform == "win32" else "linux"
UPDATE = os.environ.get("CFDDESK_UPDATE_GOLDEN", "").strip() in ("1", "true", "yes")

pytestmark = pytest.mark.occt

# A wall face for the refinement variants (face 13 is the outlet).
REFINEMENTS = [
    {
        "type": "Surface custom sizing",
        "mesh_id": "mesh_1",
        "faces": ["face 4@Body1"],
        "sizing": "Automatic",
        "fineness": 8,
    },
    {
        "type": "Inflate boundary layer",
        "mesh_id": "mesh_1",
        "faces": ["face 4@Body1"],
        "n_layers": 4,
        "gradation": "growth_rate",
        "growth_rate": 1.2,
        "overall_relative_thickness": 0.4,
    },
]


def _env() -> dict[str, str]:
    env = dict(os.environ)
    # Never ask WSL anything: a case root is given, and nothing runs there.
    env["MAGNUSIM_WSL_CASE_ROOT"] = "/home/golden/cases"
    env["PYTHONPATH"] = os.pathsep.join([str(PY), str(PY / "sdk")])
    env.pop("CFDDESK_UPDATE_GOLDEN", None)
    return env


def _project(
    tmp: Path, *, refinements: bool = False, step: Path = ELBOW, faces: tuple[int, int] = (10, 13)
) -> tuple[Path, Path]:
    """The e2e sample project (its study, BCs and mesh records) laid out the way the
    app stores it. On the elbow, inlet face 10 and outlet face 13 are planar."""
    from cfddesk.project.paths import (
        create_geometry_folder,
        create_mesh_folder,
        create_study_folder,
    )

    proj = tmp / "proj"
    proj.mkdir(parents=True)
    for f in (WEB / "e2e" / "fixtures" / "sample-project-steady-state").glob("*.json"):
        shutil.copy(f, proj / f.name)
    doc = json.loads((proj / "boundary_conditions.json").read_text(encoding="utf-8"))
    doc["boundary_conditions"][0]["faces"] = [f"face {faces[0]}@Body1"]
    doc["boundary_conditions"][1]["faces"] = [f"face {faces[1]}@Body1"]
    (proj / "boundary_conditions.json").write_text(json.dumps(doc), encoding="utf-8")
    geom = create_geometry_folder(proj, {"id": "geom-e2e", "name": step.stem, "original_filename": step.name})
    shutil.copy(step, Path(geom["dir"]) / "source.step")
    create_study_folder(proj, "geom-e2e", {"id": "sim_1", "name": "Incompressible Steady-state"})
    mesh = Path(create_mesh_folder(proj, "sim_1", {"id": "mesh_1", "name": "Mesh 1"})["dir"])
    if refinements:
        (mesh / "refinements.json").write_text(json.dumps({"refinements": REFINEMENTS}), encoding="utf-8")
    return proj, mesh


def _run(argv: list[str]) -> dict[str, Any]:
    r = subprocess.run([sys.executable, *argv], cwd=str(PY), env=_env(), capture_output=True, text=True, timeout=600)
    events = [json.loads(line.split(" ", 1)[1]) for line in r.stdout.splitlines() if line.startswith("MAGNUSIM_EVENT ")]
    results = [e for e in events if e.get("event") == "result"]
    assert r.returncode == 0 and results and results[-1].get("ok"), (r.returncode, results[-1:], r.stderr[-2000:])
    return results[-1]


def _standard(tmp: Path, *, fineness: int, hex_core: bool, refinements: bool = False, **geometry: Any) -> Path:
    proj, mesh = _project(tmp, refinements=refinements, **geometry)
    case = mesh / "case"
    res = _run(
        [
            str(TOOLS / "generate_standard.py"),
            "--project-dir", str(proj), "--case-dir", str(case), "--wsl-case", "cfddesk-golden-std",
            "--generate-id", "golden", "--fineness", str(fineness), "--hex-core", "1" if hex_core else "0",
            "--threads", "1", "--mesh-id", "mesh_1", "--simulation-id", "sim_1", "--prepare-only",
        ]
    )
    assert res.get("prepared_only") is True
    return case


def _snappy(tmp: Path, *, fineness: int, layers: bool, refinements: bool = False) -> Path:
    proj, mesh = _project(tmp, refinements=refinements)
    step = next(proj.rglob("source.step"))
    r = subprocess.run(
        [sys.executable, str(TOOLS / "convert_step_to_stl.py"), "--step", str(step), "--out", str(step.with_name("Body1.stl")), "--cad-quality"],
        cwd=str(PY), env=_env(), capture_output=True, text=True, timeout=600,
    )
    assert r.returncode == 0, r.stderr[-2000:]
    case = mesh / "case"
    _run(
        [
            str(TOOLS / "generate_snappy.py"),
            "--project-dir", str(proj), "--case-dir", str(case), "--wsl-case", "cfddesk-golden-snappy",
            "--generate-id", "golden", "--fineness", str(fineness), "--add-layers", "1" if layers else "0",
            "--mesh-id", "mesh_1", "--simulation-id", "sim_1", "--render-only",
        ]
    )
    return case


class _ReachedWslError(Exception):
    pass


def _cfmesh(tmp: Path, monkeypatch: pytest.MonkeyPatch, *, fineness: int) -> Path:
    proj, mesh = _project(tmp)
    case = mesh / "case"
    monkeypatch.setenv("MAGNUSIM_WSL_CASE_ROOT", "/home/golden/cases")
    monkeypatch.syspath_prepend(str(TOOLS))
    import generate_cfmesh_standard as cf

    def _stop(*_a: Any, **_k: Any) -> Any:
        raise _ReachedWslError

    monkeypatch.setattr(cf, "run_cfmesh_pipeline", _stop)
    monkeypatch.setattr(cf, "claim_generate_case", lambda *a, **k: [])
    monkeypatch.setattr(
        sys,
        "argv",
        [
            "generate_cfmesh_standard.py",
            "--project-dir", str(proj), "--case-dir", str(case), "--wsl-case", "cfddesk-golden-cfmesh",
            "--generate-id", "golden", "--fineness", str(fineness), "--mesh-id", "mesh_1", "--simulation-id", "sim_1",
        ],
    )
    try:
        cf.main()
    except _ReachedWslError:
        pass
    assert (case / "system" / "meshDict").is_file(), "cfMesh did not reach its WSL step"
    return case


# ---------------------------------------------------------------------------
# Fingerprints and comparison
# ---------------------------------------------------------------------------

# Durations in the host log: "(1.6s)", "(..., 0.2s)", "(timeout 480s)".
_DURATION = re.compile(r"\b\d+(?:\.\d+)?s(?=\))")


def _msh_fingerprint(path: Path) -> dict[str, Any]:
    """Node count, element counts by type, triangles per physical group (MSH 2.2 ASCII)."""
    names: dict[str, str] = {}
    types: Counter[str] = Counter()
    tris: Counter[str] = Counter()
    n_nodes = 0
    count_next = False
    with path.open(encoding="utf-8") as fh:
        section = ""
        for line in fh:
            s = line.strip()
            if s.startswith("$"):
                section = "" if s.startswith("$End") else s
                count_next = section in ("$PhysicalNames", "$Nodes", "$Elements")
                continue
            if count_next:
                count_next = False
                if section == "$Nodes":
                    n_nodes = int(s)
                continue
            if section == "$PhysicalNames":
                _dim, tag, name = s.split(" ", 2)
                names[tag] = name.strip('"')
            elif section == "$Elements":
                parts = s.split()
                types[{"2": "tri", "4": "tet", "5": "hex", "6": "prism", "7": "pyramid"}.get(parts[1], parts[1])] += 1
                if parts[1] == "2":
                    tris[names.get(parts[3], parts[3])] += 1
    return {"nodes": n_nodes, "elements": dict(sorted(types.items())), "triangles_per_group": dict(sorted(tris.items()))}


def _stl_fingerprint(path: Path) -> dict[str, Any]:
    data = path.read_bytes()
    if data[:5] == b"solid" and b"facet" in data[:400]:
        solids: Counter[str] = Counter()
        current = ""
        for line in data.decode("utf-8", "replace").splitlines():
            s = line.strip()
            if s.startswith("solid"):
                current = s[5:].strip()
            elif s.startswith("facet"):
                solids[current] += 1
        return {"triangles_per_solid": dict(sorted(solids.items()))}
    return {"triangles": int.from_bytes(data[80:84], "little")}


def _sha(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def _check(
    case: Path,
    name: str,
    *,
    text: list[str],
    platform_text: Sequence[str] = (),
    binary: Sequence[str] = (),
    normalize: Any = None,
) -> None:
    """Compare the case with tests/fixtures/mesh-goldens/<name> (or record it)."""
    gdir = GOLDEN / name
    norm = normalize or (lambda _rel, t: t)
    problems: list[str] = []
    for rel in text:
        got = norm(rel, (case / rel).read_text(encoding="utf-8"))
        golden = gdir / rel
        if UPDATE:
            golden.parent.mkdir(parents=True, exist_ok=True)
            golden.write_text(got, encoding="utf-8", newline="\n")
        elif not golden.is_file():
            problems.append(f"no golden for {rel}")
        elif golden.read_text(encoding="utf-8") != got:
            problems.append(f"{rel} differs from its golden")
    record: dict[str, Any] = {"text": {}, "files": {}}
    for rel in platform_text:
        record["text"][rel] = norm(rel, (case / rel).read_text(encoding="utf-8")).splitlines()
    for rel in binary:
        p = case / rel
        info: dict[str, Any] = {"size": p.stat().st_size, "sha256": _sha(p)}
        if p.suffix == ".msh":
            info["mesh"] = _msh_fingerprint(p)
        elif p.suffix == ".stl":
            info["stl"] = _stl_fingerprint(p)
        record["files"][rel] = info
    rec_path = gdir / f"{PLATFORM}.json"
    if UPDATE:
        gdir.mkdir(parents=True, exist_ok=True)
        rec_path.write_text(json.dumps(record, indent=1, sort_keys=True) + "\n", encoding="utf-8", newline="\n")
    elif rec_path.is_file():
        want = json.loads(rec_path.read_text(encoding="utf-8"))
        for rel, lines in want["text"].items():
            if record["text"].get(rel) != lines:
                problems.append(f"{rel} differs from the {PLATFORM} record")
        for rel, info in want["files"].items():
            got = record["files"].get(rel) or {}
            for key in ("mesh", "stl"):
                if key in info and got.get(key) != info[key]:
                    problems.append(f"{rel}: {key} {got.get(key)} != {info[key]}")
            if got.get("sha256") != info["sha256"]:
                problems.append(f"{rel}: bytes changed (sha256)")
    assert not problems, "\n".join(problems)


def _norm_standard(rel: str, text: str) -> str:
    return _DURATION.sub("<s>", text) if rel == "log.gmsh_host.txt" else text


STANDARD_TEXT = [
    "system/controlDict",
    "system/fvSchemes",
    "system/fvSolution",
    "constant/triSurface/patch_types.txt",
]


# ---------------------------------------------------------------------------
# Standard
# ---------------------------------------------------------------------------


def test_standard_hex_core(tmp_path: Path):
    case = _standard(tmp_path, fineness=2, hex_core=True)
    _check(
        case,
        "standard-hexcore-f2",
        text=[*STANDARD_TEXT, "system/snappyHexMeshDict"],
        platform_text=["log.gmsh_host.txt"],
        binary=["constant/triSurface/geometry.msh", "constant/triSurface/geometry_mm.brep"],
        normalize=_norm_standard,
    )


def test_standard_without_hex_core(tmp_path: Path):
    case = _standard(tmp_path, fineness=2, hex_core=False)
    _check(
        case,
        "standard-tets-f2",
        text=[*STANDARD_TEXT, "system/snappyHexMeshDict"],
        platform_text=["log.gmsh_host.txt"],
        binary=["constant/triSurface/geometry.msh"],
        normalize=_norm_standard,
    )


def test_standard_with_refinements(tmp_path: Path):
    case = _standard(tmp_path, fineness=2, hex_core=True, refinements=True)
    _check(
        case,
        "standard-refined-f2",
        text=[*STANDARD_TEXT, "system/snappyHexMeshDict"],
        platform_text=["log.gmsh_host.txt"],
        binary=["constant/triSurface/geometry.msh"],
        normalize=_norm_standard,
    )


def test_standard_round_plate(tmp_path: Path):
    """A second geometry: a flat plate with a round hole, inlet face 5, outlet face 3."""
    case = _standard(tmp_path, fineness=5, hex_core=True, step=ROUND, faces=(5, 3))
    _check(
        case,
        "standard-round-f5",
        text=[*STANDARD_TEXT, "system/snappyHexMeshDict"],
        platform_text=["log.gmsh_host.txt"],
        binary=["constant/triSurface/geometry.msh"],
        normalize=_norm_standard,
    )


# ---------------------------------------------------------------------------
# Hex-dominant
# ---------------------------------------------------------------------------

SNAPPY_TEXT = [
    "system/blockMeshDict",
    "system/snappyHexMeshDict",
    "system/surfaceFeatureExtractDict",
    "system/controlDict",
    "system/fvSchemes",
    "system/fvSolution",
]


def _norm_snappy(rel: str, text: str) -> str:
    """Hex-dominant's WSL script and geometry meta, without this run's folders."""
    if rel.endswith(".render.sh"):
        text = re.sub(r'^WIN_OUT="[^"]*"$', 'WIN_OUT="<case>"', text, flags=re.M)
        return re.sub(r"^# Placeholders: .*$", "# Placeholders: <wsl case> <case> <generate id>", text, flags=re.M)
    if rel == "w23-geometry-meta.json":
        doc = json.loads(text)
        for key in ("step_path", "body1_path_src", "project_id"):
            doc.pop(key, None)
        return json.dumps(doc, indent=1, sort_keys=True) + "\n"
    return text


def _snappy_binary(case: Path) -> list[str]:
    return sorted(p.relative_to(case).as_posix() for p in (case / "constant" / "triSurface").glob("*.stl"))


def test_hex_dominant_with_layers(tmp_path: Path):
    case = _snappy(tmp_path, fineness=5, layers=True)
    _check(
        case,
        "hexdominant-layers-f5",
        text=[*SNAPPY_TEXT, "generate_snappy.render.sh"],
        platform_text=["w23-geometry-meta.json"],
        binary=_snappy_binary(case),
        normalize=_norm_snappy,
    )


def test_hex_dominant_with_refinements(tmp_path: Path):
    case = _snappy(tmp_path, fineness=5, layers=False, refinements=True)
    _check(
        case,
        "hexdominant-refined-f5",
        text=[*SNAPPY_TEXT, "generate_snappy.render.sh"],
        platform_text=["w23-geometry-meta.json"],
        binary=_snappy_binary(case),
        normalize=_norm_snappy,
    )


# ---------------------------------------------------------------------------
# cfMesh (stays in the core)
# ---------------------------------------------------------------------------


@pytest.mark.slow
def test_cfmesh(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    case = _cfmesh(tmp_path, monkeypatch, fineness=1)
    _check(
        case,
        "cfmesh-f1",
        text=[
            "system/meshDict",
            "system/controlDict",
            "system/fvSchemes",
            "system/fvSolution",
            "system/meshQualityDict",
            "system/createPatchDict.cfmeshFaces",
            "constant/triSurface/patch_types.txt",
        ],
        platform_text=["log.cfmesh_host.txt"],
        binary=["constant/triSurface/geometry.stl"],
    )
