// @ts-nocheck
/**
 * First-run / Preferences wizard: units, hardware profile, listen port, workspace.
 */

const COLLAPSE_PREF_KEY = 'magnusim.collapseCompletedSections';
const WIZ_LAST_STEP = 4;

function $(id) {
  return document.getElementById(id);
}

export function prefersImperial() {
  const p = window.__CFD_PREFS__;
  return !!(p && /imperial/i.test(String(p.units || '')));
}

export async function loadPrefs() {
  try {
    const r = await fetch('/api/prefs', { cache: 'no-store' });
    const j = await r.json();
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

export function prefersCollapseCompletedSections() {
  try {
    const ls = localStorage.getItem(COLLAPSE_PREF_KEY);
    if (ls === '0') return false;
    if (ls === '1') return true;
  } catch (_) {}
  const p = window.__CFD_PREFS__;
  if (p && p.collapse_completed_sections === false) return false;
  return true;
}

function syncCollapsePrefStore(prefs) {
  const on = !prefs || prefs.collapse_completed_sections !== false;
  try { localStorage.setItem(COLLAPSE_PREF_KEY, on ? '1' : '0'); } catch (_) {}
  if (window.__CFD_PREFS__) window.__CFD_PREFS__.collapse_completed_sections = on;
}

const wizard = {
  open: false,
  required: false,
  step: 0,
  units: 'Metric',
  port: 8082,
  hardware: null,
  hwStarted: false,
  saved: false,
};

function setStep(n) {
  wizard.step = Math.max(0, Math.min(WIZ_LAST_STEP, n));
  document.querySelectorAll('.wiz-pane').forEach((el) => {
    el.hidden = Number(el.getAttribute('data-wiz-step')) !== wizard.step;
  });
  document.querySelectorAll('#wiz-rail li').forEach((el) => {
    const i = Number(el.getAttribute('data-wiz-dot'));
    const on = i === wizard.step;
    el.classList.toggle('is-on', on);
    el.classList.toggle('is-done', i < wizard.step);
    if (on) el.setAttribute('aria-current', 'step');
    else el.removeAttribute('aria-current');
    el.tabIndex = 0;
  });
  const back = $('wiz-back');
  const next = $('wiz-next');
  const skip = $('wiz-skip');
  if (back) back.hidden = wizard.step === 0;
  if (next) next.textContent = wizard.step === WIZ_LAST_STEP ? 'Finish' : 'Next';
  if (skip) skip.hidden = wizard.required;
  if (wizard.step === 2) startHardwareCheck();
}

function paintUnits() {
  document.querySelectorAll('[data-wiz-units]').forEach((btn) => {
    btn.classList.toggle('is-selected', btn.getAttribute('data-wiz-units') === wizard.units);
  });
}

function paintWorkspace() {
  const el = $('wiz-collapse-completed');
  if (el) el.checked = prefersCollapseCompletedSections();
}

function paintHardware(hw, statusText) {
  const status = $('wiz-hw-status');
  const box = $('wiz-hw-result');
  if (status) status.textContent = statusText || '';
  if (!box) return;
  if (!hw) {
    box.hidden = true;
    box.innerHTML = '';
    return;
  }
  const cores = hw.physical_cores != null ? hw.physical_cores : '—';
  const ram = hw.ram_gb != null ? hw.ram_gb + ' GB' : '—';
  const disk = hw.disk_free_gb != null ? hw.disk_free_gb + ' GB free' : '—';
  const of = hw.openfoam_ok ? 'OpenFOAM ready' : 'OpenFOAM not found — run Setup.bat if mesh/solve fails';
  const notes = (hw.notes || []).map((n) => '<li>' + escape(n) + '</li>').join('');
  box.hidden = false;
  box.innerHTML =
    '<div><strong>' +
    escape(profileLabel(hw.profile)) +
    '</strong> · ' +
    cores +
    ' cores · ' +
    ram +
    ' RAM · ' +
    disk +
    '</div>' +
    '<div style="margin-top:6px">' +
    escape(of) +
    '</div>' +
    (notes ? '<ul>' + notes + '</ul>' : '');
}

function profileLabel(p) {
  if (p === 'light') return 'Light profile';
  if (p === 'workstation') return 'Workstation profile';
  return 'Standard profile';
}

function escape(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/"/g, '&quot;');
}

async function startHardwareCheck() {
  if (wizard.hwStarted && wizard.hardware) {
    paintHardware(wizard.hardware, 'Applied to this installation.');
    return;
  }
  wizard.hwStarted = true;
  paintHardware(null, 'Checking this PC. WSL may take a minute to wake…');
  try {
    const r = await fetch('/api/prefs/hardware-check', { method: 'POST' });
    const j = await r.json();
    if (!r.ok || !j.ok) throw new Error((j && j.error) || 'Hardware check failed');
    wizard.hardware = j.hardware;
    if (j.prefs) window.__CFD_PREFS__ = j.prefs;
    paintHardware(wizard.hardware, 'Applied to this installation.');
  } catch (e) {
    paintHardware(null, 'Could not finish the check: ' + (e && e.message ? e.message : e) + '. You can continue.');
    wizard.hwStarted = false;
  }
}

async function applyPreferredUnitsNow() {
  if (typeof window.__CFD_APPLY_PREFERRED_UNITS__ === 'function') {
    try {
      await window.__CFD_APPLY_PREFERRED_UNITS__();
    } catch (e) {
      console.warn('[CFD] preferred units', e);
    }
  }
}

async function persistWizardUnits() {
  try {
    const r = await fetch('/api/prefs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ units: wizard.units }),
    });
    const j = await r.json();
    if (r.ok && j && j.prefs) {
      window.__CFD_PREFS__ = j.prefs;
      if (j.prefs.collapse_completed_sections != null) syncCollapsePrefStore(j.prefs);
    } else if (window.__CFD_PREFS__) {
      window.__CFD_PREFS__.units = wizard.units;
    }
  } catch (e) {
    if (window.__CFD_PREFS__) window.__CFD_PREFS__.units = wizard.units;
    console.warn('[CFD] prefs units', e);
  }
  await applyPreferredUnitsNow();
}

async function saveWizard(completed) {
  const port = Number(($('wiz-port') && $('wiz-port').value) || wizard.port);
  wizard.port = port;
  const r = await fetch('/api/prefs', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      units: wizard.units,
      port,
      wizard_completed: !!completed,
      collapse_completed_sections: prefersCollapseCompletedSections(),
    }),
  });
  const j = await r.json();
  if (!r.ok || !j.ok) throw new Error((j && j.error) || 'Could not save preferences');
  window.__CFD_PREFS__ = j.prefs;
  syncCollapsePrefStore(j.prefs);
  await applyPreferredUnitsNow();
  return j;
}

async function persistCollapsePref(on) {
  syncCollapsePrefStore({ collapse_completed_sections: !!on });
  try {
    const r = await fetch('/api/prefs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ collapse_completed_sections: !!on }),
    });
    const j = await r.json();
    if (r.ok && j && j.prefs) {
      window.__CFD_PREFS__ = j.prefs;
      syncCollapsePrefStore(j.prefs);
    }
  } catch (e) {
    console.warn('[CFD] prefs', e);
  }
}

function hideWizard() {
  const el = $('setup-wizard');
  if (el) el.hidden = true;
  wizard.open = false;
}

export function openSetupWizard(opts) {
  const required = !!(opts && opts.required);
  wizard.required = required;
  wizard.open = true;
  wizard.step = 0;
  wizard.hwStarted = false;
  wizard.saved = false;
  const prefs = window.__CFD_PREFS__ || {};
  wizard.units = /imperial/i.test(String(prefs.units || '')) ? 'Imperial' : 'Metric';
  wizard.port = Number(prefs.port) || 8082;
  wizard.hardware = prefs.hardware || null;
  const portEl = $('wiz-port');
  if (portEl) portEl.value = String(wizard.port);
  const note = $('wiz-port-note');
  if (note) {
    note.hidden = true;
    note.textContent = '';
  }
  paintUnits();
  paintWorkspace();
  const el = $('setup-wizard');
  if (el) el.hidden = false;
  setStep(!required && prefs.wizard_completed ? WIZ_LAST_STEP : 0);
}

async function onNext() {
  const note = $('wiz-port-note');
  if (wizard.saved) {
    hideWizard();
    return;
  }
  if (wizard.step < WIZ_LAST_STEP) {
    setStep(wizard.step + 1);
    return;
  }
  try {
    const j = await saveWizard(true);
    wizard.saved = true;
    if (j.restart_required) {
      if (note) {
        note.hidden = false;
        note.textContent =
          'Port saved. Double-click stop.bat, then run.bat, so the app listens on ' +
          j.prefs.port +
          '.';
      }
      const next = $('wiz-next');
      if (next) next.textContent = 'Close';
      wizard.required = false;
      const skip = $('wiz-skip');
      if (skip) skip.hidden = false;
      return;
    }
    hideWizard();
  } catch (e) {
    if (note) {
      note.hidden = false;
      note.textContent = e && e.message ? e.message : String(e);
    }
  }
}

let wizardWired = false;
function wireWizard() {
  if (wizardWired) return;
  wizardWired = true;
  $('wiz-back')?.addEventListener('click', () => setStep(wizard.step - 1));
  $('wiz-next')?.addEventListener('click', () => {
    onNext().catch((e) => console.warn('[CFD] wizard', e));
  });
  $('wiz-skip')?.addEventListener('click', () => {
    if (!wizard.required) hideWizard();
  });
  document.querySelectorAll('#wiz-rail li').forEach((el) => {
    const go = () => {
      const n = Number(el.getAttribute('data-wiz-dot'));
      if (Number.isFinite(n)) setStep(n);
    };
    el.addEventListener('click', go);
    el.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        go();
      }
    });
  });
  document.querySelectorAll('[data-wiz-units]').forEach((btn) => {
    btn.addEventListener('click', () => {
      wizard.units = btn.getAttribute('data-wiz-units') === 'Imperial' ? 'Imperial' : 'Metric';
      paintUnits();
      persistWizardUnits().catch((err) => console.warn('[CFD] prefs units', err));
    });
  });
  $('home-prefs')?.addEventListener('click', () => openSetupWizard({ required: false }));
  $('wb-prefs')?.addEventListener('click', () => openSetupWizard({ required: false }));
  $('wiz-collapse-completed')?.addEventListener('change', (e) => {
    persistCollapsePref(!!e.target.checked).catch((err) => console.warn('[CFD] prefs', err));
  });
}

export async function initSetupWizard() {
  wireWizard();
  const prefs = await loadPrefs();
  if (!prefs.wizard_completed) openSetupWizard({ required: true });
}
