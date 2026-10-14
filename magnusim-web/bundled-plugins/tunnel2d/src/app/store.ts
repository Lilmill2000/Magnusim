// The page's state: the scene (with undo and redo), the selection and the save status.
// SPDX-License-Identifier: GPL-3.0-or-later
import { useSyncExternalStore } from 'react';
import type { Body, Scene } from '../scene/scene';

export type SaveState = 'saved' | 'pending' | 'saving' | 'failed' | 'conflict';

export interface State {
  scene: Scene;
  selected: string | null;
  save: SaveState;
  saveError: string;
}

const HISTORY = 100;

export class Store {
  private state: State;
  private listeners = new Set<() => void>();
  private past: Scene[] = [];
  private future: Scene[] = [];
  /** Called with every scene change that should reach the file. */
  onSceneChange: ((s: Scene) => void) | null = null;

  constructor(scene: Scene) {
    this.state = { scene, selected: null, save: 'saved', saveError: '' };
  }

  get = () => this.state;

  subscribe = (fn: () => void) => {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  };

  private set(patch: Partial<State>) {
    this.state = { ...this.state, ...patch };
    for (const fn of this.listeners) fn();
  }

  /** A new scene; `undoable` puts the old one on the undo stack. */
  commit(scene: Scene, undoable = true) {
    if (undoable) {
      this.past.push(this.state.scene);
      if (this.past.length > HISTORY) this.past.shift();
      this.future = [];
    }
    // The selection survives a change while its body or rake is still there.
    const sel = this.state.selected;
    const selected = sel && (scene.bodies.some((b) => b.id === sel) || scene.rakes.some((r) => r.id === sel) || scene.probes.some((p) => p.id === sel)) ? sel : null;
    this.set({ scene, selected });
    this.onSceneChange?.(scene);
  }

  /** End of a live drag: `next` is the scene, `before` the one Undo goes back to. */
  commitFrom(before: Scene, next: Scene) {
    this.past.push(before);
    if (this.past.length > HISTORY) this.past.shift();
    this.future = [];
    this.commit(next, false);
  }

  updateBody(id: string, patch: Partial<Body>, undoable = true) {
    const s = this.state.scene;
    this.commit({ ...s, bodies: s.bodies.map((b) => (b.id === id ? { ...b, ...patch } : b)) }, undoable);
  }

  get canUndo() {
    return this.past.length > 0;
  }
  get canRedo() {
    return this.future.length > 0;
  }

  undo() {
    const prev = this.past.pop();
    if (!prev) return false;
    this.future.push(this.state.scene);
    this.commit(prev, false);
    return true;
  }

  redo() {
    const next = this.future.pop();
    if (!next) return false;
    this.past.push(this.state.scene);
    this.commit(next, false);
    return true;
  }

  select(id: string | null) {
    this.set({ selected: id });
  }

  setSave(save: SaveState, saveError = '') {
    this.set({ save, saveError });
  }
}

export function useStore<T>(store: Store, pick: (s: State) => T): T {
  return useSyncExternalStore(store.subscribe, () => pick(store.get()));
}
