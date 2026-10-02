# Snappy dict writers — where to look

One module writes the snappyHexMesh dictionaries:

| Module | Role |
|--------|------|
| `cfddesk/mesh/snappy_hexdominant.py` | Hex-dominant **web Generate** host prep: `scale_body1_stl`, `write_hexdominant_dicts`, `read_polymesh_counts`, fineness via `snappy_policy`. Driven by `tools/generate_snappy.py` + `wsl/templates/snappy_hexdominant.sh`. |

Fineness / snap knobs: `cfddesk/mesh/snappy_policy.py` (single source; JS `finenessParams` deleted in land7).
