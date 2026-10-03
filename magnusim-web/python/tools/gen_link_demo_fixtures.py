#!/usr/bin/env python3
"""Build the link-demo fixture exports (host API 1.5): deterministic BREPs and face-name sidecars.

    python tools/gen_link_demo_fixtures.py

writes into ``tests/fixtures/link-plugins/link-demo/workspace/exports/`` three versions of one
design, each a compound of two solids that share one face (a General Fuse):

- **Body 1** (id ``b1``): a box, x 0..10, y 0..20, z 0..30 mm;
- **Body 2** (id ``b2``): a box, x 0..10, y -10..0, z 0..30, sharing Body 1's -y face,
  so that face is visited twice (once per body).

The versions:

- ``v1``: Body 1 is built from two halves (y 0..10 and y 10..20), so its +x face is two
  faces with one name (``F:box:+x``), and a boss (x 3..7, y 3..7, z 30..35) stands on
  top. The boss's end face (``F:boss:end``) is where a test puts a BC.
- ``v2``: no boss (its end face is gone: lost); Body 1 is built from two halves the other
  way (x 0..5 and x 5..10), so its +x face is one face (the two v1 faces merge: two BCs on
  them are claimed twice) and its +y face is two (split); Body 1 is renamed "Fluid" with
  the same id.
- ``v3``: v2 with the boss back (its end face returns).

Files: ``v1.bbrep``, ``v2.bbrep``, ``v3.bbrep`` (binary BREPs), ``v1.brep`` (v1 as a text
BREP), and ``v1.face_names.json``, ``v2.face_names.json``, ``v3.face_names.json`` (written
with ``magnusim_sdk.link.write_face_names``, each carrying the sha256 of its binary BREP),
plus ``v1-renamed.face_names.json`` (v1 with other labels: a names-only change). For
link-demo-2, ``designs/v1.brep`` and ``designs/v2.brep`` (text BREPs) and their
``designs/v1.face_names.json`` and ``designs/v2.face_names.json``. Faces are
named by the part and side they lie on; halves of one side share the name, as a CAD
plugin names the pieces of one split face.

The tests copy these files into a project as the plugin's own export, then link them
through the host's route; the plugin's page (served from its workspace folder) fetches
them and links them through the bridge.
"""

from __future__ import annotations

import hashlib
import sys
from pathlib import Path

PY = Path(__file__).resolve().parents[1]
if str(PY) not in sys.path:
    sys.path.insert(0, str(PY))

OUT = PY / "tests" / "fixtures" / "link-plugins" / "link-demo" / "workspace" / "exports"
# link-demo-2's designs: v1 and v2 as text BREPs, with their faces (its backend writes the
# sidecar again with the text file's own hash when it exports).
DESIGNS = PY / "tests" / "fixtures" / "link-plugins" / "link-demo-2" / "designs"
SIDES = {(1, 0, 0): "+x", (-1, 0, 0): "-x", (0, 1, 0): "+y", (0, -1, 0): "-y", (0, 0, 1): "+z", (0, 0, -1): "-z"}
BOSS = (3.0, 3.0, 30.0, 4.0, 4.0, 5.0)


def _box(x0, y0, z0, dx, dy, dz):
    from OCP.BRepPrimAPI import BRepPrimAPI_MakeBox
    from OCP.gp import gp_Pnt

    return BRepPrimAPI_MakeBox(gp_Pnt(x0, y0, z0), dx, dy, dz).Shape()


def _fuse(*shapes):
    """One solid from touching boxes (the faces where they met stay split)."""
    from OCP.BRepAlgoAPI import BRepAlgoAPI_Fuse

    out = shapes[0]
    for s in shapes[1:]:
        op = BRepAlgoAPI_Fuse(out, s)
        op.Build()
        assert op.IsDone()
        out = op.Shape()
    from OCP.TopAbs import TopAbs_SOLID
    from OCP.TopExp import TopExp_Explorer

    exp = TopExp_Explorer(out, TopAbs_SOLID)
    solid = exp.Current()
    exp.Next()
    assert not exp.More(), "the parts of one body must fuse into one solid"
    return solid


def _general_fuse(*shapes):
    from OCP.BRepAlgoAPI import BRepAlgoAPI_BuilderAlgo
    from OCP.TopTools import TopTools_ListOfShape

    args = TopTools_ListOfShape()
    for s in shapes:
        args.Append(s)
    op = BRepAlgoAPI_BuilderAlgo()
    op.SetArguments(args)
    op.Build()
    assert op.IsDone()
    return op.Shape()


def _version(v: int):
    body2 = _box(0.0, -10.0, 0.0, 10.0, 10.0, 30.0)
    if v == 1:
        body1 = _fuse(_box(0, 0, 0, 10, 10, 30), _box(0, 10, 0, 10, 10, 30), _box(*BOSS))
    elif v == 2:
        body1 = _fuse(_box(0, 0, 0, 5, 20, 30), _box(5, 0, 0, 5, 20, 30))
    else:
        body1 = _fuse(_box(0, 0, 0, 5, 20, 30), _box(5, 0, 0, 5, 20, 30), _box(*BOSS))
    return _general_fuse(body1, body2)


def _face_name(body: int, normal: list[float], centroid: list[float]) -> tuple[str, str]:
    side = SIDES[tuple(int(round(c)) for c in normal)]
    if body == 2:
        return f"F:b2:{side}", f"Side box {side}"
    if centroid[2] > 30.0 + 1e-6:  # the boss stands above the box's top (z = 30)
        if side == "+z":
            return "F:boss:end", "Boss end"
        return f"F:boss:{side}", f"Boss {side}"
    return f"F:box:{side}", f"Box {side}"


def _names(shape, sha: str, version: int, label_prefix: str | None = None) -> tuple[list[dict], list[dict]]:
    from cfddesk.cad.preview import face_properties

    faces = []
    for f in face_properties(shape):
        name, label = _face_name(int(f["body"]), f["normal"], f["centroid"])
        if label_prefix:
            label = f"{label_prefix} {label}"
        faces.append({"index": f["id"], "body": f["body"], "name": name, "label": label})
    body1 = {"index": 1, "id": "b1", "name": "Body 1" if version == 1 else "Fluid"}
    bodies = [body1, {"index": 2, "id": "b2", "name": "Body 2"}]
    return bodies, faces


def main() -> int:
    from magnusim_sdk.link import check, write_face_names
    from OCP.BinTools import BinTools
    from OCP.BRepTools import BRepTools

    OUT.mkdir(parents=True, exist_ok=True)
    for stale in ("v1.bbrep", "v1.brep", "v2.bbrep", "v3.bbrep"):
        (OUT / stale).unlink(missing_ok=True)
    for v in (1, 2, 3):
        shape = _version(v)
        bbrep = OUT / f"v{v}.bbrep"
        assert BinTools.Write_s(shape, str(bbrep))
        sha = hashlib.sha256(bbrep.read_bytes()).hexdigest()
        bodies, faces = _names(shape, sha, v)
        write_face_names(OUT / f"v{v}.face_names.json", bodies, faces, sha)
        if v == 1:
            text = OUT / "v1.brep"
            assert BRepTools.Write_s(shape, str(text))
            text.write_bytes(text.read_bytes().replace(b"\r\n", b"\n"))
            bodies, faces = _names(shape, sha, v, label_prefix="Renamed")
            write_face_names(OUT / "v1-renamed.face_names.json", bodies, faces, sha)
        problems = check(bbrep, OUT / f"v{v}.face_names.json")
        assert not problems, problems
        if v in (1, 2):
            DESIGNS.mkdir(parents=True, exist_ok=True)
            text = DESIGNS / f"v{v}.brep"
            assert BRepTools.Write_s(shape, str(text))
            text.write_bytes(text.read_bytes().replace(b"\r\n", b"\n"))
            tsha = hashlib.sha256(text.read_bytes()).hexdigest()
            bodies, faces = _names(shape, tsha, v)
            write_face_names(DESIGNS / f"v{v}.face_names.json", bodies, faces, tsha)
            problems = check(text, DESIGNS / f"v{v}.face_names.json")
            assert not problems, problems
    for p in sorted(OUT.iterdir()):
        print(p.name, hashlib.sha256(p.read_bytes()).hexdigest()[:12])
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
