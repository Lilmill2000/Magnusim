// Autosave. A change is written at once: the host's Back removes the frame at
// once, and F5 or closing the tab can follow an edit by a moment, so nothing
// waits on a timer that a closing page never fires. The rules:
// - Model writes: one runs at a time; changes made while it runs are written
//   together right after it. Up to SAVE_BURST model writes go back to back,
//   then one per SAVE_INTERVAL_MS until the budget refills (P0 gate 10 asked for
//   it when every write ran on the core worker lane; ws.files streams in Node
//   and is re-measured in P1.5). Filling in one panel stays within it.
// - On a host with API 1.2 every model write is conditional (ws.files ifMatch
//   = the etag of the last read or write), and the page tells the host it has
//   unsaved work (nav.setDirty, doc/service.ts) from the first change until it
//   is written: every way out of the workspace asks "Leave without saving?",
//   and F5 or closing the tab gets the browser's own prompt. Nothing is lost
//   without the user choosing it.
// - View-only writes (tree folders opened or closed, eyes, the rollback bar,
//   the camera) never spend the model's budget (review round 2: eight twisty
//   clicks used it up, and the next real edit waited). They go on their own
//   slower cadence, at most one per VIEW_INTERVAL_MS, the first at once. A model
//   write that is due anyway takes a waiting view along.
// - flushNow() writes whatever waits at once, outside the budget: the pointer
//   left the frame (Back, Settings, Queue and the browser's own controls are all
//   outside it), the frame lost focus, a panel's Done.
// - leaveNow() is for a page that is going this instant: F5, Ctrl+R, Ctrl+W,
//   the mouse's side Back / Forward buttons, the page being hidden. With
//   ws.files it is flushNow(): the conditional write, and the host asks before
//   the page goes while it is on its way. On a 1.1 host (ws.data, no setDirty)
//   it posts the waiting model in ONE message before it returns, on top of the
//   version this tab last stored (the store's saveModelNow): that message cannot
//   check for another tab's save in between, so it is used only while this tab
//   read the stored version less than FAST_MAX_AGE_MS ago, and an etag this
//   session wrote is never a conflict for it.
// - Back to what is stored (undo to the saved model) drops a waiting write and
//   says Saved.
// - Writes are retried after errors (and at once with the chip's Retry) and
//   stop for good on a conflict.
// Owner: DOC-CORE.
// SPDX-License-Identifier: GPL-3.0-or-later
import type { CadDoc, CadView } from '../types/doc';
import type { SaveState } from '../types/doc-service';
import { DocConflictError, type DocStore } from '../types/docstore';

/** Model writes allowed back to back before the budget applies (a panel's fields typed one after another). */
export const SAVE_BURST = 6;
/** Sustained spacing of model writes once the burst is used (P0 gate 10). */
export const SAVE_INTERVAL_MS = 1500;
/** View-only writes: at most one per this, the first at once; never from the model's budget. */
export const VIEW_INTERVAL_MS = 2000;
/** leaveNow() posts without a re-read only while this tab confirmed the stored version this recently. */
export const FAST_MAX_AGE_MS = 10_000;
const RETRY_MS = [3000, 10_000, 30_000, 60_000];

export interface AutosaveOptions {
  store: DocStore;
  getDoc(): CadDoc;
  getView(): CadView;
  /** The model's etag as loaded (null: not stored yet). */
  etag: string | null;
  /** When the loaded model was stored (ISO), for the Saved chip on reopen. */
  savedAt?: string | null;
  onState(s: SaveState): void;
  /** Sustained spacing once the burst is used (ms). Tests pass less. */
  intervalMs?: number;
  burst?: number;
  /** View-only write spacing (ms). Tests pass less. */
  viewIntervalMs?: number;
  log?(msg: string, err?: unknown): void;
}

function why(e: unknown): string {
  const m = e instanceof Error ? e.message : String(e);
  return m.replace(/^Error:\s*/, '') || 'the app did not answer';
}

export class Autosave {
  private etag: string | null;
  private dirty = false;
  private viewDirty = false;
  private savedDoc: CadDoc | null = null;
  private savedAt: string | null;
  /** The model's budget or retry timer. */
  private timer: ReturnType<typeof setTimeout> | null = null;
  private writing: Promise<void> | null = null;
  /** flushNow() came while a write ran: write again right after it, outside the budget. */
  private urgent = false;
  private failures = 0;
  private stopped: 'conflict' | 'disposed' | null = null;
  private shown: SaveState['state'] | null = null;
  private tokens: number;
  private refillAt = 0;
  private readonly interval: number;
  private readonly burst: number;
  private readonly viewInterval: number;
  private viewTimer: ReturnType<typeof setTimeout> | null = null;
  private viewWriting: Promise<void> | null = null;
  /** When the last view write started (ms). */
  private viewAt = 0;
  /** When this tab last confirmed the stored model's version (load, or a conditional save's read). */
  private checkedAt: number;
  /** Bumped by each leaveNow() model post: a conditional write it overtook keeps its hands off etag and savedDoc. */
  private gen = 0;
  /** A leaveNow() model post has not been answered yet. */
  private leaving = false;

  constructor(private readonly o: AutosaveOptions) {
    this.etag = o.etag;
    this.interval = o.intervalMs ?? SAVE_INTERVAL_MS;
    this.burst = Math.max(1, o.burst ?? SAVE_BURST);
    this.viewInterval = o.viewIntervalMs ?? VIEW_INTERVAL_MS;
    this.tokens = this.burst;
    this.savedDoc = o.etag ? o.getDoc() : null;
    this.savedAt = o.etag ? (o.savedAt ?? null) : null;
    this.checkedAt = Date.now();
  }

  get conflicted(): boolean {
    return this.stopped === 'conflict';
  }

  /** When the model was last stored (ISO), or null when it never was. */
  get lastSavedAt(): string | null {
    return this.savedAt;
  }

  private send(s: SaveState) {
    this.shown = s.state;
    this.o.onState(s);
  }

  /** The model changed (an edit, undo or redo). */
  modelChanged(): void {
    if (this.stopped) return;
    if (!this.writing && this.o.getDoc() === this.savedDoc) {
      // Back to what is stored (undo to the saved model): nothing to write.
      this.dirty = false;
      if (this.timer) {
        clearTimeout(this.timer);
        this.timer = null;
      }
      this.send({ state: 'saved', at: this.savedAt });
      if (this.viewDirty) this.kickView();
      return;
    }
    this.dirty = true;
    this.send({ state: 'pending' });
    this.kick();
  }

  /** The view (rollback, visibility, tree) changed: saved too, last write wins, on its own cadence. */
  viewChanged(): void {
    if (this.stopped) return;
    this.viewDirty = true;
    // A model write that is due takes it along; otherwise its own cadence.
    if (!this.dirty) this.kickView();
  }

  /** Top the budget up for the time that passed. */
  private refill(now: number) {
    if (this.tokens >= this.burst) {
      this.refillAt = now;
      return;
    }
    const add = Math.floor((now - this.refillAt) / this.interval);
    if (add > 0) {
      this.tokens = Math.min(this.burst, this.tokens + add);
      this.refillAt = this.tokens >= this.burst ? now : this.refillAt + add * this.interval;
    }
  }

  /** Write the model now when the budget allows, else when it next does. A running write chains by itself. */
  private kick() {
    if (this.stopped || this.writing || this.timer) return;
    if (this.failures) {
      this.schedule(RETRY_MS[Math.min(this.failures - 1, RETRY_MS.length - 1)]);
      return;
    }
    const now = Date.now();
    this.refill(now);
    if (this.tokens >= 1) {
      this.tokens -= 1;
      void this.write();
      return;
    }
    this.schedule(Math.max(0, this.refillAt + this.interval - now));
  }

  private schedule(delay: number) {
    if (this.stopped) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      this.refill(Date.now());
      if (this.tokens >= 1) this.tokens -= 1;
      void this.write();
    }, delay);
  }

  // ------------------------------------------------------------------ view

  private clearViewTimer() {
    if (this.viewTimer) clearTimeout(this.viewTimer);
    this.viewTimer = null;
  }

  /** Write the view now when its cadence allows, else when it next does. */
  private kickView() {
    if (this.stopped || !this.viewDirty || this.viewTimer || this.viewWriting) return;
    const wait = this.viewAt + this.viewInterval - Date.now();
    if (wait <= 0) {
      this.writeView();
      return;
    }
    this.viewTimer = setTimeout(() => {
      this.viewTimer = null;
      // A model write that started meanwhile may have taken it along.
      if (!this.dirty) this.writeView();
    }, wait);
  }

  /** One view write (one message). `force`: do not wait for a running one (the page is going). */
  private writeView(force = false) {
    if (this.stopped || !this.viewDirty || (this.viewWriting && !force)) return;
    this.clearViewTimer();
    this.viewDirty = false;
    this.viewAt = Date.now();
    const run = this.o.store.saveView(this.o.getView()).catch((e) => {
      // The view is a convenience: log it; it is written again with the next change.
      this.o.log?.('the view was not saved', e);
    });
    const tracked: Promise<void> = run.finally(() => {
      if (this.viewWriting === tracked) this.viewWriting = null;
      if (this.viewDirty && !this.dirty) this.kickView();
    });
    this.viewWriting = tracked;
  }

  // ------------------------------------------------------------------ model

  private async write(): Promise<void> {
    if (this.stopped) return;
    if (!this.dirty) {
      // Nothing left to write (e.g. undone back to the stored model): say so.
      if (this.shown === 'pending' || this.shown === 'saving') this.send({ state: 'saved', at: this.savedAt });
      if (this.viewDirty) this.kickView();
      return;
    }
    if (this.writing) return; // the running write chains when it ends
    const run = this.doWrite();
    this.writing = run;
    try {
      await run;
    } finally {
      this.writing = null;
    }
    this.afterWrite();
  }

  private afterWrite() {
    if (this.stopped) return;
    if (this.dirty && this.o.getDoc() === this.savedDoc) {
      // Changed and changed back while the write ran.
      this.dirty = false;
      this.send({ state: 'saved', at: this.savedAt });
    }
    if (!this.dirty) {
      this.urgent = false;
      // A write a leaveNow() post overtook ends here; once that post is in, say so.
      if (!this.leaving && (this.shown === 'saving' || this.shown === 'pending')) this.send({ state: 'saved', at: this.savedAt });
      if (this.viewDirty) this.kickView();
      return;
    }
    if (this.timer) return;
    if (this.urgent && !this.failures) {
      this.urgent = false;
      void this.write();
      return;
    }
    this.kick();
  }

  private async doWrite(): Promise<void> {
    // A view that waits goes along with the model (both changed together, e.g. a
    // feature inserted at the rollback bar moves the bar), when no view write runs.
    const view = this.viewDirty && !this.viewWriting;
    const doc = this.o.getDoc();
    const gen = this.gen;
    this.dirty = false;
    if (view) {
      this.viewDirty = false;
      this.clearViewTimer();
      this.viewAt = Date.now();
    }
    this.send({ state: 'saving' });
    try {
      const etag = await this.o.store.saveModel(doc, this.etag);
      this.checkedAt = Date.now();
      // A leaveNow() post overtook this write: its etag and doc stand.
      if (gen === this.gen) {
        this.etag = etag;
        this.savedDoc = doc;
      }
      // The view as it is now (last write wins); a leaveNow() post already wrote it.
      if (view && gen === this.gen) {
        await this.o.store.saveView(this.o.getView()).catch((e) => {
          this.o.log?.('the view was not saved', e);
        });
      }
      this.failures = 0;
      if (gen !== this.gen) return; // the leaveNow() post says Saved when it lands
      this.savedAt = new Date().toISOString();
      if (!this.dirty) this.send({ state: 'saved', at: this.savedAt });
    } catch (e) {
      if (gen !== this.gen) {
        // Overtaken by a leaveNow() post, which carries a newer model.
        this.o.log?.('a save overtaken by the save on leaving failed', e);
        return;
      }
      if (e instanceof DocConflictError) {
        this.stopped = 'conflict';
        if (this.timer) clearTimeout(this.timer);
        this.timer = null;
        this.clearViewTimer();
        this.send({ state: 'conflict', message: 'Changed in another tab' });
        return;
      }
      this.failures++;
      this.dirty = true;
      if (view) this.viewDirty = true;
      this.o.log?.('the model was not saved', e);
      this.send({ state: 'error', message: why(e) });
    }
  }

  /**
   * Write whatever waits, now, outside the budget (the pointer left the frame,
   * the frame lost focus, a panel's Done). Returns at once; the write runs on.
   */
  flushNow(): void {
    if (this.stopped) return;
    if (this.viewDirty && !this.dirty) this.writeView(true);
    if (!this.dirty) return;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.writing) {
      this.urgent = true;
      return;
    }
    void this.write();
  }

  /**
   * The page is going this instant (F5, Ctrl+R / Ctrl+W, the mouse's Back
   * button, hidden): post the model in one message before returning (see the
   * file comment), and the view in another. Falls back to flushNow() when the
   * store has no one-message write (WsFilesStore: its conditional write, during
   * which the host asks before the page goes) or this tab's knowledge of the
   * stored version is old.
   */
  leaveNow(): void {
    if (this.stopped) return;
    if (this.viewDirty) this.writeView(true);
    // Nothing waits, and what is stored is what is shown. (A running write may
    // still be reading: it has not posted the model yet, so post it here.)
    if (!this.dirty && (!this.writing || this.o.getDoc() === this.savedDoc)) return;
    const store = this.o.store;
    if (typeof store.saveModelNow !== 'function' || Date.now() - this.checkedAt > FAST_MAX_AGE_MS) {
      this.flushNow();
      return;
    }
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    const doc = this.o.getDoc();
    const before = { etag: this.etag, doc: this.savedDoc };
    const gen = ++this.gen;
    let posted: { etag: string; done: Promise<string> };
    try {
      posted = store.saveModelNow(doc, this.etag);
    } catch (e) {
      this.o.log?.('the model was not saved', e);
      this.flushNow();
      return;
    }
    this.etag = posted.etag;
    this.savedDoc = doc;
    this.dirty = false;
    this.urgent = false;
    this.leaving = true;
    this.send({ state: 'saving' });
    posted.done.then(
      () => {
        if (gen === this.gen) this.leaving = false;
        if (this.stopped || gen !== this.gen) return;
        this.checkedAt = Date.now();
        this.failures = 0;
        this.savedAt = new Date().toISOString();
        if (!this.dirty && !this.writing) this.send({ state: 'saved', at: this.savedAt });
      },
      (e: unknown) => {
        // The page stayed (nothing went back, say) and the write failed: write it again the usual way.
        if (gen === this.gen) this.leaving = false;
        if (this.stopped || gen !== this.gen) return;
        this.etag = before.etag;
        this.savedDoc = before.doc;
        this.failures++;
        this.dirty = true;
        this.o.log?.('the model was not saved', e);
        this.send({ state: 'error', message: why(e) });
        this.kick();
      },
    );
  }

  /** Try a failed save again now (the chip's Retry), instead of waiting for the retry timer. */
  retryNow(): void {
    if (this.stopped || !this.dirty || this.writing) return;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    void this.write();
  }

  /** Write whatever is pending now, and wait until it is written (two tries at most; then the retry timer goes on). */
  async flush(): Promise<void> {
    let tries = 0;
    for (;;) {
      if (this.writing) {
        await this.writing.catch(() => {});
        await Promise.resolve();
        continue;
      }
      if (this.viewWriting) {
        await this.viewWriting;
        await Promise.resolve();
        continue;
      }
      if (this.stopped || (!this.dirty && !this.viewDirty) || tries >= 2) return;
      if (this.timer) {
        clearTimeout(this.timer);
        this.timer = null;
      }
      tries++;
      if (this.dirty) await this.write();
      else this.writeView();
    }
  }

  dispose(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.clearViewTimer();
    if (!this.stopped) this.stopped = 'disposed';
  }
}
