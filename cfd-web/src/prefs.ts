const COLLAPSE_PREF_KEY = 'magnusim.collapseCompletedSections';

export function prefersImperial(): boolean {
  const p = window.__CFD_PREFS__;
  return !!(p && /imperial/i.test(String(p.units || '')));
}

function syncCollapsePrefStore(prefs: Record<string, unknown>): void {
  const on = prefs.collapse_completed_sections !== false;
  try {
    localStorage.setItem(COLLAPSE_PREF_KEY, on ? '1' : '0');
  } catch {
    /* ignore */
  }
  if (window.__CFD_PREFS__) window.__CFD_PREFS__.collapse_completed_sections = on;
}

export function prefersCollapseCompletedSections(): boolean {
  try {
    const ls = localStorage.getItem(COLLAPSE_PREF_KEY);
    if (ls === '0') return false;
    if (ls === '1') return true;
  } catch {
    /* ignore */
  }
  const p = window.__CFD_PREFS__;
  if (p && p.collapse_completed_sections === false) return false;
  return true;
}

export async function loadPrefs(): Promise<Record<string, unknown>> {
  try {
    const r = await fetch('/api/prefs', { cache: 'no-store' });
    const j = (await r.json()) as Record<string, unknown>;
    if (j && j.ok) {
      window.__CFD_PREFS__ = j;
      if (j.collapse_completed_sections != null) syncCollapsePrefStore(j);
      return j;
    }
  } catch (e) {
    console.warn('[CFD] prefs', e);
  }
  window.__CFD_PREFS__ = window.__CFD_PREFS__ || {
    units: 'Metric',
    port: 8082,
    wizard_completed: false,
    collapse_completed_sections: true,
  };
  syncCollapsePrefStore(window.__CFD_PREFS__);
  return window.__CFD_PREFS__;
}

export function storeCollapsePref(on: boolean): void {
  syncCollapsePrefStore({ collapse_completed_sections: on });
}
