"""cfddesk — unified CFD desktop application."""

import sys as _sys
from pathlib import Path as _Path

__version__ = "0.1.0"

# magnusim_sdk ships beside this package (python/sdk). Setup installs it into the
# venv; a venv made before the SDK existed still finds it here.
try:
    import magnusim_sdk as _magnusim_sdk  # noqa: F401
except ImportError:
    _sdk_root = _Path(__file__).resolve().parents[1] / "sdk"
    if _sdk_root.is_dir():
        _sys.path.append(str(_sdk_root))
