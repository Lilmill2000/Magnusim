/**
 * INTENTIONAL BAD CASE for Phase 2 land14 prove.
 * Must NOT be imported by product code.
 * Guard must FAIL when scanned via --scan.
 */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

// Forbidden: Node writing materials.json as SoT
writeFileSync(join('projects', 'demo', 'materials.json'), JSON.stringify({ materials: [] }, null, 2), 'utf8');
writeFileSync(join('projects', 'demo', 'boundary_conditions.json'), '{}', 'utf8');
writeFileSync(join('projects', 'demo', 'mesh.json'), '{}', 'utf8');
writeFileSync(join('projects', 'demo', 'mesh_refinements.json'), '{}', 'utf8');
writeFileSync(join('projects', 'demo', 'result_controls.json'), '{}', 'utf8');
writeFileSync(join('projects', 'demo', 'simulation_control.json'), '{}', 'utf8');
writeFileSync(join('projects', 'demo', 'simulations.json'), '{}', 'utf8');
writeFileSync(join('projects', 'demo', 'runs', 'catalog.json'), '{}', 'utf8');
