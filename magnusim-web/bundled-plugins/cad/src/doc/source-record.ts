// LINK (host API 1.5): the study record's reserved key `source_version`. After
// each save of the model the design's save counter goes into the study record,
// so the host can say "Not up to date with <Part>." on the linked geometry's row
// while the saved design is newer than the one the geometry was made from.
// - At most one record write per SOURCE_RECORD_INTERVAL_MS (1.5 s): the first at
//   once, then the newest counter when the interval has passed (the record is
//   the host's, on its plugin lane; a burst of saves is one write).
// - Never down: a record that already holds this counter or a newer one (another
//   tab's) is left alone.
// - A refused write (the record's rev moved under it) reads the record again and
//   tries once more; then it waits for the next save.
// - Only while the study links a geometry (`linked()`): the key only tells the
//   geometry's row whether it is up to date, and every write moves the record's
//   rev, which refuses a rename the app's header started on the old rev (seen in
//   e2e: a Part's first save, then its header rename at once, "Rename failed").
// Owner: DOC-CORE.
// SPDX-License-Identifier: GPL-3.0-or-later
import type { Bridge } from '../lib/bridge';

export const SOURCE_RECORD_INTERVAL_MS = 1500;

export interface SourceRecordOptions {
  study: Bridge['study'];
  /** Whether the study links a geometry now (host API 1.5); absent = always write. */
  linked?(): Promise<boolean>;
  intervalMs?: number;
  log?(message: string, detail?: unknown): void;
}

export class SourceRecord {
  /** The newest counter a save gave. */
  private want = 0;
  /** The newest counter the record is known to hold. */
  private written = 0;
  private lastAt = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private writing: Promise<void> | null = null;
  private disposed = false;
  private readonly interval: number;

  constructor(private readonly o: SourceRecordOptions) {
    this.interval = o.intervalMs ?? SOURCE_RECORD_INTERVAL_MS;
  }

  /** A save landed with this counter. */
  saved(version: number): void {
    if (this.disposed || !(version > this.want)) return;
    this.want = version;
    this.kick();
  }

  /** The newest counter written into the record (tests). */
  get recorded(): number {
    return this.written;
  }

  /** Resolves when the record holds the newest counter (or the write gave up). */
  async settled(): Promise<void> {
    for (let i = 0; i < 20 && !this.disposed; i++) {
      if (this.writing) {
        await this.writing;
        continue;
      }
      if (this.timer || this.want > this.written) {
        await new Promise((r) => setTimeout(r, Math.max(50, this.lastAt + this.interval - Date.now())));
        continue;
      }
      return;
    }
  }

  dispose(): void {
    this.disposed = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  private kick() {
    if (this.disposed || this.writing || this.timer || this.want <= this.written) return;
    const wait = this.lastAt + this.interval - Date.now();
    if (wait > 0) {
      this.timer = setTimeout(() => {
        this.timer = null;
        this.kick();
      }, wait);
      return;
    }
    const run = this.write();
    this.writing = run;
    void run.finally(() => {
      if (this.writing === run) this.writing = null;
      this.kick();
    });
  }

  private async write(): Promise<void> {
    const v = this.want;
    this.lastAt = Date.now();
    try {
      if (this.o.linked && !(await this.o.linked())) {
        // Nothing links yet: no row to keep up to date. The next save after a link writes it.
        this.written = Math.max(this.written, v);
        return;
      }
    } catch (e) {
      this.o.log?.('could not tell whether the study links a geometry', e);
      this.written = Math.max(this.written, v);
      return;
    }
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const rec = await this.o.study.get();
        const cur = Number(rec.source_version) || 0;
        if (cur >= v) {
          this.written = Math.max(this.written, v);
          return;
        }
        await this.o.study.update({ source_version: v }, rec.rev);
        this.written = Math.max(this.written, v);
        return;
      } catch (e) {
        if (attempt === 1) {
          // Given up until the next save: the record only says whether the
          // geometry is up to date, and the next save writes it again.
          this.o.log?.('the design version was not written into the study record', e);
          this.written = Math.max(this.written, v);
        }
      }
    }
  }
}
