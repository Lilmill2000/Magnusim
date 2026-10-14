# A finished Heat Transfer case (e2e fixture)

The heated cavity of `tests/test_ht_wsl_proofs.py` on a coarse 20 x 20 graded blockMesh
(one cell thick, symmetry front and back): hot wall 30 °C, cold wall 20 °C, Boussinesq,
laminar, 400 iterations of buoyantSimpleFoam (OpenFOAM v2606), written by the plugin's
own writer (`test_the_e2e_fixture_cavity_writes_a_positive_htc_and_the_density` with
HT4_WRITE_FIXTURE=1 rewrites it). `ht4-heat-transfer.spec.js` copies it into a run's case
folder to check the results legend in °C / °F and the monitors and energy balance without
WSL; `test_ht_results.py` reads its heat transfer coefficient.
