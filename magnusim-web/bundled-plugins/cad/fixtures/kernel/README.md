# Kernel test fixtures

Used by `tests/kernel/kernel-*.test.ts` (`npm run test:kernel`) and
`e2e/cad-p1-kernel-ops.spec.ts`. Nothing here is served to the workspace.

Daniel's STEP files are never copied here. The Vortex part ("Vortex CFD Test": the
fluid volume of a cyclone separator, 1 solid, 17 faces, 34 edges, inch units, sha256
`d40156af…c71e5b`, 64,518 bytes) is read where it is, and only when
`CAD_E2E_VORTEX_STEP` names it. Without it the kernel tests and the e2e specs that need
it are skipped and say so in their names; set to a path with no file there, they fail
with that path. `kernel-gates` checks the file's sha256 against `reference.json`, and
`tests/arch/user-files.test.ts` fails if a copy of one of his files is in the plugin
(review P2/P3 round 3 removed the P1 copy, `vortex-cfd-test.step`).

| File | What | Source |
|---|---|---|
| `box20.step` | a 20 mm cube (AP214) | generated natively with OCCT 7.9.3 (P0 fixtures) |
| `flange.step` | a 100 x 100 x 10 plate with 4 through holes r = 5 (AP214) | generated natively with OCCT 7.9.3 (P0 fixtures) |
| `box20-faces.step` | the 20 mm cube written as 6 faces that share no edge (an open shell, STEP product "Box 20 faces"): the surface-only STEP for heal / knit (sew -> 1 valid solid, 8,000 mm³) | generated natively with OCCT 7.9.3 (cadquery-ocp 7.9.3.1.1) by the KERNEL builder for P2/P3, 2026-10-01 (sha256 `fb2eb02b…3b676f50`); the generator is kept outside the plugin |
| `box20-gap.step` | the same cube with its +Z face moved 0.005 mm outwards ("Box 20 gap"): heal at 0.01 mm knits it (8,000.67 mm³), at 0.001 mm it stays open with 8 free edges | as above (sha256 `7a4b70d9…2c1c12`) |
| `box10-sheet.step` | a 10 mm cube and a loose 10 x 10 sheet above it under one STEP product ("Box and sheet"): the import keeps the sheet as a surface body beside the solid | as above (sha256 `b9fcf5f0…2e1af837`) |
| `vortex-recipe.calls.json` | the kernel calls (profiles, extents, boolean kinds) of the Vortex part rebuilt from scratch | P0 Vortex recipe (native rebuild); edge indices in it are native and are not used: tests find edges by name |
| `stepped-bore.step` | a 60 x 40 x 30 block with a bore r 10 through it at (30, 16) and a counterbore r 15 from z 20 up (its wall to the y = 0 side 1 mm thick), STEP product "stepped-bore": press-pull's cylinder method without the Vortex | generated natively with OCCT 7.9.3 (cadquery-ocp 7.9.3.1.1), press-pull fix round 1, 2026-10-06 (sha256 `45ea1687…0923c19`); the generator (gen_stepped.py) is kept outside the plugin |
| `reference.json` | native reference values: OCCT 7.9.3 through cadquery-ocp 7.9.3.1.1, trimmed to what the tests read; conventions in its `about`. `p2p3` (API 3: heal of the two cube fixtures, press-pull on the Vortex) `p5_offset` (API 6: offsets of bores, a boss, a fillet, a sloped neighbour, a cone, sphere caps, a pocket, a loft and the Vortex) and `p5_fix1` (the cylinder ring method on the stepped-bore STEP and the Vortex outlets) have their own `about` | P0 fixtures workstream, 2026-09-30; `p2p3` KERNEL builder, 2026-10-01; `p5_offset` 2026-10-06 |

The 113 MB STEP (`8m0119333_V12.step`) is not in the repository. Its test is
opt-in: `CAD_KERNEL_BIG_STEP=<path> npm run test:kernel -- bigstep`.

`.gitattributes` keeps the STEP files byte for byte (no line-ending changes).
