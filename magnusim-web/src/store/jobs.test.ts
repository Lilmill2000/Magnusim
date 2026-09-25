import { renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { formatElapsed, useElapsed, useJobsStore } from './jobs';

type Listener = (ev: MessageEvent) => void;

const listeners: Record<string, Listener> = {};

vi.mock('../api/client', () => ({
  subscribeJobEvents: (_jobId: string, onEvent: Listener) => {
    listeners.current = onEvent;
    return () => {
      delete listeners.current;
    };
  },
}));

vi.mock('./project', () => ({
  useProjectStore: { getState: () => ({ projectId: 'p1' }) },
}));

function push(type: string, payload: Record<string, unknown>) {
  listeners.current?.({ type, data: JSON.stringify(payload) } as MessageEvent);
}

describe('jobs store timestamps', () => {
  beforeEach(() => {
    useJobsStore.getState().clear();
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-22T10:00:00Z'));
  });
  afterEach(() => vi.useRealTimers());

  it('stamps startedAt on the first running event and finishedAt on the result', () => {
    useJobsStore.getState().watch('job-1');
    push('event', { event: 'start', job_id: 'job-1', kind: 'mesh' });
    const started = useJobsStore.getState().jobs['job-1'];
    expect(started.startedAt).toBe(Date.parse('2026-09-22T10:00:00Z'));
    expect(started.finishedAt).toBeUndefined();

    vi.setSystemTime(new Date('2026-09-22T10:00:23Z'));
    push('result', { event: 'result', status: 'done', result: { n_cells: 677353 } });
    const done = useJobsStore.getState().jobs['job-1'];
    expect(done.status).toBe('done');
    expect(done.finishedAt).toBe(Date.parse('2026-09-22T10:00:23Z'));
    expect(done.startedAt).toBe(Date.parse('2026-09-22T10:00:00Z'));
    expect(done.result).toEqual({ n_cells: 677353 });
  });

  it('keeps the failure message', () => {
    useJobsStore.getState().watch('job-2');
    push('event', { event: 'start', job_id: 'job-2' });
    push('error', { event: 'error', status: 'failed', error: 'exit 1' });
    const job = useJobsStore.getState().jobs['job-2'];
    expect(job.status).toBe('failed');
    expect(job.error).toBe('exit 1');
    expect(job.finishedAt).toBeDefined();
  });
});

describe('formatElapsed', () => {
  it('reads as m:ss', () => {
    expect(formatElapsed(23_000)).toBe('0:23');
    expect(formatElapsed(83_000)).toBe('1:23');
    expect(formatElapsed(-5)).toBe('0:00');
  });
});

describe('useElapsed', () => {
  it('freezes on the finished value', () => {
    const start = Date.parse('2026-09-22T10:00:00Z');
    const { result } = renderHook(() => useElapsed(start, start + 23_000));
    expect(result.current).toBe('0:23');
  });

  it('is zero before the job starts', () => {
    const { result } = renderHook(() => useElapsed(undefined, undefined));
    expect(result.current).toBe('0:00');
  });
});
