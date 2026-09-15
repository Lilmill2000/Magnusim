#!/usr/bin/env bash
# cfddesk solve pipeline (Phase 1 Step 5). Placeholders replaced by solve_run.render_solve_script:
#   /home/drmil/cases/cfddesk-w27-run-land3 /mnt/c/Users/drmil/Desktop/Code/CFD/cfd-web/python 2 simpleFoam run-land3
# Emits CFDDESK_EVENT JSON lines; OpenFOAM solver stdout passes through untouched.
set -uo pipefail
DST="/home/drmil/cases/cfddesk-w27-run-land3"
WIN_OUT="/mnt/c/Users/drmil/Desktop/Code/CFD/cfd-web/python"
NPROCS="2"
RUN_ID="run-land3"
APP="simpleFoam"

_evt() {
  echo "CFDDESK_EVENT $1"
}

_evt "{\"event\":\"start\",\"run_id\":\"$RUN_ID\",\"dst\":\"$DST\",\"n_procs\":$NPROCS,\"app\":\"$APP\",\"increment\":\"phase1-land3\"}"

if [ ! -d "$WIN_OUT/constant/polyMesh" ]; then
  _evt "{\"event\":\"error\",\"code\":46,\"error\":\"missing polyMesh in $WIN_OUT\"}"
  _evt "{\"event\":\"result\",\"ok\":false,\"exit_code\":46}"
  exit 46
fi

_evt "{\"event\":\"stage\",\"stage\":\"copy_to_wsl\"}"
rm -rf "$DST"
mkdir -p "$DST"
cp -a "$WIN_OUT/." "$DST/"
cd "$DST" || exit 47
_evt "{\"event\":\"log\",\"line\":\"cwd=$(pwd)\"}"
EC=0

# ---- Live results ---------------------------------------------------------
SYNC_EVERY=10
SYNC_SETTLE_MIN=0.2
sync_results() {
  local src="$DST"
  [ "$NPROCS" -gt 1 ] && src="$DST/processor0"
  local newest="" t d
  local list=()
  for d in "$src"/[0-9]*; do
    [ -d "$d" ] || continue
    t=$(basename "$d")
    [ "$t" = "0" ] && continue
    list+=("$t")
    if [ -z "$newest" ] || awk -v a="$t" -v b="$newest" 'BEGIN{exit !(a+0 > b+0)}'; then newest="$t"; fi
  done
  [ "${#list[@]}" -gt 0 ] || return 0
  local todo=()
  for t in "${list[@]}"; do
    [ -d "$WIN_OUT/$t" ] && continue
    if [ "$NPROCS" -gt 1 ]; then
      [ "$(ls -d "$DST"/processor*/"$t" 2>/dev/null | wc -l)" -ge "$NPROCS" ] || continue
      [ -z "$(find "$DST"/processor*/"$t" -type f -mmin -$SYNC_SETTLE_MIN -print -quit 2>/dev/null)" ] || continue
    elif [ "$t" = "$newest" ]; then
      [ -z "$(find "$src/$t" -type f -mmin -$SYNC_SETTLE_MIN -print -quit 2>/dev/null)" ] || continue
    fi
    todo+=("$t")
  done
  [ "${#todo[@]}" -gt 0 ] || return 0
  if [ "$NPROCS" -gt 1 ]; then
    local tl; tl=$(IFS=,; echo "${todo[*]}")
    openfoam2606 bash -c "cd '$DST' && reconstructPar -time '$tl'" >> log.reconstructPar.live 2>&1 || true
  fi
  for t in "${todo[@]}"; do
    if [ ! -f "$DST/$t/U" ] && [ ! -f "$DST/$t/p" ]; then
      [ "$NPROCS" -gt 1 ] && rm -rf "$DST/$t"
      continue
    fi
    rm -rf "$WIN_OUT/.sync_$t" 2>/dev/null
    local ok=0 tries=0
    if cp -a "$DST/$t" "$WIN_OUT/.sync_$t" 2>>log.livesync; then
      while [ "$tries" -lt 5 ]; do
        if mv "$WIN_OUT/.sync_$t" "$WIN_OUT/$t" 2>>log.livesync; then ok=1; break; fi
        tries=$((tries + 1))
        sleep 1
      done
    fi
    if [ "$ok" -eq 1 ]; then
      _evt "{\"event\":\"time_saved\",\"t\":$t}"
    else
      echo "TIME_SYNC_RETRY t=$t" >> log.livesync
      rm -rf "$WIN_OUT/.sync_$t" 2>/dev/null
    fi
  done
  if [ -d postProcessing ]; then cp -a postProcessing "$WIN_OUT/" 2>/dev/null || true; fi
  return 0
}
live_sync_loop() {
  local n=0
  while kill -0 "$1" 2>/dev/null; do
    sleep 2
    n=$((n + 2))
    if [ "$n" -ge "$SYNC_EVERY" ]; then n=0; sync_results; fi
  done
}

if [ "$NPROCS" -gt 1 ]; then
  _evt "{\"event\":\"stage\",\"stage\":\"decompose\"}"
  openfoam2606 bash -c "cd '$DST' && decomposePar -force" 2>&1 | tee log.decomposePar
  EC=${PIPESTATUS[0]}
  _evt "{\"event\":\"stage\",\"stage\":\"decompose_end\",\"exit_code\":$EC}"
  if [ "$EC" -ne 0 ]; then
    _evt "{\"event\":\"result\",\"ok\":false,\"exit_code\":$EC}"
    exit $EC
  fi
  _evt "{\"event\":\"stage\",\"stage\":\"solve\",\"parallel\":true,\"n_procs\":$NPROCS,\"app\":\"$APP\"}"
  ( openfoam2606 bash -c "cd '$DST' && mpirun -np $NPROCS $APP -parallel" 2>&1 | tee "log.$APP"; exit "${PIPESTATUS[0]}" ) &
  SOLVER_PID=$!
  live_sync_loop "$SOLVER_PID"
  wait "$SOLVER_PID"
  EC=$?
  _evt "{\"event\":\"stage\",\"stage\":\"reconstruct\",\"exit_code\":$EC}"
  openfoam2606 bash -c "cd '$DST' && reconstructPar -newTimes" 2>&1 | tee log.reconstructPar || true
else
  _evt "{\"event\":\"stage\",\"stage\":\"solve\",\"parallel\":false,\"app\":\"$APP\"}"
  ( openfoam2606 bash -c "cd '$DST' && $APP" 2>&1 | tee "log.$APP"; exit "${PIPESTATUS[0]}" ) &
  SOLVER_PID=$!
  live_sync_loop "$SOLVER_PID"
  wait "$SOLVER_PID"
  EC=$?
  _evt "{\"event\":\"stage\",\"stage\":\"solve_end\",\"exit_code\":$EC}"
fi

_evt "{\"event\":\"stage\",\"stage\":\"copy\"}"
mkdir -p "$WIN_OUT"
for d in "log.$APP" log.decomposePar log.reconstructPar log.reconstructPar.live log.livesync postProcessing; do
  [ -e "$d" ] && cp -a "$d" "$WIN_OUT/" 2>/dev/null || true
done
for d in [0-9]*; do
  [ -d "$d" ] || continue
  if [ "$d" != "0" ] && [ -d "$WIN_OUT/$d" ]; then continue; fi
  cp -a "$d" "$WIN_OUT/" 2>/dev/null || true
done

if [ "$EC" -eq 0 ]; then
  _evt "{\"event\":\"result\",\"ok\":true,\"exit_code\":0,\"win_out\":\"$WIN_OUT\"}"
else
  _evt "{\"event\":\"result\",\"ok\":false,\"exit_code\":$EC,\"win_out\":\"$WIN_OUT\"}"
fi
exit $EC
