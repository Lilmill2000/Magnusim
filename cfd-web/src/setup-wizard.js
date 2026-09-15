/**
 * First-run / Preferences wizard: units, hardware profile, listen port.
 */

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
      return j;
    }
  } catch (e) {
    console.warn('[CFD] prefs', e);
  }
  window.__CFD_PREFS__ = window.__CFD_PREFS__ || { units: 'Metric', port: 8082, wizard_completed: false };
  return window.__CFD_PREFS__;
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
  wizard.step = Math.max(0, Math.min(3, n));
  document.querySelectorAll('.wiz-pane').forEach((el) => {
    el.hidden = Number(el.getAttribute('data-wiz-step')) !== wizard.step;
  });
  document.querySelectorAll('#wiz-rail li').forEach((el) => {
    const i = Number(el.getAttribute('data-wiz-dot'));
    el.classList.toggle('is-on', i === wizard.step);
    el.classList.toggle('is-done', i < wizard.step);
  });
  const back = $('wiz-back');
  const next = $('wiz-next');
  const skip = $('wiz-skip');
  if (back) back.hidden = wizard.step === 0;
  if (next) next.textContent = wizard.step === 3 ? 'Finish' : 'Next';
  if (skip) skip.hidden = wizard.required;
  if (wizard.step === 2) startHardwareCheck();
}

function paintUnits() {
  document.querySelectorAll('[data-wiz-units]').forEach((btn) => {
    btn.classList.toggle('is-selected', btn.getAttribute('data-wiz-units') === wizard.units);
  });
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
    }),
  });
  const j = await r.json();
  if (!r.ok || !j.ok) throw new Error((j && j.error) || 'Could not save preferences');
  window.__CFD_PREFS__ = j.prefs;
  return j;
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
  const el = $('setup-wizard');
  if (el) el.hidden = false;
  setStep(0);
}

async function onNext() {
  const note = $('wiz-port-note');
  if (wizard.saved) {
    hideWizard();
    return;
  }
  if (wizard.step < 3) {
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
          'Port saved. Double-click stop.bat, then start.bat, so the app listens on ' +
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

function wireWizard() {
  $('wiz-back')?.addEventListener('click', () => setStep(wizard.step - 1));
  $('wiz-next')?.addEventListener('click', () => {
    onNext().catch((e) => console.warn('[CFD] wizard', e));
  });
  $('wiz-skip')?.addEventListener('click', () => {
    if (!wizard.required) hideWizard();
  });
  document.querySelectorAll('[data-wiz-units]').forEach((btn) => {
    btn.addEventListener('click', () => {
      wizard.units = btn.getAttribute('data-wiz-units') === 'Imperial' ? 'Imperial' : 'Metric';
      paintUnits();
    });
  });
  $('home-prefs')?.addEventListener('click', () => openSetupWizard({ required: false }));
}

export async function initSetupWizard() {
  wireWizard();
  const prefs = await loadPrefs();
  if (!prefs.wizard_completed) openSetupWizard({ required: true });
}
