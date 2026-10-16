import { useEffect, useState } from 'react';

/**
 * Sample projects (manifest `[[samples]]`, API 1.8): projects a plugin ships, which Home
 * offers while the plugin is on. Opening one copies it into the projects folder as a new
 * project (`POST /api/project/sample`) and opens it.
 */

/** One sample and the plugin that ships it. */
export interface SampleEntry {
  plugin: string;
  plugin_name: string;
  key: string;
  title: string;
  hint: string;
}

/** A row of `/api/plugins`, as far as samples go. */
export interface CatalogSampleRow {
  key: string;
  name?: string;
  status?: string;
  samples?: { key: string; title: string; hint?: string }[];
}

/** The samples of the plugins that are on, in plugin load order, then manifest order. */
export function samplesFromCatalog(rows: readonly CatalogSampleRow[] | null | undefined): SampleEntry[] {
  const out: SampleEntry[] = [];
  for (const row of rows || []) {
    if (row.status !== 'enabled') continue;
    for (const s of row.samples || []) {
      if (s && s.key && s.title) {
        out.push({ plugin: row.key, plugin_name: String(row.name || row.key), key: s.key, title: s.title, hint: String(s.hint || '') });
      }
    }
  }
  return out;
}

/** `<plugin>:<sample>`. */
export function sampleKey(entry: { plugin: string; key: string }): string {
  return `${entry.plugin}:${entry.key}`;
}

let samples: SampleEntry[] = [];
const listeners = new Set<(list: SampleEntry[]) => void>();
let listening = false;
let serial = 0;

async function readSamples(): Promise<void> {
  const mine = ++serial;
  const r = await fetch('/api/plugins', { cache: 'no-store' });
  const j = (await r.json().catch(() => ({}))) as { plugins?: CatalogSampleRow[] };
  if (!r.ok || mine !== serial) return;
  samples = samplesFromCatalog(j.plugins);
  for (const fn of [...listeners]) fn(samples);
}

function listen(): void {
  if (listening || typeof window === 'undefined') return;
  listening = true;
  // A plugin turned on or off in Settings: its samples come and go at once.
  window.addEventListener('cfd:tree-sync', (e) => {
    const detail = (e as CustomEvent<{ plugins?: boolean } | null>).detail;
    if (detail && detail.plugins) void readSamples().catch(() => undefined);
  });
}

/** React: the samples of the plugins that are on (read on first use and after every plugin change). */
export function useSamples(): SampleEntry[] {
  const [list, setList] = useState<SampleEntry[]>(() => samples);
  useEffect(() => {
    listen();
    listeners.add(setList);
    void readSamples().catch(() => undefined);
    return () => {
      listeners.delete(setList);
    };
  }, []);
  return list;
}

/** Copy a sample into the projects folder as a new project: its id (an Error with the server's reason). */
export async function createFromSample(entry: SampleEntry, folder?: string): Promise<string> {
  const r = await fetch('/api/project/sample', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify({ plugin: entry.plugin, sample: entry.key, ...(folder ? { folder } : {}) }),
  });
  const j = (await r.json().catch(() => ({}))) as { id?: string; error?: string };
  if (!r.ok || !j.id) throw new Error(j.error || `Could not open the sample (${r.status})`);
  return j.id;
}
