#!/usr/bin/env python3
"""Build the host's link contract fixtures (host API 1.5, gate l2-contract).

    python tools/gen_link_contract_fixtures.py

writes into ``tests/fixtures/link-contract/`` one folder per part:

- ``a-shared``: two boxes that touch and share one face (a General Fuse), so that
  face is visited once per body;
- ``b-internal``: one box with an internal face (a square inside the solid);
- ``c-apart``: two boxes that do not touch.

Each folder holds ``shape.bbrep`` (binary BREP), ``shape.brep`` (the same shape as a
text BREP), ``face_names.json`` (written with ``magnusim_sdk.link.write_face_names``)
and ``expected.json``: per face index, the body, centroid and area of that face,
computed from the boxes this script defines (their dimensions), not read back from a
plugin or from the host's own face table. The explorer's visit order only says which
defined face sits at which index. The output is deterministic: run it twice and the
hashes are the same.
"""

from __future__ import annotations

import hashlib
import json
import sys
from pathlib import Path

PY = Path(__file__).resolve().parents[1]
if str(PY) not in sys.path:
    sys.path.insert(0, str(PY))

OUT = PY / "tests" / "fixtures" / "link-contract"


def _box_faces(x0: float, y0: float, z0: float, dx: float, dy: float, dz: float) -> list[dict]:
    """The six faces of an axis-aligned box: side key, centroid and area, from its dimensions."""
    cx, cy, cz = x0 + dx / 2, y0 + dy / 2, z0 + dz / 2
    return [
        {"side": "-x", "centroid": [x0, cy, cz], "area": dy * dz},
        {"side": "+x", "centroid": [x0 + dx, cy, cz], "area": dy * dz},
        {"side": "-y", "centroid": [cx, y0, cz], "area": dx * dz},
        {"side": "+y", "centroid": [cx, y0 + dy, cz], "area": dx * dz},
        {"side": "-z", "centroid": [cx, cy, z0], "area": dx * dy},
        {"side": "+z", "centroid": [cx, cy, z0 + dz], "area": dx * dy},
    ]


def _make_box(x0, y0, z0, dx, dy, dz):
    from OCP.BRepPrimAPI import BRepPrimAPI_MakeBox
    from OCP.gp import gp_Pnt

    return BRepPrimAPI_MakeBox(gp_Pnt(x0, y0, z0), dx, dy, dz).Shape()


def _general_fuse(*shapes):
    from OCP.BRepAlgoAPI import BRepAlgoAPI_BuilderAlgo
    from OCP.TopTools import TopTools_ListOfShape

    args = TopTools_ListOfShape()
    for s in shapes:
        args.Append(s)
    fuse = BRepAlgoAPI_BuilderAlgo()
    fuse.SetArguments(args)
    fuse.Build()
    assert fuse.IsDone()
    return fuse.Shape()


def _compound(*shapes):
    from OCP.BRep import BRep_Builder
    from OCP.TopoDS import TopoDS_Compound

    b = BRep_Builder()
    comp = TopoDS_Compound()
    b.MakeCompound(comp)
    for s in shapes:
        b.Add(comp, s)
    return comp


def _with_internal_face(box, x: float, lo: float, hi: float):
    """``box`` as a solid that also holds a square face at ``x`` (lo..hi in y and z), INTERNAL."""
    from OCP.BRep import BRep_Builder
    from OCP.BRepBuilderAPI import BRepBuilderAPI_MakeFace, BRepBuilderAPI_MakePolygon
    from OCP.gp import gp_Pnt
    from OCP.TopAbs import TopAbs_INTERNAL, TopAbs_SHELL
    from OCP.TopExp import TopExp_Explorer
    from OCP.TopoDS import TopoDS_Shell, TopoDS_Solid

    b = BRep_Builder()
    solid = TopoDS_Solid()
    b.MakeSolid(solid)
    exp = TopExp_Explorer(box, TopAbs_SHELL)
    b.Add(solid, exp.Current())
    corners = [gp_Pnt(x, lo, lo), gp_Pnt(x, hi, lo), gp_Pnt(x, hi, hi), gp_Pnt(x, lo, hi)]
    poly = BRepBuilderAPI_MakePolygon(*corners, True)
    face = BRepBuilderAPI_MakeFace(poly.Wire(), True).Face()
    inner = TopoDS_Shell()
    b.MakeShell(inner)
    b.Add(inner, face.Oriented(TopAbs_INTERNAL))
    b.Add(solid, inner.Oriented(TopAbs_INTERNAL))
    return _compound(solid)


def _parts() -> dict:
    """Each part: its shape, and the faces it is defined to have, per body."""
    a1 = (0.0, 0.0, 0.0, 10.0, 10.0, 10.0)
    a2 = (10.0, 0.0, 0.0, 20.0, 10.0, 10.0)
    c1 = (0.0, 0.0, 0.0, 10.0, 10.0, 10.0)
    c2 = (20.0, 0.0, 0.0, 10.0, 10.0, 10.0)
    b1 = (0.0, 0.0, 0.0, 10.0, 10.0, 10.0)
    inner = {"side": "internal", "centroid": [5.0, 5.0, 5.0], "area": 36.0}
    return {
        "a-shared": {
            "shape": _general_fuse(_make_box(*a1), _make_box(*a2)),
            "bodies": {1: _box_faces(*a1), 2: _box_faces(*a2)},
            "shared": [10.0, 5.0, 5.0],
        },
        "b-internal": {
            "shape": _with_internal_face(_make_box(*b1), 5.0, 2.0, 8.0),
            "bodies": {1: _box_faces(*b1) + [inner]},
            "internal": inner["centroid"],
        },
        "c-apart": {
            "shape": _compound(_make_box(*c1), _make_box(*c2)),
            "bodies": {1: _box_faces(*c1), 2: _box_faces(*c2)},
        },
    }


def _centroid(face) -> list[float]:
    from OCP.BRepGProp import BRepGProp
    from OCP.GProp import GProp_GProps

    props = GProp_GProps()
    BRepGProp.SurfaceProperties_s(face, props)
    c = props.CentreOfMass()
    return [float(c.X()), float(c.Y()), float(c.Z())]


def _close(a: list[float], b: list[float]) -> bool:
    return max(abs(x - y) for x, y in zip(a, b, strict=True)) < 1e-6


def build(name: str, part: dict, out: Path) -> None:
    from magnusim_sdk.link import face_visits, write_face_names
    from OCP.BinTools import BinTools
    from OCP.BRepTools import BRepTools

    out.mkdir(parents=True, exist_ok=True)
    shape = part["shape"]
    assert BinTools.Write_s(shape, str(out / "shape.bbrep"))
    text = out / "shape.brep"
    assert BRepTools.Write_s(shape, str(text))
    text.write_bytes(text.read_bytes().replace(b"\r\n", b"\n"))
    expected = []
    faces = []
    for index, body, face in face_visits(shape):
        got = _centroid(face)
        defined = [f for f in part["bodies"][body] if _close(f["centroid"], got)]
        assert len(defined) == 1, (name, index, body, got)
        f = defined[0]
        expected.append({"index": index, "body": body, "side": f["side"], "centroid": f["centroid"], "area": f["area"]})
        faces.append({"index": index, "body": body, "name": f"B{body}:{f['side']}", "label": f"Body {body} {f['side']}"})
    bodies = [{"index": b, "id": f"id-{b}", "name": f"Body {b}", "label": f"Part {b}"} for b in sorted(part["bodies"])]
    sha = hashlib.sha256((out / "shape.bbrep").read_bytes()).hexdigest()
    write_face_names(out / "face_names.json", bodies, faces, sha)
    doc = {"part": name, "n_solids": len(part["bodies"]), "faces": expected}
    if "shared" in part:
        doc["shared_centroid"] = part["shared"]
    if "internal" in part:
        doc["internal_centroid"] = part["internal"]
    (out / "expected.json").write_text(json.dumps(doc, indent=2, sort_keys=True) + "\n", encoding="utf-8", newline="\n")


def main() -> int:
    for name, part in _parts().items():
        build(name, part, OUT / name)
    for p in sorted(OUT.rglob("*")):
        if p.is_file() and p.name != "README.md":
            print(p.relative_to(OUT).as_posix(), hashlib.sha256(p.read_bytes()).hexdigest()[:12])
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
