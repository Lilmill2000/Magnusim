#!/usr/bin/env bash
# Hex-dominant snappyHexMesh pipeline (Phase 1 Step 6).
# Placeholders: __DST__ __WIN_OUT__ __GENERATE_ID__
set -uo pipefail
DST="__DST__"
WIN_OUT="__WIN_OUT__"
GENERATE_ID="__GENERATE_ID__"

emit_json() {
  echo "MAGNUSIM_EVENT $1"
}

cd "$DST" || {
  emit_json '{"event":"error","error":"missing_dst"}'
  exit 46
}

emit_json "{\"event\":\"progress\",\"stage\":\"start\",\"generate_id\":\"$GENERATE_ID\"}"
emit_json "{\"event\":\"progress\",\"stage\":\"surfaceFeatureExtract\",\"generate_id\":\"$GENERATE_ID\"}"
openfoam2606 surfaceFeatureExtract 2>&1 | tee log.surfaceFeatureExtract
EC_SFE=${PIPESTATUS[0]}
if [ "$EC_SFE" -ne 0 ]; then
  mkdir -p "$WIN_OUT"
  cp -f log.surfaceFeatureExtract "$WIN_OUT/" 2>/dev/null || true
  emit_json "{\"event\":\"result\",\"ok\":false,\"exit_code\":$EC_SFE,\"stage\":\"surfaceFeatureExtract\"}"
  exit $EC_SFE
fi
if [ -f constant/triSurface/Body1.eMesh ]; then
  cp -f constant/triSurface/Body1.eMesh constant/triSurface/cadFeatures.eMesh
fi
if [ ! -s constant/triSurface/cadFeatures.eMesh ]; then
  emit_json '{"event":"result","ok":false,"exit_code":42,"error":"emesh_missing"}'
  exit 42
fi
if [ -f constant/triSurface/walls.stl ] || [ -f constant/triSurface/inlet.stl ]; then
  emit_json '{"event":"result","ok":false,"exit_code":47,"error":"mtp1_leak"}'
  exit 47
fi
if [ ! -f constant/triSurface/Body1.stl ]; then
  emit_json '{"event":"result","ok":false,"exit_code":46,"error":"body1_missing"}'
  exit 46
fi

emit_json "{\"event\":\"progress\",\"stage\":\"blockMesh\",\"generate_id\":\"$GENERATE_ID\"}"
openfoam2606 blockMesh 2>&1 | tee log.blockMesh
EC_BM=${PIPESTATUS[0]}
if [ "$EC_BM" -ne 0 ]; then
  mkdir -p "$WIN_OUT"
  cp -f log.blockMesh "$WIN_OUT/" 2>/dev/null || true
  emit_json "{\"event\":\"result\",\"ok\":false,\"exit_code\":$EC_BM,\"stage\":\"blockMesh\"}"
  exit $EC_BM
fi

PHYS=$(lscpu -p=CORE,SOCKET 2>/dev/null | grep -v '^#' | sort -u | wc -l | tr -d ' ')
THREADS=$(nproc 2>/dev/null || echo 1)
NPROC=$THREADS
if [ -n "$PHYS" ] && [ "$PHYS" -ge 1 ]; then
  NPROC=$PHYS
fi
if [ "$NPROC" -lt 1 ]; then
  NPROC=1
fi
emit_json "{\"event\":\"progress\",\"stage\":\"snappyHexMesh\",\"nproc\":$NPROC,\"generate_id\":\"$GENERATE_ID\"}"

rm -rf 0 processor*
run_serial_snappy() {
  rm -rf processor*
  openfoam2606 snappyHexMesh -overwrite 2>&1 | tee log.snappyHexMesh
  EC=${PIPESTATUS[0]}
}
if [ "$NPROC" -gt 1 ]; then
  printf '%s\n' 'FoamFile' '{' '    version     2.0;' '    format      ascii;' '    class       dictionary;' '    object      decomposeParDict;' '}' "numberOfSubdomains $NPROC;" 'method          scotch;' > system/decomposeParDict
  openfoam2606 decomposePar 2>&1 | tee log.decomposePar
  EC_DEC=${PIPESTATUS[0]}
  if [ "$EC_DEC" -ne 0 ]; then
    run_serial_snappy
  else
    openfoam2606 mpirun -np "$NPROC" snappyHexMesh -parallel -overwrite 2>&1 | tee log.snappyHexMesh
    EC=${PIPESTATUS[0]}
    if [ "$EC" -eq 0 ]; then
      openfoam2606 reconstructParMesh -constant -mergeTol 1e-6 2>&1 | tee log.reconstructParMesh
      rm -rf processor*
    else
      run_serial_snappy
    fi
  fi
else
  run_serial_snappy
fi

rm -rf "$WIN_OUT"
mkdir -p "$WIN_OUT/constant/triSurface" "$WIN_OUT/system"
if [ -d constant/polyMesh ]; then cp -a constant/polyMesh "$WIN_OUT/constant/"; fi
if [ -f constant/triSurface/cadFeatures.eMesh ]; then cp -f constant/triSurface/cadFeatures.eMesh "$WIN_OUT/constant/triSurface/"; fi
if [ -f constant/triSurface/Body1.stl ]; then cp -f constant/triSurface/Body1.stl "$WIN_OUT/constant/triSurface/"; fi
cp -a system "$WIN_OUT/" 2>/dev/null || true
cp -f log.blockMesh log.snappyHexMesh log.surfaceFeatureExtract log.decomposePar log.reconstructParMesh "$WIN_OUT/" 2>/dev/null || true
touch "$WIN_OUT/case.foam"

OK=true
if [ "${EC:-1}" -ne 0 ]; then OK=false; fi
emit_json "{\"event\":\"result\",\"ok\":$OK,\"exit_code\":${EC:-1},\"nproc\":$NPROC,\"path_kind\":\"snappyHexMesh\",\"generate_id\":\"$GENERATE_ID\"}"
exit ${EC:-1}
