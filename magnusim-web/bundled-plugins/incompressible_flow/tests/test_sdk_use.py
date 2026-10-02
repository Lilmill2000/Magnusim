"""Incompressible Flow writes OpenFOAM files with the SDK's one copy of the helpers."""

from __future__ import annotations


def test_writer_uses_the_sdk_copy():
    import magnusim_sdk.foam as sdk_foam

    from incompressible_flow import writer

    assert writer.write_vol_field is sdk_foam.write_vol_field
    assert writer.write_foam_dict is sdk_foam.write_foam_dict
    assert writer.js_plain_float is sdk_foam.js_plain_float
