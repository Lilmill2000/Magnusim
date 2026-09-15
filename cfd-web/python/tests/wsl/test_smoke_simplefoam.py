
"""WSL smoke — deselected by default."""
import pytest

pytestmark = pytest.mark.wsl


def test_placeholder_wsl():
    pytest.skip("WSL simpleFoam smoke reserved for later")
