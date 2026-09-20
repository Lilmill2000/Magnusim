import { create } from 'zustand';
import { subscribeJobEvents } from '../api/client';

export interface JobMirror {
  id: string;
  status: string;
  kind?: string;
  progress?: number;
  note?: string;
  residual?: unknown;
  events: Array<Record<string, unknown>>;
}

export interface JobsState {
  jobs: Record<string, JobMirror>;
  unsub: Record<string, () => void>;
  watch: (jobId: string) => void;
  unwatch: (jobId: string) => void;
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
  watch(jobId) {
    if (get().unsub[jobId]) return;
    const stop = subscribeJobEvents(jobId, (ev) => {
      let payload: Record<string, unknown> = {};
      try {
        payload = JSON.parse(String(ev.data || '{}')) as Record<string, unknown>;
      } catch {
        payload = { raw: ev.data };
      }
      const status = String(payload.status || payload.event || ev.type || 'running');
      get().upsert({
        id: jobId,
        status,
        kind: payload.kind as string | undefined,
        progress: typeof payload.progress === 'number' ? payload.progress : undefined,
        note: payload.note as string | undefined,
        residual: payload.residual,
        events: [...(get().jobs[jobId]?.events || []), payload].slice(-400),
      });
      if (ev.type === 'end') get().unwatch(jobId);
    });
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
