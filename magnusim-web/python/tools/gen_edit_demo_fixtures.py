#!/usr/bin/env python3
"""Build the edit-demo fixtures (host API 1.7): a box to edit, its edit, and their face names.

    python tools/gen_edit_demo_fixtures.py [--rebuild-step]

writes into ``tests/fixtures/edit-plugins/edit-demo/workspace/fixtures/``:

- ``box.step``: a 20 mm cube, x, y and z 0..20 mm (the geometry a test imports and edits).
  Written only when it is missing or with ``--rebuild-step``: its header carries the time
  it was written, and every names file below carries its hash;
- ``box.stl``: the same cube as an STL (a mesh import: no action may edit it);
- ``box.original_names.json``: a face-name file of ``box.step`` as the host numbers its
  faces (the host's own reader and face order), each face named by its side
  (``F:box:+z``, ...) with the fingerprint of that face (``centroid``, ``area``,
  ``normal``, mm), body ``b1`` "Box", its ``shape_sha256`` the STEP file's hash: what a
  page sends as ``originalNames``;
- ``box.rotated_names.json``: the same rows with each name and fingerprint moved to the
  next row (a matcher's slip on every face): no row matches its face, so the host refuses
  it (``bad_face_names``, more than 20 % of the rows do not match);
- ``box.one_wrong_names.json``: the top's row names the -x face (with the -x face's
  fingerprint): one row of six does not match, so the host drops that name and the top
  follows by shape only (it moved: its boundary condition is lost, and reported);
- ``box-pulled.bbrep``: the edit, the cube with its +z face pulled up 10 mm (z 0..30),
  a binary BREP, and ``box-pulled.face_names.json``, its faces named the same way (so a
  boundary condition on the top follows it by name, and one on the bottom too);
- ``box.bad_names.json``: ``box.original_names.json`` with another ``shape_sha256`` (the
  host refuses it, ``bad_face_names``).

The page of the edit-demo plugin fetches them; the outputs are committed.
"""

from __future__ import annotations

import hashlib
import json
import sys
from pathlib import Path

PY = Path(__file__).resolve().parents[1]
for _p in (PY, PY / "sdk"):
    if str(_p) not in sys.path:
        sys.path.insert(0, str(_p))

OUT = PY / "tests" / "fixtures" / "edit-plugins" / "edit-demo" / "workspace" / "fixtures"
SIDES = {(1, 0, 0): "+x", (-1, 0, 0): "-x", (0, 1, 0): "+y", (0, -1, 0): "-y", (0, 0, 1): "+z", (0, 0, -1): "-z"}
BODIES = [{"index": 1, "id": "b1", "name": "Box"}]


def _box(height: float):
    from OCP.BRepPrimAPI import BRepPrimAPI_MakeBox
    from OCP.gp import gp_Pnt

    return BRepPrimAPI_MakeBox(gp_Pnt(0, 0, 0), 20.0, 20.0, height).Shape()


def _faces(shape, fingerprints: bool = False) -> list[dict]:
    """``{index, body, name, label}`` per face visit, named by the side it faces (and its fingerprint)."""
    from cfddesk.cad.preview import face_properties

    out = []
    for f in face_properties(shape):
        side = SIDES[tuple(int(round(c)) for c in f["normal"])]
        row = {"index": f["id"], "body": int(f.get("body") or 1), "name": f"F:box:{side}", "label": f"Box {side}"}
        if fingerprints:
            row.update({"centroid": [round(float(c), 9) for c in f["centroid"]], "area": round(float(f["area"]), 9), "normal": [round(float(c), 9) for c in f["normal"]]})
        out.append(row)
    return out


def _sha(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def _names_doc(faces: list[dict], sha: str) -> dict:
    return {"format": "magnusim.face-names", "version": 1, "length_unit": "mm", "shape_sha256": sha, "bodies": BODIES, "faces": faces}


def _dump(path: Path, doc: dict) -> None:
    path.write_text(json.dumps(doc, sort_keys=True, separators=(",", ":")) + "\n", encoding="utf-8")


def main(argv: list[str] | None = None) -> int:
    from magnusim_sdk.link import check, write_face_names
    from OCP.BinTools import BinTools
    from OCP.BRepMesh import BRepMesh_IncrementalMesh
    from OCP.IFSelect import IFSelect_RetDone
    from OCP.Interface import Interface_Static
    from OCP.STEPControl import STEPControl_AsIs, STEPControl_Writer
    from OCP.StlAPI import StlAPI_Writer

    from cfddesk.cad.preview import load_step

    args = list(sys.argv[1:] if argv is None else argv)
    OUT.mkdir(parents=True, exist_ok=True)
    box = _box(20.0)
    step = OUT / "box.step"
    if "--rebuild-step" in args or not step.is_file():
        Interface_Static.SetCVal_s("write.step.unit", "MM")
        writer = STEPControl_Writer()
        writer.Transfer(box, STEPControl_AsIs)
        assert writer.Write(str(step)) == IFSelect_RetDone
        step.write_bytes(step.read_bytes().replace(b"\r\n", b"\n"))
    # The original's names in the host's own face order: its reader, its numbering.
    sha = _sha(step)
    rows = _faces(load_step(step), fingerprints=True)
    _dump(OUT / "box.original_names.json", _names_doc(rows, sha))
    keys = ("name", "label", "centroid", "area", "normal")
    rotated = [{**r, **{k: rows[(i + 1) % len(rows)][k] for k in keys}} for i, r in enumerate(rows)]
    _dump(OUT / "box.rotated_names.json", _names_doc(rotated, sha))
    top = next(i for i, r in enumerate(rows) if r["name"] == "F:box:+z")
    side = next(r for r in rows if r["name"] == "F:box:-x")
    one = [dict(r) for r in rows]
    one[top].update({k: side[k] for k in keys})
    _dump(OUT / "box.one_wrong_names.json", _names_doc(one, sha))
    _dump(OUT / "box.bad_names.json", _names_doc(rows, "0" * 64))
    BRepMesh_IncrementalMesh(box, 0.1)
    stl = OUT / "box.stl"
    StlAPI_Writer().Write(box, str(stl))
    pulled = _box(30.0)
    bbrep = OUT / "box-pulled.bbrep"
    assert BinTools.Write_s(pulled, str(bbrep))
    write_face_names(OUT / "box-pulled.face_names.json", BODIES, _faces(pulled), _sha(bbrep))
    problems = check(bbrep, OUT / "box-pulled.face_names.json")
    assert not problems, problems
    for p in sorted(OUT.iterdir()):
        print(p.name, _sha(p)[:12])
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
