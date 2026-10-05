# pitzdaily-monitors: what Forces monitors and Point probes write in OpenFOAM v2606

A real `simpleFoam` run (ESI v2606, 8 iterations, k-omega SST) of the case
Incompressible Flow's writer (`write_solve_case`) wrote over the `pitzDaily`
tutorial mesh (`blockMesh`): a 10 m/s velocity inlet on `inlet`, a 0 Pa
pressure outlet on `outlet`, wall BCs on `lowerWall` and `upperWall`, and one
Forces monitor ("Forces 1") on those two walls plus a BC with no patch in the
mesh ("Wing") and the walls no BC claims (the mesh has none), and one Point
probe ("Probe 1") at (0.1, 0, 0), (5, 5, 5) (outside the mesh) and
(0.2, 0.01, 0) m. The study's
reference values: area 0.001 m², length 0.0254 m, lift along +Y (speed, drag
direction and centre of rotation blank: 10 m/s, +X, the origin).

`postProcessing/` holds the files the `forces`, `forceCoeffs` and `probes`
function objects wrote, unchanged but for CRLF line ends; `w27-case.json` is the part of
the writer's sidecar the monitors read (`rho`, `reference`, `forces_monitors`,
`probe_monitors`).

`tests/test_forces.py` and `tests/test_probes.py` read it;
`e2e/forces-probes-graphs.spec.js` (this plugin's suite) copies it into a run's
case folder.
