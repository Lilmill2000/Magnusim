"""Where the validation set keeps its files, and the app's Python on the import path."""

from __future__ import annotations

import sys
from pathlib import Path

PACKAGE = Path(__file__).resolve().parent
VALIDATION = PACKAGE.parent
WEB = VALIDATION.parent
REPO = WEB.parent
PY_ROOT = WEB / "python"

RESULTS = VALIDATION / "results"
# Coarse development runs: never committed (.gitignore).
RESULTS_COARSE = VALIDATION / "results-coarse"
# Mesh-only probes and runs with mesh settings changed on the command line: never committed,
# never reported (.gitignore).
RESULTS_PROBE = VALIDATION / "results-probe"


def results_root(*, coarse: bool = False, probe: bool = False) -> Path:
    """Where a run's folder goes: a probe (mesh only, or settings changed by hand) under
    results-probe/, a coarse run under results-coarse/, a full run under results/ (the only
    one the report reads)."""
    if probe:
        return RESULTS_PROBE
    return RESULTS_COARSE if coarse else RESULTS
REPORT_MD = VALIDATION / "VALIDATION.md"
# The public page (GitHub Pages from the repository's docs/ folder): built here, published
# by a push only the owner makes.
SITE = REPO / "docs" / "validation"
SITE_IMG = SITE / "img"


def bootstrap() -> None:
    """Put this checkout's ``python/`` (cfddesk), ``python/sdk`` (magnusim_sdk) and
    ``python/tools`` first on the import path, so the app's own code is what runs here,
    whatever the virtual environment's editable installs point at."""
    for p in (PY_ROOT / "tools", PY_ROOT / "sdk", PY_ROOT):
        s = str(p)
        if s in sys.path:
            sys.path.remove(s)
        sys.path.insert(0, s)
