import { create } from 'zustand';

export type PanelKey = string | null;
export type FiltersMode = 'mesh' | 'results';

export interface UiState {
  openPanel: PanelKey;
  selection: { faces: string[]; treeItem: string | null };
  filtersMode: FiltersMode;
  filtersVisible: boolean;
  setOpenPanel: (key: PanelKey) => void;
  setSelection: (sel: UiState['selection']) => void;
  setFiltersMode: (mode: FiltersMode) => void;
  setFiltersVisible: (on: boolean) => void;
}

export const useUiStore = create<UiState>((set) => ({
  openPanel: null,
  selection: { faces: [], treeItem: null },
  filtersMode: 'results',
  filtersVisible: false,
  setOpenPanel: (openPanel) => set({ openPanel }),
  setSelection: (selection) => set({ selection }),
  setFiltersMode: (filtersMode) => set({ filtersMode }),
  setFiltersVisible: (filtersVisible) => set({ filtersVisible }),
}));
