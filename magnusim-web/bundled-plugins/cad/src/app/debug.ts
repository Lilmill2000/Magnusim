// window.__CAD__: a read-mostly handle for e2e tests (never shown in the UI).
// Owner: INTEGRATE.
// SPDX-License-Identifier: GPL-3.0-or-later
import type { ViewState } from '@magnusim/workspace';
import { assistantTestHandle } from '../assistant/install';
import { pushAppearance, type Appearance } from '../lib/bridge';
import type { DarkLineOption, DarkLines, MarkPalette } from '../viewport/palette';
import type { AppearanceControl } from './appearance';
import type { AssistantTestHandle } from '../assistant/testing';
import type { LinkController, LinkOutcome } from '../link/controller';
import type { EditOpen } from '../link/edit-open';
import type { AppServices } from '../types/app';
import { openSetKeybind } from '../ui/keybinds';
import { keybindsFor, type Keybinds } from './keybinds';

export interface CadTestHandle {
  version: string;
  services: AppServices;
  /**
   * LINK: the project-link controller. No control in the Part runs it (the sync
   * happens when the user leaves the workspace, host API 1.6); tests run it here.
   */
  link: LinkController | null;
  /** L3: the exit hook ('pending' until the app answered its registration), and its last run. */
  leave: CadLeaveHandle;
  /** Edit in CAD (host API 1.7): the open flow of a Part opened on a project geometry. */
  edit?: EditOpen;
  /**
   * The person's keybinds (src/app/keybinds.ts) and the Set keybind dialog: `open(id)` opens it as a
   * command's right-click menu does (the toolbar's menu adds that item when the ribbon lands).
   */
  readonly keybinds: { model: Keybinds; open(commandId: string): void };
  /** The Assistant's tools in this Part (src/assistant/testing.ts), or null when its module is not installed. */
  readonly assistant: AssistantTestHandle | null;
  /** The host's appearance in the Part (src/app/appearance.ts): set once the app has installed it. */
  appearance?: CadAppearanceHandle;
  /** A JSON-safe snapshot for Playwright's evaluate(). */
  snapshot(): {
    kernel: ReturnType<AppServices['kernel']['status']['get']>;
    doc: { status: string; features: number; bodies: number; save: string };
    viewport: boolean;
    selection: number;
  };
}

/** window.__CAD__.appearance: the dark set's test path (e2e) and Daniel's E1 / E2 review switch. */
export interface CadAppearanceHandle {
  /** The appearance the Part has (its icon scale is the toolbar's), and the 3D view's palette now: its name, E1 / E2 candidates and background. */
  get(): { appearance: Appearance; palette: MarkPalette['name']; lines: DarkLines | null; background: number };
  /**
   * Deliver an appearance as the host's SDK does with its 'appearance' event (a host with none yet
   * included). The SDK also writes data-theme and the scales on <html>: the caller does that too.
   */
  push(a: Partial<Appearance>): void;
  /** E1 / E2: the candidates for edges and sketch lines in a dark view (one for both, or each apart); returns the choice. */
  darkLines(lines?: Partial<DarkLines> | DarkLineOption): DarkLines;
}

/** The appearance part of the test handle, over the app's appearance control. */
export function appearanceTestHandle(services: AppServices, control: AppearanceControl): CadAppearanceHandle {
  return {
    get() {
      const p = services.viewport.get().handle?.palette?.() ?? control.palette();
      return { appearance: { ...control.appearance() }, palette: p.name, lines: p.lines ? { ...p.lines } : null, background: p.background };
    },
    push: (a) => pushAppearance(services.bridge, { ...control.appearance(), ...a }),
    darkLines: (lines) => control.darkLines(lines),
  };
}

export interface CadLeaveHandle {
  hook: 'pending' | 'on' | 'unavailable';
  runs: number;
  last: { reason: string; outcome: LinkOutcome | null; view: ViewState | null; error: string | null } | null;
}

declare global {
  interface Window {
    __CAD__?: CadTestHandle;
  }
}

export function exposeTestHandle(services: AppServices, version: string, link: LinkController | null = null): CadLeaveHandle {
  const leave: CadLeaveHandle = { hook: 'pending', runs: 0, last: null };
  window.__CAD__ = {
    version,
    services,
    link,
    leave,
    // A getter: the modules (the Assistant's among them) install before this handle is exposed.
    get assistant() {
      return assistantTestHandle(services);
    },
    keybinds: {
      model: keybindsFor(services),
      open: (id) => void openSetKeybind(services, id),
    },
    snapshot() {
      const d = services.doc.state.get();
      return {
        kernel: services.kernel.status.get(),
        doc: { status: d.status, features: d.doc.features.length, bodies: d.rebuild.bodies.length, save: d.save.state },
        viewport: services.viewport.get().handle !== null,
        selection: services.selection.get().items.length,
      };
    },
  };
  return leave;
}
