// @ts-nocheck
/**
 * Settings: units, appearance, this PC, listen port, workspace, keybinds, Assistant, plugins.
 * Sections on the left; each change saves as it is made (a brief "Saved" in the header says so), and
 * the X or Esc closes. Units, Appearance, Port and Workspace have a Reset to defaults, Keybinds a
 * Reset all keybinds (one question first: it touches every plugin); This PC a Check again.
 * Appearance's preview shows a choice the pointer or the keyboard is on before it is made. No
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
import { isCad } from '../app/edition';
import { resetEveryPlugin, resetEveryQuestion } from '../keybinds/catalog';
import { displayCombo } from '../keybinds/combo';
import { applyAppearance, currentAppearance, DEFAULT_APPEARANCE, readAppearance, resolveTheme, saveAppearance, startAppearanceSync } from '../theme/appearance';
import { confirmAction } from '../workbench/dialogs';

const COLLAPSE_PREF_KEY = 'magnusim.collapseCompletedSections';
const WIZ_UNITS_STEP = 1;
const WIZ_PC_STEP = 2;
const WIZ_PLUGINS_STEP = 5; // stays 5: GUIDE.md and the plugin suites name it
const WIZ_ASSISTANT_STEP = 6;
const WIZ_KEYBINDS_STEP = 7;
const WIZ_APPEARANCE_STEP = 8;
const WIZ_ORDER = [WIZ_UNITS_STEP, WIZ_APPEARANCE_STEP, WIZ_PC_STEP, 3, 4, WIZ_KEYBINDS_STEP, WIZ_ASSISTANT_STEP, WIZ_PLUGINS_STEP];
// Magnusim CAD simulates nothing: no PC check (solver ranks), no Port (its window picks one),
// no Workspace (the simulation tree). Its rail is Units, Appearance, Keybinds, Assistant and Plugins.
const CAD_SECTIONS = [WIZ_UNITS_STEP, WIZ_APPEARANCE_STEP, WIZ_KEYBINDS_STEP, WIZ_ASSISTANT_STEP, WIZ_PLUGINS_STEP];
const sections = () => (isCad() ? WIZ_ORDER.filter((id) => CAD_SECTIONS.includes(id)) : WIZ_ORDER);
const pos = (id) => sections().indexOf(id);
/** The app's own port (scripts/prefs.js DEFAULT_PORT): Port's default. */
const DEFAULT_PORT = 8082;
/** How long the header's "Saved" stays, and a reason something was not saved. */
const SAVED_MS = 1800;
const ERROR_MS = 8000;

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
      // The person's look (the first paint had it from localStorage; this is the saved one).
      applyAppearance(readAppearance(j));
      startAppearanceSync();
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

/** The header's brief "Saved" (or why not: `error`, shown as one and for longer), read out to screen readers too. */
function flashSaved(text = 'Saved', error = false) {
  const el = $('wiz-saved');
  if (!el) return;
  el.textContent = text;
  el.classList.toggle('is-error', error);
  if (savedTimer) clearTimeout(savedTimer);
  savedTimer = setTimeout(() => {
    savedTimer = null;
    el.textContent = '';
    el.classList.remove('is-error');
  }, error ? ERROR_MS : SAVED_MS);
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
  wizard.step = pos(id) >= 0 ? id : sections()[0];
  document.querySelectorAll('.wiz-pane').forEach((el) => {
    el.hidden = Number(el.getAttribute('data-wiz-step')) !== wizard.step;
  });
  document.querySelectorAll('#wiz-rail li').forEach((el) => {
    el.hidden = pos(Number(el.getAttribute('data-wiz-dot'))) < 0;
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
  mountKeybinds(wizard.step === WIZ_KEYBINDS_STEP);
}

// Keybinds is mounted only while it is shown: it reads every list again each time it is (a
// workspace may have changed a key meanwhile), and a key press waited for ends with it.
let keybindsMounted = false;

function mountKeybinds(on) {
  if (on && !keybindsMounted) {
    keybindsMounted = true;
    mountIsland('wiz-keybinds', { scope: '' });
  } else if (!on && keybindsMounted) {
    keybindsMounted = false;
    unmountIsland('wiz-keybinds');
  }
}

function paintUnits() {
  document.querySelectorAll('[data-wiz-units]').forEach((btn) => {
    btn.classList.toggle('is-selected', btn.getAttribute('data-wiz-units') === wizard.units);
  });
}

/** How long Appearance's line says "Saved." after a choice was kept. */
const LOOK_SAVED_MS = 4000;
let lookSavedTimer = null;

/** Appearance's choices as saved, and its preview showing them (or `trying`, a choice not made yet). */
function paintAppearance(trying) {
  const now = currentAppearance();
  document.querySelectorAll('[data-wiz-look]').forEach((btn) => {
    const field = btn.getAttribute('data-wiz-look');
    const on = String(now[field]) === btn.getAttribute('data-value');
    btn.classList.toggle('is-selected', on);
    btn.setAttribute('aria-checked', on ? 'true' : 'false');
    // One Tab stop per group, on its choice; the arrows move within it (wireWizard).
    btn.tabIndex = on ? 0 : -1;
  });
  const look = { ...now, ...(trying || {}) };
  const preview = document.querySelector('[data-look-preview]');
  if (preview) {
    // The look now is the page's own (no light island is left when the theme changes with Settings
    // closed); a theme of its own only while one is tried.
    if (trying && trying.theme) preview.setAttribute('data-theme', resolveTheme(trying.theme));
    else preview.removeAttribute('data-theme');
    preview.style.setProperty('--mg-text-scale', String(look.text_scale));
    preview.style.setProperty('--mg-icon-scale', String(look.icon_scale));
    preview.setAttribute('data-preview-trying', trying ? '1' : '0');
  }
  const note = $('wiz-look-note');
  if (note) note.textContent = trying ? 'Preview of the choice: click it to keep it.' : 'Preview of the look now.';
  // Under the choices: the look kept now (never the one tried), and "Saved." for a while after a click.
  const kept = $('wiz-look-now');
  if (kept) {
    const pct = (x) => `${Math.round(x * 100)}%`;
    const theme = now.theme === 'system' ? `Match system (${resolveTheme('system')} now)` : now.theme === 'dark' ? 'Dark' : 'Light';
    kept.textContent = `${lookSavedTimer ? 'Saved. ' : ''}Your look now: ${theme}, text ${pct(now.text_scale)}, icons ${pct(now.icon_scale)}.`;
    kept.classList.toggle('is-saved', !!lookSavedTimer);
  }
}

/** A choice in Appearance as the preview and the save take it ({theme: 'dark'}, {text_scale: 1.15}). */
function lookOf(btn) {
  const field = btn.getAttribute('data-wiz-look');
  const raw = btn.getAttribute('data-value');
  return { [field]: field === 'theme' ? raw : Number(raw) };
}

/**
 * Saves an Appearance choice: shown at once here and in the other windows, "Saved" (or why not) in
 * the header, and "Saved. Your look now: …" under the choices.
 */
async function saveLook(patch) {
  const out = await saveAppearance(patch);
  if (out.ok) {
    if (lookSavedTimer) clearTimeout(lookSavedTimer);
    lookSavedTimer = setTimeout(() => {
      lookSavedTimer = null;
      paintAppearance();
    }, LOOK_SAVED_MS);
  }
  paintAppearance();
  if (out.ok) flashSaved();
  else flashSaved(out.error, true);
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

// A Reset all keybinds on its way: a second press waits for it instead of asking again.
let resettingKeys = false;

/**
 * Keybinds' Reset all keybinds: the Assistant panel's key and every plugin's commands back to their
 * defaults, after one question naming what it changes (it touches many; Enter answers Cancel).
 * Nothing to reset asks nothing. The button is busy meanwhile and has the keyboard again after; the
 * section reads its lists again when anything was reset. What could not be reset is said as an error.
 */
async function resetKeybinds(btn) {
  if (resettingKeys) return;
  resettingKeys = true;
  if (btn) {
    btn.disabled = true;
    btn.setAttribute('aria-busy', 'true');
  }
  try {
    const out = await resetEveryPlugin((names) => confirmAction({ ...resetEveryQuestion(names), safe: true }), displayCombo);
    const failed = out.failed.map((f) => `${f.name} (${f.why})`).join(', ');
    const kept = out.keptOff ? `. ${out.keptOff}` : '';
    if (out.error) flashSaved(out.error, true);
    else if (failed) flashSaved((out.reset.length ? `Reset ${out.reset.join(', ')}; not reset: ${failed}` : `Not reset: ${failed}`) + kept, true);
    else if (!out.asked) flashSaved('Every key is its default already');
    else if (out.reset.length) flashSaved();
    if (out.reset.length && keybindsMounted) mountIsland('wiz-keybinds', { scope: '' });
  } finally {
    resettingKeys = false;
    if (btn) {
      btn.disabled = false;
      btn.removeAttribute('aria-busy');
      if (btn.isConnected && wizard.open) btn.focus({ preventScroll: true });
    }
  }
}

/**
 * A section's Reset to defaults: Units Metric, Appearance light at 100%, Port 8082, Workspace with
 * finished sections collapsed, Keybinds every plugin's defaults.
 */
async function resetSection(key, btn) {
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
  } else if (key === 'keybinds') {
    await resetKeybinds(btn);
  } else if (key === 'appearance') {
    await saveLook({ ...DEFAULT_APPEARANCE });
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
  mountKeybinds(false);
  mountAssistant(false);
}

/**
 * Opens Settings on Units, or on the section `opts.step` names ('plugins', 'assistant',
 * 'keybinds', 'appearance': a link about one). `opts.required`: the first run's opening (its PC check starts at once).
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
  paintAppearance();
  paintWorkspace();
  const el = $('setup-wizard');
  if (el) el.hidden = false;
  // A link that is about plugins (a study whose plugin is off) opens on Plugins, and one about
  // the Assistant on the Assistant; anything else on Units.
  if (opts && opts.step === 'plugins') setStep(WIZ_PLUGINS_STEP);
  else if (opts && opts.step === 'assistant') setStep(WIZ_ASSISTANT_STEP);
  else if (opts && opts.step === 'keybinds') setStep(WIZ_KEYBINDS_STEP);
  else if (opts && opts.step === 'appearance') setStep(WIZ_APPEARANCE_STEP);
  else setStep(WIZ_UNITS_STEP);
  // The first run: the PC check (solver ranks) runs now, not only when This PC is opened.
  if (first && pos(WIZ_PC_STEP) >= 0) startHardwareCheck();
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
    btn.addEventListener('click', () => void resetSection(btn.getAttribute('data-wiz-reset'), btn));
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
  // Appearance: a click keeps a choice; the pointer or the keyboard on one shows it in the preview first.
  document.querySelectorAll('[data-wiz-look]').forEach((btn) => {
    btn.addEventListener('click', () => void saveLook(lookOf(btn)));
    const tryIt = () => paintAppearance(lookOf(btn));
    const leave = () => paintAppearance();
    btn.addEventListener('pointerenter', tryIt);
    btn.addEventListener('focus', tryIt);
    btn.addEventListener('pointerleave', leave);
    btn.addEventListener('blur', leave);
  });
  // Each group moves as radios do: an arrow (or Home, End) goes to a choice and keeps it.
  const STEP = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 };
  document.querySelectorAll('.wiz-look-group[role="radiogroup"]').forEach((group) => {
    group.addEventListener('keydown', (e) => {
      const radios = [...group.querySelectorAll('[role="radio"]')];
      const at = radios.indexOf(document.activeElement);
      if (at < 0) return;
      const n = radios.length;
      const to = e.key === 'Home' ? 0 : e.key === 'End' ? n - 1 : e.key in STEP ? (at + STEP[e.key] + n) % n : -1;
      if (to < 0) return;
      e.preventDefault();
      radios[to].focus();
      void saveLook(lookOf(radios[to]));
    });
  });
  // A look changed in another window (or by the Assistant) shows in the open section.
  window.addEventListener('cfd:appearance', () => {
    if (wizard.open) paintAppearance();
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
      // Magnusim CAD has nothing to set up first: it never opens by itself.
      if (!prefs.wizard_completed && !isCad()) openSetupWizard({ required: true });
    })();
  }
  return wizardInit;
}
