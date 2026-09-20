export type LayerId =
  | 'cad'
  | 'cad_edges'
  | 'mesh_surface'
  | 'surface_field'
  | 'streamlines'
  | 'iso'
  | 'iso_volume'
  | 'inspect_marker'
  | 'bc_glyphs'
  | `cut_plane:${string}`;

export interface LayerStyle {
  color?: [number, number, number];
  opacity?: number;
  representation?: 'surface' | 'wireframe' | 'points';
}

export interface LayerApi {
  setVisible(id: LayerId, on: boolean): void;
  keepCadWhenResultsAttach(on: boolean): void;
}

export function createLayerApi(getActor: (id: LayerId) => { setVisibility?: (v: boolean) => void } | null): LayerApi {
  let keepCad = true;
  return {
    keepCadWhenResultsAttach(on) {
      keepCad = on;
    },
    setVisible(id, on) {
      if (id === 'cad' && !on && keepCad) return;
      try {
        getActor(id)?.setVisibility?.(on);
      } catch {
        /* ignore */
      }
    },
  };
}
