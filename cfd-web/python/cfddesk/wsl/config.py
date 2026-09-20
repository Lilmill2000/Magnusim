"""WSL distro + case-root for this machine.

Setup.bat writes ``cfd-web/.magnusim-local.json`` (legacy name still accepted). Override with
``MAGNUSIM_WSL_DISTRO`` / ``MAGNUSIM_WSL_CASE_ROOT``.
"""

from __future__ import annotations

import json
import os
import subprocess
from pathlib import Path

DEFAULT_WSL_DISTRO = "Ubuntu-24.04"
DEFAULT_WSL_CASE_ROOT = "/home/cfddesk/cases"
_LOCAL_NAME = ".cfddesk-local.json"


def web_root() -> Path:
    """``cfd-web/`` (this file lives at ``python/cfddesk/wsl/config.py``)."""
    return Path(__file__).resolve().parents[3]


def local_json_path() -> Path:
    override = (os.environ.get("MAGNUSIM_LOCAL_JSON") or os.environ.get("CFDDESK_LOCAL_JSON") or "").strip()
    if override:
        return Path(override)
    current = web_root() / ".magnusim-local.json"
    legacy = web_root() / _LOCAL_NAME
    return current if current.exists() or not legacy.exists() else legacy


def _read_local() -> dict:
    path = local_json_path()
    if not path.is_file():
        return {}
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {}
    return data if isinstance(data, dict) else {}


def _probe_wsl_home(distro: str) -> str | None:
    try:
        r = subprocess.run(
            ["wsl", "-d", distro, "--", "printenv", "HOME"],
            capture_output=True,
            text=True,
            timeout=45,
            check=False,
        )
    except (OSError, subprocess.TimeoutExpired):
        return None
    if r.returncode != 0:
        return None
    lines = [ln.strip() for ln in (r.stdout or "").splitlines() if ln.strip()]
    home = lines[-1] if lines else ""
    return home if home.startswith("/") and home != "/" else None


def wsl_settings() -> dict[str, str]:
    local = _read_local()
    distro = (
        (os.environ.get("MAGNUSIM_WSL_DISTRO") or os.environ.get("CFDDESK_WSL_DISTRO") or "").strip()
        or str(local.get("wsl_distro") or "").strip()
        or DEFAULT_WSL_DISTRO
    )
    root = (
        (os.environ.get("MAGNUSIM_WSL_CASE_ROOT") or os.environ.get("CFDDESK_WSL_CASE_ROOT") or "").strip()
        or str(local.get("wsl_case_root") or "").strip()
    )
    if not root:
        home = _probe_wsl_home(distro)
        if home:
            root = home.rstrip("/") + "/cases"
    if not root:
        root = DEFAULT_WSL_CASE_ROOT
    return {"wsl_distro": distro, "wsl_case_root": root.rstrip("/") or DEFAULT_WSL_CASE_ROOT}


def get_wsl_distro() -> str:
    return wsl_settings()["wsl_distro"]


def get_wsl_case_root() -> str:
    return wsl_settings()["wsl_case_root"]
