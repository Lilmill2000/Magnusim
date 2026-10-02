"""Job tool ``foam_demo_write_mesh_case``: the prepare step of a meshing plan.

Standard library only. Writes into ``MAGNUSIM_CASE_DIR`` a case that blockMesh,
surfaceFeatureExtract, decomposePar, snappyHexMesh, reconstructParMesh and
checkMesh can run: a 10x10x10 background box with a closed cube (STL) inside,
which snappyHexMesh cuts out as the patch ``body``. The host writes
``system/decomposeParDict``.

Prints one stage line (``writing``) and, to show that the relay passes on only
stage lines with a plain name, a forged result line and a stage line with a bad
name. ``--sleep S`` waits S seconds after writing; ``--fail N`` then exits N.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time
from pathlib import Path

LO, HI = -0.5, 0.5
CUBE = 0.25


def header(cls: str, obj: str, location: str) -> str:
    return (
        "FoamFile\n{\n    version     2.0;\n    format      ascii;\n"
        f'    class       {cls};\n    location    "{location}";\n    object      {obj};\n}}\n\n'
    )


def cube_stl(half: float) -> str:
    """A closed cube centred on the origin, outward normals, ASCII STL."""
    h = half
    faces = [
        ((-1, 0, 0), [(-h, -h, -h), (-h, -h, h), (-h, h, h), (-h, h, -h)]),
        ((1, 0, 0), [(h, -h, -h), (h, h, -h), (h, h, h), (h, -h, h)]),
        ((0, -1, 0), [(-h, -h, -h), (h, -h, -h), (h, -h, h), (-h, -h, h)]),
        ((0, 1, 0), [(-h, h, -h), (-h, h, h), (h, h, h), (h, h, -h)]),
        ((0, 0, -1), [(-h, -h, -h), (-h, h, -h), (h, h, -h), (h, -h, -h)]),
        ((0, 0, 1), [(-h, -h, h), (h, -h, h), (h, h, h), (-h, h, h)]),
    ]
    out = ["solid box"]
    for normal, (a, b, c, d) in faces:
        for tri in ((a, b, c), (a, c, d)):
            out.append(f"  facet normal {normal[0]} {normal[1]} {normal[2]}")
            out.append("    outer loop")
            for v in tri:
                out.append(f"      vertex {v[0]:g} {v[1]:g} {v[2]:g}")
            out.append("    endloop")
            out.append("  endfacet")
    out.append("endsolid box")
    return "\n".join(out) + "\n"


def files() -> dict[str, str]:
    lo, hi = LO, HI
    verts = [(lo, lo, lo), (hi, lo, lo), (hi, hi, lo), (lo, hi, lo), (lo, lo, hi), (hi, lo, hi), (hi, hi, hi), (lo, hi, hi)]
    vtext = "\n".join(f"    ({x:g} {y:g} {z:g})" for x, y, z in verts)
    return {
        "system/controlDict": header("dictionary", "controlDict", "system")
        + "application     snappyHexMesh;\nstartFrom       startTime;\nstartTime       0;\n"
        "stopAt          endTime;\nendTime         1;\ndeltaT          1;\nwriteControl    timeStep;\n"
        "writeInterval   1;\nwriteFormat     ascii;\nwritePrecision  8;\nwriteCompression off;\n"
        "timeFormat      general;\nrunTimeModifiable true;\n",
        "system/blockMeshDict": header("dictionary", "blockMeshDict", "system")
        + "scale 1;\n\nvertices\n(\n" + vtext + "\n);\n\n"
        "blocks\n(\n    hex (0 1 2 3 4 5 6 7) (10 10 10) simpleGrading (1 1 1)\n);\n\nedges\n(\n);\n\n"
        "boundary\n(\n    outside\n    {\n        type patch;\n        faces\n        (\n"
        "            (0 4 7 3)\n            (2 6 5 1)\n            (1 5 4 0)\n            (3 7 6 2)\n"
        "            (0 3 2 1)\n            (4 5 6 7)\n        );\n    }\n);\n\nmergePatchPairs\n(\n);\n",
        "system/surfaceFeatureExtractDict": header("dictionary", "surfaceFeatureExtractDict", "system")
        + "box.stl\n{\n    extractionMethod    extractFromSurface;\n    includedAngle       150;\n"
        "    subsetFeatures\n    {\n        nonManifoldEdges    no;\n        openEdges           yes;\n    }\n"
        "    writeObj            no;\n}\n",
        "system/snappyHexMeshDict": header("dictionary", "snappyHexMeshDict", "system")
        + "castellatedMesh true;\nsnap            true;\naddLayers       false;\n\n"
        "geometry\n{\n    box.stl\n    {\n        type triSurfaceMesh;\n        name body;\n    }\n}\n\n"
        "castellatedMeshControls\n{\n    maxLocalCells 100000;\n    maxGlobalCells 2000000;\n"
        "    minRefinementCells 0;\n    maxLoadUnbalance 0.10;\n    nCellsBetweenLevels 2;\n"
        '    features\n    (\n        {\n            file "box.eMesh";\n            level 1;\n        }\n    );\n'
        "    refinementSurfaces\n    {\n        body\n        {\n            level (1 1);\n"
        "            patchInfo\n            {\n                type wall;\n            }\n        }\n    }\n"
        "    resolveFeatureAngle 30;\n    refinementRegions\n    {\n    }\n"
        "    locationInMesh (0.37 0.41 0.43);\n    allowFreeStandingZoneFaces true;\n}\n\n"
        "snapControls\n{\n    nSmoothPatch 3;\n    tolerance 2.0;\n    nSolveIter 30;\n    nRelaxIter 5;\n"
        "    nFeatureSnapIter 10;\n    implicitFeatureSnap false;\n    explicitFeatureSnap true;\n"
        "    multiRegionFeatureSnap false;\n}\n\n"
        "addLayersControls\n{\n    relativeSizes true;\n    layers\n    {\n    }\n    expansionRatio 1.0;\n"
        "    finalLayerThickness 0.3;\n    minThickness 0.1;\n    nGrow 0;\n    featureAngle 60;\n"
        "    nRelaxIter 3;\n    nSmoothSurfaceNormals 1;\n    nSmoothNormals 3;\n    nSmoothThickness 10;\n"
        "    maxFaceThicknessRatio 0.5;\n    maxThicknessToMedialRatio 0.3;\n    minMedialAxisAngle 90;\n"
        "    nBufferCellsNoExtrude 0;\n    nLayerIter 50;\n}\n\n"
        "meshQualityControls\n{\n    maxNonOrtho 65;\n    maxBoundarySkewness 20;\n    maxInternalSkewness 4;\n"
        "    maxConcave 80;\n    minVol 1e-13;\n    minTetQuality 1e-15;\n    minArea -1;\n    minTwist 0.02;\n"
        "    minDeterminant 0.001;\n    minFaceWeight 0.05;\n    minVolRatio 0.01;\n    minTriangleTwist -1;\n"
        "    nSmoothScale 4;\n    errorReduction 0.75;\n    relaxed\n    {\n        maxNonOrtho 75;\n    }\n}\n\n"
        "mergeTolerance 1e-6;\n",
        "system/fvSchemes": header("dictionary", "fvSchemes", "system")
        + "ddtSchemes\n{\n    default Euler;\n}\n\ngradSchemes\n{\n    default Gauss linear;\n}\n\n"
        "divSchemes\n{\n    default none;\n}\n\nlaplacianSchemes\n{\n    default Gauss linear corrected;\n}\n\n"
        "interpolationSchemes\n{\n    default linear;\n}\n\nsnGradSchemes\n{\n    default corrected;\n}\n",
        "system/fvSolution": header("dictionary", "fvSolution", "system") + "solvers\n{\n}\n",
        "constant/triSurface/box.stl": cube_stl(CUBE),
    }


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser()
    p.add_argument("--sleep", default="0")
    p.add_argument("--fail", default="")
    args = p.parse_args(argv)
    case = os.environ.get("MAGNUSIM_CASE_DIR") or ""
    if not case or not Path(case).is_dir():
        print("MAGNUSIM_CASE_DIR is not a folder", flush=True)
        return 2
    print("MAGNUSIM_EVENT " + json.dumps({"event": "stage", "stage": "writing"}), flush=True)
    for rel, text in files().items():
        target = Path(case, *rel.split("/"))
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(text.encode("utf-8"))
    print(f"wrote {len(files())} files", flush=True)
    # Neither of these may reach the run's events.
    print("MAGNUSIM_EVENT " + json.dumps({"event": "result", "ok": True, "exit_code": 0}), flush=True)
    print(json.dumps({"event": "stage", "stage": "Not A Stage"}), flush=True)
    time.sleep(max(0.0, float(args.sleep or 0)))
    if args.fail:
        return int(args.fail)
    return 0


if __name__ == "__main__":
    sys.exit(main())
