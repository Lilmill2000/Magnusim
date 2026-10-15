# A finished conjugate heat transfer case (e2e fixture)

The two-box part (python/tests/fixtures/geometry/two-boxes-shared-face.brep: Body1 x 0..10 mm,
Body2 x 10..30 mm, 10 x 10 mm across): air in Body1 coming in at 0.2 m/s and 20 °C through
its x = 0 face and out through a pressure outlet on its y = 10 mm face, Body2 aluminium 6061 with a 0.05 W heat source, its
outer faces adiabatic, gravity -Z, laminar; Hex-dominant mesh, 800 iterations of
chtMultiRegionSimpleFoam (OpenFOAM v2606), written and run through the app's run path by
`test_the_e2e_fixture_cht_case` in tests/test_ht5_cht_wsl.py (HT5_WRITE_FIXTURE=1 rewrites it).
Monitors: a thermocouple with a point in each body, the outlet's surface temperature.
`ht5-cht.spec.js` copies it into a run's case folder to check the results and the Run panel
without WSL.
