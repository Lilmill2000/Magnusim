// Files in and out of the Part (docs/p2p3-plan.md §3.7): picking a STEP (a hidden
// <input type=file>, or a drop on the frame), storing it and the healed BREP with
// ws.files (host API 1.2: streamed in 16 MB chunks, etag-checked), and giving a
// file to the user (a blob URL on an <a download>: the H13 frame is
// sandbox="allow-scripts allow-downloads", WorkspaceOverlay.tsx:478).
// Implementation: src/files/ (P2-FEATURES). Feature builds read through
// BuildContext.files (src/types/doc-service.ts).
// SPDX-License-Identifier: GPL-3.0-or-later
import type { StoredFileRef } from './doc';

/** The plugin's per-file cap (manifest [files] max_file_mb = 512): above it the picker says so before uploading. */
export const MAX_FILE_BYTES = 512 * 1024 * 1024;

/** Where a Part keeps an import (beside study.json: deleting the Part deletes it). */
export function importFolder(studyId: string, sha256: string): string {
  return `studies/${studyId}/imports/${sha256}`;
}

/** Progress of a long transfer or kernel stage, for the import panel. */
export interface TransferProgress {
  stage: 'hashing' | 'uploading' | 'reading' | 'healing' | 'writing' | 'storing' | 'loading';
  /** Bytes done and total for byte stages; absent for kernel stages (then the panel shows elapsed time). */
  done?: number;
  total?: number;
  /** ms since the stage started. */
  elapsedMs: number;
}

export interface FileTransfer {
  /**
   * Open the browser's file picker (a hidden <input type=file accept=".step,.stp">).
   * Resolves with the file, or null when the user cancels.
   */
  pick(accept: string[]): Promise<File | null>;
  /**
   * Listen for files dropped on the frame (dragover shows the drop hint).
   * Returns stop listening.
   */
  onDrop(accept: string[], fn: (file: File) => void): () => void;
  /**
   * Store bytes with ws.files: content-addressed (sha256), create-only (an
   * existing identical file is reused, never rewritten). Rejects with a plain
   * reason (too_large, quota, disk_full, plugin_off, ...: "Not stored: the
   * project's CAD files are at their 4096 MB limit"). `signal` cancels.
   */
  store(rel: string, data: Blob | ArrayBuffer, opts?: { onProgress?: (p: TransferProgress) => void; signal?: AbortSignal; sha256?: string }): Promise<StoredFileRef>;
  /** Read a stored file (null when it is gone). Checks the sha256 when given. */
  read(ref: StoredFileRef | string, opts?: { onProgress?: (p: TransferProgress) => void; signal?: AbortSignal }): Promise<ArrayBuffer | null>;
  /** Hex SHA-256 (crypto.subtle). */
  sha256(data: Blob | ArrayBuffer): Promise<string>;
  /** Hand bytes to the user as a download named `fileName` (blob URL on a temporary <a download>, revoked after the click). */
  download(data: Blob | ArrayBuffer, fileName: string, mime?: string): void;
}
