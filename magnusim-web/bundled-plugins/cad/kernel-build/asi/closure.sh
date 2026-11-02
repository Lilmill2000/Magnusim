#!/usr/bin/env bash
# The Analysis Situs files the kernel build compiles and includes, and their licences. For
# maintainers, to check the vendored set or after sources.txt changes:
#   asi/closure.sh               check asi/upstream: it is exactly the closure of sources.txt
#                                (every vendored file is used, every file used is vendored),
#                                every file is BSD-3-Clause but the two OCCT-derived
#                                asiAlgo_UnifySameDomain.{h,cpp} (LGPL-2.1 with the Open CASCADE
#                                exception), and LICENSES/AnalysisSitus-BSD-3-Clause.txt names
#                                every copyright holder and those two files
#   asi/closure.sh --src <dir>   the closure in a full upstream checkout's src/ instead, printed
#                                as the list for vendor.sh --list (LICENSE first), with the same
#                                licence summary
# The closure comes from the preprocessor (-MM -MG) with build-asi.sh's include folders and
# defines. Our patch only wraps OCCT, windowing and Eigen includes, so the pristine files give
# the same Analysis Situs closure as the patched ones.
# SPDX-License-Identifier: GPL-3.0-or-later
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
KB=$(cd "$HERE/.." && pwd)
# shellcheck source=../env.sh
source "$KB/env.sh"
SRC="$HERE/upstream/src"
CHECK=1
while [ $# -gt 0 ]; do
  case "$1" in
    --src) SRC=$(cd "$2" && pwd); CHECK=0; shift 2 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done
use_emsdk
INST="${OCCT_INSTALL:-$(occt_dir wasm32)/install}"
[ -f "$INST/lib/libTKernel.a" ] || { echo "OCCT wasm32 is not built in $INST: run build-occt.sh wasm32" >&2; exit 1; }
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
# The vendored files are scanned in a local copy (a checkout on a Windows drive is slow to read).
if [ "$CHECK" = 1 ]; then cp -R "$SRC" "$TMP/src"; SRC="$TMP/src"; fi

INC="-I$SRC/asiAlgo"
for d in $(cd "$SRC/asiAlgo" && find . -mindepth 1 -maxdepth 1 -type d | sed 's|^\./||' | LC_ALL=C sort); do
  INC="$INC -I$SRC/asiAlgo/$d"
done
INC="$INC -I$SRC/asiActiveData/API -I$SRC/asiActiveData -I$SRC/asiActiveData/Mesh/DS"
mapfile -t SRCS < <(sed '/^[[:space:]]*$/d' "$HERE/sources.txt")
for f in "${SRCS[@]}"; do
  # shellcheck disable=SC2086
  em++ -std=c++17 $KERNEL_CFLAGS -include "$HERE/asi_occt79_compat.h" $INC -I"$INST/inc" $ASI_DEFS -MM -MG "$SRC/$f" 2>/dev/null
done | tr ' \\' '\n\n' | sed -n "s|^$SRC/|src/|p" | LC_ALL=C sort -u > "$TMP/closure.txt"
for f in "${SRCS[@]}"; do grep -qxF "src/$f" "$TMP/closure.txt" || { echo "src/$f (sources.txt) is not in $SRC" >&2; exit 1; }; done

status=0
if [ "$CHECK" = 1 ]; then
  sed -E 's/^[0-9a-f]{64}  //' "$HERE/FILES.sha256" | grep -v '^LICENSE$' | LC_ALL=C sort > "$TMP/vendored.txt"
  missing=$(comm -23 "$TMP/closure.txt" "$TMP/vendored.txt")
  unused=$(comm -13 "$TMP/closure.txt" "$TMP/vendored.txt")
  [ -z "$missing" ] || { echo "used by the build, not vendored:"; echo "$missing" | sed 's/^/  /'; status=1; }
  [ -z "$unused" ] || { echo "vendored, not used by the build:"; echo "$unused" | sed 's/^/  /'; status=1; }
  [ "$status" = 0 ] && echo "closure: the $(wc -l < "$TMP/closure.txt") vendored files are exactly what the $(echo "${SRCS[@]}" | wc -w) sources.txt files compile and include"
else
  echo LICENSE
  cat "$TMP/closure.txt"
fi

python3 - "$(dirname "$SRC")" "$TMP/closure.txt" "$KB/../LICENSES/AnalysisSitus-BSD-3-Clause.txt" "$CHECK" > "$TMP/licences.txt" <<'PY' || status=1
import collections, re, sys
root, listing, licence_file, check = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4] == "1"
LGPL_OK = {"src/asiAlgo/auxiliary/asiAlgo_UnifySameDomain.h", "src/asiAlgo/auxiliary/asiAlgo_UnifySameDomain.cpp"}
holder_re = re.compile(r"Copyright \(c\) \d{4}(?:-(?:\d{4}|present))?,? (.+?)\s*$")
classes, holders, bad = collections.Counter(), collections.Counter(), []
for path in open(listing).read().split():
    head = open(f"{root}/{path}", encoding="utf-8", errors="replace").read()[:6000]
    bsd3 = all(s in head for s in ("Redistributions of source code must retain", "Redistributions in binary form", "Neither the name"))
    lgpl = "GNU Lesser General Public License version 2.1" in head and "OCCT_LGPL_EXCEPTION" in head
    kind = "BSD-3-Clause" if bsd3 else "LGPL-2.1 with the Open CASCADE exception" if lgpl else "other"
    classes[kind] += 1
    if kind == "BSD-3-Clause":
        names = {m.group(1) for m in map(holder_re.search, head.splitlines()) if m}
        if not names:
            bad.append(f"{path}: BSD-3-Clause without a copyright line")
        for n in names:
            holders[n] += 1
    elif not (lgpl and path in LGPL_OK):
        bad.append(f"{path}: {kind}")
print("licences: " + ", ".join(f"{k} {v}" for k, v in classes.most_common()))
print("BSD-3-Clause copyright holders (files): " + ", ".join(f"{k} {v}" for k, v in holders.most_common()))
if check:
    text = open(licence_file, encoding="utf-8").read()
    for n in holders:
        if f", {n}" not in text:
            bad.append(f"{licence_file.split('/')[-1]} does not name {n}")
    for p in LGPL_OK:
        if p.split("/")[-1].rsplit(".", 1)[0] not in text:
            bad.append(f"{licence_file.split('/')[-1]} does not name {p}")
for b in bad:
    print("  " + b)
sys.exit(1 if bad else 0)
PY
# The list goes to stdout alone with --src (for vendor.sh --list); the summary to stderr then.
if [ "$CHECK" = 1 ]; then cat "$TMP/licences.txt"; else cat "$TMP/licences.txt" >&2; fi
exit $status
