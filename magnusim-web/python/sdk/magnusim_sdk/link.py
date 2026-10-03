"""Linking a geometry (host API 1.5): the face numbering rule and the face-name sidecar.

A plugin whose study kind has ``links_geometry = true`` sends the host one compound
of solids, in mm, as an OCCT BREP (binary BinTools or text BRepTools), plus an
optional face-name sidecar (``face_names.json``). This module is the one copy of the
rules both sides use:

- :func:`face_visits`: the face numbering. A face's index is its 1-based position in
  ``TopExp_Explorer(shape, TopAbs_FACE)`` over the whole compound, counting every
  visit; a face two touching solids share is visited once per solid, so it has one
  index per solid, each with its own body. The host's face table, its viewport, its
  mesher and its checks all call this function.
- :func:`write_face_names`: writes the sidecar canonically (sorted keys, UTF-8, one
  line), so two exports of one design are byte-identical and the host finds "no
  change" from the file's hash alone.
- :func:`check`: the host's own checks of a shape and its sidecar (refusal codes
  ``unsupported_format``, ``bad_brep``, ``empty`` and ``bad_face_names``), from the same
  code the host's link job runs. From a shell::

      python -m magnusim_sdk.link check <shape.brep> [<face_names.json>]

  exits 0 when the host would accept the pair, else 1 and one line per problem.

Standard library only at import time: :func:`face_visits`, :func:`read_shape` and
:func:`check` import OCP when they are called, so a plugin environment needs OCP to
use them (as it needs gmsh for ``gmsh_helpers``).

The sidecar (format ``magnusim.face-names`` version 1)::

    {"format": "magnusim.face-names", "version": 1, "length_unit": "mm",
     "shape_sha256": "<sha256 of the shape file>",
     "bodies": [{"index": 1, "id": "b1", "name": "Body 1", "label": "Fluid", "color": "#8a9bb0"}],
     "faces": [{"index": 1, "body": 1, "name": "F:end", "label": "Extrude 1 - End"}]}

``name`` is the match key (faces and bodies are paired by it across updates);
``label`` is what the app shows. Body ``id`` is optional and pairs first, so a body
renamed by the user keeps its material.
"""

from __future__ import annotations

import hashlib
import json
import re
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Any

FORMATS = ("brep",)
NAMES_FORMAT = "magnusim.face-names"
NAMES_VERSION = 1
NAMES_MAX_BYTES = 32 * 1024 * 1024
MAX_FACES = 200_000
MAX_BODIES = 10_000
NAME_MAX = 200
LABEL_MAX = 120
_BIN_HEADER = b"Open CASCADE Topology"
_TEXT_HEADERS = (b"DBRep_DrawableShape", b"CASCADE Topology")
# Control characters, and the bidirectional controls a name could hide text with.
_CLEAN_RE = re.compile("[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069]")

__all__ = [
    "FORMATS",
    "LinkInputError",
    "LinkShape",
    "canonical_names_sha256",
    "check",
    "check_face_names",
    "check_shape",
    "clean_text",
    "face_visits",
    "read_face_names",
    "read_shape",
    "sha256_file",
    "write_face_names",
]


class LinkInputError(Exception):
    """A refusal of the link input: ``code`` is the host's refusal code."""

    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code
        self.message = message


@dataclass
class LinkShape:
    shape: Any
    #: "binary" (BinTools) or "text" (BRepTools)
    encoding: str


def sha256_file(path: str | Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def brep_encoding(path: str | Path) -> str | None:
    """'binary' or 'text' by the file's first bytes, None when it is neither."""
    with open(path, "rb") as fh:
        head = fh.read(256).lstrip()
    if head.startswith(_BIN_HEADER):
        return "binary"
    if any(head.startswith(h) for h in _TEXT_HEADERS):
        return "text"
    return None


def read_shape(path: str | Path, fmt: str = "brep") -> LinkShape:
    """The shape of a link input, or LinkInputError (unsupported_format, bad_brep)."""
    if fmt not in FORMATS:
        raise LinkInputError(
            "unsupported_format",
            f"This app reads the shape as {', '.join(repr(f) for f in FORMATS)}, not {fmt!r}.",
        )
    from OCP.BinTools import BinTools
    from OCP.BRep import BRep_Builder
    from OCP.BRepTools import BRepTools
    from OCP.TopoDS import TopoDS_Shape

    encoding = brep_encoding(path)
    if encoding is None:
        raise LinkInputError("bad_brep", "The shape is not an OCCT BREP file (binary or text).")
    shape = TopoDS_Shape()
    try:
        if encoding == "binary":
            BinTools.Read_s(shape, str(path))
        elif not BRepTools.Read_s(shape, str(path), BRep_Builder()):
            raise LinkInputError("bad_brep", "The text BREP could not be read.")
    except LinkInputError:
        raise
    except Exception as exc:  # OCCT raises its own stream errors for a version it does not read
        raise LinkInputError(
            "bad_brep",
            f"The {encoding} BREP could not be read by this app's OCCT"
            f" ({type(exc).__name__}). It may be written by a newer version.",
        ) from exc
    if shape.IsNull():
        raise LinkInputError("bad_brep", f"The {encoding} BREP holds no shape.")
    return LinkShape(shape=shape, encoding=encoding)


def face_visits(shape: Any) -> list[tuple[int, int | None, Any]]:
    """Every face visit as ``(index, body, face)``: the one face numbering rule.

    ``index`` is the 1-based position in ``TopExp_Explorer(shape, TopAbs_FACE)``
    over the whole shape, counting every visit. A face that two touching solids
    share is visited once per solid, so it has one index per solid. ``body`` is the
    1-based ``TopExp_Explorer(shape, TopAbs_SOLID)`` index of the solid being
    explored at that visit, None for a face outside every solid.

    The host's face table, its viewport's faceId/solidId scalars, its mesher's face
    records and each body's face list all number faces this way, so ``face N@BodyB``
    names the same face everywhere, and a plugin's sidecar index N is that face.
    """
    from OCP.TopAbs import TopAbs_FACE, TopAbs_SOLID
    from OCP.TopExp import TopExp_Explorer
    from OCP.TopoDS import TopoDS

    flat = []
    exp = TopExp_Explorer(shape, TopAbs_FACE)
    while exp.More():
        flat.append(TopoDS.Face_s(exp.Current()))
        exp.Next()
    # Each solid's own visits. The explorer goes depth first (compound -> solid ->
    # shell -> face), so these runs appear in ``flat`` in solid order, with any face
    # outside every solid in between.
    owned = []
    solids = TopExp_Explorer(shape, TopAbs_SOLID)
    body = 0
    while solids.More():
        body += 1
        fexp = TopExp_Explorer(solids.Current(), TopAbs_FACE)
        while fexp.More():
            owned.append((body, TopoDS.Face_s(fexp.Current())))
            fexp.Next()
        solids.Next()
    every_face_in_a_solid = len(owned) == len(flat)
    out: list[tuple[int, int | None, Any]] = []
    j = 0
    for i, face in enumerate(flat):
        b = None
        if j < len(owned) and (every_face_in_a_solid or owned[j][1].IsEqual(face)):
            b = owned[j][0]
            j += 1
        out.append((i + 1, b, face))
    return out


def check_shape(shape: Any) -> list[tuple[int, int | None, Any]]:
    """The face visits of a link shape, or LinkInputError (empty, bad_brep)."""
    from OCP.TopAbs import TopAbs_SOLID
    from OCP.TopExp import TopExp_Explorer

    if not TopExp_Explorer(shape, TopAbs_SOLID).More():
        raise LinkInputError("empty", "The shape has no solid. Send one compound of solids.")
    visits = face_visits(shape)
    outside = [index for index, body, _face in visits if body is None]
    if outside:
        raise LinkInputError(
            "bad_brep",
            f"Face {outside[0]} lies outside every solid ({len(outside)} such faces). Send one compound of solids.",
        )
    return visits


def clean_text(value: Any) -> str:
    """A name or label as the host keeps it: one line, no control or bidi characters."""
    return _CLEAN_RE.sub("", str(value or "")).strip()


def canonical_names_sha256(doc: Any) -> str:
    """The sidecar's content hash: its JSON with sorted keys and no whitespace."""
    text = json.dumps(doc, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def _bad(message: str) -> LinkInputError:
    return LinkInputError("bad_face_names", message)


def _check_text(where: str, value: Any, limit: int, *, required: bool) -> str | None:
    if value is None and not required:
        return None
    if not isinstance(value, str):
        raise _bad(f"{where} must be text")
    text = clean_text(value)
    if not text:
        raise _bad(f"{where} is empty")
    if len(text) > limit:
        raise _bad(f"{where} is longer than {limit} characters")
    return text


def read_face_names(path: str | Path) -> Any:
    """The parsed sidecar (bad_face_names when it is too large or not JSON)."""
    p = Path(path)
    if p.stat().st_size > NAMES_MAX_BYTES:
        raise _bad(f"the face-name file is larger than {NAMES_MAX_BYTES // (1024 * 1024)} MB")
    try:
        return json.loads(p.read_text(encoding="utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise _bad(f"the face-name file is not valid JSON ({exc})") from exc


def check_face_names(
    doc: Any,
    visits: list[tuple[int, int | None, Any]],
    n_solids: int,
    shape_sha256: str | None,
) -> dict[str, Any]:
    """Check a sidecar against the shape's face visits. Returns a summary.

    Raises LinkInputError(bad_face_names) naming the first rule broken: the units,
    ``shape_sha256``, the face count (by visit) and body count, an index out of range
    or listed twice, a face's ``body`` other than the solid its visit is in, two bodies
    with one name or one ``id``, and a name or label that is empty or too long.
    """
    if not isinstance(doc, dict):
        raise _bad("the face-name file must be a JSON object")
    if doc.get("format") != NAMES_FORMAT or doc.get("version") != NAMES_VERSION:
        raise _bad(f"format must be {NAMES_FORMAT!r} version {NAMES_VERSION}")
    if doc.get("length_unit") != "mm":
        raise _bad("length_unit must be 'mm'")
    given = doc.get("shape_sha256")
    if given is not None:
        if not isinstance(given, str) or not re.fullmatch(r"[0-9a-fA-F]{64}", given):
            raise _bad("shape_sha256 must be 64 hex digits")
        if shape_sha256 and given.lower() != shape_sha256.lower():
            raise _bad("shape_sha256 is not the hash of the shape sent with it")
    bodies = doc.get("bodies")
    faces = doc.get("faces")
    if not isinstance(bodies, list) or not isinstance(faces, list):
        raise _bad("bodies and faces must be lists")
    if len(bodies) > MAX_BODIES:
        raise _bad(f"more than {MAX_BODIES} bodies")
    if len(faces) > MAX_FACES:
        raise _bad(f"more than {MAX_FACES} faces")
    if len(bodies) != n_solids:
        raise _bad(f"{len(bodies)} bodies listed, the shape has {n_solids} solids")
    if len(faces) != len(visits):
        raise _bad(f"{len(faces)} faces listed, the shape has {len(visits)} face visits")
    seen_names: set[str] = set()
    seen_ids: set[str] = set()
    seen_index: set[int] = set()
    for i, body in enumerate(bodies):
        where = f"bodies[{i}]"
        if not isinstance(body, dict):
            raise _bad(f"{where} must be an object")
        index = body.get("index")
        if not isinstance(index, int) or isinstance(index, bool) or not 1 <= index <= n_solids:
            raise _bad(f"{where}.index is out of range")
        if index in seen_index:
            raise _bad(f"body index {index} is listed twice")
        seen_index.add(index)
        name = _check_text(f"{where}.name", body.get("name"), NAME_MAX, required=False)
        if name is not None:
            if name in seen_names:
                raise _bad(f"two bodies are named {name!r}")
            seen_names.add(name)
        _check_text(f"{where}.label", body.get("label"), LABEL_MAX, required=False)
        bid = body.get("id")
        if bid is not None:
            bid = _check_text(f"{where}.id", bid, NAME_MAX, required=True)
            assert bid is not None
            if bid in seen_ids:
                raise _bad(f"two bodies have the id {bid!r}")
            seen_ids.add(bid)
    by_index = {index: body for index, body, _face in visits}
    seen_index = set()
    named = 0
    for i, face in enumerate(faces):
        where = f"faces[{i}]"
        if not isinstance(face, dict):
            raise _bad(f"{where} must be an object")
        index = face.get("index")
        if not isinstance(index, int) or isinstance(index, bool) or index not in by_index:
            raise _bad(f"{where}.index is out of range")
        if index in seen_index:
            raise _bad(f"face index {index} is listed twice")
        seen_index.add(index)
        if face.get("body") != by_index[index]:
            raise _bad(f"face {index} is in body {by_index[index]}, not {face.get('body')!r}")
        if _check_text(f"{where}.name", face.get("name"), NAME_MAX, required=False):
            named += 1
        _check_text(f"{where}.label", face.get("label"), LABEL_MAX, required=False)
    return {"bodies": len(bodies), "faces": len(faces), "named": named}


_BODY_KEYS = ("index", "id", "name", "label", "color")
_FACE_KEYS = ("index", "body", "name", "label")


def _clean_rows(rows: Any, keys: tuple[str, ...], what: str) -> list[dict[str, Any]]:
    if not isinstance(rows, (list, tuple)):
        raise TypeError(f"{what} must be a list")
    out = []
    for row in rows:
        if not isinstance(row, dict):
            raise TypeError(f"each of {what} must be a dict")
        out.append({k: row[k] for k in keys if row.get(k) is not None})
    return sorted(out, key=lambda r: int(r.get("index") or 0))


def write_face_names(
    path: str | Path,
    bodies: list[dict[str, Any]],
    faces: list[dict[str, Any]],
    shape_sha256: str | None = None,
) -> str:
    """Write the sidecar canonically; returns the sha256 of the bytes written.

    ``bodies``: ``{index, id?, name?, label?, color?}`` per solid; ``faces``: ``{index,
    body, name?, label?}`` per face visit (see :func:`face_visits`). Keys with a None
    value are left out, rows are sorted by index and keys by name, so the same design
    always gives the same bytes. Pass ``shape_sha256`` (the shape file's hash) so the
    host can tell the sidecar belongs to that export.
    """
    doc: dict[str, Any] = {
        "format": NAMES_FORMAT,
        "version": NAMES_VERSION,
        "length_unit": "mm",
        "bodies": _clean_rows(bodies, _BODY_KEYS, "bodies"),
        "faces": _clean_rows(faces, _FACE_KEYS, "faces"),
    }
    if shape_sha256:
        doc["shape_sha256"] = str(shape_sha256).lower()
    data = (json.dumps(doc, sort_keys=True, separators=(",", ":"), ensure_ascii=False, allow_nan=False) + "\n").encode("utf-8")
    p = Path(path)
    p.parent.mkdir(parents=True, exist_ok=True)
    tmp = p.with_name(p.name + ".tmp")
    tmp.write_bytes(data)
    tmp.replace(p)
    return hashlib.sha256(data).hexdigest()


def check(shape_path: str | Path, face_names_path: str | Path | None = None, fmt: str = "brep") -> list[str]:
    """What the host would refuse in this shape and sidecar, as ``"<code>: <message>"`` lines.

    An empty list means the host accepts the pair. The checks are the link job's own:
    the format, a readable BREP, at least one solid, every face inside a solid, and
    every rule of the sidecar against the shape's face visits.
    """
    try:
        shape = read_shape(shape_path, fmt)
        visits = check_shape(shape.shape)
        if face_names_path is not None:
            n_solids = len({body for _index, body, _face in visits if body is not None})
            doc = read_face_names(face_names_path)
            check_face_names(doc, visits, n_solids, sha256_file(shape_path))
    except LinkInputError as exc:
        return [f"{exc.code}: {exc.message}"]
    except OSError as exc:
        return [f"not_found: {exc}"]
    return []


def main(argv: list[str] | None = None) -> int:
    args = list(sys.argv[1:] if argv is None else argv)
    if not args or args[0] != "check" or len(args) not in (2, 3):
        print("usage: python -m magnusim_sdk.link check <shape.brep> [<face_names.json>]", file=sys.stderr)
        return 2
    problems = check(args[1], args[2] if len(args) == 3 else None)
    for line in problems:
        print(line)
    if not problems:
        print("ok")
    return 1 if problems else 0


if __name__ == "__main__":
    sys.exit(main())
