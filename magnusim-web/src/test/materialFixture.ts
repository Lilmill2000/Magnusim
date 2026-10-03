import type { MaterialModelRow } from '../materialModel';

/** A material model row as registry.describe gives it (fixture, not the plugin's). */
export const FIXTURE_MODEL: MaterialModelRow = {
  key: 'newtonian_incompressible',
  label: 'Newtonian (incompressible)',
  schema: {
    properties: {
      nu: { title: '(ν) Kinematic viscosity', default: 1.516e-5, minimum: 0, 'x-cfddesk': { unit: 'm^2/s', quantity: 'kinematic_viscosity' } },
      rho: { title: '(ρ) Density', default: 1.204, minimum: 0, 'x-cfddesk': { unit: 'kg/m^3', quantity: 'density' } },
    },
  },
  library: [
    { key: 'air', name: 'Air', values: { nu: 1.516e-5, rho: 1.204 }, library: 'AIR', codes: ['AIR', 'DEFAULT'], names: ['Air'], legacy_values: { nu: 1.529e-5, rho: 1.196 } },
    { key: 'water', name: 'Water', values: { nu: 1.004e-6, rho: 998.2 }, library: 'WATER', codes: ['WATER'], names: ['Water'] },
    { key: 'custom', name: 'Custom fluid', values: { nu: 1.516e-5, rho: 1.204 }, library: 'CUSTOM', codes: ['CUSTOM'], names: [], legacy_values: { nu: 1.529e-5, rho: 1.196 } },
  ],
  record_keys: { nu: ['kinematic_viscosity', 'nu'], rho: ['density', 'rho'] },
  record_constants: { type: 'Newtonian', viscosity_model: 'Newtonian', kinematic_viscosity_unit: 'm2/s', density_unit: 'kg/m3' },
  custom_preset: 'custom',
};

/** Analyses that offer the fixture model (and one that offers none), as registry.describe gives them. */
export const FIXTURE_REGISTRY = {
  analysis: [
    { key: 'incompressible_steady', label: 'Incompressible', material_models: ['newtonian_incompressible'] },
    { key: 'no_fluid_steady', label: 'No fluid', material_models: [] },
  ],
  material: [FIXTURE_MODEL],
  default_analysis: { steady: 'incompressible_steady' },
};
