/**
 * The day's spend (Foundation spec 6.6): `<home>/assistant/spend.json`.
 *
 *   { "version": 1, "days": { "2026-10-16": { "usd": 0.4213, "requests": 37 } },
 *     "open": { "r-1a2b3c": { "usd": 0.31, "day": "2026-10-16", "at": "…" } } }
 *
 * Each provider request first reserves its estimate, then settles its real cost. Both
 * change the memory at once (so two turns, or a turn and the Settings test, can't both
 * pass the day's cap), and the file is written through one queue: each write takes the
 * whole current state, and writes asked for meanwhile ride on the next one. A reservation
 * is on disk before its request is sent, so after a crash the open ones count as spent.
 * The day is the server's local date from an injected clock; days older than 31 go.
 */
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { readJsonFile, writeFileAtomic } from './files.ts';
import { assistantDataDir } from './home.ts';
import { alog } from './log.ts';
import { assistantState } from './state.ts';

export type Clock = () => Date;

export interface DaySpend { usd: number; requests: number }
export interface OpenReservation { usd: number; day: string; at: string }
export interface SpendDoc { version: 1; days: Record<string, DaySpend>; open: Record<string, OpenReservation> }
export interface Reservation { id: string; usd: number; day: string }

/** Days a record is kept (the spend's days here; the chat history's files, history.ts). */
export const KEEP_DAYS = 31;
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

const round6 = (n: number) => Math.round(n * 1e6) / 1e6;
const money = (n: unknown) => (typeof n === 'number' && Number.isFinite(n) && n >= 0 ? n : 0);

/** The server's local date, YYYY-MM-DD. */
export function todayKey(clock: Clock = () => new Date()): string {
  const d = clock();
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** A YYYY-MM-DD date as a day count, to tell how many days apart two dates are. */
export function dayNumber(day: string): number {
  const [y, m, d] = day.split('-').map(Number);
  return Math.floor(Date.UTC(y, m - 1, d) / 86_400_000);
}

export class SpendLedger {
  readonly file: string;
  private readonly clock: Clock;
  private doc: SpendDoc = { version: 1, days: {}, open: {} };
  private loading: Promise<void> | null = null;
  /** The write that runs or ran last (never rejects). */
  private writing: Promise<void> = Promise.resolve();
  /** A write asked for but not started yet: later asks join it. */
  private pending: Promise<void> | null = null;

  constructor(o: { file: string; clock?: Clock }) {
    this.file = o.file;
    this.clock = o.clock ?? (() => new Date());
  }

  /** Reads the file once. Reservations an earlier process left open count as spent. */
  load(): Promise<void> {
    if (!this.loading) this.loading = this.readFromDisk();
    return this.loading;
  }

  private async readFromDisk(): Promise<void> {
    const r = await readJsonFile(this.file);
    if (r.state === 'bad') alog('warn', 'spend.json could not be read; starting from zero', { error: r.error });
    const raw = r.state === 'ok' && r.value && typeof r.value === 'object' ? (r.value as Partial<SpendDoc>) : {};
    const days: Record<string, DaySpend> = {};
    if (raw.days && typeof raw.days === 'object') {
      for (const [day, v] of Object.entries(raw.days)) {
        if (!DAY_RE.test(day) || !v || typeof v !== 'object') continue;
        days[day] = { usd: round6(money(v.usd)), requests: Math.max(0, Math.floor(money(v.requests))) };
      }
    }
    let recovered = 0;
    if (raw.open && typeof raw.open === 'object') {
      for (const v of Object.values(raw.open)) {
        if (!v || typeof v !== 'object' || !DAY_RE.test(String(v.day))) continue;
        const d = (days[v.day] ??= { usd: 0, requests: 0 });
        d.usd = round6(d.usd + money(v.usd));
        d.requests += 1;
        recovered += 1;
      }
    }
    // reserve() and settle() wait for this load, so nothing is open yet.
    this.doc = { version: 1, days, open: {} };
    if (recovered) {
      alog('warn', 'requests from an earlier run never settled; counted as spent', { requests: recovered });
      await this.flush();
    }
  }

  today(): string {
    return todayKey(this.clock);
  }

  /** Settled spend today, in USD. */
  spentToday(): number {
    return this.doc.days[this.today()]?.usd ?? 0;
  }

  /** Open reservations made today, in USD. */
  reservedToday(): number {
    const day = this.today();
    let sum = 0;
    for (const v of Object.values(this.doc.open)) if (v.day === day) sum += v.usd;
    return round6(sum);
  }

  openCount(): number {
    return Object.keys(this.doc.open).length;
  }

  /**
   * Reserves `usd` for one request, or null when today's spend, today's open
   * reservations and this one would pass `dayCapUsd`. Checked and set at once, so of two
   * callers only one can take the last of the day's room. Resolves once it is on disk
   * (a failed write is logged, and the reservation still holds in memory).
   */
  async reserve(usd: number, o: { dayCapUsd?: number } = {}): Promise<Reservation | null> {
    await this.load();
    // From here to the reservation nothing awaits: the check and the set are one step.
    const amount = round6(money(usd));
    const day = this.today();
    if (o.dayCapUsd != null && this.spentToday() + this.reservedToday() + amount > o.dayCapUsd + 1e-9) return null;
    const id = `r-${randomBytes(6).toString('hex')}`;
    this.doc.open[id] = { usd: amount, day, at: this.clock().toISOString() };
    await this.flush();
    return { id, usd: amount, day };
  }

  /** The request cost `usd` (its reservation's day keeps it). A second settle of one id does nothing. */
  async settle(res: Reservation | string, usd: number): Promise<void> {
    await this.load();
    const id = typeof res === 'string' ? res : res.id;
    const open = this.doc.open[id];
    if (!open) return;
    delete this.doc.open[id];
    const d = (this.doc.days[open.day] ??= { usd: 0, requests: 0 });
    d.usd = round6(d.usd + money(usd));
    d.requests += 1;
    await this.flush();
  }

  /** A copy of the whole state, as the next write puts it on disk. */
  snapshot(): SpendDoc {
    this.trim();
    return structuredClone(this.doc);
  }

  private trim(): void {
    const today = dayNumber(this.today());
    for (const day of Object.keys(this.doc.days)) {
      if (today - dayNumber(day) > KEEP_DAYS) delete this.doc.days[day];
    }
  }

  /** Writes the current state after the write before it; asks made meanwhile share one write. */
  flush(): Promise<void> {
    if (this.pending) return this.pending;
    const next = this.writing.then(async () => {
      this.pending = null;
      try {
        await writeFileAtomic(this.file, `${JSON.stringify(this.snapshot(), null, 2)}\n`, { mode: 0o600 });
      } catch (err) {
        alog('error', 'spend.json could not be written', { error: err instanceof Error ? err.message : String(err) });
      }
    });
    this.pending = next;
    this.writing = next;
    return next;
  }
}

/** This server's ledger (spend.json in the Assistant's folder), loaded. */
export async function spendLedger(): Promise<SpendLedger> {
  const st = assistantState();
  if (!st.ledger) st.ledger = new SpendLedger({ file: join(assistantDataDir(), 'spend.json') });
  const ledger = st.ledger;
  await ledger.load();
  return ledger;
}
