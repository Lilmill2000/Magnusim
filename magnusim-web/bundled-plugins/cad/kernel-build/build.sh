#!/usr/bin/env bash
# Build the CAD kernel: OCCT 7.9.3 (only when the libraries for the current pins
# are missing), then the facade, into the workspace.
#   kernel-build/build.sh                     wasm32 -> workspace/kernel/mk32.{mjs,wasm}
#                                             + kernel-build/mk32.build.txt (build record)
#   kernel-build/build.sh --variant wasm64    wasm64 -> $CAD_BUILD_ROOT/facade-out-wasm64/
#                                             (kept for bigger models; not shipped)
#   kernel-build/build.sh --out <dir>         write somewhere else (for comparing builds)
#   kernel-build/build.sh --clean             recompile the facade from nothing
# Run on Linux or WSL with git, cmake, ninja and python3 (emsdk). The first OCCT
# build takes a while (JOBS=16 parallel jobs by default); later runs rebuild only
# the facade. kernel-build/repro-check.sh builds twice from clean and compares.
# Commit workspace/kernel/*.wasm only on version bumps; development builds stay out of git.
# SPDX-License-Identifier: GPL-3.0-or-later
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
PLUGIN=$(cd "$HERE/.." && pwd)
# shellcheck source=env.sh
source "$HERE/env.sh"

VARIANT=wasm32
OUT=""
CLEAN=0
while [ $# -gt 0 ]; do
  case "$1" in
    --variant) VARIANT="$2"; shift 2 ;;
    --out) OUT="$2"; shift 2 ;;
    --clean) CLEAN=1; shift ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done
case "$VARIANT" in wasm32 | wasm64) ;; *) echo "variant must be wasm32 or wasm64" >&2; exit 2 ;; esac
NAME=$([ "$VARIANT" = wasm64 ] && echo mk64 || echo mk32)
SHIP="$PLUGIN/workspace/kernel"
if [ -z "$OUT" ]; then
  if [ "$VARIANT" = wasm32 ]; then OUT="$SHIP"; else OUT="$CAD_BUILD_ROOT/facade-out-wasm64"; fi
fi

if [ -z "${OCCT_INSTALL:-}" ] && [ ! -f "$(occt_dir "$VARIANT")/install/lib/libTKernel.a" ]; then
  "$HERE/build-occt.sh" "$VARIANT"
fi

# Build into a staging folder, then move the pair into place (the workspace may be
# served while this runs: the .mjs and .wasm must never be from different builds
# for longer than two renames).
STAGE="$CAD_BUILD_ROOT/facade-stage-$VARIANT-$$"
rm -rf "$STAGE"
mkdir -p "$STAGE"
trap 'rm -rf "$STAGE"' EXIT
if [ "$CLEAN" = 1 ]; then rm -rf "${FACADE_OBJ:-$CAD_BUILD_ROOT/facade-obj-$VARIANT}"; fi
"$HERE/build-facade.sh" "$VARIANT" "$STAGE"

# Build record: every input that shapes the output, and the output hashes.
use_emsdk
emcc_line=$(emcc --version | head -1)
{
  echo "# Kernel build record (kernel-build/build.sh). Same inputs => same bytes."
  echo "variant: $VARIANT"
  echo "emscripten: $emcc_line" | sed 's/ (Emscripten gcc\/clang-like replacement + linker emulating GNU ld)//'
  echo "emsdk: $EMSDK_VERSION"
  echo "occt: $OCCT_TAG $OCCT_COMMIT"
  for p in "$HERE"/occt-patches/*.patch; do
    [ -e "$p" ] || continue
    echo "occt_patch: $(basename "$p") sha256=$(sha256sum "$p" | cut -c1-64)"
  done
  echo "occt_flags: $KERNEL_CFLAGS -UOCC_CONVERT_SIGNALS -ffile-prefix-map=<build root>=/cad-build"
  echo "occt_key: $(occt_key "$VARIANT")"
  cat "$STAGE/$NAME.flags.txt"
  echo "facade_sources: $(cat "$HERE"/facade/*.cpp "$HERE"/facade/*.hpp | sha256sum | cut -c1-64)"
  echo "$NAME.wasm: $(stat -c %s "$STAGE/$NAME.wasm") bytes sha256=$(sha256sum "$STAGE/$NAME.wasm" | cut -c1-64)"
  echo "$NAME.mjs: $(stat -c %s "$STAGE/$NAME.mjs") bytes sha256=$(sha256sum "$STAGE/$NAME.mjs" | cut -c1-64)"
} > "$STAGE/$NAME.build.txt"

mkdir -p "$OUT"
cp -f "$STAGE/$NAME.wasm" "$OUT/.$NAME.wasm.new"
cp -f "$STAGE/$NAME.mjs" "$OUT/.$NAME.mjs.new"
mv -f "$OUT/.$NAME.wasm.new" "$OUT/$NAME.wasm"
mv -f "$OUT/.$NAME.mjs.new" "$OUT/$NAME.mjs"
if [ "$OUT" = "$SHIP" ]; then
  cp -f "$STAGE/$NAME.build.txt" "$HERE/$NAME.build.txt"
else
  cp -f "$STAGE/$NAME.build.txt" "$OUT/$NAME.build.txt"
fi
grep -E "^$NAME\.(wasm|mjs):" "$STAGE/$NAME.build.txt"
echo "kernel $VARIANT -> $OUT"
