# Shared settings for the kernel build scripts (sourced, not run).
# solver-build/build.sh sources this file too (CAD_BUILD_ROOT, use_emsdk,
# KERNEL_PATHFLAGS): keep those names.
# SPDX-License-Identifier: GPL-3.0-or-later

# Everything big lives outside the plugin: toolchain, OCCT source and builds, objects.
export CAD_BUILD_ROOT="${CAD_BUILD_ROOT:-$HOME/cad-build}"
KERNEL_BUILD_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)

# Pinned versions (kernel-build/SOURCES.md).
EMSDK_VERSION=6.0.10
# What `emcc --version` reports for 6.0.10; use_emsdk refuses anything else.
EMSDK_EMCC_COMMIT=d6c521a7f05449857c76bd99e396895583cf2083
EMSDK_REPO=https://github.com/emscripten-core/emsdk.git
OCCT_TAG=V7_9_3
OCCT_COMMIT=a016080bf6738d6aeae020badee4e888ad1540a5
OCCT_REPO=https://github.com/Open-Cascade-SAS/OCCT.git
OCCT_SRC="$CAD_BUILD_ROOT/occt-7.9.3"

# Every object linked into the kernel uses the same code-generation flags.
KERNEL_CFLAGS="-O3 -fwasm-exceptions -msimd128"
# Source paths baked into messages (__FILE__) are made machine-independent, so a
# build does not depend on (or reveal) where it ran. Codegen is unchanged.
KERNEL_PATHFLAGS="-ffile-prefix-map=$CAD_BUILD_ROOT=/cad-build -ffile-prefix-map=$(cd "$KERNEL_BUILD_DIR/.." && pwd)=/cad-plugin"

# OCCT libraries live in a folder named after everything that shapes them (the
# pinned commit, Emscripten, flags, patches and the configure script), so any
# change to those builds OCCT again instead of reusing stale libraries:
#   $CAD_BUILD_ROOT/occt-<variant>-<key>/{build,install}
occt_key() {
  local variant="$1"
  {
    echo "occt=$OCCT_COMMIT emsdk=$EMSDK_VERSION/$EMSDK_EMCC_COMMIT variant=$variant cflags=$KERNEL_CFLAGS"
    cat "$KERNEL_BUILD_DIR/build-occt.sh"
    for p in "$KERNEL_BUILD_DIR"/occt-patches/*.patch; do
      [ -e "$p" ] || continue
      echo "patch $(basename "$p")"
      cat "$p"
    done
  } | sha256sum | cut -c1-12
}
occt_dir() { echo "$CAD_BUILD_ROOT/occt-$1-$(occt_key "$1")"; }

# Put the pinned Emscripten on PATH (installs it on first use).
use_emsdk() {
  local dir="$CAD_BUILD_ROOT/emsdk"
  if [ ! -f "$dir/emsdk_env.sh" ]; then
    git clone "$EMSDK_REPO" "$dir"
  fi
  # shellcheck disable=SC1091
  source "$dir/emsdk_env.sh" >/dev/null 2>&1 || true
  if ! command -v emcc >/dev/null 2>&1 || ! emcc --version 2>/dev/null | head -1 | grep -q " $EMSDK_VERSION "; then
    (cd "$dir" && ./emsdk install "$EMSDK_VERSION" && ./emsdk activate "$EMSDK_VERSION" >/dev/null)
    # shellcheck disable=SC1091
    source "$dir/emsdk_env.sh" >/dev/null 2>&1
  fi
  emcc --version | head -1 | grep -q " $EMSDK_VERSION ($EMSDK_EMCC_COMMIT)" || {
    echo "emcc $EMSDK_VERSION ($EMSDK_EMCC_COMMIT) is not active: $(emcc --version | head -1)" >&2
    exit 1
  }
  if [ -x "$HOME/.local/bin/ninja" ]; then export PATH="$HOME/.local/bin:$PATH"; fi
}
