#!/usr/bin/env bash
set -eu
CASE_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$CASE_DIR"

fail() {
  echo "MESH_SCRIPT_FAIL: $1" >&2
  exit 1
}

MSH="constant/triSurface/geometry.msh"
test -f "$MSH" || fail "missing $MSH"

rm -rf constant/polyMesh

openfoam2606 bash -c '
  cd "'"$CASE_DIR"'"
  gmshToFoam constant/triSurface/geometry.msh > log.gmshToFoam 2>&1
' || fail gmshToFoam

openfoam2606 bash -c '
  cd "'"$CASE_DIR"'"
  checkMesh > log.checkMesh 2>&1 || true
'

echo MESH_SCRIPT_OK
