/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** '1' (dev server only): serve the UI kit dev sheet at #/dev/ui-kit. */
  readonly VITE_MAGNUSIM_DEV_SHEETS?: string;
}

declare module '*workbench/runtime.js';
