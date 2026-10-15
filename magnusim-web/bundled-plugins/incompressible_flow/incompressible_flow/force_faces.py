"""Force result controls: the force on exactly the faces the user picked.

OpenFOAM's ``forces`` function object measures whole patches, and the meshers make
one patch per boundary condition (the walls no BC claims share ``walls``). So the
case writer moves the mesh faces of each picked CAD face into a patch of its own,
in the run's copy of the mesh: ``mgf_<face number>__<owner patch>`` (one per CAD
face and the patch it came from). The piece keeps its owner's type and boundary
conditions (the field writer gives it the owner's entries), so the flow is the same;
the Force's ``forces`` / ``forceCoeffs`` objects list its pieces, and a whole-wall
Forces monitor lists its walls' pieces with them.

Only wall boundaries are split: a picked face on an inlet or outlet is refused at
Start (the writer's ``_force_problem``), since splitting a flow-rate inlet would
give each piece the whole flow. The stored mesh is not changed. A continued run keeps the
split it started with: a Force added since is measured from the next Start.
"""

from __future__ import annotations

import re
from collections.abc import Iterable, Mapping, Sequence
from pathlib import Path
from typing import Any

from .force_objects import force_coeffs_block, forces_block, monitor_key
from .function_objects import monitor_write_control_text
from .polymesh import (
    Patch,
    faces_of,
    read_boundary,
    read_list,
    read_points,
    write_boundary,
    write_list,
)

PIECE_PREFIX = "mgf_"
_PIECE = re.compile(r"^mgf_(\d+)__(.+)$")
_FACE_LABEL = re.compile(r"face\s+(\d+)", re.I)
# Patch types a split may take faces from (a wall BC's patch is "wall", or "patch"
# before the writer retypes it).
_SPLITTABLE_TYPES = ("wall", "patch")


def face_number(label: Any) -> int | None:
    """The face number of a web face label (``face 12@Body1`` is 12), else None."""
    m = _FACE_LABEL.search(str(label or ""))
    if not m:
        return None
    n = int(m.group(1))
    return n if n >= 1 else None


def piece_name(face: int, owner: str) -> str:
    return f"{PIECE_PREFIX}{int(face)}__{owner}"


def piece_owner(name: str) -> tuple[int, str] | None:
    """``(face number, owner patch)`` of a piece patch name, else None."""
    m = _PIECE.match(str(name or ""))
    return (int(m.group(1)), m.group(2)) if m else None


def force_records(result_controls: Iterable[Any] | None) -> list[dict[str, Any]]:
    """The result controls that are Force (on picked faces) controls: ``{id, name, faces}``."""
    out: list[dict[str, Any]] = []
    for rec in result_controls or []:
        if isinstance(rec, dict) and rec.get("monitor_type") == "force":
            faces = [str(f) for f in rec.get("faces") or [] if f]
            out.append({"id": rec.get("id"), "name": str(rec.get("name") or "Force"), "faces": faces})
    return out


def face_centres(points: Any, offsets: Any, labels: Any, start: int, size: int) -> Any:
    """The centre (mean of its points) of faces ``start`` .. ``start + size - 1``."""
    import numpy as np

    if size <= 0:
        return np.zeros((0, 3), dtype=np.float64)
    lo, hi = int(offsets[start]), int(offsets[start + size])
    pts = points[labels[lo:hi]]
    firsts = offsets[start : start + size] - lo
    sums = np.add.reduceat(pts, firsts, axis=0)
    return sums / np.diff(offsets[start : start + size + 1])[:, None]


def split_faces(poly_dir: Path | str, pieces: Mapping[str, tuple[str, Any]]) -> dict[str, int]:
    """Move boundary faces into new patches.

    ``pieces`` maps a new patch name to ``(owner patch, the owner's local face
    indices)``. Each piece goes right after its owner in the boundary list, with
    the owner's type and groups. Returns the number of faces in each new patch.
    The face order inside every patch keeps its order; nothing else moves.
    """
    import numpy as np

    poly = Path(poly_dir)
    boundary = read_boundary(poly / "boundary")
    faces = read_list(poly / "faces")
    owner = read_list(poly / "owner")
    offsets, labels = faces_of(faces)
    cells = owner.lists[0]
    n_faces = len(offsets) - 1
    by_owner: dict[str, list[tuple[str, Any]]] = {}
    for name, (own, local) in pieces.items():
        by_owner.setdefault(own, []).append((name, np.unique(np.asarray(local, dtype=np.int64))))
    names = {p.name for p in boundary.patches}
    for own in by_owner:
        if own not in names:
            raise ValueError(f"no patch {own!r} to split")
    order: list[Any] = []
    new_patches: list[Patch] = []
    counts: dict[str, int] = {}
    n_internal = boundary.patches[0].start if boundary.patches else n_faces
    order.append(np.arange(n_internal, dtype=np.int64))
    cursor = n_internal
    for p in boundary.patches:
        idx = np.arange(p.start, p.start + p.size, dtype=np.int64)
        taken = np.zeros(p.size, dtype=bool)
        moved: list[tuple[str, Any]] = []
        for name, local in sorted(by_owner.get(p.name, []), key=lambda x: x[0]):
            local = local[(local >= 0) & (local < p.size)]
            local = local[~taken[local]]
            taken[local] = True
            moved.append((name, idx[np.sort(local)]))
        keep = idx[~taken]
        order.append(keep)
        p.set("startFace", str(cursor))
        p.set("nFaces", str(len(keep)))
        new_patches.append(p)
        cursor += len(keep)
        for name, glob in moved:
            entries = [(k, v) for k, v in p.entries if k not in ("nFaces", "startFace")]
            piece = Patch(name=name, entries=entries + [("nFaces", str(len(glob))), ("startFace", str(cursor))])
            order.append(glob)
            new_patches.append(piece)
            counts[name] = len(glob)
            cursor += len(glob)
    if cursor != n_faces:
        raise ValueError(f"boundary covers {cursor - n_internal} faces of {n_faces - n_internal}")
    perm = np.concatenate(order)
    sizes = np.diff(offsets)[perm]
    new_offsets = np.zeros(n_faces + 1, dtype=np.int64)
    np.cumsum(sizes, out=new_offsets[1:])
    new_labels = np.concatenate([labels[offsets[f] : offsets[f + 1]] for f in perm]) if n_faces else labels
    faces.lists = [new_offsets, new_labels]
    owner.lists = [cells[perm]]
    write_list(faces)
    write_list(owner)
    boundary.patches = new_patches
    write_boundary(boundary)
    return counts


def existing_pieces(poly_dir: Path | str | None) -> dict[str, tuple[int, str]]:
    """The piece patches a mesh already has: ``{name: (face number, owner)}``."""
    if not poly_dir or not (Path(poly_dir) / "boundary").is_file():
        return {}
    out: dict[str, tuple[int, str]] = {}
    for p in read_boundary(Path(poly_dir) / "boundary").patches:
        hit = piece_owner(p.name)
        if hit:
            out[p.name] = hit
    return out


def plan_force_faces(
    poly_dir: Path | str | None,
    records: Sequence[dict[str, Any]],
    wall_patches: set[str],
    services: Any,
    *,
    restart: bool = False,
) -> dict[str, Any]:
    """Split the run's mesh for its Force controls and say what each measures.

    ``wall_patches`` are the patches whose faces may be split (walls). ``services``
    classifies boundary face centres by the CAD face they lie on
    (``nearest_face_numbers``). A continued run (``restart``) keeps the pieces its
    mesh has. Returns ``{"pieces": {piece: owner}, "plans": [...]}``.
    """
    poly = Path(poly_dir) if poly_dir else None
    have = existing_pieces(poly)
    wanted: dict[int, list[int]] = {}
    for rec in records:
        for label in rec.get("faces") or []:
            n = face_number(label)
            if n is not None:
                wanted.setdefault(n, [])
    made: dict[str, tuple[int, str]] = dict(have)
    notes_all: list[str] = []
    if poly is not None and wanted and not restart and not have:
        made.update(_split_for(poly, sorted(wanted), wall_patches, services, notes_all))
    plans: list[dict[str, Any]] = []
    taken: set[str] = set()
    for rec in records:
        name = rec["name"]
        nums = [n for n in (face_number(f) for f in rec.get("faces") or []) if n is not None]
        patches = sorted(p for p, (n, _own) in made.items() if n in nums)
        notes: list[str] = []
        if not rec.get("faces"):
            notes.append("No faces are picked: pick them in the 3D view.")
        found = {made[p][0] for p in patches}
        missing = [f for f in rec.get("faces") or [] if face_number(f) not in found]
        if missing and rec.get("faces"):
            if restart:
                notes.append("Faces picked after this run started are measured from the next Start.")
            else:
                notes.append(
                    "Not on this mesh's walls (inside the part, or left out of the mesh): " + ", ".join(missing) + "."
                )
        key = monitor_key("force", name, taken) if patches else None
        plans.append(
            {
                "id": rec.get("id"),
                "name": name,
                "faces": list(rec.get("faces") or []),
                "key": key,
                "coeffs_key": None,
                "patches": patches,
                "boundaries": [],
                "missing": missing,
                "notes": notes,
                "moment_coefficient": False,
            }
        )
    return {"pieces": {p: own for p, (_n, own) in made.items()}, "plans": plans, "notes": notes_all}


def _split_for(
    poly: Path,
    numbers: Sequence[int],
    wall_patches: set[str],
    services: Any,
    notes: list[str],
) -> dict[str, tuple[int, str]]:
    """Classify the wall faces of ``poly`` and split out those of ``numbers``."""
    import numpy as np

    if services is None or not hasattr(services, "nearest_face_numbers"):
        notes.append("This app cannot read the part's faces here: Force controls are not measured.")
        return {}
    zones = poly / "faceZones"
    if zones.is_file() and re.search(rb"^\s*[1-9]\d*\s*\(", zones.read_bytes().split(b"}", 1)[-1], re.M):
        notes.append("This mesh has face zones: Force controls are not measured on it.")
        return {}
    boundary = read_boundary(poly / "boundary")
    faces = read_list(poly / "faces")
    offsets, labels = faces_of(faces)
    points = read_points(poly / "points")
    pieces: dict[str, tuple[str, Any]] = {}
    made: dict[str, tuple[int, str]] = {}
    want = np.asarray(sorted(set(int(n) for n in numbers)), dtype=np.int64)
    # Only the mesh faces near the picked faces are classified (a big mesh has many).
    box = services.face_bounds(want.tolist()) if hasattr(services, "face_bounds") else None
    if box is not None:
        lo, hi = (np.asarray(v, dtype=np.float64) for v in box)
        margin = max(0.02 * float(np.linalg.norm(hi - lo)), 1e-6)
        lo, hi = lo - margin, hi + margin
    for p in boundary.patches:
        if p.name not in wall_patches or p.get("type") not in _SPLITTABLE_TYPES or p.size == 0:
            continue
        centres = face_centres(points, offsets, labels, p.start, p.size)
        near = np.ones(len(centres), dtype=bool)
        if box is not None:
            near = np.all((centres >= lo) & (centres <= hi), axis=1)
        nearest = np.zeros(len(centres), dtype=np.int64)
        if near.any():
            nearest[near] = np.asarray(services.nearest_face_numbers(centres[near]), dtype=np.int64)
        for n in want:
            local = np.nonzero(nearest == n)[0]
            if len(local):
                name = piece_name(int(n), p.name)
                pieces[name] = (p.name, local)
                made[name] = (int(n), p.name)
    if pieces:
        split_faces(poly, pieces)
    return made


def owner_entries(entries: dict[str, Any], pieces: Mapping[str, str]) -> dict[str, Any]:
    """A field's boundary entries with each piece given its owner's entry (right after it)."""
    out: dict[str, Any] = {}
    by_owner: dict[str, list[str]] = {}
    for piece, own in pieces.items():
        by_owner.setdefault(own, []).append(piece)
    for name, entry in entries.items():
        out[name] = entry
        for piece in sorted(by_owner.get(name, [])):
            out[piece] = dict(entry) if isinstance(entry, dict) else entry
    return out


def with_pieces(patches: Sequence[str], pieces: Mapping[str, str]) -> list[str]:
    """``patches`` and the pieces split from them (a whole-wall Forces monitor measures both)."""
    out = list(patches)
    for piece, own in sorted(pieces.items()):
        if own in patches and piece not in out:
            out.append(piece)
    return out


def force_functions_text(plans: Iterable[dict[str, Any]], reference: Any, *, transient: Any = None) -> str:
    """The forces (and forceCoeffs) blocks of the Force controls."""
    write = monitor_write_control_text(transient=transient)
    blocks: list[str] = []
    for plan in plans:
        if not plan.get("key"):
            continue
        blocks.append(
            forces_block(plan["key"], plan["patches"], rho=reference.rho, cofr=reference.cofr, write_control_text=write)
        )
        if plan.get("coeffs_key"):
            blocks.append(
                force_coeffs_block(
                    plan["coeffs_key"],
                    plan["patches"],
                    rho=reference.rho,
                    cofr=reference.cofr,
                    lift=reference.lift,
                    drag=reference.drag,
                    speed=reference.speed,
                    length=reference.length or 1.0,
                    area=reference.area,
                    write_control_text=write,
                )
            )
    return "\n".join(blocks)


def with_coefficients(plans: list[dict[str, Any]], reference: Any) -> list[dict[str, Any]]:
    """Give each measured plan its forceCoeffs key when the study has a reference area."""
    taken = {p["key"] for p in plans if p.get("key")}
    for plan in plans:
        if plan.get("key") and reference.area:
            plan["coeffs_key"] = monitor_key("fcoeffs", plan["name"], taken)
            plan["moment_coefficient"] = bool(reference.length)
    return plans
