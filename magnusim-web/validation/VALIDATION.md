# Validation

Magnusim's validation set: textbook flows with published answers, set up and solved through
the app itself. Each case is a STEP file imported into a project, given its BCs and fluid,
meshed by the app's mesher and solved by Start, through the same routes the page and the
Assistant use; its numbers are then read from the run's own monitors and from Plot over
path, and compared with the reference values below, each with its citation. Nothing is
tuned per case and no number is typed in: a value here is what the app produced.

**Report-only.** These numbers are what this version computes; no case fails on them yet.
After the first full run the tolerances are locked, and from then on a locked quantity
outside its tolerance fails the run and blocks a release. The bands shown are the proposed
ones (from the reference data). A run fails already when it cannot produce its numbers: a
setup the app refuses, a mesh or solve that fails, wall layers asked and not applied.

The set so far: case 1 (laminar pipe, both meshers). Cases 2 to 6 (turbulent pipe,
lid-driven cavity, backward-facing step, cylinder, sphere) follow; see
`validation/README.md`.

## Running it

WSL with OpenFOAM v2606, as the app's Setup installs it. From `magnusim-web`:

```bash
npm run test:validation                                   # every case and variant (8 cores each), then this report
npm run test:validation -- --case c1 --variant standard --cores 4
npm run test:validation -- --coarse                       # quick coarse runs (results-coarse/, not reported)
npm run validation:report                                 # this file and the public page from the results
npm run validation:report -- --check                      # exit 1 when they are out of date
```

Each run writes `validation/results/<case>/<variant>/plan.json` (every request it sends)
and `result.json` (the values, their sources, the mesh, the run and its health). The
public page is built into `docs/validation/` at the repository's root; it is published
only when GitHub Pages is turned on for `docs/` and the branch is pushed.

## Results

Environment: 2026-11-04: commit 4816248f16ae, OpenFOAM v2606 (build _481094f-20260618), 4 cores of a 32-thread PC: c1_laminar_pipe/hexdominant (WSL load 2.42 while it solved), c1_laminar_pipe/standard (WSL load 1.49 while it solved).

| Case | Mesher | Status | Quantity | Reference | Magnusim | Error | Band (report-only) | Cells | Wall layers | Iterations | Solve time | Run health |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Laminar pipe, Re = 100 | Hex-dominant | ok | Darcy friction factor × Re, developed part (x/D 10 to 13) | 64 | 63.268 | -1.14 % | ±2 % (inside) | 128 706 | applied (pipe_wall 3.83 of 4) | 143 | 21 s | healthy |
| Laminar pipe, Re = 100 | Hex-dominant | ok | Centreline speed / bulk speed, developed part (x/D 10 to 13) | 2 | 2.0021 | +0.11 % | ±1.5 % (inside) | 128 706 | applied (pipe_wall 3.83 of 4) | 143 | 21 s | healthy |
| Laminar pipe, Re = 100 | Hex-dominant | ok | Development length L_e / D (to 99 % of the developed centreline speed) | 5.77 | 5.5473 | -3.86 % | ±15 % (inside) | 128 706 | applied (pipe_wall 3.83 of 4) | 143 | 21 s | healthy |
| Laminar pipe, Re = 100 | Standard | ok | Darcy friction factor × Re, developed part (x/D 10 to 13) | 64 | 74.232 | +15.99 % | ±2 % (outside) | 139 228 | applied (pipe_wall 3 of 3) | 316 | 30 s | healthy |
| Laminar pipe, Re = 100 | Standard | ok | Centreline speed / bulk speed, developed part (x/D 10 to 13) | 2 | 2.0026 | +0.13 % | ±1.5 % (inside) | 139 228 | applied (pipe_wall 3 of 3) | 316 | 30 s | healthy |
| Laminar pipe, Re = 100 | Standard | ok | Development length L_e / D (to 99 % of the developed centreline speed) | 5.77 | 5.451 | -5.53 % | ±15 % (inside) | 139 228 | applied (pipe_wall 3 of 3) | 316 | 30 s | healthy |

## Laminar pipe, Re = 100

A pipe, D = 20 mm, L = 300 mm (15 D) along +x from x = 0 (STEP in mm, built with OCP); a custom fluid with nu = 0.0002 m²/s and rho = 1 kg/m³, so Re = U D / nu = 100; a velocity inlet of 1 m/s normal to the face, a 0 Pa pressure outlet and a no-slip wall; laminar, steady (simpleFoam), Accurate numerics, residual targets 1e-6, at most 3000 iterations.

### Hex-dominant

- Status: ok.
- Mesh settings: Hex-dominant at fineness 6 with an Inflate boundary layer of 4 layers, 1 mm in all, on the wall (automatic boundary layers off); 1 non-orthogonal corrector.
- Mesh: 128 706 cells (the plan's estimate about 163 000), background block 67 × 8 × 12, wall cells 1.49 × 0.831 × 0.554 mm (x × y × z), generated in 20.1 s; checkMesh OK (max non-orthogonality 69.2°, max skewness 1.49, max aspect ratio 12.4); wall layers applied (pipe_wall 3.83 of 4), first layer 0.179 mm.
- Run: 143 iterations, converged at iteration 143; solve 21 s on 4 ranks (Cores 4); run health healthy.
- Pre-run check: info still_start: The run starts from rest; starting from potential flow shortens the start-up.
- Its estimate before Start: 3,000 iterations at most · ~23 minutes on 4 cores · Re ≈ 100.
- **Darcy friction factor × Re, developed part (x/D 10 to 13)**: 63.268 against 64 (-1.14 %, band ±2 % (inside), report-only); ± 0.015 % (the slope's standard error and twice the cross-section's). How: f·Re = 2 D_eff² (−dp/dx) / (mu U_b): dp/dx the least-squares slope of the centreline pressure from Plot over path (0,0,0) to (0.3,0,0) m, 300 subdivisions, over x/D 10 to 13; U_b = Q / A and D_eff = sqrt(4 A / pi), Q the flow through the inlet and A the pipe's meshed cross-section, the mean of the inlet's and the outlet's mesh areas (all three from the run's monitors), since a meshed circle's area is not exactly pi D²/4. Source: `route:/api/plot-over-path`. -dp/dx 15.8252 Pa/m from 60 samples (slope standard error 0.01 %, r² 0.999999); D_eff 19.995 mm, U_b 1.0000 m/s.
- **Centreline speed / bulk speed, developed part (x/D 10 to 13)**: 2.0021 against 2 (+0.11 %, band ±1.5 % (inside), report-only). How: the centre value u_c of a least-squares fit U_x = u_c + b r² (the developed profile's own form) to the cell values, not interpolated, of every cell whose centre lies in x/D 10 to 13 within R/2 of the axis, read from the run's saved U by the app's own volume loader (case_volume.load_volume, the code behind Plot over path), over U_b = Q / A (as for f·Re). Source: `app_sampling (cell values)`. u_c 2.0021 m/s (standard error 0.0011) from 400 cells within 5.00 mm of the axis, over U_b 1.0000 m/s; the cells nearest the axis (r = 1.834 mm) read 1.9358 m/s, the exact profile there 1.9327.
- **Development length L_e / D (to 99 % of the developed centreline speed)**: 5.5473 against 5.77 (-3.86 %, band ±15 % (inside), report-only). How: the first x where the centreline speed from Plot over path (0,0,0) to (0.3,0,0) m, 300 subdivisions, reaches 99 % of the same line's developed value (its mean over x/D 10 to 13), linearly interpolated between samples, over D_eff. Source: `route:/api/plot-over-path`. 99 % of 1.9331 m/s reached at x = 110.9 mm.
- Shown, not compared: the pipe's cross-section as meshed 313.99 mm² (inlet 313.99, outlet 313.99; -0.05 % against pi D²/4), so D_eff 19.995 mm and U_b 1 m/s; -dp/dx 15.825 Pa/m (-1.09 % against 32 mu U / D² = 16 Pa/m with the nominal D); the wall shear stress the run saved, over x/D 10 to 13, 0.07904 Pa (-1.22 % against 8 mu U_b / D_eff = 0.08002 Pa), which balances -dp/dx = 4 tau_w / D_eff = 15.813 Pa/m; the inlet's area-averaged pressure 5.606 Pa (the outlet's 0 Pa), flow out against in -0.001 %; Darcy f 0.6328 at Re_eff 99.973; Plot over path's centreline over x/D 10 to 13 1.9331 U_b (the field averaged to the mesh's points); the centreline probes' mean U_x over x/D 10 to 13 1.9335 U_b (the cell holding each point); the 24000 cells of x/D 10 to 13 within an RMS 0.00795 U_b of 2 U_b (1 - (r/R)²) at their own radii; Plot over path's profile at x = 12 D within an RMS 0.0515 U_b of it.

![Laminar pipe, Re = 100, Hex-dominant: centreline pressure](../../docs/validation/img/c1_laminar_pipe-hexdominant-pressure.png)
![Laminar pipe, Re = 100, Hex-dominant: centreline speed](../../docs/validation/img/c1_laminar_pipe-hexdominant-centreline.png)
![Laminar pipe, Re = 100, Hex-dominant: velocity profile at x = 12 D](../../docs/validation/img/c1_laminar_pipe-hexdominant-profile.png)
![Laminar pipe, Re = 100, Hex-dominant: residuals](../../docs/validation/img/c1_laminar_pipe-hexdominant-residuals.png)

### Standard

- Status: ok.
- Mesh settings: Standard at fineness 6 with its automatic boundary layers and hex core; 2 non-orthogonal correctors.
- Mesh: 139 228 cells, generated in 15.1 s; checkMesh OK (max non-orthogonality 67.1°, max skewness 0.928, max aspect ratio 8.63); wall layers applied (pipe_wall 3 of 3), first layer 0.136 mm.
- Run: 316 iterations, converged at iteration 316; solve 30 s on 4 ranks (Cores 4); run health healthy.
- Pre-run check: info still_start: The run starts from rest; starting from potential flow shortens the start-up.
- Its estimate before Start: 3,000 iterations at most · ~4 minutes on 4 cores · Re ≈ 100.
- **Darcy friction factor × Re, developed part (x/D 10 to 13)**: 74.232 against 64 (+15.99 %, band ±2 % (outside), report-only); ± 0.041 % (the slope's standard error and twice the cross-section's). How: f·Re = 2 D_eff² (−dp/dx) / (mu U_b): dp/dx the least-squares slope of the centreline pressure from Plot over path (0,0,0) to (0.3,0,0) m, 300 subdivisions, over x/D 10 to 13; U_b = Q / A and D_eff = sqrt(4 A / pi), Q the flow through the inlet and A the pipe's meshed cross-section, the mean of the inlet's and the outlet's mesh areas (all three from the run's monitors), since a meshed circle's area is not exactly pi D²/4. Source: `route:/api/plot-over-path`. -dp/dx 18.5985 Pa/m from 60 samples (slope standard error 0.04 %, r² 0.999990); D_eff 19.978 mm, U_b 1.0000 m/s.
- **Centreline speed / bulk speed, developed part (x/D 10 to 13)**: 2.0026 against 2 (+0.13 %, band ±1.5 % (inside), report-only). How: the centre value u_c of a least-squares fit U_x = u_c + b r² (the developed profile's own form) to the cell values, not interpolated, of every cell whose centre lies in x/D 10 to 13 within R/2 of the axis, read from the run's saved U by the app's own volume loader (case_volume.load_volume, the code behind Plot over path), over U_b = Q / A (as for f·Re). Source: `app_sampling (cell values)`. u_c 2.0026 m/s (standard error 0.0007) from 3887 cells within 4.99 mm of the axis, over U_b 1.0000 m/s; the cells nearest the axis (r = 0.001 mm) read 2.0068 m/s, the exact profile there 2.0000.
- **Development length L_e / D (to 99 % of the developed centreline speed)**: 5.451 against 5.77 (-5.53 %, band ±15 % (inside), report-only). How: the first x where the centreline speed from Plot over path (0,0,0) to (0.3,0,0) m, 300 subdivisions, reaches 99 % of the same line's developed value (its mean over x/D 10 to 13), linearly interpolated between samples, over D_eff. Source: `route:/api/plot-over-path`. 99 % of 1.9513 m/s reached at x = 108.9 mm.
- Shown, not compared: the pipe's cross-section as meshed 313.48 mm² (inlet 313.48, outlet 313.48; -0.22 % against pi D²/4), so D_eff 19.978 mm and U_b 1 m/s; -dp/dx 18.598 Pa/m (+16.24 % against 32 mu U / D² = 16 Pa/m with the nominal D); the wall shear stress the run saved, over x/D 10 to 13, 0.09294 Pa (+16.05 % against 8 mu U_b / D_eff = 0.08009 Pa), which balances -dp/dx = 4 tau_w / D_eff = 18.608 Pa/m; the inlet's area-averaged pressure 6.349 Pa (the outlet's 0 Pa), flow out against in 0 %; Darcy f 0.7431 at Re_eff 99.891; Plot over path's centreline over x/D 10 to 13 1.9513 U_b (the field averaged to the mesh's points); the centreline probes' mean U_x over x/D 10 to 13 2.0071 U_b (the cell holding each point); the 27441 cells of x/D 10 to 13 within an RMS 0.0438 U_b of 2 U_b (1 - (r/R)²) at their own radii; Plot over path's profile at x = 12 D within an RMS 0.0723 U_b of it.

![Laminar pipe, Re = 100, Standard: centreline pressure](../../docs/validation/img/c1_laminar_pipe-standard-pressure.png)
![Laminar pipe, Re = 100, Standard: centreline speed](../../docs/validation/img/c1_laminar_pipe-standard-centreline.png)
![Laminar pipe, Re = 100, Standard: velocity profile at x = 12 D](../../docs/validation/img/c1_laminar_pipe-standard-profile.png)
![Laminar pipe, Re = 100, Standard: residuals](../../docs/validation/img/c1_laminar_pipe-standard-residuals.png)

### References

- **Darcy friction factor × Re, developed part (x/D 10 to 13)**: 64 (exact, CONFIRMED). G. Hagen (1839), "Ueber die Bewegung des Wassers in engen cylindrischen Röhren", Ann. Phys. Chem. 46:423-442; J. L. M. Poiseuille (1840), C. R. Acad. Sci. Paris 11:961-967, 1041-1048: the exact (Hagen-Poiseuille) solution of the Navier-Stokes equations for fully developed laminar pipe flow; Darcy f = 64/Re (f = 0.640 at Re 100), i.e. -dp/dx = 32 mu U / D² = 16 Pa/m here. Conditions: fully developed, steady, Newtonian; Re = rho U D / mu with U the bulk (mean) speed; Re = 100.
- **Centreline speed / bulk speed, developed part (x/D 10 to 13)**: 2 (exact, CONFIRMED). G. Hagen (1839), "Ueber die Bewegung des Wassers in engen cylindrischen Röhren", Ann. Phys. Chem. 46:423-442; J. L. M. Poiseuille (1840), C. R. Acad. Sci. Paris 11:961-967, 1041-1048: the exact (Hagen-Poiseuille) solution of the Navier-Stokes equations for fully developed laminar pipe flow; u(r) = 2 U (1 - (r/R)²), so u_c = 2.000 U. Conditions: fully developed, steady, Newtonian; Re = rho U D / mu with U the bulk (mean) speed; Re = 100.
- **Development length L_e / D (to 99 % of the developed centreline speed)**: 5.77 (correlation, SECONDARY). F. Durst, S. Ray, B. Ünsal, O. A. Bayoumi (2005), "The development lengths of laminar pipe and channel flows", J. Fluids Eng. 127:1154-1160; the pipe correlation L/D = [0.619^1.6 + (0.0567 Re)^1.6]^(1/1.6) (constants as quoted from the abstract by citing papers; error under 3 % for all laminar Re), 5.77 at Re 100. Conditions: laminar, uniform inlet; the distance to 99 % of the developed centreline velocity; Re = 100. Depends on the 99 % definition and on the inlet profile; the 0.05 Re rule (5.0) is about 13 % short.

### Notes

- Where the design and the reference data differ, the reference data win: the bands are ±2 % on f·Re and ±1.5 % on U_cl/U_b on both meshers (the design proposed ±2 % / ±5 % and ±2 % / ±3 %), and the developed part read is x/D 10 to 13 (the design's 8 to 13: the reference data ask for stations more than about 10 D from a uniform inlet).
- The bulk speed and D_eff use the pipe's cross-section as meshed (the mean of the inlet's and the outlet's mesh areas, from the run's monitors), not pi D²/4: f·Re goes as the area squared.
- The compared centreline speed comes from the cell values themselves (a fit of U_x = u_c + b r² over the window's cells within R/2 of the axis). Plot over path samples the field averaged to the mesh's points, which reads a peak low where the cells are coarse, and on a mesh whose axis runs along cell edges no cell centre lies on the axis at all; what the line reads on the axis is shown beside the fit, with the profile's RMS difference from the exact parabola at the cells' own radii.
- The centreline Point probes take the value of the cell that holds each point. Where the axis runs along cell edges (Hex-dominant) that is one of the off-axis cells around it, the same cells the fit uses, so the probes are shown, not used as an independent check.
- The development length is read on Plot over path's centreline, against the same line's developed value, so the line's averaging enters both nearly alike. The 99 % point lies where the centreline speed is nearly flat: a change in the fourth digit of the solution moves it by millimetres, and repeated runs of the same plan can read a few per cent apart. Its band is wide (±15 %) for that reason and for the 99 % definition.
- On Standard the friction factor reads well above the exact value. The wall shear stress the run itself saved (shown with each run) carries the same excess, and the cell values run faster than the parabola near the wall and slower at mid-radius, so the pressure drop is the solution's, not an artefact of reading it. It is under investigation (an app gap), and the turbulent pipe's Standard runs wait for it. Probes that change one setting at a time point at the momentum convection scheme on Standard's cells, which are not aligned with the flow: first-order convection raises the friction much further, a finer mesh lowers it only slowly, and neither the gradient limiter, the hex core nor the wall layers account for it.
