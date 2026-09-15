#!/usr/bin/env bash
# cfddesk parallel snappyHexMesh (N=__N__, method=__METHOD__)
# Note: on complex geometry parallel snappy is often only 3-6x faster than
# serial, not Nx, due to load imbalance during refine/snap.
set -uo pipefail
CASE_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$CASE_DIR"
N=__N__

fail() {
  echo "MESH_SCRIPT_FAIL: $1" >&2
  exit 1
}

# Drop leftover processor* from a previous different N (solve-path same rule).
rm -rf processor*[0-9]* || true

# Stale 0/ (and other time dirs) from a prior solve name inlet/outlet/walls.
# blockMesh only has patch blockBounds — decomposePar would FOAM FATAL on
# missing patchField entries. Meshing does not need fields; solve rewrites 0/.
rm -rf 0
for t in [1-9]*; do
  [ -d "$t" ] || continue
  case "$t" in processor*) continue ;; esac
  rm -rf "$t"
done

openfoam2606 bash -c '
  cd "'"$CASE_DIR"'"
  blockMesh > log.blockMesh 2>&1
' || fail blockMesh

openfoam2606 bash -c '
  cd "'"$CASE_DIR"'"
  decomposePar > log.decomposePar 2>&1
' || fail decomposePar

openfoam2606 bash -c '
  cd "'"$CASE_DIR"'"
  mpirun -np '"$N"' snappyHexMesh -parallel -overwrite > log.snappyHexMesh 2>&1
' || fail snappyHexMesh

openfoam2606 bash -c '
  cd "'"$CASE_DIR"'"
  reconstructParMesh -constant -mergeTol 1e-6 > log.reconstructParMesh 2>&1
' || fail reconstructParMesh

# Final polyMesh must live in constant/ (same as serial -overwrite path).
rm -rf processor*[0-9]* || true

openfoam2606 bash -c '
  cd "'"$CASE_DIR"'"
  checkMesh > log.checkMesh 2>&1 || true
'

# checkMesh exit code is evaluated in Python (_checkmesh_ok); do not abort
# the script on skewness-only failures when layers are enabled.
echo MESH_SCRIPT_OK
