"""The one legacy frame-field default: cases written before API 1.1."""

from __future__ import annotations

from types import SimpleNamespace

from cfddesk.registry import contract
from cfddesk.registry.contract import GENERIC_LOG_PARSER, LEGACY_FRAME_FIELDS, LaunchSpec


def test_legacy_frame_fields_are_the_default_analysis_fields():
    assert LEGACY_FRAME_FIELDS == ("U", "p")
    assert isinstance(LEGACY_FRAME_FIELDS, tuple)


def test_a_launch_spec_without_frame_fields_gets_the_legacy_ones():
    spec = LaunchSpec(
        app="simpleFoam",
        keep_frames="latest",
        process_names=("simpleFoam",),
        stop_strategy="write_now",
        parallel=False,
        log_parser=GENERIC_LOG_PARSER,
    )
    assert spec.frame_fields == LEGACY_FRAME_FIELDS
    assert spec.to_json()["frame_fields"] == list(LEGACY_FRAME_FIELDS)


def test_frame_fields_fall_back_to_the_legacy_ones_last():
    # Neither its own frame_fields nor result fields: a case of the default analysis.
    assert contract.frame_fields(SimpleNamespace()) == LEGACY_FRAME_FIELDS
    assert contract.frame_fields(SimpleNamespace(frame_fields=(), fields=())) == LEGACY_FRAME_FIELDS
    # Its result fields come before the legacy ones, its frame_fields before both.
    assert contract.frame_fields(SimpleNamespace(fields=("T",))) == ("T",)
    assert contract.frame_fields(SimpleNamespace(frame_fields=("T", "q"), fields=("T",))) == ("T", "q")
