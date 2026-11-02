#!/usr/bin/env bash
# Compile and link the kernel facade against the OCCT libraries:
#   build-facade.sh wasm32|wasm64 <outdir>
# Writes <outdir>/mk32.{mjs,wasm} (or mk64.*). Uses the OCCT install that
# build-occt.sh makes for the current pins ($(occt_dir <variant>)/install);
# OCCT_INSTALL=<dir> overrides it (development only: the build record says so).
# wasm32 also compiles facade/asi_ops.cpp (the Analysis Situs ops, kernel API 8) against the
# patched headers build-asi.sh leaves next to libasi.a, and links libasi.a ($ASI_OBJ, or
# $(asi_dir wasm32)). wasm64 has no Analysis Situs: its facade is built with -DMK_NO_ASI and
# those ops answer in words.
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
ASI_FACADE_DEFS=""
if [ "$VARIANT" = wasm64 ]; then
  ASI_FACADE_DEFS="-DMK_NO_ASI"
  CFLAGS="$CFLAGS -sMEMORY64=1 $ASI_FACADE_DEFS"
  NAME=mk64
  MEMFLAGS="-sMEMORY64=1 -sMAXIMUM_MEMORY=16GB -sSIGNATURE_CONVERSIONS=mk_call:pp,mk_alloc:pp,mk_free:_p"
else
  NAME=mk32
  MEMFLAGS="-sMAXIMUM_MEMORY=4GB"
fi

# Analysis Situs (wasm32 only): libasi.a and the patched sources it was built from
# (build-asi.sh), whose headers asi_ops.cpp compiles against.
ASI_LIB=""
ASI_OPS_OBJ=""
if [ "$VARIANT" = wasm32 ]; then
  ASI_BUILT="${ASI_OBJ:-$(asi_dir "$VARIANT")}"
  ASI_LIB="$ASI_BUILT/libasi.a"
  if [ ! -f "$ASI_LIB" ] || [ ! -d "$ASI_BUILT/src/asiAlgo" ] || [ ! -f "$ASI_BUILT/asi_occt79_compat.h" ]; then
    echo "Analysis Situs is not built in $ASI_BUILT: run build-asi.sh $VARIANT" >&2
    exit 1
  fi
fi

# shellcheck disable=SC2086
em++ $CFLAGS -I"$INST/inc" -I"$HERE/facade" -c "$HERE/facade/facade.cpp" -o "$OBJ/facade.o"

# asi_ops.cpp is the only facade source that sees Analysis Situs: its include paths, its
# defines and the force-included compatibility header, exactly as libasi.a was compiled.
if [ "$VARIANT" = wasm32 ]; then
  ASI_INC="-I$ASI_BUILT/src/asiAlgo"
  for d in $(cd "$ASI_BUILT/src/asiAlgo" && find . -mindepth 1 -maxdepth 1 -type d | sed 's|^\./||' | LC_ALL=C sort); do
    ASI_INC="$ASI_INC -I$ASI_BUILT/src/asiAlgo/$d"
  done
  ASI_INC="$ASI_INC -I$ASI_BUILT/src/asiActiveData/API -I$ASI_BUILT/src/asiActiveData -I$ASI_BUILT/src/asiActiveData/Mesh/DS"
  # shellcheck disable=SC2086
  em++ $CFLAGS -ffile-prefix-map="$ASI_BUILT"=/cad-asi -include "$ASI_BUILT/asi_occt79_compat.h" $ASI_INC \
    -I"$INST/inc" -I"$HERE/facade" $ASI_DEFS -Wno-deprecated-declarations -c "$HERE/facade/asi_ops.cpp" -o "$OBJ/asi_ops.o"
  ASI_OPS_OBJ="$OBJ/asi_ops.o"
fi

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

# libasi.a goes after asi_ops.o and before the OCCT libraries: wasm-ld takes from it only the
# members something references.
# shellcheck disable=SC2086
em++ "$OBJ/facade.o" $ASI_OPS_OBJ $ASI_LIB -L"$INST/lib" -Wl,--start-group $LIBS -Wl,--end-group $LINKFLAGS ${EXTRA_LDFLAGS:-} -o "$OUT/$NAME.mjs"
# What the build record (build.sh) quotes.
{
  echo "compile: em++ -std=c++17 $KERNEL_CFLAGS -ffile-prefix-map=<build root>=/cad-build -ffile-prefix-map=<plugin>=/cad-plugin ${EXTRA_CXXFLAGS:-}${ASI_FACADE_DEFS:+ $ASI_FACADE_DEFS}"
  if [ -n "$ASI_OPS_OBJ" ]; then echo "compile_asi_ops: the same, plus -ffile-prefix-map=<asi build>=/cad-asi -include asi_occt79_compat.h -I<asiAlgo and its folders> -I<asiActiveData/API, asiActiveData, asiActiveData/Mesh/DS> $ASI_DEFS -Wno-deprecated-declarations"; fi
  echo "link: $LINKFLAGS ${EXTRA_LDFLAGS:-}"
  echo "occt_install: ${OCCT_INSTALL:+override }$(basename "$(dirname "$INST")")"
  if [ -n "$ASI_LIB" ]; then echo "link_inputs: facade.o, asi_ops.o, libasi.a (Analysis Situs), then the OCCT libraries"; fi
} > "$OUT/$NAME.flags.txt"
ls -l "$OUT/$NAME.mjs" "$OUT/$NAME.wasm"
