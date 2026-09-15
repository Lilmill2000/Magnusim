"""OpenFOAM case writers and BC registry."""

from __future__ import annotations

from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from cfddesk.case.writer import (
        assert_boundary_patch_types,
        assert_guardrails,
        write_simplefoam_case,
    )

__all__ = [
    "assert_boundary_patch_types",
    "assert_guardrails",
    "write_simplefoam_case",
]


def __getattr__(name: str):
    if name in __all__:
        from cfddesk.case import writer as _writer

        return getattr(_writer, name)
    raise AttributeError(f"module {__name__!r} has no attribute {name!r}")
