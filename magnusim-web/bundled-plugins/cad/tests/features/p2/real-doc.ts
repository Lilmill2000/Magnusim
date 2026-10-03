// A document service on the REAL kernel (hybrid: API 3 stand-ins until the
// kernel has the ops), a fake host with ws.files (API 1.2), and the P2 feature
// types registered, for P2 tests that check real geometry.
// SPDX-License-Identifier: GPL-3.0-or-later
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect, vi } from 'vitest';
import { createDocService } from '../../../src/doc';
import { createBridge } from '../../../src/lib/bridge';
import { createBus } from '../../../src/lib/bus';
import { createStateStore } from '../../../src/lib/store';
import type { AppServices } from '../../../src/types/app';
import type { CadEvents } from '../../../src/types/events';
import type { DocService } from '../../../src/types/doc-service';
import { createFileTransfer } from '../../../src/files/transfer';
import { importDef } from '../../../src/features/import/feature';
import { deleteFacesDef } from '../../../src/features/delete_faces/feature';
import { pressPullDef } from '../../../src/features/press_pull/feature';
import { splitDef } from '../../../src/features/split/feature';
import { combineDef } from '../../../src/features/combine/feature';
import { createImportRuns } from '../../../src/features/import/runs';
import { FakeFolder } from '../../doc/fake-files';
import { realKernelAnywhere } from './kernel-anywhere';
import { createFakeWorkspace } from '../../fakes/workspace-sdk';
import { hybridKernel, type HybridKernel } from './hybrid-kernel';

export const FIXTURES = fileURLToPath(new URL('../../../fixtures/kernel/', import.meta.url));
export const fixture = (name: string) => readFileSync(`${FIXTURES}${name}`);

export const P2_DEFS = [importDef, deleteFacesDef, pressPullDef, splitDef, combineDef];

export interface RealDoc {
  doc: DocService;
  kernel: HybridKernel;
  folder: FakeFolder;
  services: AppServices;
  dispose(): void;
}

/** A Part on the real kernel. Pass `folder` to reopen the same project folder. */
export async function openRealDoc(opts: { folder?: FakeFolder; units?: 'metric' | 'imperial' } = {}): Promise<RealDoc> {
  const folder = opts.folder ?? new FakeFolder();
  const ws = createFakeWorkspace({ units: opts.units ?? 'metric', hostVersion: '1.2', folder });
  const real = realKernelAnywhere();
  await real.start();
  const kernel = hybridKernel(real);
  const bridge = createBridge(ws);
  const bus = createBus<CadEvents>();
  const doc = createDocService({ bridge, kernel, bus, saveIntervalMs: 20, log: () => {} });
  for (const def of P2_DEFS) doc.features.register(def as never);
  await doc.load();
  // The services the import runs need (no UI).
  const services = { bridge, bus, kernel, doc, apis: createStateStore({ sketch: null, solver: null, files: null }) } as unknown as AppServices;
  return {
    doc,
    kernel,
    folder,
    services,
    dispose() {
      doc.dispose();
      kernel.dispose();
    },
  };
}

/** Wait for the rebuild to finish with every feature built. */
export async function settle(doc: DocService, timeout = 60_000) {
  await new Promise((r) => setTimeout(r, 0));
  await vi.waitFor(
    () => {
      const s = doc.state.get();
      expect(s.rebuild.status).toBe('done');
      for (const f of s.doc.features) expect(s.rebuild.features[f.id]?.state ?? 'pending', f.name).not.toBe('pending');
    },
    { timeout, interval: 20 },
  );
  return doc.state.get().rebuild;
}

/** Import a fixture through the panel's own runs (upload, read, heal, BREP), and commit it. */
export async function importFixture(r: RealDoc, name: string, opts: { bytes?: Uint8Array } = {}) {
  const bytes = opts.bytes ?? fixture(name);
  const runs = createImportRuns(r.services, () => ({ kernel: r.kernel, files: createFileTransfer({ files: r.services.bridge.files }), studyId: r.services.bridge.studyId }));
  const s = r.doc.beginNew('import', { source: { rel: '', size: bytes.byteLength, sha256: '', fileName: name, unit: null } } as never);
  const file = new File([new Uint8Array(bytes).buffer as ArrayBuffer], name);
  runs.start(s, file);
  await vi.waitFor(
    () => {
      const run = runs.state.get().runs[s.feature];
      if (run?.error) throw new Error(`import stopped: ${run.error}`);
      expect(s.incomplete()).toBeNull();
    },
    { timeout: 60_000, interval: 20 },
  );
  const outcome = runs.state.get().runs[s.feature]?.outcome ?? null;
  s.commit();
  const rebuild = await settle(r.doc);
  return { feature: s.feature, outcome, rebuild, runs };
}
