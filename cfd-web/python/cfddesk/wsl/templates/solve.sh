#!/usr/bin/env bash
# cfddesk solve pipeline (Phase 1). Placeholders replaced by solve_run.render_solve_script:
#   __DST__ __WIN_OUT__ __NPROCS__ __APP__ __RUN_ID__
# Ext4 ($DST) is the case source of truth. Windows gets residuals/postProcessing,
# viewer VTPs, logs, and saved fields as each write interval completes so
# Results can open mid-run. Transient runs keep every result frame; steady
# runs only need the latest converged field.
# Emits MAGNUSIM_EVENT JSON lines (CFDDESK_EVENT still accepted by parsers); OpenFOAM stdout passes through.
set -uo pipefail
DST="__DST__"
WIN_OUT="__WIN_OUT__"
NPROCS="__NPROCS__"
RUN_ID="__RUN_ID__"
APP="__APP__"

_evt() {
  echo "MAGNUSIM_EVENT $1"
}

_evt "{\"event\":\"start\",\"run_id\":\"$RUN_ID\",\"dst\":\"$DST\",\"n_procs\":$NPROCS,\"app\":\"$APP\",\"increment\":\"phase1-lean-copy\"}"

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

# ---- Live results: graphs + completed volume frames ------------------------
SYNC_EVERY=10
copy_saved_time() {
  local t="$1"
  if [ -f "$DST/$t/U" ] || [ -f "$DST/$t/p" ]; then
    rm -rf "$WIN_OUT/$t"
    if cp -a "$DST/$t" "$WIN_OUT/"; then
      _evt "{\"event\":\"time_saved\",\"t\":$t}"
    else
      [ "$EC" -ne 0 ] || EC=48
      _evt "{\"event\":\"error\",\"code\":48,\"error\":\"result frame copy failed\"}"
    fi
  fi
}

_list_times() {
  local root="$1" t d
  for d in "$root"/[0-9]*; do
    [ -d "$d" ] || continue
    t=$(basename "$d")
    [[ "$t" =~ ^[0-9]+([.][0-9]+)?([eE][+-]?[0-9]+)?$ ]] || continue
    [ "$t" = "0" ] && continue
    echo "$t"
  done | awk '{print $1+0, $0}' | sort -n | awk '{print $2}'
}

_latest_time() {
  _list_times "$DST" | tail -n 1
}

sync_results() {
  if [ -d "$DST/postProcessing" ]; then
    rm -rf "$WIN_OUT/.sync_pp" 2>/dev/null
    if cp -a "$DST/postProcessing" "$WIN_OUT/.sync_pp" 2>>log.livesync; then
      rm -rf "$WIN_OUT/postProcessing"
      mv "$WIN_OUT/.sync_pp" "$WIN_OUT/postProcessing" 2>>log.livesync || true
    fi
  fi
  [ -f "log.$APP" ] && cp -f "log.$APP" "$WIN_OUT/" 2>/dev/null || true
  return 0
}

# Reconstruct/copy times the solver has finished writing. Skip the newest
# processor (or serial) time — it may still be open.
sync_live_frames() {
  if [ -f "$DST/.live_frame_lock" ]; then
    return 0
  fi
  touch "$DST/.live_frame_lock"
  local src_root="$DST" latest t
  if [ "$NPROCS" -gt 1 ] && [ -d "$DST/processor0" ]; then
    src_root="$DST/processor0"
  fi
  latest=$(_list_times "$src_root" | tail -n 1)
  if [ -z "$latest" ]; then
    rm -f "$DST/.live_frame_lock"
    return 0
  fi
  for t in $(_list_times "$src_root"); do
    [ "$t" = "$latest" ] && continue
    if [ "$NPROCS" -gt 1 ] && [ ! -f "$DST/$t/U" ] && [ ! -f "$DST/$t/p" ]; then
      openfoam2606 bash -c "cd '$DST' && reconstructPar -time $t -noZero" >> log.reconstructPar.live 2>&1 || true
    fi
    if [ ! -f "$WIN_OUT/$t/U" ] && [ ! -f "$WIN_OUT/$t/p" ]; then
      copy_saved_time "$t"
    fi
  done
  rm -f "$DST/.live_frame_lock"
}

live_sync_loop() {
  local n=0
  while kill -0 "$1" 2>/dev/null; do
    sleep 2
    n=$((n + 2))
    sync_live_frames
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
  ( openfoam2606 bash -c "cd '$DST' && mpirun --oversubscribe -np $NPROCS $APP -parallel" 2>&1 | tee "log.$APP"; exit "${PIPESTATUS[0]}" ) &
  SOLVER_PID=$!
  live_sync_loop "$SOLVER_PID"
  wait "$SOLVER_PID"
  EC=$?
  _evt "{\"event\":\"stage\",\"stage\":\"reconstruct\",\"exit_code\":$EC}"
  if [ "$APP" = "pimpleFoam" ]; then
    openfoam2606 bash -c "cd '$DST' && reconstructPar -noZero" 2>&1 | tee log.reconstructPar
  else
    openfoam2606 bash -c "cd '$DST' && reconstructPar -latestTime" 2>&1 | tee log.reconstructPar
  fi
  RECON_EC=${PIPESTATUS[0]}
  if [ "$EC" -eq 0 ] && [ "$RECON_EC" -ne 0 ]; then EC=$RECON_EC; fi
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
# Viewer VTPs / VTK dumps if a later land writes them on ext4.
if [ -d VTK ]; then cp -a VTK "$WIN_OUT/" 2>/dev/null || true; fi
shopt -s nullglob
for f in *.vtp *.vtu *.vtk; do
  [ -e "$f" ] && cp -f "$f" "$WIN_OUT/" 2>/dev/null || true
done
if [ "$APP" = "pimpleFoam" ]; then
  for frame in "$DST"/[0-9]*; do
    [ -d "$frame" ] || continue
    t=$(basename "$frame")
    [[ "$t" =~ ^[0-9]+([.][0-9]+)?([eE][+-]?[0-9]+)?$ ]] || continue
    [ "$t" = "0" ] || copy_saved_time "$t"
  done
else
  LATEST=$(_latest_time)
  [ -z "$LATEST" ] || copy_saved_time "$LATEST"
fi

if [ "$EC" -eq 0 ]; then
  _evt "{\"event\":\"result\",\"ok\":true,\"exit_code\":0,\"win_out\":\"$WIN_OUT\"}"
else
  _evt "{\"event\":\"result\",\"ok\":false,\"exit_code\":$EC,\"win_out\":\"$WIN_OUT\"}"
fi
exit $EC
