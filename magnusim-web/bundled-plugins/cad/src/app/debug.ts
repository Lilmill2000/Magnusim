// window.__CAD__: a read-mostly handle for e2e tests (never shown in the UI).
// Owner: INTEGRATE.
// SPDX-License-Identifier: GPL-3.0-or-later
import type { ViewState } from '@magnusim/workspace';
import { assistantTestHandle } from '../assistant/install';
import { checkClock } from '../features/assembly/check';
import { recognitionOf } from '../kernel/recognition';
import { cornersBudget } from '../features/delete_faces/corners';
import { secondWayBudget } from '../features/delete_faces/plan';
import { moveHandleTest, type MoveHandleTestView } from '../features/move_body/handle';
import { sectionArrowTest, type SectionArrowTestView } from '../features/section/handle';
import type { Appearance } from '../lib/bridge';
import type { MarkPalette } from '../viewport/palette';
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
  /** The assembly checks' time limit (ms; src/features/assembly/check.ts checkClock): an e2e sets it low to see a check stop. */
  readonly assemblyCheck: { limitMs: number };
  /**
   * The page's fillet and hole recognition limits (src/kernel/recognition.ts, over services.kernel):
   * an e2e lowers maxFilletFaces (RECOGNIZE_MAX_FILLET_FACES, a search without holes) or
   * maxHoleFaces (RECOGNIZE_MAX_HOLE_FACES, any search with holes) to see the over-limit words on a
   * small body.
   */
  readonly recognition: { maxFilletFaces: number; maxHoleFaces: number };
  /**
   * The time Delete faces' second way allows (src/features/delete_faces/plan.ts secondWayBudget:
   * suppress_blends' own budget_ms, which may only lower its 1.4 s): an e2e lowers budgetMs to see
   * the budget's words on a small body; null is the kernel's own.
   */
  readonly secondWay: { budgetMs: number | null };
  /**
   * The time Delete faces' third way allows each group of a round and its corner faces
   * (src/features/delete_faces/corners.ts cornersBudget, which may only lower its 2.5 s): an e2e
   * lowers groupMs to see the third way's refusal; null is its own.
   */
  readonly corners: { groupMs: number | null };
  /** Move/copy body's handle in the view while its panel is open (src/features/move_body/handle.ts), or null: where its parts are. */
  readonly moveHandle: MoveHandleTestView | null;
  /** The section view's arrow in the view while the Section view panel is open (src/features/section/handle.ts), or null. */
  readonly sectionArrow: SectionArrowTestView | null;
  /** A JSON-safe snapshot for Playwright's evaluate(). */
  snapshot(): {
    kernel: ReturnType<AppServices['kernel']['status']['get']>;
    doc: { status: string; features: number; bodies: number; save: string };
    viewport: boolean;
    selection: number;
  };
}

/**
 * window.__CAD__.appearance: what the dark set's e2e reads (the look itself comes from the host:
 * the person's pref, and Settings → Appearance).
 */
export interface CadAppearanceHandle {
  /**
   * The appearance the Part has (its icon scale is the toolbar's), and the 3D view's palette now:
   * its name, its background, and whether its marks follow what is under them (E2: dark).
   */
  get(): { appearance: Appearance; palette: MarkPalette['name']; background: number; followsFaces: boolean };
}

/** The appearance part of the test handle, over the app's appearance control. */
export function appearanceTestHandle(services: AppServices, control: AppearanceControl): CadAppearanceHandle {
  return {
    get() {
      const p = services.viewport.get().handle?.palette?.() ?? control.palette();
      return { appearance: { ...control.appearance() }, palette: p.name, background: p.background, followsFaces: p.face !== null };
    },
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
    assemblyCheck: checkClock,
    recognition: recognitionOf(services.kernel).limits,
    secondWay: secondWayBudget,
    corners: cornersBudget,
    get moveHandle() {
      return moveHandleTest();
    },
    get sectionArrow() {
      return sectionArrowTest();
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
