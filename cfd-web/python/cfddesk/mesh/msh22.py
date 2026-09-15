"""ASCII MSH 2.2 writer for gmshToFoam (hex / pyr / tet / tri / quad)."""

from __future__ import annotations

from pathlib import Path

import numpy as np

# gmsh / MSH 2.2 element types
TRI = 2
QUAD = 3
TET = 4
HEX = 5
PRISM = 6
PYR = 7


def write_msh22(
    path: Path,
    nodes: np.ndarray,
    *,
    volume_cells: list[tuple[int, np.ndarray, int]],
    boundary_faces: list[tuple[int, np.ndarray, int, str]],
    physical_names: dict[int, tuple[int, str]],
) -> None:
    """Write MSH 2.2.

    ``volume_cells``: (etype, node_index_array 0-based, physical_tag)
    ``boundary_faces``: (etype, node_index_array 0-based, physical_tag, name)
    ``physical_names``: tag → (dim, name)
    """
    nodes = np.asarray(nodes, dtype=float)
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    lines: list[str] = [
        "$MeshFormat",
        "2.2 0 8",
        "$EndMeshFormat",
        "$PhysicalNames",
        str(len(physical_names)),
    ]
    for tag in sorted(physical_names):
        dim, name = physical_names[tag]
        lines.append(f'{dim} {tag} "{name}"')
    lines.append("$EndPhysicalNames")
    lines.append("$Nodes")
    lines.append(str(len(nodes)))
    for i, p in enumerate(nodes, start=1):
        lines.append(f"{i} {p[0]:.16g} {p[1]:.16g} {p[2]:.16g}")
    lines.append("$EndNodes")

    elems: list[str] = []
    eid = 1
    for etype, conn, ptag in volume_cells:
        ids = " ".join(str(int(j) + 1) for j in conn)
        elems.append(f"{eid} {etype} 2 {ptag} {ptag} {ids}")
        eid += 1
    for etype, conn, ptag, _name in boundary_faces:
        ids = " ".join(str(int(j) + 1) for j in conn)
        elems.append(f"{eid} {etype} 2 {ptag} {ptag} {ids}")
        eid += 1
    lines.append("$Elements")
    lines.append(str(len(elems)))
    lines.extend(elems)
    lines.append("$EndElements")
    path.write_text("\n".join(lines) + "\n", encoding="ascii", newline="\n")
