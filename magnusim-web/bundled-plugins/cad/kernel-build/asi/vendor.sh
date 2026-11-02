#!/usr/bin/env bash
# Take the pinned Analysis Situs files into asi/upstream/ again and check them. For
# maintainers: the kernel build never runs this, build-asi.sh uses the committed files.
#   asi/vendor.sh                  clone upstream (blob-less, no checkout) into a temporary folder
#   asi/vendor.sh --from <clone>   use a clone that already has the pinned commit (offline: it
#                                  never fetches into that clone; a missing file is an error)
#   asi/vendor.sh --list <file>    take these paths (relative to the upstream root, one per
#                                  line) instead of the ones FILES.sha256 lists, and write a new
#                                  FILES.sha256 (after sources.txt changes: SOURCES.md says how)
#   asi/vendor.sh --out <dir>      write there instead of asi/upstream/ (to compare)
# Without --list the files must match FILES.sha256, or nothing is replaced.
#
# How the committed files were taken (2026-11-01): `vendor.sh --from <clone> --list <list>`,
# where <clone> was the sparse checkout made for the 2026-10-29 build proof:
#   git clone --filter=blob:none --no-checkout --depth 1 --branch v2026.1.1 \
#     https://gitlab.com/ssv/AnalysisSitus.git src-asi
#   git -C src-asi sparse-checkout set --no-cone '/*' '!/src/asiAlgo/mesh/occt62/' '!/data/'
#   git -C src-asi checkout
# and <list> was LICENSE, the 43 sources.txt files and every Analysis Situs header their compile
# includes (the .d files of that build): 170 files. Each file is `git show <commit>:<path>`, the
# pristine blob at the pin, never the working tree (the proof had edited it).
#
# Without --from this script makes no checkout at all: it fetches the commit's trees and then
# only the blobs it takes. src/asiAlgo/mesh/occt62/ holds J. R. Shewchuk's Triangle, which is
# not free for commercial use: it is never fetched, checked out or vendored.
# SPDX-License-Identifier: GPL-3.0-or-later
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
# shellcheck source=../env.sh
source "$HERE/../env.sh"

FROM=""
LIST=""
OUT="$HERE/upstream"
while [ $# -gt 0 ]; do
  case "$1" in
    --from) FROM="$2"; shift 2 ;;
    --list) LIST="$2"; shift 2 ;;
    --out) OUT="$2"; shift 2 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

paths=()
if [ -n "$LIST" ]; then
  mapfile -t paths < <(tr -d '\r' < "$LIST" | sed '/^[[:space:]]*$/d' | LC_ALL=C sort -u)
else
  mapfile -t paths < <(sed -E 's/^[0-9a-f]{64}  //' "$HERE/FILES.sha256")
fi
[ "${#paths[@]}" -gt 0 ] || { echo "no files to take" >&2; exit 1; }
for p in "${paths[@]}"; do
  case "$p" in
    src/asiAlgo/mesh/occt62/* | */triangle.* | triangle.*)
      echo "refused: $p (Triangle is never vendored)" >&2
      exit 1
      ;;
    LICENSE | src/*) ;;
    *)
      echo "refused: $p (only LICENSE and files under src/)" >&2
      exit 1
      ;;
  esac
done

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
GIT=(git)
if [ -z "$FROM" ]; then
  git clone --quiet --filter=blob:none --no-checkout --depth 1 --branch "$ASI_TAG" "$ASI_REPO" "$TMP/asi"
  FROM="$TMP/asi"
else
  # Never fetch into someone else's clone: with no promisor remote a missing blob is an error.
  GIT=(git -c remote.origin.promisor=false)
fi
got=$("${GIT[@]}" -C "$FROM" rev-parse --verify --quiet "$ASI_TAG^{commit}" || true)
[ "$got" = "$ASI_COMMIT" ] || { echo "$FROM: $ASI_TAG is '${got:-missing}', expected $ASI_COMMIT" >&2; exit 1; }

NEW="$TMP/upstream"
mkdir -p "$NEW"
for p in "${paths[@]}"; do
  mkdir -p "$NEW/$(dirname "$p")"
  "${GIT[@]}" -C "$FROM" show "$ASI_COMMIT:$p" > "$NEW/$p"
done

if [ -n "$LIST" ]; then
  (cd "$NEW" && printf '%s\n' "${paths[@]}" | xargs sha256sum) > "$TMP/FILES.sha256"
else
  if ! bad=$(cd "$NEW" && sha256sum --quiet --strict -c "$HERE/FILES.sha256" 2>&1); then
    echo "the files at $ASI_COMMIT differ from FILES.sha256; nothing was replaced:" >&2
    echo "$bad" | sed 's/^/  /' >&2
    exit 1
  fi
fi

rm -rf "$OUT"
mkdir -p "$(dirname "$OUT")"
cp -R "$NEW" "$OUT"
if [ -n "$LIST" ]; then cp "$TMP/FILES.sha256" "$HERE/FILES.sha256"; fi
echo "${#paths[@]} files of Analysis Situs $ASI_TAG ($ASI_COMMIT) -> $OUT"
