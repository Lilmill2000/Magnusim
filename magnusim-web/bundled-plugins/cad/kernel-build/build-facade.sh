#!/usr/bin/env bash
# Compile and link the kernel facade against the OCCT libraries:
#   build-facade.sh wasm32|wasm64 <outdir>
# Writes <outdir>/mk32.{mjs,wasm} (or mk64.*). Uses the OCCT install that
# build-occt.sh makes for the current pins ($(occt_dir <variant>)/install);
# OCCT_INSTALL=<dir> overrides it (development only: the build record says so).
# Plain extern "C" ABI (mk_call / mk_alloc / mk_free), no embind: nothing needs
# eval or new Function under the workspace frame's Content-Security-Policy.
# EXTRA_CXXFLAGS adds compile flags (tests only, e.g. -DMK_TEST_NO_WORK_COPY).
# SPDX-License-Identifier: GPL-3.0-or-later
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
# shellcheck source=env.sh
source "$HERE/env.sh"
VARIANT="${1:?usage: build-facade.sh wasm32|wasm64 <outdir>}"
OUT="${2:?usage: build-facade.sh wasm32|wasm64 <outdir>}"
use_emsdk

INST="${OCCT_INSTALL:-$(occt_dir "$VARIANT")/install}"
OBJ="${FACADE_OBJ:-$CAD_BUILD_ROOT/facade-obj-$VARIANT}"
mkdir -p "$OBJ" "$OUT"
[ -f "$INST/lib/libTKernel.a" ] || { echo "OCCT $VARIANT is not built in $INST: run build-occt.sh $VARIANT" >&2; exit 1; }

CFLAGS="-std=c++17 $KERNEL_CFLAGS $KERNEL_PATHFLAGS ${EXTRA_CXXFLAGS:-}"
if [ "$VARIANT" = wasm64 ]; then
  CFLAGS="$CFLAGS -sMEMORY64=1"
  NAME=mk64
  MEMFLAGS="-sMEMORY64=1 -sMAXIMUM_MEMORY=16GB -sSIGNATURE_CONVERSIONS=mk_call:pp,mk_alloc:pp,mk_free:_p"
else
  NAME=mk32
  MEMFLAGS="-sMAXIMUM_MEMORY=4GB"
fi

# shellcheck disable=SC2086
em++ $CFLAGS -I"$INST/inc" -I"$HERE/facade" -c "$HERE/facade/facade.cpp" -o "$OBJ/facade.o"

LIBS="-lTKDESTEP -lTKDE -lTKXSBase -lTKXCAF -lTKVCAF -lTKV3d -lTKService -lTKCAF -lTKLCAF -lTKCDF \
-lTKFeat -lTKFillet -lTKOffset -lTKBool -lTKBO -lTKPrim -lTKMesh -lTKHLR -lTKShHealing -lTKTopAlgo \
-lTKGeomAlgo -lTKBRep -lTKGeomBase -lTKG3d -lTKG2d -lTKMath -lTKernel"

LINKFLAGS="-O3 -fwasm-exceptions -msimd128 \
-sMODULARIZE=1 -sEXPORT_ES6=1 -sENVIRONMENT=web,worker,node \
-sDYNAMIC_EXECUTION=0 -sALLOW_MEMORY_GROWTH=1 $MEMFLAGS \
-sINITIAL_MEMORY=64MB -sSTACK_SIZE=8MB \
-sEXPORTED_FUNCTIONS=[_mk_call,_mk_alloc,_mk_free,_malloc,_free] \
-sEXPORTED_RUNTIME_METHODS=[ccall,cwrap,UTF8ToString,stringToUTF8,lengthBytesUTF8,HEAPU8,HEAPF32,HEAPU32] \
-sEXPORT_NAME=createMagnusimKernel -sFILESYSTEM=0"

# shellcheck disable=SC2086
em++ "$OBJ/facade.o" -L"$INST/lib" -Wl,--start-group $LIBS -Wl,--end-group $LINKFLAGS ${EXTRA_LDFLAGS:-} -o "$OUT/$NAME.mjs"
# What the build record (build.sh) quotes.
{
  echo "compile: em++ -std=c++17 $KERNEL_CFLAGS -ffile-prefix-map=<build root>=/cad-build -ffile-prefix-map=<plugin>=/cad-plugin ${EXTRA_CXXFLAGS:-}"
  echo "link: $LINKFLAGS ${EXTRA_LDFLAGS:-}"
  echo "occt_install: ${OCCT_INSTALL:+override }$(basename "$(dirname "$INST")")"
} > "$OUT/$NAME.flags.txt"
ls -l "$OUT/$NAME.mjs" "$OUT/$NAME.wasm"
