#!/usr/bin/env bash
# Build the sketch solver (FreeCAD's PlaneGCS through the salusoft89/planegcs
# embind wrapper) to WebAssembly, with our patches (planegcs.patch):
#   solver-build/build.sh                 -> workspace/solver/planegcs.{mjs,wasm}
#   solver-build/build.sh --out <dir>     write somewhere else (for comparing builds)
# Steps: pinned upstream checkout in $CAD_BUILD_ROOT/planegcs-pinned (reset to the
# pinned commit), git apply planegcs.patch, regenerate the embind bindings with the
# wrapper's generator (Node 20), compile with the pinned Emscripten.
# Run on Linux or WSL with git, curl and tar. SOURCES.md lists every source and licence.
# SPDX-License-Identifier: GPL-3.0-or-later
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
PLUGIN=$(cd "$HERE/.." && pwd)
# shellcheck source=../kernel-build/env.sh
source "$PLUGIN/kernel-build/env.sh"

PLANEGCS_REPO="${PLANEGCS_REPO:-https://github.com/Salusoft89/planegcs.git}"
PLANEGCS_COMMIT=ee9b156da9827a91a56a888a53520f63d5cffaa6
NODE_VERSION=20.18.1
BOOST_VERSION=1.86.0
EIGEN_VERSION=3.4.0

OUT="$PLUGIN/workspace/solver"
while [ $# -gt 0 ]; do
  case "$1" in
    --out) OUT="$2"; shift 2 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

DEPS="$CAD_BUILD_ROOT/deps"
SRC="$CAD_BUILD_ROOT/planegcs-pinned"
OBJ="$CAD_BUILD_ROOT/planegcs-obj"
mkdir -p "$DEPS" "$OBJ" "$OUT"

# Header-only dependencies and the generator's Node (build time only; not shipped).
BOOST_DIR="$DEPS/boost_${BOOST_VERSION//./_}"
if [ ! -d "$BOOST_DIR/boost" ]; then
  curl -fsSL "https://archives.boost.io/release/$BOOST_VERSION/source/boost_${BOOST_VERSION//./_}.tar.gz" | tar -xz -C "$DEPS"
fi
EIGEN_DIR="$DEPS/eigen-$EIGEN_VERSION"
if [ ! -d "$EIGEN_DIR/Eigen" ]; then
  curl -fsSL "https://gitlab.com/libeigen/eigen/-/archive/$EIGEN_VERSION/eigen-$EIGEN_VERSION.tar.gz" | tar -xz -C "$DEPS"
fi
NODE_DIR="$DEPS/node-v$NODE_VERSION-linux-x64"
if [ ! -x "$NODE_DIR/bin/node" ]; then
  curl -fsSL "https://nodejs.org/dist/v$NODE_VERSION/node-v$NODE_VERSION-linux-x64.tar.xz" | tar -xJ -C "$DEPS"
fi

# Pristine upstream at the pinned commit, then our patch.
if [ ! -d "$SRC/.git" ]; then
  git clone "$PLANEGCS_REPO" "$SRC"
fi
git -C "$SRC" fetch -q origin "$PLANEGCS_COMMIT" 2>/dev/null || true
git -C "$SRC" checkout -q -f "$PLANEGCS_COMMIT"
git -C "$SRC" apply "$HERE/planegcs.patch"

# Regenerate the embind bindings from the patched template.
(
  export PATH="$NODE_DIR/bin:$PATH"
  cd "$SRC"
  [ -d node_modules ] || npm ci --no-audit --no-fund > "$CAD_BUILD_ROOT/planegcs-npm.log" 2>&1
  cd build-bindings && ./process_all.sh > "$CAD_BUILD_ROOT/planegcs-bindings.log" 2>&1
)

use_emsdk
CXXFLAGS=(-std=gnu++20 -O3 -fwasm-exceptions -msimd128 -Wno-deprecated -Wno-switch
  -Wno-macro-redefined -flto -DEIGEN_MPL2_ONLY $KERNEL_PATHFLAGS
  -I"$SRC/planegcs" -I"$SRC/planegcs/headers" -I"$BOOST_DIR" -I"$EIGEN_DIR")
pids=()
for s in GCS Geo Constraints SubSystem qp_eq bindings; do
  (em++ "${CXXFLAGS[@]}" -c "$SRC/planegcs/$s.cpp" -o "$OBJ/$s.o") &
  pids+=($!)
done
for p in "${pids[@]}"; do wait "$p"; done

LDFLAGS=(-O3 -flto -fwasm-exceptions -msimd128 -lembind
  -sMODULARIZE=1 -sEXPORT_ES6=1 -sENVIRONMENT=web,worker,node
  -sDYNAMIC_EXECUTION=0 -sEMBIND_AOT=1 -sALLOW_MEMORY_GROWTH=1 -sMAXIMUM_MEMORY=1GB
  -sSTACK_SIZE=5MB -sFILESYSTEM=0 -sASSERTIONS=0
  -sEXPORTED_RUNTIME_METHODS=HEAPF64
  -sINCOMING_MODULE_JS_API=locateFile,print,printErr,wasmBinary,instantiateWasm)
em++ "${LDFLAGS[@]}" "$OBJ"/{GCS,Geo,Constraints,SubSystem,qp_eq,bindings}.o -o "$OUT/planegcs.mjs"
cp "$SRC/planegcs/bindings.cpp" "$HERE/bindings.generated.cpp"
ls -l "$OUT/planegcs.mjs" "$OUT/planegcs.wasm"
echo "solver -> $OUT"
