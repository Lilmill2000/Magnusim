// The scene file: studies/<id>/scene.json in the plugin's folder of the project
// (ws.files). Saved shortly after each change; a write names the version it replaces
// (etag), so a save from another tab is never overwritten. While a change is not saved
// yet, leaving the workspace asks first (nav.setDirty).
// SPDX-License-Identifier: GPL-3.0-or-later
import type { Workspace } from '@magnusim/workspace';
import { defaultScene, parseScene, type Scene } from '../scene/scene';
import type { Store } from './store';

const DEBOUNCE_MS = 400;

export const scenePath = (studyId: string) => `studies/${studyId}/scene.json`;

export interface Loaded {
  scene: Scene;
  etag: string | null;
  /** Why the saved file could not be used (a new scene was made in its place), or ''. */
  problem: string;
  /**
   * Where the file that could not be used was kept before anything is saved over it; null
   * when it could not be copied, and then nothing is saved (so it is never lost).
   */
  kept?: string | null;
}

/** The name the unreadable scene is kept under: scene-unreadable-2026-11-12-0930-05.json. */
export function keptPath(studyId: string, now = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `studies/${studyId}/scene-unreadable-${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}-${p(now.getHours())}${p(now.getMinutes())}-${p(now.getSeconds())}.json`;
}

export async function loadScene(ws: Workspace, studyId: string): Promise<Loaded> {
  const path = scenePath(studyId);
  const info = await ws.files.stat(path);
  if (!info) return { scene: defaultScene(), etag: null, problem: '' };
  const buf = await ws.files.read(path);
  if (!buf) return { scene: defaultScene(), etag: null, problem: '' };
  try {
    return { scene: parseScene(JSON.parse(new TextDecoder().decode(buf))), etag: info.etag, problem: '' };
  } catch (err) {
    const problem = err instanceof Error ? err.message : String(err);
    // A new scene takes its place, and its first save replaces the file: keep the file first
    // (a tunnel saved by a newer plugin, one body that does not read), so nothing is lost.
    const kept = keptPath(studyId);
    try {
      await ws.files.write(kept, buf, { ifMatch: null });
      return { scene: defaultScene(), etag: info.etag, problem, kept };
    } catch {
      return { scene: defaultScene(), etag: info.etag, problem, kept: null };
    }
  }
}

export class Saver {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private latest: Scene | null = null;
  private writing: Promise<void> | null = null;

  constructor(
    private ws: Workspace,
    private store: Store,
    private studyId: string,
    private etag: string | null,
  ) {}

  /** A changed scene: saved after a short pause (changes in between are saved together). */
  schedule(scene: Scene) {
    if (this.store.get().save === 'conflict') return;
    this.latest = scene;
    this.store.setSave('pending');
    void this.ws.nav.setDirty(true, 'The tunnel’s last changes are not saved yet.');
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.flush(), DEBOUNCE_MS);
  }

  async flush(): Promise<void> {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (this.writing) await this.writing;
    const scene = this.latest;
    if (!scene) return;
    this.latest = null;
    this.store.setSave('saving');
    this.writing = (async () => {
      try {
        const res = await this.ws.files.write(scenePath(this.studyId), JSON.stringify(scene, null, 1), { ifMatch: this.etag });
        this.etag = res.etag;
        if (!this.latest) {
          this.store.setSave('saved');
          await this.ws.nav.setDirty(false);
        }
      } catch (err) {
        const code = (err as { code?: string })?.code;
        if (code === 'changed') {
          this.store.setSave('conflict', 'This tunnel was saved from another tab. Reopen it to see that version; changes here are not saved.');
          await this.ws.nav.setDirty(false);
        } else {
          this.latest = this.latest ?? scene;
          this.store.setSave('failed', err instanceof Error ? err.message : String(err));
        }
      } finally {
        this.writing = null;
      }
    })();
    await this.writing;
  }

  /** Write the first version of a new tunnel's file. */
  async create(scene: Scene) {
    this.latest = scene;
    await this.flush();
  }
}
