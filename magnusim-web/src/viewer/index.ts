import { applyMeshDisplayScale, applyRelativeCamera, captureRelativeCamera } from './camera';
import { createRainbowLut, setLutRange } from './lut';
import { createLayerApi, type LayerId } from './layers';

export interface ViewerApi {
  render: () => void;
  resize: () => void;
  captureRelativeCamera: typeof captureRelativeCamera;
  applyRelativeCamera: typeof applyRelativeCamera;
  applyMeshDisplayScale: typeof applyMeshDisplayScale;
  createRainbowLut: typeof createRainbowLut;
  setLutRange: typeof setLutRange;
  setLayerVisible: (id: LayerId, on: boolean) => void;
  keepCadWhenResultsAttach: (on: boolean) => void;
}

export function bindLegacyViewer(): ViewerApi {
  const view = window.__CFD_VIEW__;
  const layers = createLayerApi(() => null);
  const api: ViewerApi = {
    render() {
      try {
        view?.renderWindow?.render();
      } catch {
        /* ignore */
      }
    },
    resize() {
      try {
        window.__CFD_RESIZE_VIEWER__?.();
      } catch {
        /* ignore */
      }
    },
    captureRelativeCamera,
    applyRelativeCamera,
    applyMeshDisplayScale,
    createRainbowLut,
    setLutRange,
    setLayerVisible: layers.setVisible,
    keepCadWhenResultsAttach: layers.keepCadWhenResultsAttach,
  };
  window.__cfdViewer = api;
  return api;
}

export function createViewer(): ViewerApi {
  return bindLegacyViewer();
}

export { applyMeshDisplayScale, applyRelativeCamera, captureRelativeCamera } from './camera';
