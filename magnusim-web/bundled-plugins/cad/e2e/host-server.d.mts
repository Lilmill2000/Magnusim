// Types of host-server.mjs for the TypeScript e2e files.
// SPDX-License-Identifier: GPL-3.0-or-later
export interface HostServer {
  base: string;
  port: number;
  pid: number;
  reused: boolean;
  projects: string | null;
  /** The server's local prefs JSON (MAGNUSIM_LOCAL_JSON): plugins.enabled / plugins.disabled live there. */
  prefs: string | null;
  stop(): void;
  /** The end of the server's output (empty for a reused server). */
  tail(): string;
}
export const PLUGIN_DIR: string;
export const WEB_ROOT: string;
export const KEEP_FREE: number[];
export function readLiveLock(lock: string | null): Promise<{ base: string; port: number; pid: number; server_pid: number; projects?: string; prefs?: string } | null>;
export function killTree(pid: number): void;
export function startHostServer(opts?: { port?: number; lock?: string | null; pluginsDir?: string | null; log?: (m: string) => void }): Promise<HostServer>;
