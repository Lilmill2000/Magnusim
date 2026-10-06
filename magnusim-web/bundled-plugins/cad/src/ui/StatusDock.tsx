// Bottom-left status chips (core .measure-dock / .measure-chip recipe):
//   kernel   starting / restarting, or failed with Retry
//   rebuild  "Rebuilding…" while a rebuild runs (after a short delay, so fast
//            rebuilds do not flicker), or "Rebuild failed: <why>"
//   volume   the selected body's volume; several bodies (selected, or shown when
//            none is selected) each on its own, never added together ("Body 1:
//            8000 mm³ · Enclosure 1: 64,000 mm³", Daniel 2026-10-02); a surface body has none
//   size     the same bodies' exact bounding box ("100 mm × 100 mm × 20 mm")
//   save     "Saved" / "Saving…" / "Not saved: <why> · Retry" / "Not applied: press Enter"
//            (a value typed in a field, so the chip agrees with the app's unsaved
//            dot) / "Changed in another tab · Reload (discard my change) · Keep mine
//            (replace the other tab's save)" (both tabs edited) / "Updated in another
//            tab · Reload" (this tab had no change: not unsaved work, L3 review B1)
//   removed  "This Part uses a removed feature: Old box · Suppress it" while an
//            unsuppressed Box or Cylinder (removed types) is in the history: the
//            exit cannot link the Part until they are suppressed or deleted (L3
//            review B2); Suppress is one undo step
//   keys     while the frame has no keyboard focus: the host (API 1.2) gives
//            the page the keyboard when it opens and after its own dialogs,
//            but a click on the host's header takes it away, and then
//            shortcuts reach the frame only after a click in it, so the dock
//            says so (proposal §3.4 hint)
// Owner: UI-SHELL.
// SPDX-License-Identifier: GPL-3.0-or-later
import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type ReactElement } from 'react';
import { pendingEdits, subscribePendingEdits } from '../lib/pendingEdits';
import { useServices } from '../lib/services';
import { useStateStore } from '../lib/store';
import { isRemovedFeature } from '../doc/features/removed';
import { Chip, formatQuantity, formatVolume } from './kit';
import { selectedBodies } from './tree/model';
import type { DocUnits } from '../types/units';

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

/**
 * What a Reload after "Changed in another tab" dropped from this tab, in words (review P2/P3
 * round 2: Reload adopted the other tab's version and this tab's unsaved Cylinder 1 was gone
 * without a word). A conflict only comes from a refused save, so this tab always had changes.
 */
export function reloadWords(before: { features: { id: string; name: string }[] }, after: { features: { id: string }[] }): string {
  const kept = new Set(after.features.map((f) => f.id));
  const gone = before.features.filter((f) => !kept.has(f.id)).map((f) => f.name);
  if (!gone.length) return "Reloaded the other tab's version: this tab's changes that were not saved are gone.";
  const list = gone.length === 1 ? gone[0] : `${gone.slice(0, -1).join(', ')} and ${gone[gone.length - 1]}`;
  return `Reloaded the other tab's version: ${list}, made in this tab and not saved, ${gone.length === 1 ? 'is' : 'are'} gone.`;
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

/** Bodies listed in the volume chip before the rest go into "+ N more" (the full list is the tooltip). */
export const VOLUME_LIST_MAX = 4;

type VolumeBody = { id: string; name: string; volume: number | null; solids?: number | null };

/** One body's volume in words: "8000 mm³", "Surface body: no volume" (no solid), with its pieces ("2 pieces"). */
function volumeWords(b: VolumeBody, units: DocUnits): string {
  if (b.solids === 0) return 'surface body, no volume';
  return formatVolume(b.volume ?? 0, units);
}

/**
 * The volume chip's text: one body alone, "8000 mm³" (or "Body 1 · 8000 mm³" when it is named:
 * selected, or the others are hidden); several, each on its own, "Body 1: 8000 mm³ · Body 2:
 * 6283.19 mm³", never added together. A surface body has no volume ("Surface body: no volume").
 * Hidden bodies are not listed and the chip says how many.
 */
/**
 * The bodies a list of more than VOLUME_LIST_MAX shows, in their own order: the CFD bodies
 * (`first`, an Enclosure's) and then the biggest, so the fluid domain is never the one behind
 * "+ N more" (P4a review).
 */
export function volumeListShown<T extends VolumeBody>(bodies: readonly T[], first: ReadonlySet<string> = new Set()): T[] {
  if (bodies.length <= VOLUME_LIST_MAX) return [...bodies];
  const ranked = [...bodies].sort((a, b) => Number(first.has(b.id)) - Number(first.has(a.id)) || (b.volume ?? 0) - (a.volume ?? 0));
  const keep = new Set(ranked.slice(0, VOLUME_LIST_MAX).map((b) => b.id));
  return bodies.filter((b) => keep.has(b.id));
}

export function VolumeList({ bodies, named, hidden, units, first }: { bodies: readonly VolumeBody[]; named: boolean; hidden: number; units: DocUnits; first?: ReadonlySet<string> }) {
  const pieces = (b: VolumeBody) => ((b.solids ?? 0) > 1 ? ` · ${b.solids} pieces` : '');
  const hiddenNote = hidden ? (
    <span className="cad-chip-hidden" data-volume-hidden={String(hidden)}>
      {' '}
      ({hidden === 1 ? '1 hidden body' : `${hidden} hidden bodies`} not listed)
    </span>
  ) : null;
  if (bodies.length === 1) {
    const b = bodies[0];
    const which = named || (b.solids ?? 0) > 1 ? `${b.name}${pieces(b)}` : null;
    return (
      <>
        {which ? (
          <span className="cad-chip-which" title={which}>
            <span className="cad-chip-name">{which}</span> ·{' '}
          </span>
        ) : null}
        {b.solids === 0 ? <span data-volume-surface="1" data-volume-body={b.id}>Surface body: no volume</span> : <span data-volume-mm3={String(b.volume ?? 0)} data-volume-body={b.id}>{formatVolume(b.volume ?? 0, units)}</span>}
        {hiddenNote}
      </>
    );
  }
  const shown = volumeListShown(bodies, first);
  const rest = bodies.length - shown.length;
  const all = bodies.map((b) => `${b.name}${pieces(b)}: ${volumeWords(b, units)}`).join(' · ');
  return (
    <span className="cad-chip-list" title={all} data-volume-list={String(bodies.length)}>
      {shown.map((b, i) => (
        <span key={b.id} className="cad-chip-entry" data-volume-entry={b.id}>
          {i ? ' · ' : ''}
          <span className="cad-chip-which">
            <span className="cad-chip-name" title={b.name}>
              {b.name}
            </span>
            {pieces(b)}:{' '}
          </span>
          {b.solids === 0 ? <span data-volume-surface="1" data-volume-body={b.id}>surface body, no volume</span> : <span data-volume-mm3={String(b.volume ?? 0)} data-volume-body={b.id}>{formatVolume(b.volume ?? 0, units)}</span>}
        </span>
      ))}
      {rest > 0 ? <span data-volume-more={String(rest)}> · + {rest} more</span> : null}
      {hiddenNote}
    </span>
  );
}

export function StatusDock() {
  const services = useServices();
  const { doc } = services;
  const k = useStateStore(services.kernel.status, (s) => ({ state: s.state, message: s.message, memoryHigh: s.memory_high, heap: s.heap_bytes }));
  const d = useStateStore(doc.state, (s) => ({ status: s.status, rebuild: s.rebuild.status, rebuildMsg: s.rebuild.message, bodies: s.rebuild.bodies, save: s.save, units: s.doc.units, features: s.doc.features }));
  const sel = useStateStore(services.selection);
  const rebuilding = useDelayed(d.rebuild === 'running', 300);
  const [measuring, setMeasuring] = useState(false);
  const hasFocus = useHasFocus();
  const typed = useSyncExternalStore(subscribePendingEdits, pendingEdits, pendingEdits);
  const chips: ReactElement[] = [];
  const dockRef = useDockReserve();

  /** "Keep mine": warned in the app's own words first; this tab's version then replaces the other tab's save. */
  const keepMine = async () => {
    const title = String(services.bridge.context.study?.title ?? '').trim() || 'this Part';
    const ok = await services.bridge
      .confirm({
        title: "Replace the other tab's save?",
        message: `Another tab saved ${title} after this tab's last save. Keep mine stores this tab's version over it: what the other tab changed since then is lost. The other tab is told to reload the next time it saves.`,
        confirmLabel: 'Keep mine',
      })
      .catch(() => false);
    if (!ok) return;
    try {
      await doc.keepMine();
      if (doc.state.get().save.state === 'saved') services.bridge.toast(`Kept this tab's version of ${title}.`, 'info');
    } catch (err) {
      services.bridge.toast(`Keep mine failed: ${err instanceof Error ? err.message : String(err)}`, 'error');
    }
  };

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

  // Removed feature types (Box, Cylinder) still in the history and not suppressed: the Part cannot go
  // to the project until they are suppressed or deleted, so it says so when the Part opens, with the
  // one step that fixes it (L3 review B2: every exit said "failed to build. Fix, retry or suppress").
  const removed = d.status === 'ready' ? d.features.filter((f) => isRemovedFeature(f) && !f.suppressed) : [];
  if (removed.length) {
    const one = removed.length === 1;
    const names = removed.map((f) => f.name);
    const list = one ? names[0] : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
    chips.push(
      <Chip
        key="removed"
        chip="removed"
        state="removed"
        kind="warning"
        actions={[
          {
            label: one ? 'Suppress it' : 'Suppress them',
            id: 'Suppress',
            run: () => {
              const r = doc.suppressRemoved();
              if (!r.ok) services.bridge.toast(r.reason, 'error');
            },
          },
        ]}
      >
        {one ? 'This Part uses a removed feature: ' : 'This Part uses removed features: '}
        {list}
      </Chip>,
    );
  }

  if (d.status === 'ready' && d.bodies.length) {
    // Selected bodies that are no longer built (deleted, suppressed, rolled back) do not count:
    // with none left, the chip falls back to the shown bodies (review round 2: it vanished).
    const picked = selectedBodies(sel);
    const pickedLive = d.bodies.filter((b) => picked.has(b.id));
    // With nothing selected: the bodies shown (a hidden body is not listed, and the chip says so).
    const shown = d.bodies.filter((b) => b.visible);
    const hidden = pickedLive.length ? 0 : d.bodies.length - shown.length;
    const chosen = pickedLive.length ? pickedLive : shown;
    const unmeasured = chosen.filter((b) => b.volume == null);
    // Each body on its own, never added together (Daniel, 2026-10-02: "Enclosure 1: 213,286,252 mm³ ·
    // Body1: 44,798,524 mm³"; a total of a part and the air around it means nothing).
    const named = chosen.length > 1 || pickedLive.length > 0 || hidden > 0;
    if (chosen.length && !unmeasured.length) {
      chips.push(
        <Chip key="volume" chip="volume" k="Volume">
          <VolumeList bodies={chosen} named={named} hidden={hidden} units={d.units} first={new Set(d.features.flatMap((f) => (f.type === 'enclosure' && 'creates' in f && f.creates ? [f.creates as string] : [])))} />
        </Chip>,
      );
    } else if (chosen.length) {
      // Large parts are measured on request (the kernel's long timeout).
      const which = named ? (chosen.length === 1 ? chosen[0].name : `${chosen.length} bodies`) : null;
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
    // Size: the exact bounding box of the same bodies (proposal §7 P2: "Press-pull +10 mm ->
    // the bounding-box chip grows by 10 mm"), once they are measured (exact boxes come with it).
    if (chosen.length && !unmeasured.length) {
      const box = chosen.reduce<number[] | null>((a, b) => (a ? [Math.min(a[0], b.bbox[0]), Math.min(a[1], b.bbox[1]), Math.min(a[2], b.bbox[2]), Math.max(a[3], b.bbox[3]), Math.max(a[4], b.bbox[4]), Math.max(a[5], b.bbox[5])] : [...b.bbox]), null)!;
      const size = [box[3] - box[0], box[4] - box[1], box[5] - box[2]];
      chips.push(
        <Chip key="size" chip="size" k="Size">
          <span data-size-mm={size.map((v) => String(v)).join(',')}>{size.map((v) => formatQuantity(v, 'length', d.units)).join(' × ')}</span>
        </Chip>,
      );
    }
  }

  const save = d.save;
  if (save.state === 'conflict') {
    // Two tabs (Daniel, 2026-10-02): the other tab saved while this one had a change
    // that was not saved. Either way is the user's choice, and nothing goes silently.
    chips.push(
      <Chip
        key="save"
        chip="save"
        state="conflict"
        kind="warning"
        actions={[
          {
            label: 'Reload (discard my change)',
            id: 'Reload',
            run: () => {
              const before = doc.state.get().doc;
              void doc
                .reload()
                .then(() => services.bridge.toast(reloadWords(before, doc.state.get().doc), 'info'))
                .catch((err: unknown) => services.bridge.toast(`Reload failed: ${err instanceof Error ? err.message : String(err)}`, 'error'));
            },
          },
          {
            label: "Keep mine (replace the other tab's save)",
            id: 'Keep mine',
            run: () => void keepMine(),
          },
        ]}
      >
        {save.message || 'Changed in another tab'}
      </Chip>,
    );
  } else if (save.state === 'updated') {
    // Another tab saved while this one had no change of its own: nothing here is lost by
    // reloading, and nothing is unsaved (no "Keep mine": there is nothing of this tab's to keep).
    chips.push(
      <Chip
        key="save"
        chip="save"
        state="updated"
        actions={[
          {
            label: 'Reload',
            id: 'Reload',
            run: () => {
              void doc.reload().catch((err: unknown) => services.bridge.toast(`Reload failed: ${err instanceof Error ? err.message : String(err)}`, 'error'));
            },
          },
        ]}
      >
        {save.message || 'Updated in another tab'}
      </Chip>,
    );
  } else if (typed.pending && save.state !== 'error') {
    // A value typed in a field and not applied: the page is unsaved (the app's dot
    // says so), and the chip must not say Saved (SD final review).
    chips.push(
      <Chip key="save" chip="save" state="typed" kind={typed.refused ? 'warning' : 'info'}>
        {typed.refused ? 'Not applied' : 'Not applied: press Enter'}
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

  // Modules' chips (sketch mode's "Under defined · 2 DOF"); each renders nothing when it has nothing to say.
  for (const m of services.modules?.all() ?? []) {
    (m.chips ?? []).forEach((ModuleChip, i) => chips.push(<ModuleChip key={`m:${m.id}:${i}`} />));
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
    <div className="cad-dock" data-cad-dock="1" ref={dockRef}>
      {chips}
    </div>
  );
}

/**
 * The tree column ends above the dock, however tall the dock is: a volume list of several bodies
 * wraps at 1280 px and covered the bottom of the tree and the rollback bar, which could then not
 * be dragged (P4a review). The dock's height goes into --cad-dock-reserve on the stage.
 */
function useDockReserve() {
  const ref = useRef<HTMLDivElement | null>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    const stage = el?.parentElement;
    if (!el || !stage) return;
    const set = () => {
      const bottom = parseFloat(getComputedStyle(el).bottom) || 16;
      const h = el.offsetHeight;
      // The default reserve (52 px) stays when the dock is one chip high or empty.
      stage.style.setProperty('--cad-dock-reserve', `${Math.max(52, Math.ceil(h + bottom + 8))}px`);
    };
    set();
    const ro = typeof ResizeObserver === 'function' ? new ResizeObserver(set) : null;
    ro?.observe(el);
    return () => {
      ro?.disconnect();
      stage.style.removeProperty('--cad-dock-reserve');
    };
  }, []);
  return ref;
}
