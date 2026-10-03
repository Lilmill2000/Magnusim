"""The link job's preview, in the job's own process (host API 1.5, proposal 5.4 step 6).

``python -m cfddesk.cad.link_preview --shape IN --format brep [--names SIDECAR]
--shape-sha256 HEX --out DIR --report FILE`` reads the plugin's shape (binary or
text BREP), checks it and its face-name sidecar, and writes into DIR the files a
geometry folder holds: ``source.bbrep`` (BinTools), ``cad_faces.vtp``,
``cad_edges.vtp``, ``cad_preview.json`` (with the face table, without the centre of
mass, which is a follow-up) and ``face_names.json`` (the sidecar as sent).

The report is one JSON object: ``{ok: true, n_solids, n_faces, bounds, bodies,
names_sha256, encoding}`` or ``{ok: false, code, error}`` for a refusal of the input
(``unsupported_format``, ``bad_brep``, ``empty``, ``bad_face_names``). The exit code is
0 in both cases; any other failure exits non-zero, which the job reports as
``preview_failed``.

``--com BBREP`` prints the shape's centre of mass as one JSON line (the follow-up).
"""

from __future__ import annotations

import argparse
import json
import shutil
import sys
from pathlib import Path
from typing import Any


def _write_report(path: Path, doc: dict[str, Any]) -> None:
    tmp = path.with_name(path.name + ".tmp")
    tmp.write_text(json.dumps(doc), encoding="utf-8")
    tmp.replace(path)


def build(shape_path: Path, fmt: str, names_path: Path | None, shape_sha256: str | None, out: Path) -> dict[str, Any]:
    """Write the geometry files into ``out``; the report (raises LinkInputError on a refusal)."""
    from OCP.BinTools import BinTools

    from cfddesk.cad.link_input import (
        LinkInputError,
        canonical_names_sha256,
        check_face_names,
        check_link_shape,
        read_face_names,
        read_link_shape,
    )
    from cfddesk.cad.preview import export_preview

    read = read_link_shape(shape_path, fmt)
    visits = check_link_shape(read.shape)
    n_solids = len({body for _index, body, _face in visits if body is not None})
    names_doc = None
    summary: dict[str, Any] = {"named": 0}
    if names_path is not None:
        names_doc = read_face_names(names_path)
        summary = check_face_names(names_doc, visits, n_solids, shape_sha256)
    out.mkdir(parents=True, exist_ok=True)
    bbrep = out / "source.bbrep"
    if read.encoding == "binary":
        # The bytes the plugin sent: BinTools read them, so the host reads them too.
        shutil.copyfile(shape_path, bbrep)
    elif not BinTools.Write_s(read.shape, str(bbrep)):
        raise LinkInputError("bad_brep", "The shape could not be stored as a binary BREP.")
    meta_path = out / "cad_preview.json"
    meta = export_preview(
        out / "source.step", out / "cad_edges.vtp", out / "cad_faces.vtp", meta_path, shape=read.shape, com=False
    )
    # The files move into the geometry folder: name them as they will be there.
    meta["step_path"] = "source.step"
    meta["edges_vtp"] = "cad_edges.vtp"
    meta["faces_vtp"] = "cad_faces.vtp"
    bodies = _name_faces(meta, names_doc, n_solids)
    meta_path.write_text(json.dumps(meta, separators=(",", ":")), encoding="utf-8")
    if names_path is not None:
        shutil.copyfile(names_path, out / "face_names.json")
    return {
        "ok": True,
        "encoding": read.encoding,
        "n_solids": n_solids,
        "n_faces": len(visits),
        "bounds": meta.get("bounds"),
        "bodies": bodies,
        "names_sha256": canonical_names_sha256(names_doc) if names_doc is not None else None,
        "named": int(summary.get("named") or 0),
    }


def _name_faces(meta: dict[str, Any], names_doc: Any, n_solids: int) -> list[dict[str, Any]]:
    """Put the sidecar's names and labels on ``meta['faces']`` and add ``body_info``.

    Each face entry gains ``name`` and ``label`` from the sidecar row of its index.
    ``bodies`` stays the list of body labels readers expect (``["Body1", ...]``); the
    new ``body_info`` lists ``{ref, id, name, label, color}`` per body. Returns the
    bodies for ``link/state.json`` (``{index, ref, id, name, label}``).
    """
    from cfddesk.cad.link_input import clean_text

    by_face: dict[int, dict[str, Any]] = {}
    by_body: dict[int, dict[str, Any]] = {}
    if isinstance(names_doc, dict):
        by_face = {int(f["index"]): f for f in names_doc.get("faces") or [] if isinstance(f, dict)}
        by_body = {int(b["index"]): b for b in names_doc.get("bodies") or [] if isinstance(b, dict)}
    for face in meta.get("faces") or []:
        row = by_face.get(int(face.get("id") or 0))
        if not row:
            continue
        for key in ("name", "label"):
            if row.get(key):
                face[key] = clean_text(row[key])
    info: list[dict[str, Any]] = []
    out: list[dict[str, Any]] = []
    for i in range(1, n_solids + 1):
        row = by_body.get(i) or {}
        entry: dict[str, Any] = {"ref": f"Body{i}"}
        for key in ("id", "name", "label", "color"):
            if row.get(key):
                entry[key] = clean_text(row[key])
        info.append(entry)
        out.append({"index": i, **entry})
    meta["body_info"] = info
    return out


def centre_of_mass(bbrep: Path) -> dict[str, Any]:
    from OCP.BinTools import BinTools
    from OCP.TopoDS import TopoDS_Shape

    from cfddesk.cad.preview import shape_center_of_mass

    shape = TopoDS_Shape()
    BinTools.Read_s(shape, str(bbrep))
    com, kind = shape_center_of_mass(shape)
    return {"center_of_mass": com, "center_of_mass_kind": kind}


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="Preview of a linked geometry (the link job's own process)")
    ap.add_argument("--shape", type=Path)
    ap.add_argument("--format", default="brep")
    ap.add_argument("--names", type=Path, default=None)
    ap.add_argument("--shape-sha256", default=None)
    ap.add_argument("--out", type=Path)
    ap.add_argument("--report", type=Path)
    ap.add_argument("--com", type=Path, default=None, help="print the centre of mass of this binary BREP")
    args = ap.parse_args(argv)
    if args.com is not None:
        print("LINK_COM " + json.dumps(centre_of_mass(args.com)), flush=True)
        return 0
    if args.shape is None or args.out is None or args.report is None:
        ap.error("--shape, --out and --report are required")
    from cfddesk.cad.link_input import LinkInputError

    try:
        report = build(args.shape, args.format, args.names, args.shape_sha256, args.out)
    except LinkInputError as exc:
        report = {"ok": False, "code": exc.code, "error": exc.message}
    _write_report(args.report, report)
    print("LINK_PREVIEW " + json.dumps({"ok": report.get("ok"), "code": report.get("code")}), flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
