#!/usr/bin/env bash
# Build OCCT 7.9.3 static libraries for WebAssembly: build-occt.sh wasm32|wasm64
# Clones the pinned OCCT source into $CAD_BUILD_ROOT if it is missing, applies
# occt-patches/*.patch (idempotent), checks that nothing else differs from the
# pinned commit, configures only the toolkits the facade links, and installs into
# $(occt_dir <variant>)/install (env.sh: the folder name is a hash of everything
# that shapes the libraries). Logs: $(occt_dir <variant>)/{configure,build,install}.log
# SPDX-License-Identifier: GPL-3.0-or-later
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
# shellcheck source=env.sh
source "$HERE/env.sh"
VARIANT="${1:?usage: build-occt.sh wasm32|wasm64}"
case "$VARIANT" in wasm32 | wasm64) ;; *) echo "variant must be wasm32 or wasm64" >&2; exit 2 ;; esac
use_emsdk
command -v ninja >/dev/null || { echo "ninja is required" >&2; exit 1; }

if [ ! -d "$OCCT_SRC/.git" ]; then
  git clone --depth 1 --branch "$OCCT_TAG" "$OCCT_REPO" "$OCCT_SRC"
fi
got=$(git -C "$OCCT_SRC" rev-parse HEAD)
[ "$got" = "$OCCT_COMMIT" ] || { echo "OCCT source is $got, expected $OCCT_COMMIT ($OCCT_TAG)" >&2; exit 1; }

# Our OCCT patches (idempotent: skipped when already applied).
for p in "$HERE"/occt-patches/*.patch; do
  [ -e "$p" ] || continue
  if ! patch -d "$OCCT_SRC" -p1 -R --dry-run -s -f < "$p" > /dev/null 2>&1; then
    patch -d "$OCCT_SRC" -p1 -N -s < "$p"
  fi
done
# The source must be exactly the pinned commit plus those patches.
changed=$(git -C "$OCCT_SRC" status --porcelain --untracked-files=no | awk '{print $2}' | sort -u | tr '\n' ' ')
expected=$(cat "$HERE"/occt-patches/*.patch 2>/dev/null | sed -n 's|^+++ b/||p' | awk '{print $1}' | sort -u | tr '\n' ' ')
[ "$changed" = "$expected" ] || { echo "OCCT source differs from $OCCT_TAG + occt-patches: [$changed] vs [$expected]" >&2; exit 1; }

DIR=$(occt_dir "$VARIANT")
BUILD="$DIR/build"
INSTALL="$DIR/install"
# OCC_CONVERT_SIGNALS turns OCC_CATCH_SIGNALS into setjmp; wasm has no signals, and
# wasm SjLj inside try/catch miscompiles (V8: "br_table label arity inconsistent"
# in ShapeUpgrade_ShapeDivide::Perform).
FLAGS="$KERNEL_CFLAGS $KERNEL_PATHFLAGS -UOCC_CONVERT_SIGNALS"
if [ "$VARIANT" = wasm64 ]; then FLAGS="$FLAGS -sMEMORY64=1"; fi
rm -rf "$BUILD" "$INSTALL"
mkdir -p "$BUILD"
cd "$BUILD"
emcmake cmake -G Ninja "$OCCT_SRC" \
  -DCMAKE_BUILD_TYPE=Release \
  -DBUILD_LIBRARY_TYPE=Static \
  -DINSTALL_DIR="$INSTALL" \
  -DINSTALL_DIR_INCLUDE=inc \
  -DINSTALL_DIR_RESOURCE=src \
  -DCMAKE_C_FLAGS="$FLAGS" -DCMAKE_CXX_FLAGS="$FLAGS" \
  -DBUILD_MODULE_FoundationClasses=ON \
  -DBUILD_MODULE_ModelingData=OFF \
  -DBUILD_MODULE_ModelingAlgorithms=OFF \
  -DBUILD_MODULE_Visualization=OFF \
  -DBUILD_MODULE_ApplicationFramework=OFF \
  -DBUILD_MODULE_DataExchange=OFF \
  -DBUILD_MODULE_DETools=OFF \
  -DBUILD_MODULE_Draw=OFF \
  -DBUILD_ADDITIONAL_TOOLKITS="TKDESTEP;TKXCAF;TKBool;TKBO;TKFillet;TKOffset;TKFeat;TKPrim;TKMesh;TKShHealing;TKHLR;TKTopAlgo;TKGeomAlgo" \
  -DUSE_FREETYPE=OFF -DUSE_TK=OFF -DUSE_OPENGL=OFF -DUSE_GLES2=OFF -DUSE_FREEIMAGE=OFF \
  -DUSE_RAPIDJSON=OFF -DUSE_DRACO=OFF -DUSE_TBB=OFF -DUSE_VTK=OFF -DUSE_OPENVR=OFF -DUSE_FFMPEG=OFF \
  -DBUILD_DOC_Overview=OFF -DBUILD_Inspector=OFF > "$DIR/configure.log" 2>&1
echo "OCCT $VARIANT configured in $BUILD"
ninja -j"${JOBS:-16}" > "$DIR/build.log" 2>&1
echo "OCCT $VARIANT built"
ninja install > "$DIR/install.log" 2>&1
echo "OCCT $VARIANT installed in $INSTALL"
