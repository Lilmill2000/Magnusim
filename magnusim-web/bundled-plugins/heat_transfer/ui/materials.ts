/**
 * A study's material records as the study and run panels need them: which bodies
 * are fluid and which solid, so the panels say which solver runs, and each solid's
 * heat source. Read from the core's materials route (the Materials panel's own),
 * again whenever a material is saved (`cfd:material`).
 */
import { useEffect, useState } from 'react';

export const FLUID_MODEL = 'thermo_fluid';
export const SOLID_MODEL = 'thermo_solid';

export interface StudyMaterial {
  id: string;
  name: string;
  model: string;
  bodies: string[];
  /** A solid's heat source in W, and per volume in W/m³ (undefined: the record has none). */
  heatSourceW?: number;
  heatSourceWm3?: number;
}

function finiteOrUndefined(v: unknown): number | undefined {
  if (v === null || v === undefined || v === '' || typeof v === 'boolean') return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

/** The records of this plugin's two models that have bodies, in order. */
export function placedMaterials(rows: unknown): StudyMaterial[] {
  const list = Array.isArray(rows) ? rows : [];
  const out: StudyMaterial[] = [];
  for (const raw of list) {
    if (!raw || typeof raw !== 'object') continue;
    const r = raw as Record<string, unknown>;
    const model = String(r.material_model || '');
    if (model !== FLUID_MODEL && model !== SOLID_MODEL) continue;
    const vols = Array.isArray(r.assigned_volumes) ? r.assigned_volumes.map(String).filter(Boolean) : [];
    const bodies = vols.length ? vols : r.assigned_volume ? [String(r.assigned_volume)] : [];
    if (!bodies.length) continue;
    const row: StudyMaterial = { id: String(r.id || ''), name: String(r.name || (model === SOLID_MODEL ? 'Solid' : 'Fluid')), model, bodies };
    if (model === SOLID_MODEL) {
      const w = finiteOrUndefined(r.heat_source_W);
      const d = finiteOrUndefined(r.heat_source_W_m3);
      if (w !== undefined) row.heatSourceW = w;
      if (d !== undefined) row.heatSourceWm3 = d;
    }
    out.push(row);
  }
  return out;
}

/** "Body2", "Body2 and Body3", "Body2, Body3 and Body4". */
export function bodiesText(bodies: readonly string[]): string {
  if (bodies.length <= 1) return bodies[0] || '';
  return `${bodies.slice(0, -1).join(', ')} and ${bodies[bodies.length - 1]}`;
}

/** The project id of a plugin UI's scope (`p:<id>`, '' when none is open). */
export function scopeProject(scope: string): string {
  const m = /(?:^|\|)p:([^|]+)/.exec(String(scope || ''));
  return m ? m[1] : '';
}

/** The study's placed materials (null while they load or when the study is not known). */
export function useStudyMaterials(projectId: string, simId: string): StudyMaterial[] | null {
  const [rows, setRows] = useState<StudyMaterial[] | null>(null);
  useEffect(() => {
    if (!projectId || !simId) {
      setRows(null);
      return undefined;
    }
    let live = true;
    const load = () => {
      const q = new URLSearchParams({ project_id: projectId, simulation_id: simId });
      fetch(`/api/materials?${q}`)
        .then((r) => r.json())
        .then((j: { materials?: unknown }) => {
          if (live) setRows(placedMaterials(j && j.materials));
        })
        .catch(() => {
          if (live) setRows(null);
        });
    };
    load();
    window.addEventListener('cfd:material', load);
    return () => {
      live = false;
      window.removeEventListener('cfd:material', load);
    };
  }, [projectId, simId]);
  return rows;
}
