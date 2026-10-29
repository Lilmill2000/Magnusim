// The parity tests' own helpers (tests/assistant/parity.test.ts for Magnusim, and
// parity-no-projects.test.ts for Magnusim CAD): every key a tool's input asks for, a field of a
// tool by its path, why a row does not hold, and the app booted as the host starts it.
// SPDX-License-Identifier: GPL-3.0-or-later
import type { AssistantTool } from '@magnusim/workspace';
import { act } from 'react';
import { expect, vi } from 'vitest';
import type { Reach } from '../../src/assistant/parity';
import { CAD_TOOLS } from '../../src/assistant/schemas';
import type { AppServices } from '../../src/types/app';
import { createFakeWorkspace, setFakeConnection } from '../fakes/workspace-sdk';
import { FakeWorker, okHandler } from '../fakes/fake-worker';

export type Node = { type?: string; properties?: Record<string, Node>; items?: Node; enum?: string[] };

/**
 * Every row key a tool's input asks for: a leaf field's path ("set[].expr", an array of strings by
 * its own path) and, for an enum, each value as "path=value" ("views=iso_back", "set[].kind=angle").
 */
export function schemaKeys(schema: Node): string[] {
  const out: string[] = [];
  const walk = (n: Node, path: string) => {
    if (n.type === 'object') {
      for (const [k, v] of Object.entries(n.properties ?? {})) walk(v, path ? `${path}.${k}` : k);
      return;
    }
    if (n.type === 'array' && n.items) {
      if (n.items.type === 'object') return walk(n.items, `${path}[]`);
      if (n.items.enum) for (const v of n.items.enum) out.push(`${path}=${v}`);
      else out.push(path);
      return;
    }
    if (n.enum) for (const v of n.enum) out.push(`${path}=${v}`);
    else out.push(path);
  };
  walk(schema, '');
  return out;
}

/** A field path of a tool's input ("entities[].kind"), or null when the tool or a step of it is not there (in `tools`: Magnusim's by default). */
export function fieldNode(tool: string, field: string, tools: readonly AssistantTool[] = CAD_TOOLS): Node | null {
  const t = tools.find((x) => x.name === tool);
  if (!t) return null;
  let n: Node | undefined = t.inputSchema as unknown as Node;
  for (const step of field.split('.')) {
    const arr = step.endsWith('[]');
    const key = arr ? step.slice(0, -2) : step;
    n = n?.properties?.[key];
    if (arr) n = n?.items;
    if (!n) return null;
  }
  return n;
}

/** Why a row does not hold now ("" when it does), against `tools` (Magnusim's by default). */
export function problem(r: Reach, tools: readonly AssistantTool[] = CAD_TOOLS): string {
  if (r.kind === 'auto') return r.why.trim() ? '' : 'auto with no reason';
  const n = fieldNode(r.tool, r.field, tools);
  if (!n) return `${r.tool}.${r.field} is not in schemas.ts`;
  if (r.value !== undefined && n.enum && !n.enum.includes(r.value)) return `${r.tool}.${r.field} has no value ${r.value}`;
  return '';
}

/**
 * The app as the host starts it (every module installed, on a fake host and kernel). `projectLinks`
 * false: Magnusim CAD's welcome (no projects, no simulation). The test file mocks the viewport.
 */
export async function bootApp(o: { projectLinks?: boolean } = {}): Promise<AppServices> {
  const ws = createFakeWorkspace({
    ...('projectLinks' in o ? { projectLinks: o.projectLinks } : {}),
    spawnWorker: () => {
      const w = new FakeWorker(okHandler());
      w.ready();
      return w as unknown as Worker;
    },
  });
  setFakeConnection(ws);
  const { bootstrap } = await import('../../src/app/bootstrap');
  const root = document.createElement('div');
  document.body.append(root);
  let services: AppServices | null = null;
  await act(async () => {
    services = await bootstrap(root);
  });
  await vi.waitFor(() => expect(root.querySelector('[data-cad-app]')?.getAttribute('data-kernel')).toBe('ready'));
  return services!;
}
