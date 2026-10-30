// "A picture after every edit": each edit call that answers ok (every tool whose risk is not read:
// the edit tools, undo and delete) carries one small picture of the Part, so the model sees what it
// made. The picture is the view tool's (ViewportHandle.snapshot, drawn off screen with its own
// orthographic camera: the person's camera never moves): iso, framed on every shown body (the shown
// sketches when there is none), the bodies' own colours (the person's see-through bodies see-through,
// named in the line), EDIT_PICTURE_PX, PNG (encodePicture). The
// data says what it is in one line (`picture`), or why there is none this time (`picture_note`);
// a picture that fails never fails the call. No picture when the person turned them off (ws.prefs
// `assistant.pictures`: 'each', the default, or 'off'; the chip's Pictures toggle), when the
// turn's model reads no images (TurnFacts.images false), for an outside client's call (ext:, mcp:)
// unless its model is known to read images, and when the Part has no 3D view or its graphics
// context is lost. The pace and the approval are done before it: the picture is the kept step.
// When the host says each call's place in the model's step (placeOf), one picture per step: on
// the call after which no edit of the step follows, when an edit of it changed the Part
// (stepPicture); its earlier edits say PICTURE_LATER. A picture still owed when the step ends is
// the conversation's when the turn names one (its next request brings it), else the turn's.
// Owner: ASSISTANT.
// SPDX-License-Identifier: GPL-3.0-or-later
import type { AssistantCall, AssistantImage } from '@magnusim/workspace';
import type { PrefsApi } from '../lib/bridge';
import type { CallCtx } from '../types/assistant';
import type { ViewportHandle } from '../types/viewport';
import { ToolError } from './errors';
import { toolNamed } from './schemas';
import { seeThroughOf } from '../viewport/bind';
import { encodePicture, LABEL_FONT_PX } from './view';

/** The person's choice, in ws.prefs. */
export const PICTURES_PREF = 'assistant.pictures';
export type Pictures = 'each' | 'off';

/** The picture's size (px): small enough to cost little, large enough to see a misplaced feature. */
export const EDIT_PICTURE_PX = Object.freeze({ width: 640, height: 480 });
/** How long the picture waits for a rebuild still running after the edit (ms); then it says so. */
export const PICTURE_SETTLE_MS = 5000;

export interface PicturesControl {
  get(): Pictures;
  /** The person's choice (kept in ws.prefs when the host has them). */
  set(v: Pictures): void;
  /** Tests: this choice whatever the person chose, never written to ws.prefs; null gives theirs back. */
  force(v: Pictures | null): void;
  subscribe(fn: (v: Pictures) => void): () => void;
  dispose(): void;
}

const isPictures = (v: unknown): v is Pictures => v === 'each' || v === 'off';

export function createPictures(o: { prefs: PrefsApi | null }): PicturesControl {
  let value: Pictures = 'each';
  let forced: Pictures | null = null;
  let chosen = false;
  let disposed = false;
  const listeners = new Set<(v: Pictures) => void>();
  const now = () => forced ?? value;
  const tell = () => {
    for (const fn of [...listeners]) fn(now());
  };
  const take = (v: unknown) => {
    const next: Pictures = isPictures(v) ? v : 'each';
    if (next === value) return;
    const was = now();
    value = next;
    if (now() !== was) tell();
  };
  const offs: (() => void)[] = [];
  if (o.prefs) {
    // The person's choice, read once (a choice made here meanwhile wins), then heard from other tabs.
    o.prefs
      .get<Pictures>(PICTURES_PREF)
      .then((v) => {
        if (!disposed && !chosen) take(v);
      })
      .catch(() => undefined);
    offs.push(
      o.prefs.onChange((key, v) => {
        if (key === PICTURES_PREF) take(v);
      }),
    );
  }
  return {
    get: now,
    set(next) {
      chosen = true;
      const was = now();
      value = isPictures(next) ? next : 'each';
      if (now() !== was) tell();
      o.prefs?.set(PICTURES_PREF, value).catch(() => undefined);
    },
    force(v) {
      const was = now();
      forced = isPictures(v) ? v : null;
      if (now() !== was) tell();
    },
    subscribe(fn) {
      listeners.add(fn);
      return () => {
        listeners.delete(fn);
      };
    },
    dispose() {
      disposed = true;
      for (const off of offs.splice(0)) off();
      listeners.clear();
    },
  };
}

/** An outside client's call (no turn of the app's: ext:<n>, or another app's over MCP). */
export const isExternalKey = (key: string) => key.startsWith('ext:') || key.startsWith('mcp:');

/** Whether this call's turn gets pictures at all: Pictures on, and a model that reads images (an outside client's only when known to). */
export function picturesOn(ctx: Pick<CallCtx, 'key' | 'turn'>, pictures: Pictures): boolean {
  if (pictures !== 'each') return false;
  const images = ctx.turn?.images ?? null;
  if (images === false) return false;
  if (isExternalKey(ctx.key) && images !== true) return false;
  return true;
}

/** Whether this call's ok answer gets a picture (before anything is drawn). */
export function wantsPicture(ctx: Pick<CallCtx, 'tool' | 'key' | 'turn'>, pictures: Pictures): boolean {
  const spec = toolNamed(ctx.tool);
  if (!spec || spec.risk === 'read') return false;
  return picturesOn(ctx, pictures);
}

/** What an edit's answer says when a later call of its step brings the picture. */
export const PICTURE_LATER = "see this step's last edit";
/** Keys still owed a picture, kept at most (the newest). */
const OWED_KEPT = 32;

/** What a step's last call says when it failed with an earlier edit's picture still owed. */
export const PICTURE_NEXT = 'comes with your next step';

/** A call's place in its model step (one answer of the model): the host's AssistantCall fields. */
export interface StepPlace {
  step: number;
  /** The calls of the step after it that the host sends to this page (not one it answers itself: capped, skipped, stopped). */
  callsLeft: number;
  /** How many of those are edits (0: no edit of the step follows). */
  editsLeft: number;
}

/**
 * The call's place in its step (AssistantCall.step, callsLeftInStep, editsLeftInStep; unreleased
 * 1.9, not in the SDK's types yet). Null when the host does not say it (an older host, another
 * app's call over MCP, a coding agent) or says it out of shape: then each edit that answers ok
 * gets its own picture, as before.
 */
export function placeOf(call: AssistantCall): StepPlace | null {
  const c = call as { step?: unknown; callsLeftInStep?: unknown; editsLeftInStep?: unknown };
  const whole = (v: unknown) => (typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 ? v : null);
  const [step, callsLeft, editsLeft] = [whole(c.step), whole(c.callsLeftInStep), whole(c.editsLeftInStep)];
  return step !== null && step >= 1 && callsLeft !== null && editsLeft !== null && editsLeft <= callsLeft ? { step, callsLeft, editsLeft } : null;
}

/**
 * What an ok answer gets: 'now' the picture, 'later' the PICTURE_LATER line (its key then owes
 * one), or 'none'. `editsLeft`: the place's (null: no place). `edits`: wantsPicture, and the reply
 * changed the model and has no image of its own; `owed`: an earlier 'later' had no picture yet;
 * `on`: picturesOn, and no image of its own. The call after which no edit follows brings it,
 * after its own edit or an owed one (a read after the step's last edit, or the next step's when
 * that edit failed).
 */
export function stepPicture(o: { editsLeft: number | null; edits: boolean; owed: boolean; on: boolean }): 'now' | 'later' | 'none' {
  if (o.editsLeft === null) return o.edits ? 'now' : 'none';
  if (o.editsLeft > 0) return o.edits ? 'later' : 'none';
  return o.edits || (o.owed && o.on) ? 'now' : 'none';
}

/** `key` is owed a picture (a 'later' answer); only the newest OWED_KEPT keys are kept. */
export function owePicture(owed: Set<string>, key: string): void {
  owed.delete(key);
  owed.add(key);
  if (owed.size > OWED_KEPT) owed.delete(owed.values().next().value as string);
}

/** The see-through bodies an edit's picture names (the rest are counted). */
const SEE_THROUGH_NAMED = 8;

/** What an edit's answer gets: the picture and its line, or a note why there is none; null: nothing at all. */
export type EditPicture = { image: AssistantImage; caption: string } | { note: string } | null;

const settledWithin = async (p: Promise<unknown>, ms: number): Promise<boolean> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const done = p.then(() => true);
  // Rejected after the time ran out (the call stopped): nobody waits for it any more.
  done.catch(() => undefined);
  try {
    return await Promise.race([done, new Promise<boolean>((r) => (timer = setTimeout(() => r(false), ms)))]);
  } finally {
    clearTimeout(timer);
  }
};

/**
 * The picture of the Part after an edit that answered ok. Never throws: a failure is a note. Null
 * when there is nothing to draw with (no 3D view, no snapshot, a lost context) or the call stopped.
 */
export async function editPicture(ctx: Pick<CallCtx, 'services' | 'signal'>): Promise<EditPicture> {
  const { services } = ctx;
  const handle: ViewportHandle | null = services.viewport.get().handle;
  if (!handle || typeof handle.snapshot !== 'function') return null;
  try {
    if (handle.stats().contextLost) return null;
    // The edit has rebuilt; a rebuild still catching up (a parameter's dependants) is waited for, a little.
    if (!(await settledWithin(services.doc.settled(ctx.signal), PICTURE_SETTLE_MS))) return { note: 'No picture this time: the Part was still rebuilding.' };
    if (ctx.signal.aborted) return null;
    let shot;
    try {
      shot = handle.snapshot({ view: 'iso', width: EDIT_PICTURE_PX.width, height: EDIT_PICTURE_PX.height, hide: [], section: null });
    } catch (e) {
      // The graphics context went away (or the view did): nothing to draw with, as without a view.
      if ((e as { code?: unknown })?.code === 'not_ready') return null;
      throw e;
    }
    const image = await encodePicture(shot.rgba, shot.width, shot.height, [], LABEL_FONT_PX.small);
    const s = services.doc.state.get();
    const drawn = s.rebuild.bodies.filter((b) => b.visible && !!b.tess);
    const shown = drawn.length;
    const what = shown ? `all ${shown === 1 ? '1 shown body' : `${shown} shown bodies`}` : 'the shown sketches (no body yet)';
    // The person's see-through bodies are drawn see-through here too: said, so a ghosted body is not taken for a fault.
    const through = drawn.filter((b) => seeThroughOf(s, services, b.id)).map((b) => b.name);
    const see = through.length ? `; see-through as in the person's view: ${through.slice(0, SEE_THROUGH_NAMED).join(', ')}${through.length > SEE_THROUGH_NAMED ? ` and ${through.length - SEE_THROUGH_NAMED} more` : ''}` : '';
    return { image, caption: `Picture: iso view of the Part framed on ${what}, ${shot.width}x${shot.height}, real colours${see}; look at it and fix what looks wrong.` };
  } catch (e) {
    if (ctx.signal.aborted) return null;
    const raw = e instanceof Error && e.message ? e.message : String(e);
    const why = e instanceof ToolError ? raw.slice(e.reason.length + 2) : raw;
    return { note: `No picture this time: ${why.slice(0, 120)}` };
  }
}
