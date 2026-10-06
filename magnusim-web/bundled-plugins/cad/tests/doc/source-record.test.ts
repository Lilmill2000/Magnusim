// @vitest-environment node
// LINK: the save counter into the study record (doc/source-record.ts), on fake timers,
// so the throttle is exact whatever the machine's load (Linux CI: on the real clock the
// first write of a burst came after all its saves): not while nothing is linked; the
// first write at once when the interval since the last one has passed; then at most
// one per SOURCE_RECORD_INTERVAL_MS, with the newest counter; never down.
// Owner: DOC-CORE.
// SPDX-License-Identifier: GPL-3.0-or-later
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SOURCE_RECORD_INTERVAL_MS, SourceRecord } from '../../src/doc/source-record';

afterEach(() => {
  vi.useRealTimers();
});

/** A study record with a rev, as the host keeps it; every source_version write is logged. */
function fakeStudy(start: number | undefined = undefined) {
  let rec: { rev: number; source_version?: number } = { rev: 1, ...(start === undefined ? {} : { source_version: start }) };
  const writes: number[] = [];
  const study = {
    async get() {
      return { ...rec };
    },
    async update(patch: Record<string, unknown>, rev: number) {
      writes.push(Number(patch.source_version));
      if (rev !== rec.rev) throw new Error('This study was changed elsewhere (stale rev)');
      rec = { ...rec, ...patch, rev: rec.rev + 1 };
      return { ...rec };
    },
  };
  return { study, writes, record: () => rec };
}

/** Let the record's write (linked, get, update: a few awaits) run, with no time passing. */
async function settle() {
  for (let i = 0; i < 50; i++) await Promise.resolve();
}

describe('SourceRecord: the save counter in the study record', () => {
  it('nothing while nothing is linked; the first write at once; then the newest, once, after the interval', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const { study, writes, record } = fakeStudy();
    let linked = false;
    const r = new SourceRecord({ study: study as never, linked: async () => linked });
    // Not linked: nothing written (it still counts as the last write for the interval).
    r.saved(1);
    await settle();
    expect(writes).toEqual([]);
    linked = true;
    await vi.advanceTimersByTimeAsync(SOURCE_RECORD_INTERVAL_MS);
    // The interval since the last write has passed: the next save's counter is written at once.
    r.saved(2);
    await settle();
    expect(writes).toEqual([2]);
    expect(record().source_version).toBe(2);
    // A burst of saves: nothing more before the interval is over, then only the newest.
    for (const v of [3, 4, 5, 6]) r.saved(v);
    await settle();
    await vi.advanceTimersByTimeAsync(SOURCE_RECORD_INTERVAL_MS - 1);
    await settle();
    expect(writes).toEqual([2]);
    await vi.advanceTimersByTimeAsync(1);
    await settle();
    expect(writes).toEqual([2, 6]);
    expect(record().source_version).toBe(6);
    expect(r.recorded).toBe(6);
    // Settled: nothing waits.
    await vi.advanceTimersByTimeAsync(SOURCE_RECORD_INTERVAL_MS * 2);
    expect(writes).toEqual([2, 6]);
    r.dispose();
  });

  it('a save while a write is still on its way waits for it and the interval, then writes the newest', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const { study, writes } = fakeStudy();
    const r = new SourceRecord({ study: study as never });
    r.saved(2);
    r.saved(3);
    await settle();
    expect(writes).toEqual([2]);
    await vi.advanceTimersByTimeAsync(SOURCE_RECORD_INTERVAL_MS);
    await settle();
    expect(writes).toEqual([2, 3]);
    r.dispose();
  });

  it('never down: a record that holds this counter or a newer one (another tab) is left alone', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const { study, writes, record } = fakeStudy(40);
    const r = new SourceRecord({ study: study as never });
    r.saved(7);
    await settle();
    expect(writes).toEqual([]);
    expect(record().source_version).toBe(40);
    expect(r.recorded).toBe(7);
    r.dispose();
  });
});
