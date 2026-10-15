"""Force result controls on picked faces: the polyMesh reader/writer and the
boundary face split (fixtures/force-faces: the 2D cavity mesh as OpenFOAM v2606
wrote it, ascii, and converted to binary by foamFormatConvert)."""

from __future__ import annotations

import dataclasses
import json
import shutil
from pathlib import Path

import numpy as np
import pytest
from conftest import FIXTURES, JS_PROJECT
from conftest import run_spec as load_run_spec

from incompressible_flow.force_faces import (
    face_number,
    force_records,
    owner_entries,
    piece_name,
    piece_owner,
    plan_force_faces,
    split_faces,
    with_pieces,
)
from incompressible_flow.polymesh import faces_of, read_boundary, read_list, read_points, write_list

MESHES = FIXTURES / "force-faces"


@pytest.fixture(params=["ascii", "binary"])
def mesh(request, tmp_path: Path) -> Path:
    dst = tmp_path / request.param / "polyMesh"
    shutil.copytree(MESHES / request.param / "constant" / "polyMesh", dst)
    return dst


def _faces(poly: Path) -> list[tuple[int, ...]]:
    offsets, labels = faces_of(read_list(poly / "faces"))
    return [tuple(int(v) for v in labels[offsets[i] : offsets[i + 1]]) for i in range(len(offsets) - 1)]


class WallSides:
    """Stands in for the core's CAD classification: the cavity's fixed walls are
    face 1 (x = 0), face 2 (x = 0.1) and face 3 (y = 0); the lid is face 4."""

    def __init__(self) -> None:
        self.calls = 0
        self.asked = 0

    def face_bounds(self, numbers):
        boxes = {1: ([0, 0, -1], [0, 0.1, 1]), 2: ([0.1, 0, -1], [0.1, 0.1, 1]), 3: ([0, 0, -1], [0.1, 0, 1])}
        got = [boxes[n] for n in numbers if n in boxes]
        if not got:
            return None
        return np.min([g[0] for g in got], axis=0), np.max([g[1] for g in got], axis=0)

    def nearest_face_numbers(self, centres: np.ndarray) -> list[int]:
        self.calls += 1
        self.asked += len(centres)
        out = []
        for x, y, _z in centres:
            if x < 1e-6:
                out.append(1)
            elif x > 0.1 - 1e-6:
                out.append(2)
            elif y < 1e-6:
                out.append(3)
            else:
                out.append(4)
        return out


@pytest.mark.parametrize("fmt", ["ascii", "binary"])
@pytest.mark.parametrize("name", ["faces", "owner", "neighbour"])
def test_a_list_written_back_unchanged_is_the_same_file(tmp_path: Path, fmt: str, name: str) -> None:
    src = MESHES / fmt / "constant" / "polyMesh" / name
    lst = read_list(src)
    write_list(lst, tmp_path / name)
    assert (tmp_path / name).read_bytes() == src.read_bytes()


@pytest.mark.parametrize("fmt", ["ascii", "binary"])
def test_both_formats_read_the_same_mesh(fmt: str) -> None:
    poly = MESHES / fmt / "constant" / "polyMesh"
    assert len(read_points(poly / "points")) == 882
    assert len(read_list(poly / "owner").lists[0]) == 1640
    assert len(read_list(poly / "neighbour").lists[0]) == 760
    assert [p.name for p in read_boundary(poly / "boundary").patches] == ["movingWall", "fixedWalls", "frontAndBack"]
    assert _faces(poly) == _faces(MESHES / "ascii" / "constant" / "polyMesh")


def test_split_moves_exactly_the_picked_faces_into_their_own_patch(mesh: Path) -> None:
    before = _faces(mesh)
    owner_before = read_list(mesh / "owner").lists[0].copy()
    fixed = next(p for p in read_boundary(mesh / "boundary").patches if p.name == "fixedWalls")
    points = read_points(mesh / "points")
    centres = np.array([points[list(f)].mean(axis=0) for f in before[fixed.start : fixed.start + fixed.size]])
    left = np.nonzero(centres[:, 0] < 1e-6)[0]
    assert len(left) == 20

    counts = split_faces(mesh, {piece_name(1, "fixedWalls"): ("fixedWalls", left)})

    assert counts == {"mgf_1__fixedWalls": 20}
    patches = read_boundary(mesh / "boundary").patches
    assert [p.name for p in patches] == ["movingWall", "fixedWalls", "mgf_1__fixedWalls", "frontAndBack"]
    piece = patches[2]
    assert piece.get("type") == "wall" and piece.get("inGroups").replace(" ", "") == "1(wall)"
    # Contiguous, covering every boundary face once.
    start = 760
    for p in patches:
        assert p.start == start
        start += p.size
    assert start == 1640
    assert patches[1].size == 40
    after = _faces(mesh)
    owner_after = read_list(mesh / "owner").lists[0]
    # Internal faces untouched; every face kept with its own cell.
    assert after[:760] == before[:760]
    assert sorted(zip(after, owner_after.tolist(), strict=True)) == sorted(zip(before, owner_before.tolist(), strict=True))
    moved = set(after[piece.start : piece.start + piece.size])
    assert moved == {before[fixed.start + i] for i in left}
    pts = read_points(mesh / "points")
    assert all(pts[list(f)].mean(axis=0)[0] < 1e-6 for f in moved)


def test_a_split_mesh_is_written_in_its_own_format(mesh: Path) -> None:
    fmt = mesh.parent.name
    split_faces(mesh, {"mgf_3__fixedWalls": ("fixedWalls", np.arange(5))})
    assert read_list(mesh / "faces").fmt == fmt
    assert read_list(mesh / "owner").fmt == fmt


def test_plan_splits_each_picked_face_per_owner_and_lists_its_pieces(mesh: Path) -> None:
    services = WallSides()
    records = force_records(
        [
            {"id": "a", "monitor_type": "force", "name": "Force 1", "faces": ["face 1@Body1", "face 3@Body1"]},
            {"id": "b", "monitor_type": "force", "name": "Force 2", "faces": ["face 3@Body1"]},
            {"id": "c", "monitor_type": "area_average", "name": "Area average 1", "faces": ["face 2@Body1"]},
        ]
    )
    assert [r["id"] for r in records] == ["a", "b"]

    out = plan_force_faces(mesh, records, {"fixedWalls", "movingWall"}, services)

    assert out["pieces"] == {"mgf_1__fixedWalls": "fixedWalls", "mgf_3__fixedWalls": "fixedWalls"}
    one, two = out["plans"]
    assert one["key"] == "force_force_1" and one["patches"] == ["mgf_1__fixedWalls", "mgf_3__fixedWalls"]
    assert two["key"] == "force_force_2" and two["patches"] == ["mgf_3__fixedWalls"]
    assert one["missing"] == [] and one["notes"] == []
    sizes = {p.name: p.size for p in read_boundary(mesh / "boundary").patches}
    assert sizes["mgf_1__fixedWalls"] == 20 and sizes["mgf_3__fixedWalls"] == 20 and sizes["fixedWalls"] == 20


def test_a_face_on_no_wall_is_named_and_nothing_else_moves(mesh: Path) -> None:
    out = plan_force_faces(
        mesh,
        [{"id": "a", "name": "Force 1", "faces": ["face 4@Body1", "face 9@Body1"]}],
        {"movingWall"},
        WallSides(),
    )
    plan = out["plans"][0]
    assert plan["patches"] == ["mgf_4__movingWall"]
    assert plan["missing"] == ["face 9@Body1"]
    assert "face 9@Body1" in plan["notes"][0]


def test_only_wall_patches_are_split(mesh: Path) -> None:
    # frontAndBack is empty: never split, even when a picked face's number matches its faces.
    out = plan_force_faces(mesh, [{"id": "a", "name": "F", "faces": ["face 1@Body1"]}], {"frontAndBack"}, WallSides())
    assert out["pieces"] == {}
    assert out["plans"][0]["key"] is None


def test_a_continued_run_keeps_its_pieces_and_does_not_split_again(mesh: Path) -> None:
    plan_force_faces(mesh, [{"id": "a", "name": "F", "faces": ["face 1"]}], {"fixedWalls"}, WallSides())
    services = WallSides()
    out = plan_force_faces(
        mesh, [{"id": "a", "name": "F", "faces": ["face 1", "face 2"]}], {"fixedWalls"}, services, restart=True
    )
    assert services.calls == 0
    assert out["pieces"] == {"mgf_1__fixedWalls": "fixedWalls"}
    assert out["plans"][0]["patches"] == ["mgf_1__fixedWalls"]
    assert out["plans"][0]["notes"] == ["Faces picked after this run started are measured from the next Start."]


def test_no_faces_picked_says_so() -> None:
    out = plan_force_faces(None, [{"id": "a", "name": "F", "faces": []}], set(), None)
    assert out["plans"][0]["key"] is None
    assert out["plans"][0]["notes"] == ["No faces are picked: pick them in the 3D view."]


def test_pieces_take_their_owners_entries_and_whole_wall_lists_include_them() -> None:
    entries = {"inlet": {"type": "fixedValue"}, "walls": {"type": "noSlip"}}
    pieces = {"mgf_2__walls": "walls", "mgf_1__walls": "walls"}
    out = owner_entries(entries, pieces)
    assert list(out) == ["inlet", "walls", "mgf_1__walls", "mgf_2__walls"]
    assert out["mgf_1__walls"] == {"type": "noSlip"} and out["mgf_1__walls"] is not entries["walls"]
    assert with_pieces(["walls"], pieces) == ["walls", "mgf_1__walls", "mgf_2__walls"]
    assert with_pieces(["inlet"], pieces) == ["inlet"]


def test_labels_and_piece_names() -> None:
    assert face_number("face 12@Body1") == 12 and face_number("Face 3") == 3
    assert face_number("edge 2") is None and face_number("face 0") is None
    assert piece_owner(piece_name(12, "my_wall")) == (12, "my_wall")
    assert piece_owner("walls") is None


def test_only_faces_near_the_picked_faces_are_classified(mesh: Path) -> None:
    services = WallSides()
    plan_force_faces(mesh, [{"id": "a", "name": "F", "faces": ["face 1"]}], {"fixedWalls", "movingWall"}, services)
    # Face 1 is the wall x = 0: its 20 mesh faces and the bottom wall's few next to it,
    # not all 80 wall faces.
    assert 20 <= services.asked < 40


# ---- the case writer -----------------------------------------------------------------


def _spec_on_cavity(tmp_path: Path, controls: list[dict], fmt: str = "binary", *, keep_bcs: bool = False):
    """The js-project study's run, meshed with the cavity: its patches are walls no BC
    claims (the study's BCs are dropped unless ``keep_bcs``)."""
    mesh = tmp_path / "mesh"
    shutil.copytree(MESHES / fmt / "constant", mesh / "constant")
    spec = load_run_spec(JS_PROJECT, run_id="run-force", require_mesh=False, n_procs=1)
    return dataclasses.replace(
        spec,
        mesh_case_dir=str(mesh),
        reference={"ref_area": 0.01, "ref_length": 0.1, "ref_cofr": [0.05, 0.05, 0]},
        result_controls=controls,
        forces_monitors=[],
        mapped=list(spec.mapped) if keep_bcs else [],
    )


def _block(text: str, key: str) -> str:
    start = text.index(f"    {key}\n")
    return text[start : text.index("    }", start)]


@pytest.mark.parametrize("fmt", ["ascii", "binary"])
def test_the_writer_splits_the_picked_faces_and_measures_them(tmp_path: Path, fmt: str) -> None:
    from incompressible_flow.writer import write_solve_case

    controls = [{"id": "f1", "monitor_type": "force", "name": "Force 1", "faces": ["face 1@Body1", "face 3@Body1"]}]
    spec = _spec_on_cavity(tmp_path, controls, fmt)
    report = write_solve_case(spec, tmp_path / "case", WallSides())
    assert report.get("ok", True) is not False, report
    case = tmp_path / "case"
    names = [p.name for p in read_boundary(case / "constant" / "polyMesh" / "boundary").patches]
    assert names == ["movingWall", "fixedWalls", "mgf_1__fixedWalls", "mgf_3__fixedWalls", "frontAndBack"]
    # The stored mesh is not touched.
    assert [p.name for p in read_boundary(tmp_path / "mesh" / "constant" / "polyMesh" / "boundary").patches] == [
        "movingWall",
        "fixedWalls",
        "frontAndBack",
    ]
    u = (case / "0" / "U").read_text(encoding="utf-8")
    owner = u[u.index("    fixedWalls") : u.index("}", u.index("    fixedWalls"))].split("{", 1)[1]
    for piece in ("mgf_1__fixedWalls", "mgf_3__fixedWalls"):
        assert u[u.index(f"    {piece}") : u.index("}", u.index(f"    {piece}"))].split("{", 1)[1] == owner
    control = (case / "system" / "controlDict").read_text(encoding="utf-8")
    forces = _block(control, "force_force_1")
    assert "type            forces;" in forces
    assert "patches         (mgf_1__fixedWalls mgf_3__fixedWalls);" in forces
    assert "CofR            (0.05 0.05 0);" in forces
    coeffs = _block(control, "fcoeffs_force_1")
    assert "type            forceCoeffs;" in coeffs and "Aref            0.01;" in coeffs
    side = json.loads((case / "w27-case.json").read_text(encoding="utf-8"))
    plan = side["force_controls"][0]
    assert plan["key"] == "force_force_1" and plan["coeffs_key"] == "fcoeffs_force_1"
    assert plan["faces"] == ["face 1@Body1", "face 3@Body1"] and plan["moment_coefficient"] is True
    assert "mgf_1__fixedWalls" in side["patches"]


def test_a_whole_wall_forces_monitor_still_measures_the_split_pieces(tmp_path: Path) -> None:
    from incompressible_flow.writer import write_solve_case

    controls = [
        {"id": "f1", "monitor_type": "force", "name": "Force 1", "faces": ["face 1@Body1"]},
        {"id": "w", "monitor_type": "forces", "name": "Forces 1", "boundaries": ["@walls"]},
    ]
    spec = _spec_on_cavity(tmp_path, controls)
    spec = dataclasses.replace(spec, forces_monitors=[{"id": "w", "name": "Forces 1", "boundaries": ["fixedWalls"]}])
    # A BC named fixedWalls on the cavity's patch (the monitor names BCs by id or name).
    spec = dataclasses.replace(
        spec, mapped=list(spec.mapped) + [{"patch": "fixedWalls", "bc": {"name": "fixedWalls", "bc_type": "Wall"}}]
    )
    write_solve_case(spec, tmp_path / "case", WallSides())
    control = (tmp_path / "case" / "system" / "controlDict").read_text(encoding="utf-8")
    assert "patches         (fixedWalls mgf_1__fixedWalls);" in _block(control, "forces_forces_1")


def test_a_force_on_an_inlet_face_is_refused_with_the_reason(tmp_path: Path) -> None:
    from incompressible_flow.writer import write_solve_case

    spec = _spec_on_cavity(tmp_path, [], keep_bcs=True)
    inlet = next(m for m in spec.mapped if "inlet" in str(m.get("patch")))
    label = inlet["bc"]["faces"][0]
    spec = dataclasses.replace(
        spec, result_controls=[{"id": "f1", "monitor_type": "force", "name": "Force 1", "faces": [label]}]
    )
    report = write_solve_case(spec, tmp_path / "case", WallSides())
    assert report["ok"] is False
    assert report["error"].startswith("Force 1 measures walls: face ")
    assert "which is not a wall" in report["error"]
    assert not (tmp_path / "case" / "constant" / "polyMesh").exists()


def test_a_run_with_no_force_controls_is_written_as_before(tmp_path: Path) -> None:
    from incompressible_flow.writer import write_solve_case

    spec = _spec_on_cavity(tmp_path, [{"id": "a", "monitor_type": "area_average", "name": "A", "faces": []}])
    services = WallSides()
    write_solve_case(spec, tmp_path / "case", services)
    assert services.calls == 0
    poly = tmp_path / "case" / "constant" / "polyMesh"
    for name in ("faces", "owner", "points"):
        assert (poly / name).read_bytes() == (tmp_path / "mesh" / "constant" / "polyMesh" / name).read_bytes()
    side = json.loads((tmp_path / "case" / "w27-case.json").read_text(encoding="utf-8"))
    assert side["force_controls"] == []
