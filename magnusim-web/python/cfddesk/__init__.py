"""cfddesk — unified CFD desktop application."""

import sys as _sys
from pathlib import Path as _Path

__version__ = "0.1.0"

# magnusim_sdk ships beside this package (python/sdk), and this checkout's copy comes first.
# Setup installs it into the venv too, but a venv shared by several checkouts maps it to
# whichever installed it last: a module that copy lacks (magnusim_sdk.health, added in RH1)
# would fail every plugin that imports it. A venv made before the SDK existed finds it here.
_sdk_root = _Path(__file__).resolve().parents[1] / "sdk"
if _sdk_root.is_dir() and str(_sdk_root) not in _sys.path:
    _sys.path.insert(0, str(_sdk_root))
