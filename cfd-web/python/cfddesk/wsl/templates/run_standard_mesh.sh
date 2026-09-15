#!/usr/bin/env bash
set -u
CASE_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$CASE_DIR"

fail() {
  echo "MESH_SCRIPT_FAIL: $1" >&2
  exit 1
}

MSH="constant/triSurface/geometry.msh"
test -f "$MSH" || fail "missing $MSH"
rm -rf constant/polyMesh 0 [1-9]*

openfoam2606 bash -c '
  cd "'"$CASE_DIR"'"
  gmshToFoam constant/triSurface/geometry.msh > log.gmshToFoam 2>&1
' || fail gmshToFoam
test -f constant/polyMesh/boundary || fail "gmshToFoam produced no polyMesh"

if [ -f constant/triSurface/patch_types.txt ]; then
  python3 - <<'PY' > log.patchTypes 2>&1 || fail patchTypes

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
text = path.read_text(encoding="utf-8", errors="replace")
changed = 0
for name, want in types.items():
    pat = re.compile(r"(\n\s*" + re.escape(name) + r"\s*\{[^}]*?\btype\s+)(\w+)(\s*;)")
    text, n = pat.subn(lambda m: m.group(1) + want + m.group(3), text)
    changed += n
# gmshToFoam adds physicalType entries that shadow the real type for some tools
text = re.sub(r"\n(\s*)physicalType\s+\w+\s*;", r"\n\1// physicalType removed", text)
path.write_bytes(text.replace("\r\n", "\n").encode("utf-8"))
print("PATCH_TYPES_APPLIED", changed)
PY
fi

if [ -f system/snappyHexMeshDict ]; then
  openfoam2606 bash -c '
    cd "'"$CASE_DIR"'"
    snappyHexMesh -overwrite > log.snappyHexMesh 2>&1
  ' || fail snappyHexMesh
  grep -q "Finished meshing" log.snappyHexMesh || fail "snappyHexMesh did not finish"
else
  echo "layers off (no snappyHexMeshDict)" > log.snappyHexMesh
fi

openfoam2606 bash -c '
  cd "'"$CASE_DIR"'"
  checkMesh > log.checkMesh 2>&1 || true
'

echo MESH_SCRIPT_OK
