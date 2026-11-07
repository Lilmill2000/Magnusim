# Heat Transfer: validation

Textbook heat transfer cases against published values. Each case is set up as a study,
meshed by the app's mesher and solved the way Start runs it (the runner's relay: this
plugin's prepare job, then `solve.sh` in WSL with OpenFOAM v2606), then measured from its
monitors and its saved fields. Hex-dominant meshes every case; the pipes are meshed with
Standard as well.

**Report-only.** These numbers are what this version computes; no case fails on them yet.
The first full run sets the tolerances, after which a case outside its tolerance blocks a
release. The proofs in `tests/test_ht_wsl_proofs.py` and `tests/test_ht5_cht_wsl.py` keep
their own tolerances.

Run the set (WSL with OpenFOAM v2606: about two hours one case after another, each on 8
cores; under an hour in three groups side by side with `-k`), then this report:

```bash
cd python
pytest -m validation ../bundled-plugins/heat_transfer/tests -s
python ../bundled-plugins/heat_transfer/validation/report.py
```

The rows are in `validation/results.json` (`HT_VALIDATION_OUT` writes them elsewhere).

## How each number is measured

- **Cavity.** Nu = q L / (k ΔT). The headline is de Vahl Davis's Nu-bar, the cavity's
  mean Nusselt number: the mean of the hot and the cold wall's heat flow monitors (their
  mean flux) at the last iteration, with half of the gap between the two walls as its
  ±. His hot-wall values Nu_0 (1.117, 2.238, 4.509, 8.817) are noted beside it. Nu_max is
  the largest face value of the last saved wall heat flux on the hot wall, on the faces
  of the slab's middle half (the faces along the edges where the wall meets the symmetry
  planes are left out) between y/L 0.01 and 0.99 (the corner faces at the floor and the
  roof are left out too), with its height y/L; a peak more than 0.03 L from the
  reference's height is flagged in the table. The 2D cavity is a
  slab 40 mm deep (0.4 L) with symmetry on both faces, so the solution is the 2D one.
  It is that deep because Hex-dominant's background cells are cubes only when the part
  is about as deep as it is wide; on a 3 mm slab the cells came out ten times flatter
  than wide, the wall layers were not added (0.02 of 4) and, at Ra = 1e5 after 6000
  iterations, Nu_avg read +6.5 % and was still moving, where the 40 mm slab settled
  within about 1000 iterations.
- **Pipes.** Nu = q D / (k (T_wall − T_bulk)) in slices along the developed part of the
  pipe: T_wall and q are the area-weighted means of the wall faces in the slice, T_bulk
  the mixing-cup temperature of its cells (the sum of u T V over the sum of u V). The
  value is the slices' mean, its ± the standard error of that mean: on Hex-dominant
  meshes the slices scatter by several per cent around it with the castellated cells'
  pattern along the pipe. The air has constant properties (constant density, gravity
  off), as the correlations assume. The turbulent pipe's slices are 17.5 to 22.5 D after
  a uniform inlet, where the flow is still developing (its Nu is above the developed
  one), and its wall's y+ (OpenFOAM's yPlus on the solved case) is recorded with it. With
  k-omega SST's walls before 2026-11-06 (nutkWallFunction) it read 10 to 20 % under
  Gnielinski's correlation, more than the correlation's own scatter; with Spalding's law and
  stepwise omega since, within 2 % (its two rows rerun on 2026-11-07).
- **Conduction.** The heat through each face from the wall heat flux monitors, and the
  highest temperature from the solid's own monitor row.

Mesh checks of the turbulent pipe (2026-10-15, with the walls before 2026-11-06, before the
y+ was recorded, not in the table): Hex-dominant at fineness 7 (293 760 cells) read 98.52,
−7.88 % (fineness 6: −9.64 %); Standard at fineness 8 (141 197 cells) read 82.16, −23.17 %
(fineness 6: −20.55 %). With those walls Standard's tetrahedra read low whatever the cell
count; the checks were not run again with the new walls.

Results of 2026-10-15 (Heat Transfer 0.1.0, OpenFOAM v2606 (build _481094f-20260618)); 2026-11-07 (Heat Transfer 0.2.0, OpenFOAM v2606 (build _481094f-20260618)). The commit that holds them is in the repository's history.

## Results

| Case | Quantity | Reference | Magnusim | Error | Mesher | Cells | Iterations |
| --- | --- | --- | --- | --- | --- | --- | --- |
| de Vahl Davis cavity, Ra = 1e3 | Nu-bar (mean of the hot and cold walls) | 1.118 | 1.118 ± 0.00 % | +0.00 % | Hex-dominant | 105 518 | 1500 |
| de Vahl Davis cavity, Ra = 1e3 | Nu_max (hot wall) | 1.505 | 1.507 | +0.13 % | Hex-dominant | 105 518 | 1500 |
| de Vahl Davis cavity, Ra = 1e4 | Nu-bar (mean of the hot and cold walls) | 2.243 | 2.245 ± 0.00 % | +0.09 % | Hex-dominant | 105 518 | 2000 |
| de Vahl Davis cavity, Ra = 1e4 | Nu_max (hot wall) | 3.528 | 3.522 | -0.17 % | Hex-dominant | 105 518 | 2000 |
| de Vahl Davis cavity, Ra = 1e5 | Nu-bar (mean of the hot and cold walls) | 4.519 | 4.494 ± 0.00 % | -0.55 % | Hex-dominant | 105 518 | 2500 |
| de Vahl Davis cavity, Ra = 1e5 | Nu_max (hot wall) | 7.717 | 7.611 | -1.37 % | Hex-dominant | 105 518 | 2500 |
| de Vahl Davis cavity, Ra = 1e6 | Nu-bar (mean of the hot and cold walls) | 8.800 | 8.745 ± 0.89 % | -0.63 % | Hex-dominant | 196 640 | 4000 |
| de Vahl Davis cavity, Ra = 1e6 | Nu_max (hot wall) | 17.93 | 17.06 | -4.83 % | Hex-dominant | 196 640 | 4000 |
| Laminar pipe, fixed wall heat flux (10 W/m²) | Nu (fully developed) | 4.364 | 4.360 ± 1.44 % | -0.09 % | Hex-dominant | 124 242 | 3000 |
| Laminar pipe, fixed wall heat flux (10 W/m²) | Nu (fully developed) | 4.364 | 4.967 ± 0.18 % | +13.81 % | Standard | 139 169 | 3000 |
| Laminar pipe, fixed wall temperature (30 °C, inlet 20 °C) | Nu (fully developed) | 3.657 | 3.644 ± 1.77 % | -0.35 % | Hex-dominant | 124 662 | 3000 |
| Laminar pipe, fixed wall temperature (30 °C, inlet 20 °C) | Nu (fully developed) | 3.657 | 4.135 ± 0.35 % | +13.07 % | Standard | 139 200 | 3000 |
| Turbulent pipe, fixed wall heat flux (1000 W/m²) | Nu (17.5 to 22.5 D from the inlet) | 106.9 | 105.2 ± 0.15 % | -1.61 % | Hex-dominant | 59 736 | 2000 |
| Turbulent pipe, fixed wall heat flux (1000 W/m²) | Nu (17.5 to 22.5 D from the inlet) | 106.9 | 107.3 ± 0.44 % | +0.31 % | Standard | 36 219 | 2000 |
| Composite wall (steel 10 mm, stainless steel 20 mm) | Heat through the wall (W) | 5.338 | 5.343 | +0.11 % | Hex-dominant | 13 634 | 600 |
| Heated block (stainless steel, 10 W, h = 500 W/(m²·K)) | Heat out (W) | 10.00 | 10.00 | +0.00 % | Hex-dominant | 12 576 | 800 |
| Heated block (stainless steel, 10 W, h = 500 W/(m²·K)) | Highest temperature rise (K) | 14.60 | 14.60 | +0.03 % | Hex-dominant | 12 576 | 800 |

## The cases

### Natural convection

**de Vahl Davis cavity, Ra = 1e3.**
square cavity L = 0.1 m as a 40 mm slab (symmetry on both faces), ΔT = 10 K, Pr = 0.71, β ΔT = 0.01 (Boussinesq), laminar, buoyantSimpleFoam, Accurate numerics.
Reference: G. de Vahl Davis, Natural convection of air in a square cavity: a bench mark numerical solution, Int. J. Numer. Methods Fluids 3 (1983) 249-264, Table IV.

- Nu-bar (mean of the hot and cold walls) on Hex-dominant: 1.118 ± 0.00 % against 1.118 (+0.00 %); mesh: Hex-dominant fineness 4, 4 layers on the hot and cold walls; hot wall 1.1180 (de Vahl Davis's hot-wall Nu_0 1.117), cold wall 1.1180: 0.00 % apart, half of it the ± here; the mean moved 0.001 % over the last fifth of the iterations; layers: cold 4 of 4 layers, 100 % of the thickness; hot 4 of 4 layers, 100 % of the thickness.
- Nu_max (hot wall) on Hex-dominant: 1.507 against 1.505 (+0.13 %); mesh: Hex-dominant fineness 4, 4 layers on the hot and cold walls; at y/L = 0.0930 (reference 0.092, 0.0010 off), read on the faces of the slab's middle half between y/L 0.01 and 0.99 (not the corner faces); layers: cold 4 of 4 layers, 100 % of the thickness; hot 4 of 4 layers, 100 % of the thickness.

**de Vahl Davis cavity, Ra = 1e4.**
square cavity L = 0.1 m as a 40 mm slab (symmetry on both faces), ΔT = 10 K, Pr = 0.71, β ΔT = 0.01 (Boussinesq), laminar, buoyantSimpleFoam, Accurate numerics.
Reference: G. de Vahl Davis, Natural convection of air in a square cavity: a bench mark numerical solution, Int. J. Numer. Methods Fluids 3 (1983) 249-264, Table IV.

- Nu-bar (mean of the hot and cold walls) on Hex-dominant: 2.245 ± 0.00 % against 2.243 (+0.09 %); mesh: Hex-dominant fineness 4, 4 layers on the hot and cold walls; hot wall 2.2449 (de Vahl Davis's hot-wall Nu_0 2.238), cold wall 2.2449: 0.00 % apart, half of it the ± here; the mean moved 0.000 % over the last fifth of the iterations; layers: cold 4 of 4 layers, 100 % of the thickness; hot 4 of 4 layers, 100 % of the thickness.
- Nu_max (hot wall) on Hex-dominant: 3.522 against 3.528 (-0.17 %); mesh: Hex-dominant fineness 4, 4 layers on the hot and cold walls; at y/L = 0.1388 (reference 0.143, 0.0042 off), read on the faces of the slab's middle half between y/L 0.01 and 0.99 (not the corner faces); layers: cold 4 of 4 layers, 100 % of the thickness; hot 4 of 4 layers, 100 % of the thickness.

**de Vahl Davis cavity, Ra = 1e5.**
square cavity L = 0.1 m as a 40 mm slab (symmetry on both faces), ΔT = 10 K, Pr = 0.71, β ΔT = 0.01 (Boussinesq), laminar, buoyantSimpleFoam, Accurate numerics.
Reference: G. de Vahl Davis, Natural convection of air in a square cavity: a bench mark numerical solution, Int. J. Numer. Methods Fluids 3 (1983) 249-264, Table IV.

- Nu-bar (mean of the hot and cold walls) on Hex-dominant: 4.494 ± 0.00 % against 4.519 (-0.55 %); mesh: Hex-dominant fineness 4, 4 layers on the hot and cold walls; hot wall 4.4940 (de Vahl Davis's hot-wall Nu_0 4.509), cold wall 4.4940: 0.00 % apart, half of it the ± here; the mean moved 0.000 % over the last fifth of the iterations; layers: cold 4 of 4 layers, 100 % of the thickness; hot 4 of 4 layers, 100 % of the thickness.
- Nu_max (hot wall) on Hex-dominant: 7.611 against 7.717 (-1.37 %); mesh: Hex-dominant fineness 4, 4 layers on the hot and cold walls; at y/L = 0.0815 (reference 0.081, 0.0005 off), read on the faces of the slab's middle half between y/L 0.01 and 0.99 (not the corner faces); layers: cold 4 of 4 layers, 100 % of the thickness; hot 4 of 4 layers, 100 % of the thickness.

**de Vahl Davis cavity, Ra = 1e6.**
square cavity L = 0.1 m as a 40 mm slab (symmetry on both faces), ΔT = 10 K, Pr = 0.71, β ΔT = 0.01 (Boussinesq), laminar, buoyantSimpleFoam, Accurate numerics.
Reference: G. de Vahl Davis, Natural convection of air in a square cavity: a bench mark numerical solution, Int. J. Numer. Methods Fluids 3 (1983) 249-264, Table IV.

- Nu-bar (mean of the hot and cold walls) on Hex-dominant: 8.745 ± 0.89 % against 8.800 (-0.63 %); mesh: Hex-dominant fineness 5, 5 layers on the hot and cold walls; hot wall 8.8219 (de Vahl Davis's hot-wall Nu_0 8.817), cold wall 8.6672: 1.77 % apart, half of it the ± here; the mean moved 0.051 % over the last fifth of the iterations; layers: cold 5 of 5 layers, 100 % of the thickness; hot 5 of 5 layers, 100 % of the thickness.
- Nu_max (hot wall) on Hex-dominant: 17.06 against 17.93 (-4.83 %); mesh: Hex-dominant fineness 5, 5 layers on the hot and cold walls; at y/L = 0.0330 (reference 0.0378, 0.0048 off), read on the faces of the slab's middle half between y/L 0.01 and 0.99 (not the corner faces); layers: cold 5 of 5 layers, 100 % of the thickness; hot 5 of 5 layers, 100 % of the thickness.

### Forced convection

**Laminar pipe, fixed wall heat flux (10 W/m²).**
pipe D = 20 mm, L = 300 mm, air with constant properties (Pr = 0.731), Re = 100 (uniform inlet 0.0758 m/s at 20 °C), gravity off, laminar, buoyantSimpleFoam; Nu the mean of ten 10 mm slices from x = 150 to 250 mm (x / (D Re Pr) from 0.10), its ± the standard error of that mean.
Reference: R. K. Shah and A. L. London, Laminar Flow Forced Convection in Ducts, Academic Press (1978), circular duct, fully developed.

- Nu (fully developed) on Hex-dominant: 4.360 ± 1.44 % against 4.364 (-0.09 %); mesh: Hex-dominant fineness 6, 4 layers on the wall; slices 155 mm: 4.407, 165 mm: 4.186, 175 mm: 4.295, 185 mm: 4.650, 195 mm: 4.223, 205 mm: 4.174, 215 mm: 4.614, 225 mm: 4.255, 235 mm: 4.171, 245 mm: 4.626 (lowest 4.171, highest 4.650); at 205 mm T_wall 299.457 K, T_bulk 297.551 K (mixing cup), q 10.000 W/m²; layers: heated 3.58 of 4 layers, 89.9 % of the thickness.
- Nu (fully developed) on Standard: 4.967 ± 0.18 % against 4.364 (+13.81 %); mesh: Standard fineness 6, layers on; slices 155 mm: 4.896, 165 mm: 4.992, 175 mm: 4.979, 185 mm: 4.973, 195 mm: 4.996, 205 mm: 4.972, 215 mm: 4.963, 225 mm: 4.965, 235 mm: 4.961, 245 mm: 4.973 (lowest 4.896, highest 4.996); at 205 mm T_wall 299.219 K, T_bulk 297.619 K (mixing cup), q 10.000 W/m²; layers applied: yes.

**Laminar pipe, fixed wall temperature (30 °C, inlet 20 °C).**
pipe D = 20 mm, L = 300 mm, air with constant properties (Pr = 0.731), Re = 100 (uniform inlet 0.0758 m/s at 20 °C), gravity off, laminar, buoyantSimpleFoam; Nu the mean of ten 10 mm slices from x = 150 to 250 mm (x / (D Re Pr) from 0.10), its ± the standard error of that mean.
Reference: R. K. Shah and A. L. London, Laminar Flow Forced Convection in Ducts, Academic Press (1978), circular duct, fully developed.

- Nu (fully developed) on Hex-dominant: 3.644 ± 1.77 % against 3.657 (-0.35 %); mesh: Hex-dominant fineness 6, 4 layers on the wall; slices 155 mm: 3.642, 165 mm: 3.479, 175 mm: 3.567, 185 mm: 3.937, 195 mm: 3.518, 205 mm: 3.464, 215 mm: 3.926, 225 mm: 3.524, 235 mm: 3.463, 245 mm: 3.925 (lowest 3.463, highest 3.937); at 205 mm T_wall 303.150 K, T_bulk 302.147 K (mixing cup), q 4.366 W/m²; layers: heated 3.6 of 4 layers, 90.4 % of the thickness.
- Nu (fully developed) on Standard: 4.135 ± 0.35 % against 3.657 (+13.07 %); mesh: Standard fineness 6, layers on; slices 155 mm: 4.046, 165 mm: 4.156, 175 mm: 4.171, 185 mm: 4.134, 195 mm: 4.193, 205 mm: 4.113, 215 mm: 4.107, 225 mm: 4.131, 235 mm: 4.194, 245 mm: 4.105 (lowest 4.046, highest 4.194); at 205 mm T_wall 303.150 K, T_bulk 302.439 K (mixing cup), q 3.675 W/m²; layers applied: yes.

**Turbulent pipe, fixed wall heat flux (1000 W/m²).**
pipe D = 20 mm, L = 500 mm, air with constant properties (Pr = 0.731), Re = 50 000 (uniform inlet 37.89 m/s at 20 °C, the inlet's default turbulence), gravity off, k-omega SST with wall functions (no layers), buoyantSimpleFoam; Nu the mean of five 20 mm slices from x = 350 to 450 mm (17.5 to 22.5 D after the uniform inlet: the flow is still developing there, and a developing flow's Nu is above the developed one, so the developed value would read lower still).
Reference: V. Gnielinski, New equations for heat and mass transfer in turbulent pipe and channel flow, Int. Chem. Eng. 16 (1976) 359-368, with Petukhov's friction factor.

- Nu (17.5 to 22.5 D from the inlet) on Hex-dominant: 105.2 ± 0.15 % against 106.9 (-1.61 %); mesh: Hex-dominant fineness 6, no layers; wall y+ in the slices 13.77 to 58.01 (mean 27.95); slices 360 mm: 104.939, 380 mm: 105.002, 400 mm: 105.094, 420 mm: 105.809, 440 mm: 105.232 (lowest 104.939, highest 105.809); at 400 mm T_wall 302.419 K, T_bulk 294.849 K, q 1000.00 W/m². k-omega SST's walls take Spalding's law with stepwise omega (Incompressible Flow's walls, since the validation set's fix of 2026-11-06; before it, nutkWallFunction read this pipe 10 to 20 % low); Gnielinski's own scatter is about ±10 %.
- Nu (17.5 to 22.5 D from the inlet) on Standard: 107.3 ± 0.44 % against 106.9 (+0.31 %); mesh: Standard fineness 6, no layers; wall y+ in the slices 53.83 to 166.53 (mean 91.41); slices 360 mm: 106.292, 380 mm: 108.766, 400 mm: 107.627, 420 mm: 106.233, 440 mm: 107.439 (lowest 106.233, highest 108.766); at 400 mm T_wall 302.240 K, T_bulk 294.848 K, q 1000.01 W/m². k-omega SST's walls take Spalding's law with stepwise omega (Incompressible Flow's walls, since the validation set's fix of 2026-11-06; before it, nutkWallFunction read this pipe 10 to 20 % low); Gnielinski's own scatter is about ±10 %; layers applied: no.

### Conduction (CHT)

**Composite wall (steel 10 mm, stainless steel 20 mm).**
two solids 10 x 10 mm across, steel (k 63.9) 10 mm and stainless steel 304 (k 14.9) 20 mm, 100 °C and 20 °C on their outer faces, every other face adiabatic; chtMultiRegionSimpleFoam.
Reference: 1D conduction through two layers in series, q = ΔT / (L1/k1 + L2/k2).

- Heat through the wall (W) on Hex-dominant: 5.343 against 5.338 (+0.11 %); mesh: Hex-dominant fineness 3; heat out 5.34343 W; every cell within 0.48 % of ΔT of the 1D profile.

**Heated block (stainless steel, 10 W, h = 500 W/(m²·K)).**
stainless steel 304 block 40 x 40 x 10 mm, 10 W spread evenly, its bottom cooled by h = 500 W/(m²·K) to 20 °C, every other face adiabatic; chtMultiRegionSimpleFoam (one region).

- Heat out (W) on Hex-dominant: 10.00 against 10.00 (+0.00 %); reference: energy balance: the source's power; mesh: Hex-dominant fineness 3.
- Highest temperature rise (K) on Hex-dominant: 14.60 against 14.60 (+0.03 %); reference: 1D conduction with a uniform source: Q / (h A) + q''' L² / (2 k); mesh: Hex-dominant fineness 3.
