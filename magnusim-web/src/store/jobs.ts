import { useEffect, useState } from 'react';
import { create } from 'zustand';
import { subscribeJobEvents } from '../api/client';
import { useProjectStore } from './project';

export interface JobMirror {
  id: string;
  status: string;
  kind?: string;
  progress?: number;
  note?: string;
  residual?: unknown;
  /** Epoch ms from the first event that reported the job running. */
  startedAt?: number;
  finishedAt?: number;
  result?: unknown;
  error?: string;
  events: Array<Record<string, unknown>>;
}

const TERMINAL = new Set(['done', 'failed', 'stopped']);

export interface JobsState {
  jobs: Record<string, JobMirror>;
  unsub: Record<string, () => void>;
  watch: (jobId: string, projectId?: string) => void;
  unwatch: (jobId: string) => void;
  clear: () => void;
  upsert: (job: Partial<JobMirror> & { id: string }) => void;
}

export const useJobsStore = create<JobsState>((set, get) => ({
  jobs: {},
  unsub: {},
  upsert(job) {
    set((s) => {
      const prev = s.jobs[job.id] || { id: job.id, status: 'queued', events: [] };
      const next = { ...prev, ...job, events: job.events || prev.events };
      const jobs = { ...s.jobs, [job.id]: next };
      window.__cfdJobs = jobs;
      return { jobs };
    });
  },
  clear() {
    for (const fn of Object.values(get().unsub)) fn();
    delete window.__cfdJobs;
    set({ jobs: {}, unsub: {} });
  },
  watch(jobId, projectId) {
    if (get().unsub[jobId]) return;
    const pid = projectId || useProjectStore.getState().projectId || '';
    const stop = subscribeJobEvents(jobId, (ev) => {
      let payload: Record<string, unknown> = {};
      try {
        payload = JSON.parse(String(ev.data || '{}')) as Record<string, unknown>;
      } catch {
        payload = { raw: ev.data };
      }
      const status = String(payload.status || payload.event || ev.type || 'running');
      const name = String(payload.event || ev.type || '');
      const prev = get().jobs[jobId];
      const terminal = TERMINAL.has(status) || name === 'result' || name === 'error';
      const startedAt = prev?.startedAt ?? (terminal ? undefined : Date.now());
      get().upsert({
        id: jobId,
        status,
        kind: payload.kind as string | undefined,
        progress: typeof payload.progress === 'number' ? payload.progress : undefined,
        note: payload.note as string | undefined,
        residual: payload.residual,
        startedAt,
        finishedAt: terminal ? (prev?.finishedAt ?? Date.now()) : prev?.finishedAt,
        result: payload.result === undefined ? prev?.result : payload.result,
        error: typeof payload.error === 'string' ? payload.error : prev?.error,
        events: [...(prev?.events || []), payload].slice(-400),
      });
      if (ev.type === 'end') get().unwatch(jobId);
    }, pid);
    set((s) => ({ unsub: { ...s.unsub, [jobId]: stop } }));
  },
  unwatch(jobId) {
    const fn = get().unsub[jobId];
    if (fn) fn();
    set((s) => {
      const unsub = { ...s.unsub };
      delete unsub[jobId];
      return { unsub };
    });
  },
}));

export function useJob(jobId: string | undefined): JobMirror | undefined {
  return useJobsStore((s) => (jobId ? s.jobs[jobId] : undefined));
}

export function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

/** Ticks every second while the job runs, then freezes on the finished value. */
export function useElapsed(startedAt?: number, finishedAt?: number): string {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!startedAt || finishedAt) return;
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [startedAt, finishedAt]);
  if (!startedAt) return '0:00';
  return formatElapsed((finishedAt ?? now) - startedAt);
}
