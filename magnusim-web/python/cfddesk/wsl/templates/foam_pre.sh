#!/usr/bin/env bash
# WSL steps of a step-list run (plugin OpenFOAM cases, meshing plans).
# Placeholders (DST, WIN_OUT, TOKEN and STEPS, each between two underscores on
# both sides) are replaced in one pass by cfddesk.wsl.foam_case.render_foam_pre;
# each appears once, below.
# Copies the Windows case in, runs each step from the one allowlist, and copies
# back constant/polyMesh, 0/ (when there is one) and the logs. Tool output goes
# only to log.<tool>.<i>; this script prints only MAGNUSIM_EVENT lines.
# A step is a bash array run as `openfoam2606 "${STEP_i[@]}"`; no argument is
# pasted into bash -c. A parallel step with more than one rank runs as
# mpirun --oversubscribe -np N <tool> ... -parallel, as solve.sh runs a parallel solve.
# .magnusim-stop in the Windows case, checked before and after each step, ends
# the run with exit 130. This script never creates the Windows case folder.
set -uo pipefail
DST="__DST__"
WIN_OUT="__WIN_OUT__"
TOKEN="__TOKEN__"

_evt() {
  local j="$1"
  # Stage and result events carry the WSL wall clock (the relay times the phase).
  case "$j" in
    *'"event":"stage"'*|*'"event":"result"'*) j="${j%\}},\"t_wall\":$(date +%s.%3N)}" ;;
  esac
  echo "MAGNUSIM_EVENT $j"
}

_copy_logs() {
  [ -d "$WIN_OUT" ] || return 0
  local f
  for f in "$DST"/log.*; do
    [ -f "$f" ] && cp -f "$f" "$WIN_OUT/" 2>/dev/null
  done
  return 0
}

_fail() {
  local ec="$1" tool="${2:-}" idx="${3:-}"
  _copy_logs
  if [ -n "$tool" ]; then
    _evt "{\"event\":\"result\",\"ok\":false,\"exit_code\":$ec,\"tool\":\"$tool\",\"index\":$idx}"
  else
    _evt "{\"event\":\"result\",\"ok\":false,\"exit_code\":$ec}"
  fi
  exit "$ec"
}

_stop_check() {
  if [ -e "$WIN_OUT/.magnusim-stop" ]; then
    _copy_logs
    _evt "{\"event\":\"result\",\"ok\":false,\"stopped\":true,\"exit_code\":130}"
    exit 130
  fi
}

# Result time folders in the case copy (0 is the start, not a result).
_time_dirs() {
  local d t
  for d in "$DST"/[0-9]*; do
    [ -d "$d" ] || continue
    t=${d##*/}
    [[ "$t" =~ ^[0-9]+([.][0-9]+)?([eE][+-]?[0-9]+)?$ ]] || continue
    [ "$t" = "0" ] && continue
    echo "$t"
  done
}

_step_done() {
  local idx="$1" tool="$2" ec="$3" par="$4" np="$5"
  _evt "{\"event\":\"pre\",\"tool\":\"$tool\",\"index\":$idx,\"exit_code\":$ec,\"parallel\":$par,\"n_procs\":$np}"
  [ "$ec" -eq 0 ] || _fail "$ec" "$tool" "$idx"
  [ -z "$(_time_dirs)" ] || _fail 50 "$tool" "$idx"
  _stop_check
}

# decomposePar and reconstructParMesh of a run with one rank: the span runs serially.
_step_skipped() {
  _evt "{\"event\":\"pre\",\"tool\":\"$2\",\"index\":$1,\"exit_code\":0,\"parallel\":false,\"n_procs\":1,\"skipped\":true}"
}

# A folder comes back whole: copied beside its old one, then renamed into place.
_put_back() {
  local rel="$1" part="$2" dest tmp
  dest="$WIN_OUT/$rel"
  tmp="$(dirname "$dest")/$part"
  rm -rf "$tmp"
  if cp -a "$DST/$rel" "$tmp" && rm -rf "$dest" && mv "$tmp" "$dest"; then
    return 0
  fi
  rm -rf "$tmp" 2>/dev/null
  return 1
}

_evt "{\"event\":\"stage\",\"stage\":\"pre_copy_in\",\"token\":\"$TOKEN\"}"
_stop_check
rm -rf "$DST"
mkdir -p "$DST"
cp -a "$WIN_OUT/." "$DST/" || _fail 47
cd "$DST" || _fail 47

__STEPS__

[ -d "$DST/constant/polyMesh" ] || _fail 46

_evt "{\"event\":\"stage\",\"stage\":\"pre_copy_back\"}"
[ -d "$WIN_OUT/constant" ] || mkdir "$WIN_OUT/constant" || _fail 48
_put_back constant/polyMesh .magnusim-polyMesh.part || _fail 48
if [ -d "$DST/0" ]; then
  _put_back 0 .magnusim-0.part || _fail 48
fi
_copy_logs
_evt "{\"event\":\"stage\",\"stage\":\"pre_done\"}"
_evt "{\"event\":\"result\",\"ok\":true,\"exit_code\":0}"
exit 0
