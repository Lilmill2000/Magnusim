#!/usr/bin/env bash
# Reproducibility check: build the facade twice from nothing (fresh object
# folders, and Analysis Situs' libasi.a rebuilt from its sources each time) and
# compare the outputs byte for byte, then compare them with the shipped
# workspace/kernel/mk32.* and kernel-build/mk32.build.txt when those are meant
# to be this build.
#   kernel-build/repro-check.sh [--against-shipped]
# Exit 0 only when both builds are identical (and match the shipped files when
# asked) and no build-machine path is in what ships.
# SPDX-License-Identifier: GPL-3.0-or-later
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
PLUGIN=$(cd "$HERE/.." && pwd)
# shellcheck source=env.sh
source "$HERE/env.sh"
AGAINST=0
[ "${1:-}" = "--against-shipped" ] && AGAINST=1

WORK="$CAD_BUILD_ROOT/repro-$$"
rm -rf "$WORK"
mkdir -p "$WORK"
trap 'rm -rf "$WORK"' EXIT
for run in a b; do
  ASI_OBJ="$WORK/asi-$run" FACADE_OBJ="$WORK/obj-$run" "$HERE/build.sh" --out "$WORK/out-$run" --clean > "$WORK/$run.log" 2>&1 || {
    cat "$WORK/$run.log" >&2
    exit 1
  }
  grep -h '^libasi.a:' "$WORK/$run.log" | sed "s|$WORK|<work>|; s|^|run $run: |" || true
done
status=0
same() { # same <label> <file a> <file b>
  local a b
  a=$(sha256sum "$2" | cut -c1-64)
  b=$(sha256sum "$3" | cut -c1-64)
  if [ "$a" = "$b" ]; then echo "same   $1 $a"; else echo "DIFFER $1 $a vs $b"; status=1; fi
}
same libasi.a "$WORK/asi-a/libasi.a" "$WORK/asi-b/libasi.a"
for f in mk32.wasm mk32.mjs; do
  same "$f" "$WORK/out-a/$f" "$WORK/out-b/$f"
  if [ "$AGAINST" = 1 ]; then
    a=$(sha256sum "$WORK/out-a/$f" | cut -c1-64)
    s=$(sha256sum "$PLUGIN/workspace/kernel/$f" | cut -c1-64)
    if [ "$a" = "$s" ]; then echo "same as shipped $f"; else echo "DIFFERS from shipped $f ($s)"; status=1; fi
  fi
done
if [ "$AGAINST" = 1 ]; then
  if cmp -s "$WORK/out-a/mk32.build.txt" "$HERE/mk32.build.txt"; then echo "same as shipped mk32.build.txt"; else
    echo "DIFFERS from shipped mk32.build.txt:"
    diff "$HERE/mk32.build.txt" "$WORK/out-a/mk32.build.txt" | sed 's/^/  /' || true
    status=1
  fi
fi

# No build-machine path: this home folder, the build root, the plugin or this check's folder
# anywhere, and in mk32.wasm and libasi.a no path into the folder that holds home folders
# either (mk32.mjs keeps Emscripten's virtual HOME, the same in every build).
homes="$(dirname "$HOME")/"
for f in out-a/mk32.wasm out-a/mk32.mjs asi-a/libasi.a; do
  pats=("$HOME/" "$CAD_BUILD_ROOT" "$PLUGIN" "$WORK")
  if [ "$f" != out-a/mk32.mjs ] && [ "$homes" != "//" ]; then pats+=("$homes"); fi
  n=0
  for p in "${pats[@]}"; do n=$((n + $({ grep -a -o -F "$p" "$WORK/$f" || true; } | wc -l))); done
  if [ "$n" = 0 ]; then echo "no build-machine path in $(basename "$f")"; else echo "BUILD-MACHINE PATHS in $(basename "$f"): $n"; status=1; fi
done
exit $status
