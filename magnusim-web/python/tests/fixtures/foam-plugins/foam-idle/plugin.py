"""Foam idle (gate:h15-submit-openfoam): registers nothing. The e2e turns it on
while a Foam demo case runs; that case must keep running."""

from __future__ import annotations


def register(hub):
    del hub
    return None
