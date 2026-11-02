#!/usr/bin/env bash
# Build the vendored Analysis Situs subset (asi/, SOURCES.md) into a static library for the
# kernel:  build-asi.sh wasm32
# 1. Refuses unless asi/upstream/ is exactly what asi/FILES.sha256 lists (a changed file, a
#    CRLF checkout or an extra file stops it here).
# 2. Copies asi/upstream/src into a fresh work folder and applies asi/asi-occt79-wasm.patch
#    (no fuzz).
# 3. Compiles the asi/sources.txt files with the kernel's flags, asi_occt79_compat.h
#    force-included, against the same OCCT install as the facade, and archives them in
#    sources.txt order.
# Output: $(asi_dir wasm32)/{libasi.a,asi.flags.txt,build.log} (env.sh: the folder name hashes
# every input), or $ASI_OBJ when set. build.sh runs this when that libasi.a is missing; the
# work folder is renamed into place only when the library is complete. Paths are mapped
# (-ffile-prefix-map), so the bytes do not depend on where it ran.
# SPDX-License-Identifier: GPL-3.0-or-later
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
# shellcheck source=env.sh
source "$HERE/env.sh"
VARIANT="${1:?usage: build-asi.sh wasm32}"
[ "$VARIANT" = wasm32 ] || { echo "Analysis Situs is built for wasm32 only (the kernel that ships); $VARIANT links without it" >&2; exit 2; }

# 1. The vendored files are the pinned ones, and only those.
for f in FILES.sha256 sources.txt asi-occt79-wasm.patch asi_occt79_compat.h; do
  if grep -q $'\r' "$ASI_DIR/$f"; then
    echo "kernel-build/asi/$f has CRLF line ends: kernel-build/ was checked out with line-end conversion. The root .gitattributes keeps kernel-build/ LF and asi/upstream/ byte for byte; check kernel-build/ out again with those lines (or with core.autocrlf=false)." >&2
    exit 1
  fi
done
listed=$(sed -E 's/^[0-9a-f]{64}  //' "$ASI_DIR/FILES.sha256" | LC_ALL=C sort)
present=$(cd "$ASI_DIR/upstream" && find . -type f | sed 's|^\./||' | LC_ALL=C sort)
extra=$(comm -13 <(echo "$listed") <(echo "$present"))
if [ -n "$extra" ]; then
  echo "kernel-build/asi/upstream has files that asi/FILES.sha256 does not list:" >&2
  echo "$extra" | sed 's/^/  /' >&2
  exit 1
fi
if ! bad=$(cd "$ASI_DIR/upstream" && sha256sum --quiet --strict -c "$ASI_DIR/FILES.sha256" 2>&1); then
  echo "kernel-build/asi/upstream is not Analysis Situs $ASI_TAG (commit $ASI_COMMIT): these files do not match their sha256 in asi/FILES.sha256:" >&2
  echo "$bad" | grep -v '^sha256sum: WARNING' | sed 's/^/  /' >&2
  echo "A vendored file was changed, or checked out with CRLF line ends (.gitattributes keeps asi/upstream byte for byte). Our changes go in asi/asi-occt79-wasm.patch; asi/vendor.sh takes the pristine files again." >&2
  exit 1
fi

use_emsdk
INST="${OCCT_INSTALL:-$(occt_dir "$VARIANT")/install}"
[ -f "$INST/lib/libTKernel.a" ] || { echo "OCCT $VARIANT is not built in $INST: run build-occt.sh $VARIANT" >&2; exit 1; }
DEST="${ASI_OBJ:-$(asi_dir "$VARIANT")}"
WORK="$DEST.tmp-$$"
rm -rf "$WORK"
mkdir -p "$WORK/obj"
trap 'rm -rf "$WORK"' EXIT
started=$(date +%s)

# 2. A fresh copy with our port applied.
cp -R "$ASI_DIR/upstream/src" "$WORK/src"
cp "$ASI_DIR/asi_occt79_compat.h" "$WORK/asi_occt79_compat.h"
patch -d "$WORK" -p1 --forward --batch --fuzz=0 --no-backup-if-mismatch -s < "$ASI_DIR/asi-occt79-wasm.patch" ||
  { echo "asi/asi-occt79-wasm.patch does not apply to the vendored files" >&2; exit 1; }

# 3. Compile (in parallel; the archive order is sources.txt's) and archive.
INC="-I$WORK/src/asiAlgo"
for d in $(cd "$WORK/src/asiAlgo" && find . -mindepth 1 -maxdepth 1 -type d | sed 's|^\./||' | LC_ALL=C sort); do
  INC="$INC -I$WORK/src/asiAlgo/$d"
done
INC="$INC -I$WORK/src/asiActiveData/API -I$WORK/src/asiActiveData -I$WORK/src/asiActiveData/Mesh/DS"
ASI_CFLAGS="-std=c++17 $KERNEL_CFLAGS $KERNEL_PATHFLAGS -ffile-prefix-map=$WORK=/cad-asi -include $WORK/asi_occt79_compat.h $INC -I$INST/inc $ASI_DEFS -Wno-deprecated-declarations"
mapfile -t SRCS < <(sed '/^[[:space:]]*$/d' "$ASI_DIR/sources.txt")
export ASI_CFLAGS WORK
# shellcheck disable=SC2016
if ! printf '%s\n' "${SRCS[@]}" | xargs -P "${JOBS:-16}" -I{} bash -c '
  f="$1"; o="$WORK/obj/${f%.cpp}.o"; mkdir -p "$(dirname "$o")"
  echo "CXX $f"
  em++ $ASI_CFLAGS -c "$WORK/src/$f" -o "$o"' _ {} > "$WORK/build.log" 2>&1; then
  cp "$WORK/build.log" "$DEST.failed.log"
  grep -m 40 -E "error" "$WORK/build.log" >&2 || true
  echo "Analysis Situs did not compile (full log: $DEST.failed.log)" >&2
  exit 1
fi
OBJS=()
for f in "${SRCS[@]}"; do OBJS+=("$WORK/obj/${f%.cpp}.o"); done
emar rcsD "$WORK/libasi.a" "${OBJS[@]}"

# What the build record (build.sh) quotes.
{
  echo "asi_flags: em++ -std=c++17 $KERNEL_CFLAGS -ffile-prefix-map=<build root>=/cad-build -ffile-prefix-map=<plugin>=/cad-plugin -ffile-prefix-map=<asi work>=/cad-asi -include asi_occt79_compat.h -I<asiAlgo and its folders> -I<asiActiveData/API, asiActiveData, asiActiveData/Mesh/DS> -I<occt install>/inc $ASI_DEFS -Wno-deprecated-declarations"
  echo "asi_occt_install: ${OCCT_INSTALL:+override }$(basename "$(dirname "$INST")")"
} > "$WORK/asi.flags.txt"

rm -rf "$DEST" "$DEST.failed.log"
mv "$WORK" "$DEST"
echo "libasi.a: ${#SRCS[@]} objects, $(stat -c %s "$DEST/libasi.a") bytes, sha256 $(sha256sum "$DEST/libasi.a" | cut -c1-64), built in $(($(date +%s) - started)) s -> $DEST"
