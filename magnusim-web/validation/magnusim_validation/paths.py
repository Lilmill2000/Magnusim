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
