#!/usr/bin/env bash
set -eu
CASE_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$CASE_DIR"

fail() {
  echo "MESH_SCRIPT_FAIL: $1" >&2
  exit 1
}

test -f system/meshDict || fail "missing system/meshDict"
test -f constant/triSurface/geometry.stl || fail "missing constant/triSurface/geometry.stl"

rm -rf constant/polyMesh
rm -f constant/triSurface/geometry.fms

# Use meshDict surfaceFile as-is. Do NOT force .fms via surfaceFeatureEdges —
# that marks every sharp CAD edge and cartesianMesh builds dark fine bands
# (not SimScale-uniform surface). Optional .fms only if meshDict asks for it.
SURF="$(awk '/^surfaceFile/{gsub(/"/, "", $2); gsub(/;/, "", $2); print $2; exit}' system/meshDict || true)"
if [ "$SURF" = "constant/triSurface/geometry.fms" ]; then
  openfoam2606 bash -c '
    cd "'"$CASE_DIR"'"
    surfaceFeatureEdges -angle 89       constant/triSurface/geometry.stl       constant/triSurface/geometry.fms       > log.surfaceFeatureEdges 2>&1
  ' || fail surfaceFeatureEdges
  test -f constant/triSurface/geometry.fms || fail "missing geometry.fms after surfaceFeatureEdges"
else
  echo "surfaceFile=$SURF (skip surfaceFeatureEdges — uniform surface)" > log.surfaceFeatureEdges
fi

openfoam2606 bash -c '
  cd "'"$CASE_DIR"'"
  export OMP_NUM_THREADS="${OMP_NUM_THREADS:-8}"
  cartesianMesh > log.cartesianMesh 2>&1
' || fail cartesianMesh

# Merge walls__f* → walls and retype inlet/outlet (cfMesh emits type wall).
if [ -f system/createPatchDict.cfmeshFaces ]; then
  cp -f system/createPatchDict.cfmeshFaces system/createPatchDict
  openfoam2606 bash -c '
    cd "'"$CASE_DIR"'"
    createPatch -overwrite > log.createPatch.cfmeshFaces 2>&1
  ' || fail createPatch.cfmeshFaces
fi

# Belt: rewrite types from patch_types.txt if createPatch left inlet/outlet as wall.
if [ -f constant/triSurface/patch_types.txt ] && [ -f constant/polyMesh/boundary ]; then
  python3 - <<'PY'
from pathlib import Path
import re
types = {}
for line in Path("constant/triSurface/patch_types.txt").read_text(
    encoding="utf-8", errors="replace"
).splitlines():
    parts = line.split()
    if len(parts) >= 2:
        types[parts[0]] = parts[1]
path = Path("constant/polyMesh/boundary")
lines = path.read_text(encoding="utf-8", errors="replace").splitlines(keepends=True)
changed = 0
current = None
out = []
skip = {"FoamFile", "version", "format", "arch", "class", "location", "object"}
name_re = re.compile(r"^\s*([A-Za-z_]\w*)\s*$")
type_re = re.compile(r"^(\s*type\s+)\S+(\s*;.*)$")
for line in lines:
    raw = line.rstrip("\r\n")
    m_name = name_re.match(raw)
    if m_name and m_name.group(1) not in skip:
        current = m_name.group(1)
        out.append(line)
        continue
    if raw.strip() == "}":
        current = None
        out.append(line)
        continue
    if current and current in types:
        m_type = type_re.match(raw)
        if m_type:
            want = types[current]
            nl = "\n" if line.endswith("\n") else ""
            new_line = f"{m_type.group(1)}{want}{m_type.group(2)}{nl}"
            if new_line.rstrip("\n") != raw:
                changed += 1
            out.append(new_line)
            continue
    out.append(line)
path.write_bytes("".join(out).replace("\r\n", "\n").encode("utf-8"))
print("PATCH_TYPES_APPLIED", changed)
PY
fi

openfoam2606 bash -c '
  cd "'"$CASE_DIR"'"
  checkMesh > log.checkMesh 2>&1 || true
'

echo MESH_SCRIPT_OK
