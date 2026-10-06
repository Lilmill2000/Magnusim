# SPDX-License-Identifier: GPL-3.0-or-later
"""The page's key-number maths (workspace/keyNumbers.js), run with Node's test runner."""

from __future__ import annotations

import shutil
import subprocess
from pathlib import Path

import pytest

HERE = Path(__file__).resolve().parent


def test_key_numbers_js() -> None:
    node = shutil.which("node")
    if node is None:
        pytest.fail("node is needed: the Airfoil page's key numbers are JavaScript (workspace/keyNumbers.js)")
    r = subprocess.run(
        [node, "--test", str(HERE / "keyNumbers.test.mjs")],
        capture_output=True,
        text=True,
        timeout=120,
        check=False,
    )
    assert r.returncode == 0, r.stdout + r.stderr
