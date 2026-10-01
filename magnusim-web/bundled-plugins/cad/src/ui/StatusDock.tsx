// Bottom-left status chips (core .measure-dock / .measure-chip recipe):
//   kernel   starting / restarting, or failed with Retry
//   rebuild  "Rebuilding…" while a rebuild runs (after a short delay, so fast
//            rebuilds do not flicker), or "Rebuild failed: <why>"
//   volume   the selected bodies' volume, or the shown bodies' total when none
//            is selected ("Total of 3 bodies · 24,000 mm³")
//   save     "Saved" / "Saving…" / "Not saved: <why> · Retry" / "Changed in another tab · Reload"
//   keys     while the frame has no keyboard focus: the host (API 1.2) gives
//            the page the keyboard when it opens and after its own dialogs,
//            but a click on the host's header takes it away, and then
//            shortcuts reach the frame only after a click in it, so the dock
//            says so (proposal §3.4 hint)
// Owner: UI-SHELL.
// SPDX-License-Identifier: GPL-3.0-or-later
import { useEffect, useState, type ReactElement } from 'react';
import { useServices } from '../lib/services';
import { useStateStore } from '../lib/store';
import { Chip, formatVolume } from './kit';
import { selectedBodies } from './tree/model';

/**
 * Whether keys reach the frame now: it has keyboard focus. The host gives it
 * focus when it connects (host API 1.2), but a click on the host (the header,
 * Settings, Queue) takes it away again, so the hint shows whenever it does not
 * (review round 2: after a host click, Ctrl+Z did nothing and nothing said so).
 * Focus that comes with a press waits for the release: the chip going away
 * mid-click would move whatever is under the pointer, and the hint is the
 * dock's last chip, so it never moves the chips before it.
 */
function useHasFocus(): boolean {
  const [has, setHas] = useState(() => typeof document !== 'undefined' && document.hasFocus());
  useEffect(() => {
    let pressed = false;
    let waiting = false;
    const on = () => {
      if (pressed) waiting = true;
      else setHas(true);
    };
    const off = () => {
      waiting = false;
      setHas(false);
    };
    const down = () => {
      pressed = true;
    };
    const up = () => {
      pressed = false;
      // After this press's click has been dispatched.
      if (waiting) {
        waiting = false;
        setTimeout(() => setHas(document.hasFocus()), 0);
      }
    };
    if (document.hasFocus()) on();
    window.addEventListener('focus', on);
    window.addEventListener('blur', off);
    document.addEventListener('focusin', on);
    document.addEventListener('pointerdown', down, true);
    document.addEventListener('pointerup', up, true);
    document.addEventListener('pointercancel', up, true);
    return () => {
      window.removeEventListener('focus', on);
      window.removeEventListener('blur', off);
      document.removeEventListener('focusin', on);
      document.removeEventListener('pointerdown', down, true);
      document.removeEventListener('pointerup', up, true);
      document.removeEventListener('pointercancel', up, true);
    };
  }, []);
  return has;
}

function useDelayed(flag: boolean, ms: number): boolean {
  const [on, setOn] = useState(false);
  useEffect(() => {
    if (!flag) {
      setOn(false);
      return;
    }
    const t = setTimeout(() => setOn(true), ms);
    return () => clearTimeout(t);
  }, [flag, ms]);
  return flag && on;
}

export function StatusDock() {
  const services = useServices();
  const { doc } = services;
  const k = useStateStore(services.kernel.status, (s) => ({ state: s.state, message: s.message, memoryHigh: s.memory_high, heap: s.heap_bytes }));
  const d = useStateStore(doc.state, (s) => ({ status: s.status, rebuild: s.rebuild.status, rebuildMsg: s.rebuild.message, bodies: s.rebuild.bodies, save: s.save, units: s.doc.units }));
  const sel = useStateStore(services.selection);
  const rebuilding = useDelayed(d.rebuild === 'running', 300);
  const [measuring, setMeasuring] = useState(false);
  const hasFocus = useHasFocus();
  const chips: ReactElement[] = [];

  if (k.state === 'starting' || k.state === 'restarting') {
    chips.push(
      <Chip key="kernel" chip="kernel" state={k.state} busy>
        {k.state === 'starting' ? 'Starting kernel…' : 'Restarting kernel…'}
      </Chip>,
    );
  } else if (k.state === 'failed') {
    chips.push(
      <Chip key="kernel" chip="kernel" state="failed" kind="error" actions={[{ label: 'Retry', run: () => void services.kernel.restart('Retry').catch(() => {}) }]}>
        {k.message || 'The kernel failed to start'}
      </Chip>,
    );
  }

  // The kernel stayed above its recycle threshold even after a fresh worker rebuilt the part.
  if (k.memoryHigh && k.state === 'ready') {
    chips.push(
      <Chip key="memory" chip="memory" kind="warning" state="high">
        Large model · {k.heap != null ? `${(k.heap / 1024 ** 3).toFixed(1)} GB` : 'high'} memory
      </Chip>,
    );
  }

  if (d.rebuildMsg) {
    chips.push(
      <Chip key="rebuild" chip="rebuild" state="failed" kind="error">
        Rebuild failed: {d.rebuildMsg}
      </Chip>,
    );
  } else if (rebuilding) {
    chips.push(
      <Chip key="rebuild" chip="rebuild" state="running" busy>
        Rebuilding…
      </Chip>,
    );
  }

  if (d.status === 'ready' && d.bodies.length) {
    // Selected bodies that are no longer built (deleted, suppressed, rolled back) do not count:
    // with none left, the chip falls back to the total (review round 2: it vanished).
    const picked = selectedBodies(sel);
    const pickedLive = d.bodies.filter((b) => picked.has(b.id));
    // With nothing selected: the bodies shown (a hidden body is not counted), and say it is a total.
    const shown = d.bodies.filter((b) => b.visible);
    const hidden = d.bodies.length - shown.length;
    const chosen = pickedLive.length ? pickedLive : shown;
    let which: string | null = null;
    if (pickedLive.length) which = chosen.length === 1 ? chosen[0].name : `${chosen.length} bodies`;
    else if (hidden) which = `Total of ${chosen.length} shown ${chosen.length === 1 ? 'body' : 'bodies'}`;
    else if (chosen.length > 1) which = `Total of ${chosen.length} bodies`;
    const unmeasured = chosen.filter((b) => b.volume == null);
    if (chosen.length && !unmeasured.length) {
      const total = chosen.reduce((sum, b) => sum + (b.volume ?? 0), 0);
      chips.push(
        <Chip key="volume" chip="volume" k="Volume">
          {which ? (
            <span className="cad-chip-which" title={which}>
              <span className="cad-chip-name">{which}</span> ·{' '}
            </span>
          ) : null}
          <span data-volume-mm3={String(total)}>{formatVolume(total, d.units)}</span>
        </Chip>,
      );
    } else if (chosen.length) {
      // Large parts are measured on request (the kernel's long timeout).
      const measure = () => {
        setMeasuring(true);
        Promise.all(unmeasured.map((b) => doc.measure(b.id)))
          .catch((err: unknown) => services.bridge.toast(`Measure failed: ${err instanceof Error ? err.message : String(err)}`, 'error'))
          .finally(() => setMeasuring(false));
      };
      chips.push(
        <Chip key="volume" chip="volume" k="Volume" state={measuring ? 'measuring' : 'unmeasured'} busy={measuring} actions={measuring ? [] : [{ label: 'Measure', run: measure }]}>
          {which ? (
            <span className="cad-chip-which" title={which}>
              <span className="cad-chip-name">{which}</span> ·{' '}
            </span>
          ) : null}
          {measuring ? 'Measuring…' : 'Not measured yet'}
        </Chip>,
      );
    }
  }

  const save = d.save;
  if (save.state === 'conflict') {
    chips.push(
      <Chip key="save" chip="save" state="conflict" kind="warning" actions={[{ label: 'Reload', run: () => void doc.reload().catch((err: unknown) => services.bridge.toast(`Reload failed: ${err instanceof Error ? err.message : String(err)}`, 'error')) }]}>
        {save.message || 'Changed in another tab'}
      </Chip>,
    );
  } else if (save.state === 'error') {
    // The save is retried by itself (3 s, 10 s, 30 s, then every minute); Retry tries at once.
    chips.push(
      <Chip key="save" chip="save" state="error" kind="error" actions={[{ label: 'Retry', run: () => doc.retrySave() }]}>
        Not saved: {save.message}
      </Chip>,
    );
  } else if (save.state === 'pending' || save.state === 'saving') {
    chips.push(
      <Chip key="save" chip="save" state={save.state}>
        Saving…
      </Chip>,
    );
  } else if (save.state === 'saved' && save.at) {
    chips.push(
      <Chip key="save" chip="save" state="saved">
        Saved
      </Chip>,
    );
  }

  // Last: it comes and goes with the frame's focus, and the chips before it stay put.
  if (!hasFocus && d.status === 'ready') {
    chips.push(
      <Chip key="keys" chip="keys" state="no-focus">
        Click here to use keyboard shortcuts
      </Chip>,
    );
  }

  return (
    <div className="cad-dock" data-cad-dock="1">
      {chips}
    </div>
  );
}
