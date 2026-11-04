# Mesh facts fixtures (run health RH2)

Real OpenFOAM v2606 output for `tests/unit/test_mesh_facts.py` and the Mesh panel's quality
e2e (`e2e/mesh-quality-line.spec.js`). Made on 2026-11-03 with `make_fixtures.sh` in WSL
(Ubuntu-24.04, `openfoam2606`), every tool serial on one core:

```sh
bash make_fixtures.sh /mnt/c/<somewhere>/out   # works in ~/rh2-fixture-work
```

| Case | What | Used for |
|---|---|---|
| `contraction` | 2D forward-facing step (a contraction to 0.7 of the height), three graded blockMesh blocks, 960 hexes; pimpleFoam laminar, nu 1e-3, inflow 1 m/s along x, fixed Δt 0.004 s, 40 steps | the Courant-rate table (ascii mesh), `checkmesh/ok-hex-2d.log` |
| `contraction-binary` | the same mesh after `foamFormatConvert` to binary (`faceCompactList`) | the binary reader gives the same table |
| `sphere` | snappyHexMesh around a 0.3 m sphere (level 2, two layers growing by 1.2) in a 2.6 x 1.2 x 1.2 m box, 3,468 cells (polyhedra, prisms); pimpleFoam, inflow 2 m/s along x, fixed Δt 0.001 s, 30 steps | the rate table on an unstructured mesh, `log.snappyHexMesh`'s layer report and `system/snappyHexMeshDict`, `checkmesh/ok-snappy-layers.log` |
| broken | the contraction with one point pushed through its cell | `checkmesh/negative-volume.log` (4 failed checks) |
| sheared | a sheared, graded thin slab | `checkmesh/skewed.log` (skewness failed; 750 faces over 70°) |
| thin | a 3D slab of cells 1,000 times thinner than wide | `checkmesh/high-aspect-ratio.log` |

`courant-logged.json` keeps each pimpleFoam run's largest Courant number per step, from its
`Courant Number mean: … max: …` lines. Both runs start from a uniform flow at the inflow speed,
so the first step's largest Courant number is inflow speed × Δt × the largest cell rate along
the flow.

The meshes are gzipped (`points.gz`, …; OpenFOAM and `magnusim_sdk.courant_rates` read them so).
The logs are scrubbed: the host is `cfdbox-17`, the case folders `/home/user/<case>`, the PID 1234.
