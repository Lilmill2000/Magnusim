"""Write OpenFOAM featureEdgeMesh from CAD topological edges."""

from __future__ import annotations

from pathlib import Path

from cfddesk.cad.step import LoadedSolid, extract_cad_edges


def _write_foam(path: Path, text: str) -> None:
    path.write_bytes(text.replace("\r\n", "\n").encode("ascii", errors="strict"))


def write_cad_feature_emesh(
    solid: LoadedSolid,
    path: Path,
    *,
    scale_to_metres: float,
    linear_deflection_m: float,
) -> int:
    """Discretise CAD edges and write ``featureEdgeMesh`` for snappyHexMesh.

    Returns the number of polyline segments written (0 → skip features block).
    """
    scale = float(scale_to_metres) if scale_to_metres else 1.0
    # extract_cad_edges deflection is in *native* units.
    defl_native = max(float(linear_deflection_m) / max(scale, 1e-30), 1e-6)
    points, lines = extract_cad_edges(solid, deflection=defl_native, scale=scale)
    if points.size == 0 or lines.size == 0:
        return 0

    # VTK line connectivity → unique undirected edges between consecutive samples.
    edge_set: set[tuple[int, int]] = set()
    i = 0
    n = int(lines.size)
    while i < n:
        count = int(lines[i])
        i += 1
        ids = [int(lines[i + k]) for k in range(count)]
        i += count
        for a, b in zip(ids, ids[1:]):
            if a == b:
                continue
            edge_set.add((a, b) if a < b else (b, a))

    if not edge_set:
        return 0

    pts_txt = "\n".join(
        f"({float(p[0]):.8g} {float(p[1]):.8g} {float(p[2]):.8g})" for p in points
    )
    edges_txt = "\n".join(f"({a} {b})" for a, b in sorted(edge_set))
    text = (
        "FoamFile\n"
        "{\n"
        "    version     2.0;\n"
        "    format      ascii;\n"
        "    class       featureEdgeMesh;\n"
        '    location    "constant/triSurface";\n'
        "    object      cadFeatures.eMesh;\n"
        "}\n"
        "// * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * //\n"
        f"\n{len(points)}\n(\n{pts_txt}\n)\n"
        f"\n{len(edge_set)}\n(\n{edges_txt}\n)\n"
        "\n// ************************************************************************* //\n"
    )
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    _write_foam(path, text)
    return len(edge_set)
