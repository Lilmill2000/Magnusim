#!/bin/bash
# Install OpenFOAM v2606 + case directory inside the CFD Desk WSL distro.
# Invoked as root by Setup.ps1. Optional arg: preferred Linux username.
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive
export NEEDRESTART_MODE=a
export NEEDRESTART_SUSPEND=1

log() { echo "[cfddesk-wsl] $*"; }

apt-get update -y
apt-get install -y --no-install-recommends \
  ca-certificates curl wget gnupg sudo \
  python3 \
  openmpi-bin \
  rsync \
  locales

if ! command -v openfoam2606 >/dev/null 2>&1; then
  log "Adding the OpenFOAM.com Debian repository (one-time)"
  curl -fsSL https://dl.openfoam.com/add-debian-repo.sh | bash
  apt-get update -y
  log "Installing openfoam2606-default (large download)"
  apt-get install -y openfoam2606-default
else
  log "openfoam2606 already on PATH"
fi

# Hex-element-core path needs cartesianMesh. Package names differ by repo.
if ! openfoam2606 bash -c 'command -v cartesianMesh' >/dev/null 2>&1; then
  log "Trying to install cfMesh (cartesianMesh) from apt"
  apt-get install -y cfmesh-openfoam2606 \
    || apt-get install -y openfoam2606-cfmesh \
    || log "cfMesh is not in apt — Standard mesh still works; Hex element core will not"
fi

PREFERRED="${1:-}"
TARGET_USER=""
if [ -n "$PREFERRED" ] && id -u "$PREFERRED" >/dev/null 2>&1; then
  TARGET_USER="$PREFERRED"
elif getent passwd 1000 >/dev/null 2>&1; then
  TARGET_USER="$(getent passwd 1000 | cut -d: -f1)"
elif [ -n "$PREFERRED" ]; then
  log "Creating Linux user $PREFERRED"
  useradd -m -s /bin/bash -u 1000 "$PREFERRED"
  echo "$PREFERRED ALL=(ALL) NOPASSWD:ALL" >/etc/sudoers.d/cfddesk
  chmod 440 /etc/sudoers.d/cfddesk
  mkdir -p /etc
  printf '[user]\ndefault=%s\n' "$PREFERRED" >/etc/wsl.conf
  TARGET_USER="$PREFERRED"
else
  TARGET_USER="root"
fi

if [ "$TARGET_USER" = "root" ]; then
  HOME_DIR="/root"
else
  HOME_DIR="$(getent passwd "$TARGET_USER" | cut -d: -f6)"
fi
[ -n "$HOME_DIR" ] || HOME_DIR="/root"

mkdir -p "$HOME_DIR/cases"
if [ "$TARGET_USER" != "root" ]; then
  chown -R "$TARGET_USER:$TARGET_USER" "$HOME_DIR/cases" || true
fi

log "Checking simpleFoam"
openfoam2606 bash -c 'simpleFoam -help' >/dev/null

CFMESH="no"
if openfoam2606 bash -c 'command -v cartesianMesh' >/dev/null 2>&1; then
  CFMESH="yes"
fi

python3 - <<PY
import json
print(json.dumps({
    "user": "$TARGET_USER",
    "home": "$HOME_DIR",
    "cases": "$HOME_DIR/cases",
    "cartesianMesh": "$CFMESH",
}))
PY
