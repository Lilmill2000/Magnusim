#!/usr/bin/env bash
# Remove finished Magnusim scratch cases under the WSL case root.
# Args: ROOT MAX_AGE_MIN DRY (1 = only count what would go)
#
# Every mesh and solve works in its own copy, ROOT/<case id>, and copies what it
# made back to Windows; a run that succeeds removes its copy itself. This sweeps
# the rest (failed, stopped or interrupted runs). A case goes only when:
#   - its name is a Magnusim case id (cfddesk-<a-z0-9 segments>), not a reserved one
#   - it is a real folder, not a link
#   - nothing in it was created or changed in the last MAX_AGE_MIN minutes. This is
#     ctime: cp -a keeps the Windows mtimes, so a case copied a minute ago can
#     look days old by mtime
#   - no process works in it (cwd) or names it on its command line
# Each case is first renamed into a private trash folder (one atomic step), so a
# job that starts on the same id meanwhile gets a fresh folder.
# Prints one line: PRUNE_RESULT {json}
set -u
ROOT="${1:-}"
MAX_AGE_MIN="${2:-}"
DRY="${3:-0}"

_fail() {
  echo "PRUNE_RESULT {\"ok\":false,\"error\":\"$1\"}"
  exit 2
}

case "$ROOT" in
  /*/cases) ;;
  *) _fail "case root must be an absolute path ending in /cases" ;;
esac
case "$ROOT" in
  *..* | *//* | *[[:space:]]*) _fail "case root must be a plain path" ;;
esac
[[ "$MAX_AGE_MIN" =~ ^[0-9]+$ ]] || _fail "max age must be whole minutes"
if [ "$DRY" = "1" ]; then dry=true; else dry=false; fi
if [ ! -d "$ROOT" ]; then
  echo "PRUNE_RESULT {\"ok\":true,\"removed\":0,\"freed_kb\":0,\"kept_recent\":0,\"kept_busy\":0,\"dry_run\":$dry,\"note\":\"no case root\"}"
  exit 0
fi

# ROOT/<name> paths that a live process works in or names (few forks: this runs
# once per candidate). Capture it before testing a path against it.
_busy() {
  {
    find /proc -mindepth 2 -maxdepth 2 -name cwd -printf '%l\n' 2>/dev/null
    cat /proc/[0-9]*/cmdline 2>/dev/null | tr '\0' '\n'
  } | grep -oE -- "$ROOT/[^/[:space:]'\"]+" | sort -u
}

removed=0
freed_kb=0
kept_recent=0
kept_busy=0
TRASH="$ROOT/.magnusim-prune-$$"

# Trash a sweep left behind when it died part way.
for t in "$ROOT"/.magnusim-prune-*; do
  [ -d "$t" ] || continue
  pid=${t##*-}
  [[ "$pid" =~ ^[0-9]+$ ]] || continue
  kill -0 "$pid" 2>/dev/null && continue
  [ "$DRY" = "1" ] || rm -rf -- "${t:?}"
done

BUSY=$(_busy)
for d in "$ROOT"/cfddesk-*; do
  name=${d##*/}
  [[ "$name" =~ ^cfddesk-[a-z0-9]+(-[a-z0-9]+)*$ ]] || continue
  # Reserved ids the app never creates for a job (setup and manual cases).
  [ "$name" = "cfddesk-cfmesh" ] && continue
  [[ "$name" == cfddesk-manual-* ]] && continue
  [ -L "$d" ] && continue
  [ -d "$d" ] || continue
  if printf '%s\n' "$BUSY" | grep -qxF -- "$d"; then
    kept_busy=$((kept_busy + 1))
    continue
  fi
  if [ -n "$(find "$d" -cmin "-$MAX_AGE_MIN" -print -quit 2>/dev/null)" ]; then
    kept_recent=$((kept_recent + 1))
    continue
  fi
  kb=$(du -sk -- "$d" 2>/dev/null | cut -f1)
  if [ "$DRY" != "1" ]; then
    # Last look: a job may have started on this case while the sweep ran. Scan
    # first, then test: a grep running during the scan would name the case itself.
    now=$(_busy)
    if printf '%s\n' "$now" | grep -qxF -- "$d"; then
      kept_busy=$((kept_busy + 1))
      continue
    fi
    mkdir -p -- "$TRASH" || break
    mv -T -- "$d" "$TRASH/$name" 2>/dev/null || continue
    rm -rf -- "${TRASH:?}/${name:?}"
  fi
  removed=$((removed + 1))
  freed_kb=$((freed_kb + ${kb:-0}))
done
[ -d "$TRASH" ] && rmdir -- "$TRASH" 2>/dev/null
echo "PRUNE_RESULT {\"ok\":true,\"removed\":$removed,\"freed_kb\":$freed_kb,\"kept_recent\":$kept_recent,\"kept_busy\":$kept_busy,\"dry_run\":$dry}"
