#!/usr/bin/env bash
# Reproducibility check: build the facade twice from nothing (fresh object
# folders) and compare the outputs byte for byte, then compare them with the
# shipped workspace/kernel/mk32.* when those are meant to be this build.
#   kernel-build/repro-check.sh [--against-shipped]
# Exit 0 only when both builds are identical (and match the shipped files when asked).
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
  FACADE_OBJ="$WORK/obj-$run" "$HERE/build.sh" --out "$WORK/out-$run" --clean > "$WORK/$run.log" 2>&1 || {
    cat "$WORK/$run.log" >&2
    exit 1
  }
done
status=0
for f in mk32.wasm mk32.mjs; do
  a=$(sha256sum "$WORK/out-a/$f" | cut -c1-64)
  b=$(sha256sum "$WORK/out-b/$f" | cut -c1-64)
  if [ "$a" = "$b" ]; then echo "same   $f $a"; else echo "DIFFER $f $a vs $b"; status=1; fi
  if [ "$AGAINST" = 1 ]; then
    s=$(sha256sum "$PLUGIN/workspace/kernel/$f" | cut -c1-64)
    if [ "$a" = "$s" ]; then echo "same as shipped $f"; else echo "DIFFERS from shipped $f ($s)"; status=1; fi
  fi
done
exit $status
