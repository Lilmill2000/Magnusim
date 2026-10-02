# cavity-2d: a finished plugin OpenFOAM case (H15)

The Foam demo plugin's lid-driven cavity (`foam-plugins/foam-demo`, `write_cavity`):
20x20x1 `blockMesh`, `pimpleFoam` laminar, `writeFormat ascii`, end time 0.5,
written every 0.1, so five result frames (`0.1` … `0.5`, `U` and `p`; `phi` left
out to keep the fixture small). `constant/polyMesh` came back from the run's
`blockMesh` step. `w27-case.json` is what the host writes into a plugin case
before it runs: `rho` 1000 and `kinematic_fields` `["p"]`, so the results view
shows `p` in Pa, 1000 times the values in the files.

`e2e/h15-plugin-results.spec.js` copies this folder into a plugin study's
`cases/fixture` and into a core study's run folder; it needs no WSL.

Regenerate it (WSL with OpenFOAM, from `magnusim-web/python`, under the WSL test
lock): the run goes through `tools/run_foam_case.py` as a real plugin case does.

```
MAGNUSIM_REGEN_CAVITY_FIXTURE=1 .venv/Scripts/python.exe -m pytest -m wsl tests/wsl/test_foam_case_wsl.py -k cavity_fixture
```

Without the variable that test runs the case again and checks that this folder
still matches it (the frames and the mesh).
