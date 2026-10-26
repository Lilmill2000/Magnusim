// @ts-nocheck
/**
 * Settings: units, this PC, listen port, workspace, Assistant, plugins. Sections on the left;
 * each change saves as it is made (a brief "Saved" in the header says so), and the X or Esc
 * closes. Units, Port and Workspace have a Reset to defaults; This PC a Check again. No
 * Welcome, Next, Back or Finish (Daniel, 2026-10-25: the sections are the way around).
 *
 * The first run opens it on Units, with the PC check (solver ranks) running meanwhile; closing
 * it marks setup done (wizard_completed), so it doesn't open by itself again.
 *
 * Sections keep their ids (data-wiz-step / data-wiz-dot); WIZ_ORDER is the rail's order.
 * Plugins stays id 5 (plugin guides and suites name it); the Assistant is id 6, shown before it.
 */
import { settleStep } from '../assistant/status';
import { mountIsland, unmountIsland } from '../islands';

const COLLAPSE_PREF_KEY = 'magnusim.collapseCompletedSections';
const WIZ_UNITS_STEP = 1;
const WIZ_PC_STEP = 2;
const WIZ_PLUGINS_STEP = 5; // stays 5: GUIDE.md and the plugin suites name it
const WIZ_ASSISTANT_STEP = 6;
const WIZ_ORDER = [WIZ_UNITS_STEP, WIZ_PC_STEP, 3, 4, WIZ_ASSISTANT_STEP, WIZ_PLUGINS_STEP];
const pos = (id) => WIZ_ORDER.indexOf(id);
/** The app's own port (scripts/prefs.js DEFAULT_PORT): Port's default. */
const DEFAULT_PORT = 8082;
/** How long the header's "Saved" stays. */
const SAVED_MS = 1800;

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
  // This opening is the first run's (closing it marks setup done).
  firstRun: false,
  step: WIZ_UNITS_STEP,
  units: 'Metric',
  port: DEFAULT_PORT,
  hardware: null,
  hwStarted: false,
};
let savedTimer = null;

/** The header's brief "Saved" (or why not), read out to screen readers too. */
function flashSaved(text = 'Saved') {
  const el = $('wiz-saved');
  if (!el) return;
  el.textContent = text;
  if (savedTimer) clearTimeout(savedTimer);
  savedTimer = setTimeout(() => {
    savedTimer = null;
    el.textContent = '';
  }, SAVED_MS);
}

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
 * on their way (assistant/status.ts settleStep): a refused one, or a key saved with a warning,
 * keeps the step on screen with what it said, and the next press leaves. Any other step is
 * left at once.
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

/** Shows section `id` (a known section id, else Units). */
function setStep(id) {
  wizard.step = pos(id) >= 0 ? id : WIZ_ORDER[0];
  document.querySelectorAll('.wiz-pane').forEach((el) => {
    el.hidden = Number(el.getAttribute('data-wiz-step')) !== wizard.step;
  });
  document.querySelectorAll('#wiz-rail li').forEach((el) => {
    const on = Number(el.getAttribute('data-wiz-dot')) === wizard.step;
    el.classList.toggle('is-on', on);
    if (on) el.setAttribute('aria-current', 'page');
    else el.removeAttribute('aria-current');
    el.tabIndex = 0;
  });
  const main = document.querySelector('#setup-wizard .wiz-main');
  if (main) main.scrollTop = 0;
  if (wizard.step === WIZ_PC_STEP) startHardwareCheck();
  mountAssistant(wizard.step === WIZ_ASSISTANT_STEP);
  if (wizard.step === WIZ_PLUGINS_STEP) mountIsland('wiz-plugins', { scope: '' });
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

async function startHardwareCheck(again = false) {
  if (!again && wizard.hwStarted) {
    if (wizard.hardware) paintHardware(wizard.hardware, 'Applied to this installation.');
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
    paintHardware(null, 'Could not finish the check: ' + (e && e.message ? e.message : e) + '. Check again to retry.');
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
  flashSaved();
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

/** POSTs a part of the settings; the answer's prefs become the page's. */
async function postPrefs(patch) {
  const r = await fetch('/api/prefs', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
  });
  const j = await r.json();
  if (!r.ok || !j.ok) throw new Error((j && j.error) || 'Could not save settings');
  window.__CFD_PREFS__ = j.prefs;
  if (j.prefs && j.prefs.collapse_completed_sections != null) syncCollapsePrefStore(j.prefs);
  return j;
}

/** Port saves as it changes: the server takes it at the next start (stop.bat, then run.bat). */
async function savePort() {
  const el = $('wiz-port');
  const note = $('wiz-port-note');
  const port = Number(el && el.value);
  if (port === wizard.port) return;
  try {
    const j = await postPrefs({ port });
    wizard.port = j.prefs.port;
    if (el) el.value = String(wizard.port);
    flashSaved();
    if (note) {
      note.hidden = !j.restart_required;
      note.textContent = j.restart_required
        ? 'Saved. Double-click stop.bat, then run.bat, so the app listens on ' + j.prefs.port + '.'
        : '';
    }
  } catch (e) {
    if (note) {
      note.hidden = false;
      note.textContent = e && e.message ? e.message : String(e);
    }
  }
}

/** A section's Reset to defaults: Units Metric, Port 8082, Workspace with finished sections collapsed. */
async function resetSection(key) {
  if (key === 'units') {
    wizard.units = 'Metric';
    paintUnits();
    await persistWizardUnits();
  } else if (key === 'port') {
    const el = $('wiz-port');
    if (el) el.value = String(DEFAULT_PORT);
    await savePort();
  } else if (key === 'workspace') {
    const el = $('wiz-collapse-completed');
    if (el) el.checked = true;
    await persistCollapsePref(true);
  }
}

/** Closing marks the first run's setup done, so Settings doesn't open by itself again. */
async function markSetUp() {
  try {
    await postPrefs({ wizard_completed: true });
  } catch (e) {
    console.warn('[CFD] prefs', e);
  }
}

function closeSettings() {
  leave(() => {
    const first = wizard.firstRun;
    hideWizard();
    if (first) void markSetUp();
  });
}

async function persistCollapsePref(on) {
  flashSaved();
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
  wizard.firstRun = false;
  unmountIsland('wiz-plugins');
  mountAssistant(false);
}

/**
 * Opens Settings on Units, or on the section `opts.step` names ('plugins', 'assistant': a link
 * about one). `opts.required`: the first run's opening (its PC check starts at once).
 */
export function openSetupWizard(opts) {
  const first = !!(opts && opts.required);
  wizard.firstRun = first;
  wizard.open = true;
  wizard.hwStarted = false;
  const prefs = window.__CFD_PREFS__ || {};
  wizard.units = /imperial/i.test(String(prefs.units || '')) ? 'Imperial' : 'Metric';
  wizard.port = Number(prefs.port) || DEFAULT_PORT;
  wizard.hardware = prefs.hardware || null;
  const portEl = $('wiz-port');
  if (portEl) portEl.value = String(wizard.port);
  const note = $('wiz-port-note');
  if (note) {
    note.hidden = true;
    note.textContent = '';
  }
  const saved = $('wiz-saved');
  if (saved) saved.textContent = '';
  paintUnits();
  paintWorkspace();
  const el = $('setup-wizard');
  if (el) el.hidden = false;
  // A link that is about plugins (a study whose plugin is off) opens on Plugins, and one about
  // the Assistant on the Assistant; anything else on Units.
  if (opts && opts.step === 'plugins') setStep(WIZ_PLUGINS_STEP);
  else if (opts && opts.step === 'assistant') setStep(WIZ_ASSISTANT_STEP);
  else setStep(WIZ_UNITS_STEP);
  // The first run: the PC check (solver ranks) runs now, not only when This PC is opened.
  if (first) startHardwareCheck();
  $('wiz-close')?.focus({ preventScroll: true });
}

let wizardWired = false;
function wireWizard() {
  if (wizardWired) return;
  wizardWired = true;
  $('wiz-close')?.addEventListener('click', closeSettings);
  $('setup-wizard')?.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' || e.defaultPrevented || e.isComposing) return;
    e.preventDefault();
    closeSettings();
  });
  // A click on the dimmed page around it closes it too.
  $('setup-wizard')?.addEventListener('mousedown', (e) => {
    if (e.target === $('setup-wizard')) closeSettings();
  });
  $('wiz-port')?.addEventListener('change', () => void savePort());
  document.querySelectorAll('[data-wiz-reset]').forEach((btn) => {
    btn.addEventListener('click', () => void resetSection(btn.getAttribute('data-wiz-reset')));
  });
  document.querySelectorAll('[data-wiz-recheck]').forEach((btn) => {
    btn.addEventListener('click', () => void startHardwareCheck(true));
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
      // The first run opens Settings (on Units, the PC check running) until it is closed once.
      if (!prefs.wizard_completed) openSetupWizard({ required: true });
    })();
  }
  return wizardInit;
}
