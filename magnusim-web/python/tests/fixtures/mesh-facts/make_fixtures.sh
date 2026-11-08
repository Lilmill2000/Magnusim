#!/usr/bin/env bash
# Small OpenFOAM cases for the RH2 mesh-facts fixtures (checkMesh samples, a snappy layer
# report, and short pimpleFoam runs whose logged Courant numbers check the rate table).
# Runs serial (1 core). Work dir: ~/rh2-fixture-work (removed by the caller when done).
set -u
OUT="$1"   # where results are copied (a /mnt/c path)
W="$HOME/rh2-fixture-work"
rm -rf "$W"
mkdir -p "$W" "$OUT"
cd "$W"

hdr() { # class object
cat <<EOF
FoamFile
{
    version     2.0;
    format      ascii;
    class       $1;
    object      $2;
}
EOF
}

common_system() { # dir endTime deltaT
  local d="$1"
  mkdir -p "$d/system" "$d/constant" "$d/0"
  { hdr dictionary controlDict; cat <<EOF
application     pimpleFoam;
startFrom       startTime;
startTime       0;
stopAt          endTime;
endTime         $2;
deltaT          $3;
writeControl    timeStep;
writeInterval   100000;
purgeWrite      0;
writeFormat     ascii;
writePrecision  10;
writeCompression off;
timeFormat      general;
timePrecision   8;
runTimeModifiable false;
adjustTimeStep  no;
EOF
  } > "$d/system/controlDict"
  { hdr dictionary fvSchemes; cat <<'EOF'
ddtSchemes      { default Euler; }
gradSchemes     { default Gauss linear; }
divSchemes
{
    default         none;
    div(phi,U)      Gauss linearUpwind grad(U);
    div((nuEff*dev2(T(grad(U))))) Gauss linear;
}
laplacianSchemes { default Gauss linear corrected; }
interpolationSchemes { default linear; }
snGradSchemes   { default corrected; }
EOF
  } > "$d/system/fvSchemes"
  { hdr dictionary fvSolution; cat <<'EOF'
solvers
{
    p { solver GAMG; smoother GaussSeidel; tolerance 1e-7; relTol 0.01; }
    pFinal { $p; relTol 0; }
    "(U|UFinal)" { solver smoothSolver; smoother symGaussSeidel; tolerance 1e-7; relTol 0; }
}
PIMPLE
{
    nOuterCorrectors 1;
    nCorrectors 2;
    nNonOrthogonalCorrectors 1;
    pRefCell 0;
    pRefValue 0;
}
EOF
  } > "$d/system/fvSolution"
  { hdr dictionary transportProperties; echo "transportModel Newtonian;"; echo "nu 1e-03;"; } > "$d/constant/transportProperties"
  { hdr dictionary turbulenceProperties; echo "simulationType laminar;"; } > "$d/constant/turbulenceProperties"
}

# ---- Case A: 2D contraction (a forward-facing step), graded hexes ----
A="$W/contraction"
common_system "$A" 0.16 0.004
{ hdr dictionary blockMeshDict; cat <<'EOF'
convertToMeters 1;
vertices
(
    (0 0 0) (1 0 0) (1 0.3 0) (0 0.3 0) (0 1 0) (1 1 0) (3 0.3 0) (3 1 0)
    (0 0 0.1) (1 0 0.1) (1 0.3 0.1) (0 0.3 0.1) (0 1 0.1) (1 1 0.1) (3 0.3 0.1) (3 1 0.1)
);
blocks
(
    hex (0 1 2 3 8 9 10 11) (20 8 1) simpleGrading (0.25 1 1)
    hex (3 2 5 4 11 10 13 12) (20 16 1) simpleGrading (0.25 1 1)
    hex (2 6 7 5 10 14 15 13) (30 16 1) simpleGrading (4 1 1)
);
boundary
(
    inlet { type patch; faces ((0 8 11 3) (3 11 12 4)); }
    outlet { type patch; faces ((6 7 15 14)); }
    walls { type wall; faces ((0 1 9 8) (1 2 10 9) (2 6 14 10) (4 12 13 5) (5 13 15 7)); }
    frontAndBack { type empty; faces ((0 3 2 1) (3 4 5 2) (2 5 7 6) (8 9 10 11) (11 10 13 12) (10 14 15 13)); }
);
EOF
} > "$A/system/blockMeshDict"
{ hdr volVectorField U; cat <<'EOF'
dimensions [0 1 -1 0 0 0 0];
internalField uniform (1 0 0);
boundaryField
{
    inlet { type fixedValue; value uniform (1 0 0); }
    outlet { type zeroGradient; }
    walls { type noSlip; }
    frontAndBack { type empty; }
}
EOF
} > "$A/0/U"
{ hdr volScalarField p; cat <<'EOF'
dimensions [0 2 -2 0 0 0 0];
internalField uniform 0;
boundaryField
{
    inlet { type zeroGradient; }
    outlet { type fixedValue; value uniform 0; }
    walls { type zeroGradient; }
    frontAndBack { type empty; }
}
EOF
} > "$A/0/p"
( cd "$A" && openfoam2606 blockMesh > log.blockMesh 2>&1 && openfoam2606 checkMesh > log.checkMesh 2>&1; openfoam2606 pimpleFoam > log.pimpleFoam 2>&1; echo "A pimpleFoam exit $?" )

# ---- Case C: 3D snappy around a sphere with two layers (hex-dominant, polyhedra) ----
C="$W/sphere"
common_system "$C" 0.03 0.001
sed -i 's/^application .*/application     snappyHexMesh;/' "$C/system/controlDict"
{ hdr dictionary blockMeshDict; cat <<'EOF'
convertToMeters 1;
vertices
(
    (-1 -0.6 -0.6) (1.6 -0.6 -0.6) (1.6 0.6 -0.6) (-1 0.6 -0.6)
    (-1 -0.6 0.6) (1.6 -0.6 0.6) (1.6 0.6 0.6) (-1 0.6 0.6)
);
blocks ( hex (0 1 2 3 4 5 6 7) (13 6 6) simpleGrading (1 1 1) );
boundary
(
    inlet { type patch; faces ((0 4 7 3)); }
    outlet { type patch; faces ((1 2 6 5)); }
    sides { type patch; faces ((0 1 5 4) (3 7 6 2) (0 3 2 1) (4 5 6 7)); }
);
EOF
} > "$C/system/blockMeshDict"
{ hdr dictionary snappyHexMeshDict; cat <<'EOF'
castellatedMesh true;
snap            true;
addLayers       true;
geometry
{
    ball { type searchableSphere; centre (0 0 0); radius 0.3; }
}
castellatedMeshControls
{
    maxLocalCells 1000000;
    maxGlobalCells 2000000;
    minRefinementCells 0;
    maxLoadUnbalance 0.10;
    nCellsBetweenLevels 2;
    features ();
    refinementSurfaces { ball { level (2 2); patchInfo { type wall; } } }
    resolveFeatureAngle 30;
    refinementRegions {}
    locationInMesh (-0.9 0.51 0.51);
    allowFreeStandingZoneFaces true;
}
snapControls
{
    nSmoothPatch 3;
    tolerance 2.0;
    nSolveIter 30;
    nRelaxIter 5;
}
addLayersControls
{
    relativeSizes true;
    layers { ball { nSurfaceLayers 2; } }
    expansionRatio 1.2;
    finalLayerThickness 0.4;
    minThickness 0.1;
    nGrow 0;
    featureAngle 130;
    slipFeatureAngle 30;
    nRelaxIter 5;
    nSmoothSurfaceNormals 1;
    nSmoothNormals 3;
    nSmoothThickness 10;
    maxFaceThicknessRatio 0.5;
    maxThicknessToMedialRatio 0.3;
    minMedialAxisAngle 90;
    nBufferCellsNoExtrude 0;
    nLayerIter 50;
}
meshQualityControls
{
    maxNonOrtho 65;
    maxBoundarySkewness 20;
    maxInternalSkewness 4;
    maxConcave 80;
    minVol 1e-13;
    minTetQuality 1e-30;
    minArea -1;
    minTwist 0.02;
    minDeterminant 0.001;
    minFaceWeight 0.05;
    minVolRatio 0.01;
    minTriangleTwist -1;
    nSmoothScale 4;
    errorReduction 0.75;
}
debug 0;
mergeTolerance 1e-6;
EOF
} > "$C/system/snappyHexMeshDict"
{ hdr dictionary meshQualityDict; echo '#includeEtc "caseDicts/mesh/generation/meshQualityDict"'; } > "$C/system/meshQualityDict"
{ hdr volVectorField U; cat <<'EOF'
dimensions [0 1 -1 0 0 0 0];
internalField uniform (2 0 0);
boundaryField
{
    inlet { type fixedValue; value uniform (2 0 0); }
    outlet { type zeroGradient; }
    sides { type slip; }
    ball { type noSlip; }
}
EOF
} > "$C/0/U"
{ hdr volScalarField p; cat <<'EOF'
dimensions [0 2 -2 0 0 0 0];
internalField uniform 0;
boundaryField
{
    inlet { type zeroGradient; }
    outlet { type fixedValue; value uniform 0; }
    sides { type slip; }
    ball { type zeroGradient; }
}
EOF
} > "$C/0/p"
( cd "$C" && mv 0 0.orig && openfoam2606 blockMesh > log.blockMesh 2>&1 && openfoam2606 snappyHexMesh -overwrite > log.snappyHexMesh 2>&1; echo "C snappy exit $?"; \
  openfoam2606 checkMesh > log.checkMesh 2>&1; \
  mv 0.orig 0; sed -i 's/^application .*/application     pimpleFoam;/' system/controlDict; \
  openfoam2606 pimpleFoam > log.pimpleFoam 2>&1; echo "C pimpleFoam exit $?" )

# ---- Case D: case A's mesh with one point moved through its cell (a failed check) ----
D="$W/broken"
mkdir -p "$D/system" "$D/constant"
cp -r "$A/system/controlDict" "$A/system/fvSchemes" "$A/system/fvSolution" "$D/system/"
cp -r "$A/constant/polyMesh" "$D/constant/"
python3 - "$D/constant/polyMesh/points" <<'PY'
import re, sys
path = sys.argv[1]
text = open(path).read()
head, body = text.split("(", 1)
lines = body.split("\n")
# The first interior point of the inlet block's second row: push it far along +x and -y.
rows = [i for i, ln in enumerate(lines) if ln.startswith("(")]
i = rows[25]
x, y, z = (float(v) for v in lines[i].strip("()").split())
lines[i] = f"({x + 0.2} {y - 0.08} {z})"
open(path, "w").write(head + "(" + "\n".join(lines))
PY
( cd "$D" && openfoam2606 checkMesh > log.checkMesh 2>&1; echo "D checkMesh exit $?" )

# ---- Case E: thin sheared cells (skewness, aspect ratio and non-orthogonality warnings) ----
E="$W/sheared"
mkdir -p "$E/system" "$E/constant"
cp "$A/system/controlDict" "$A/system/fvSchemes" "$A/system/fvSolution" "$E/system/"
{ hdr dictionary blockMeshDict; cat <<'EOF'
convertToMeters 1;
vertices
(
    (0 0 0) (1 0 0) (4.2 1 0) (3.2 1 0)
    (0 0 0.0005) (1 0 0.0005) (4.2 1 0.0005) (3.2 1 0.0005)
);
blocks ( hex (0 1 2 3 4 5 6 7) (10 40 1) simpleGrading (1 30 1) );
boundary
(
    walls { type wall; faces ((0 1 5 4) (3 7 6 2) (0 4 7 3) (1 2 6 5)); }
    frontAndBack { type empty; faces ((0 3 2 1) (4 5 6 7)); }
);
EOF
} > "$E/system/blockMeshDict"
( cd "$E" && openfoam2606 blockMesh > log.blockMesh 2>&1; openfoam2606 checkMesh > log.checkMesh 2>&1; echo "E checkMesh exit $?" )

# Copy everything back (meshes, logs, dicts; no time folders).
for c in contraction sphere broken sheared; do
  mkdir -p "$OUT/$c"
  cp -r "$W/$c/constant/polyMesh" "$OUT/$c/" 2>/dev/null || true
  cp "$W/$c"/log.* "$OUT/$c/" 2>/dev/null || true
done
( cd "$A" && openfoam2606 foamFormatConvert -constant > log.foamFormatConvert 2>&1 ) || true
sed -i 's/^writeFormat .*/writeFormat     binary;/' "$A/system/controlDict"
( cd "$A" && openfoam2606 foamFormatConvert -constant -noZero > log.foamFormatConvert 2>&1; echo "A convert exit $?" )
mkdir -p "$OUT/contraction-binary"
cp -r "$A/constant/polyMesh" "$OUT/contraction-binary/"

# ---- Case F: a 3D slab of very thin cells (high aspect ratio) ----
W="$HOME/rh2-fixture-work/thin"
rm -rf "$W"
mkdir -p "$W/system" "$W/constant" "$OUT/thin"
cd "$W"
hdr() {
cat <<EOF
FoamFile
{
    version     2.0;
    format      ascii;
    class       $1;
    object      $2;
}
EOF
}
cp "$HOME/rh2-fixture-work/contraction/system/fvSchemes" "$HOME/rh2-fixture-work/contraction/system/fvSolution" system/
{ hdr dictionary controlDict; printf 'application blockMesh;\nstartFrom startTime;\nstartTime 0;\nstopAt endTime;\nendTime 1;\ndeltaT 1;\nwriteControl timeStep;\nwriteInterval 1;\n'; } > system/controlDict
{ hdr dictionary blockMeshDict; cat <<'EOF'
convertToMeters 1;
vertices
(
    (0 0 0) (1 0 0) (1 1 0) (0 1 0)
    (0 0 0.00002) (1 0 0.00002) (1 1 0.00002) (0 1 0.00002)
);
blocks ( hex (0 1 2 3 4 5 6 7) (6 6 1) simpleGrading (1 1 1) );
boundary
(
    walls { type wall; faces ((0 1 5 4) (3 7 6 2) (0 4 7 3) (1 2 6 5) (0 3 2 1) (4 5 6 7)); }
);
EOF
} > system/blockMeshDict
openfoam2606 blockMesh > log.blockMesh 2>&1
openfoam2606 checkMesh > log.checkMesh 2>&1
cp log.checkMesh "$OUT/thin/"

# ---- Case G: 8 thin sheared cells, graded (skewness and 4 cells of high aspect ratio: the two
# failed checks the meshers keep a mesh with, cfddesk.wsl.mesh_run._checkmesh_ok) ----
W="$HOME/rh2-fixture-work/thin-sheared"
rm -rf "$W"
mkdir -p "$W/system" "$W/constant" "$OUT/thin-sheared"
cd "$W"
cp "$HOME/rh2-fixture-work/thin/system/controlDict" "$HOME/rh2-fixture-work/thin/system/fvSchemes" "$HOME/rh2-fixture-work/thin/system/fvSolution" system/
{ hdr dictionary blockMeshDict; cat <<'EOF'
convertToMeters 1;
vertices
(
    (0 0 0) (1 0 0) (6 1 0) (5 1 0)
    (0 0 0.0005) (1 0 0.0005) (6 1 0.0005) (5 1 0.0005)
);
blocks ( hex (0 1 2 3 4 5 6 7) (2 4 1) simpleGrading (1 30 1) );
boundary
(
    walls { type wall; faces ((0 1 5 4) (3 7 6 2) (0 4 7 3) (1 2 6 5) (0 3 2 1) (4 5 6 7)); }
);
EOF
} > system/blockMeshDict
openfoam2606 blockMesh > log.blockMesh 2>&1
openfoam2606 checkMesh > log.checkMesh 2>&1
cp log.checkMesh "$OUT/thin-sheared/"
echo DONE
