// @ts-nocheck
/**
 * First-run setup and Settings wizard: units, hardware profile, listen port, workspace,
 * Assistant, plugins.
 *
 * Steps keep their ids (data-wiz-step / data-wiz-dot); WIZ_ORDER is the order they are
 * walked in. Plugins stays id 5 and last (plugin guides and suites name it); the Assistant
 * is id 6, shown before it.
 */
import { settleStep } from '../assistant/status';
import { mountIsland, unmountIsland } from '../islands';

const COLLAPSE_PREF_KEY = 'magnusim.collapseCompletedSections';
const WIZ_WORKSPACE_STEP = 4;
const WIZ_PLUGINS_STEP = 5; // stays 5 and last: GUIDE.md and the plugin suites name it
const WIZ_ASSISTANT_STEP = 6;
const WIZ_ORDER = [0, 1, 2, 3, 4, WIZ_ASSISTANT_STEP, WIZ_PLUGINS_STEP];
const WIZ_LAST_STEP = WIZ_PLUGINS_STEP;
const pos = (id) => WIZ_ORDER.indexOf(id);

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

// The Assistant step is mounted only while it is shown: it holds a key field.
let assistantMounted = false;
// Each showing of it, and the one a leave waiting for its changes belongs to.
let assistantVisit = 0;
let leavingVisit = 0;

function mountAssistant(on) {
  if (on && !assistantMounted) {
    assistantMounted = true;
    assistantVisit += 1;
    mountIsland('wiz-assistant', { scope: '' });
  } else if (!on && assistantMounted) {
    assistantMounted = false;
    unmountIsland('wiz-assistant');
  }
}

/**
 * Runs `go` (another step, or closing the wizard) once the shown step may be left. The
 * Assistant step first sends what its fields hold (a pasted key) and waits for its changes
 * on their way (assistant/status.ts settleStep): a refused one keeps the step on screen with
 * its reason, and the next press leaves. Any other step is left at once.
 */
function leave(go) {
  if (wizard.step !== WIZ_ASSISTANT_STEP || !assistantMounted) return go();
  const visit = assistantVisit;
  // A press while the step's changes are waited for: the first one leaves.
  if (leavingVisit === visit) return;
  const settled = settleStep();
  if (settled === true) return go();
  leavingVisit = visit;
  settled.then(
    (ok) => {
      if (leavingVisit === visit) leavingVisit = 0;
      // Still this showing of the step (nothing else moved the wizard meanwhile).
      if (ok && wizard.open && assistantMounted && assistantVisit === visit) go();
    },
    () => {
      if (leavingVisit === visit) leavingVisit = 0;
    },
  );
}

/** Shows step `id` (a known step id, else the first). */
function setStep(id) {
  wizard.step = pos(id) >= 0 ? id : WIZ_ORDER[0];
  const at = pos(wizard.step);
  document.querySelectorAll('.wiz-pane').forEach((el) => {
    el.hidden = Number(el.getAttribute('data-wiz-step')) !== wizard.step;
  });
  document.querySelectorAll('#wiz-rail li').forEach((el) => {
    const i = Number(el.getAttribute('data-wiz-dot'));
    const on = i === wizard.step;
    el.classList.toggle('is-on', on);
    el.classList.toggle('is-done', pos(i) >= 0 && pos(i) < at);
    if (on) el.setAttribute('aria-current', 'step');
    else el.removeAttribute('aria-current');
    el.tabIndex = 0;
  });
  const back = $('wiz-back');
  const next = $('wiz-next');
  const skip = $('wiz-skip');
  if (back) back.hidden = at === 0;
  if (next) next.textContent = wizard.step === WIZ_LAST_STEP ? 'Finish' : 'Next';
  if (skip) skip.hidden = wizard.required;
  if (wizard.step === 2) startHardwareCheck();
  mountAssistant(wizard.step === WIZ_ASSISTANT_STEP);
  if (wizard.step === WIZ_PLUGINS_STEP) mountIsland('wiz-plugins', { scope: '' });
}

/** The step `delta` places on in the walk (the first or last at the ends). */
function stepBy(delta) {
  const i = Math.max(0, Math.min(WIZ_ORDER.length - 1, pos(wizard.step) + delta));
  return WIZ_ORDER[i];
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
  // An open plugin workspace follows the units live (workspace bridge).
  window.dispatchEvent(new CustomEvent('cfd:units'));
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
  if (!r.ok || !j.ok) throw new Error((j && j.error) || 'Could not save settings');
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
  unmountIsland('wiz-plugins');
  mountAssistant(false);
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
  // Settings (after first run) opens on Workspace, as V0.1.0 did; Plugins is two steps on.
  // A link that is about plugins (a study whose plugin is off) opens on Plugins, and one
  // about the Assistant on the Assistant.
  if (!required && opts && opts.step === 'plugins') setStep(WIZ_PLUGINS_STEP);
  else if (!required && opts && opts.step === 'assistant') setStep(WIZ_ASSISTANT_STEP);
  else setStep(!required && prefs.wizard_completed ? WIZ_WORKSPACE_STEP : 0);
}

async function onNext() {
  const note = $('wiz-port-note');
  if (wizard.saved) {
    hideWizard();
    return;
  }
  if (wizard.step !== WIZ_LAST_STEP) {
    setStep(stepBy(1));
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
  $('wiz-back')?.addEventListener('click', () => leave(() => setStep(stepBy(-1))));
  $('wiz-next')?.addEventListener('click', () => {
    leave(() => onNext().catch((e) => console.warn('[CFD] wizard', e)));
  });
  $('wiz-skip')?.addEventListener('click', () => {
    if (!wizard.required) leave(hideWizard);
  });
  document.querySelectorAll('#wiz-rail li').forEach((el) => {
    const go = () => {
      const n = Number(el.getAttribute('data-wiz-dot'));
      if (!Number.isFinite(n)) return;
      if (n === wizard.step) setStep(n);
      else leave(() => setStep(n));
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

// Home and the SetupWizard island both start it; the second start used to arrive after
// the user had moved on and put the wizard back on its first step.
let wizardInit: Promise<void> | null = null;

export function initSetupWizard(): Promise<void> {
  if (!wizardInit) {
    wizardInit = (async () => {
      wireWizard();
      const prefs = await loadPrefs();
      if (!prefs.wizard_completed) openSetupWizard({ required: true });
    })();
  }
  return wizardInit;
}
