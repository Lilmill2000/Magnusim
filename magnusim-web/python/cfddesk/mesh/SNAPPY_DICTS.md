# Snappy dict writers — where to look

Two modules write snappyHexMesh-related dictionaries. Do not merge them into a
god file; call the right one:

| Module | Role |
|--------|------|
| `cfddesk/mesh/case_writer.py` | General mesh-case prep (`prepare_mesh_case`, `write_snappy_hex_mesh_dict`) used by the library / CLI mesh path. |
| `cfddesk/mesh/snappy_hexdominant.py` | Hex-dominant **web Generate** host prep: `scale_body1_stl`, `write_hexdominant_dicts`, `read_polymesh_counts`, fineness via `snappy_policy`. Driven by `tools/generate_snappy.py` + `wsl/templates/snappy_hexdominant.sh`. |

Fineness / snap knobs: `cfddesk/mesh/snappy_policy.py` (single source; JS `finenessParams` deleted in land7).
