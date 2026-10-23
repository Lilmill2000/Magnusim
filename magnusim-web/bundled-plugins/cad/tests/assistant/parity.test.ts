// The parity test (Daniel's rule: anything a person can do, use or see in the CAD program, the
// Assistant can do through its tools). The app is booted as the host starts it (every module
// installed, on a fake host and kernel), and every person-facing capability it has is listed
// programmatically: every registered command (the toolbar, the context menus and the keyboard run
// them), every registered feature type and every field of its new record, the sketch's relation
// and dimension kinds, and every method of the UI controller, the document, the left rails, the
// toolbar layout and the project link. Each must have a row in src/assistant/parity.ts (whose
// type-keyed tables also fail the typecheck on any feature field, entity kind, sketch tool or
// method left out), and every row must name a tool and a field (and an enum value) that exist in
// schemas.ts, or say why it is no person action. No row waits for a later tool: each is reached
// now or is automatic or internal with its reason.
// SPDX-License-Identifier: GPL-3.0-or-later
import { act } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { CAD_TOOLS } from '../../src/assistant/schemas';
import { COMMANDS, DOC, FEATURE_FIELDS, LINK, PARITY_TABLES, RAILS, SKETCH_CONSTRAINTS, TOOLBAR, UI, type Reach } from '../../src/assistant/parity';
import { DIMENSION_KINDS, RELATION_KINDS } from '../../src/sketch/model';
import { railsFor } from '../../src/ui/left-rails';
import { toolbarPrefs } from '../../src/ui/toolbar-layout';
import { uiFor } from '../../src/ui/controller';
import type { AppServices } from '../../src/types/app';
import { createFakeWorkspace, setFakeConnection } from '../fakes/workspace-sdk';
import { FakeWorker, okHandler } from '../fakes/fake-worker';

// three's WebGLRenderer needs WebGL, which jsdom lacks (the viewport's table is checked by type).
vi.mock('../../src/viewport/viewport', () => ({
  createViewport: () => ({ state: { get: () => ({ ready: true }), subscribe: () => () => {} }, dispose() {} }),
}));
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type Node = { type?: string; properties?: Record<string, Node>; items?: Node; enum?: string[] };

/** A field path of a tool's input ("entities[].kind"), or null when the tool or a step of it is not there. */
function fieldNode(tool: string, field: string): Node | null {
  const t = CAD_TOOLS.find((x) => x.name === tool);
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

/** Why a row does not hold now ("" when it does). */
function problem(r: Reach): string {
  if (r.kind === 'auto') return r.why.trim() ? '' : 'auto with no reason';
  const n = fieldNode(r.tool, r.field);
  if (!n) return `${r.tool}.${r.field} is not in schemas.ts`;
  if (r.value !== undefined && n.enum && !n.enum.includes(r.value)) return `${r.tool}.${r.field} has no value ${r.value}`;
  return '';
}

async function boot(): Promise<AppServices> {
  const ws = createFakeWorkspace({
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

const rows = () => Object.entries(PARITY_TABLES).flatMap(([table, t]) => Object.entries(t).map(([key, r]) => ({ table, key, r })));

describe('parity: every person-facing capability has an Assistant tool and field', () => {
  it('every registered command, feature type and field, sketch kind and control method has a row', async () => {
    const services = await boot();
    const missing: string[] = [];
    // Commands: the toolbar's, the context menus' and the keyboard's (all run by id from the registry).
    for (const c of services.commands.all()) if (!COMMANDS[c.id]) missing.push(`command ${c.id} (${c.label})`);
    // Feature types and every field of a new record of each.
    const doc = services.doc.state.get().doc;
    for (const def of services.doc.features.all()) {
      const table = (FEATURE_FIELDS as unknown as Record<string, Record<string, Reach>>)[def.type];
      if (!table) {
        missing.push(`feature type ${def.type}`);
        continue;
      }
      for (const k of Object.keys(def.create(doc))) if (!table[k]) missing.push(`feature ${def.type}.${k}`);
    }
    for (const k of [...RELATION_KINDS, ...DIMENSION_KINDS]) if (!(SKETCH_CONSTRAINTS as Record<string, Reach>)[k]) missing.push(`sketch constraint ${k}`);
    // The person's controls: the tree and panels (UI), the chips and the document (DOC), the rails, the toolbar layout, Back's link.
    const methods: [string, object, Record<string, Reach>][] = [
      ['ui', uiFor(services), UI],
      ['doc', services.doc, DOC],
      ['rails', railsFor(services), RAILS],
      ['toolbar', toolbarPrefs(services), TOOLBAR],
      ['link', services.apis.get().link ?? {}, LINK],
    ];
    for (const [name, obj, table] of methods) for (const k of Object.keys(obj)) if (!table[k]) missing.push(`${name}.${k}`);
    expect(services.apis.get().link, 'bootstrap publishes the project link').toBeTruthy();
    expect(missing).toEqual([]);
    // Summary of the table (printed for the report).
    const all = rows();
    const count = (k: Reach['kind']) => all.filter((x) => x.r.kind === k).length;
    expect(count('reach') + count('auto')).toBe(all.length);
    console.log(`[parity] ${all.length} rows: ${count('reach')} reached, ${count('auto')} automatic or internal; ${services.commands.all().length} commands, ${services.doc.features.all().length} feature types`);
  });

  it('every row names a tool, field and value that exist in schemas.ts, or is automatic with a reason', () => {
    const bad = rows()
      .map((x) => ({ ...x, why: problem(x.r) }))
      .filter((x) => x.why)
      .map((x) => `${x.table} ${x.key}: ${x.why}`);
    expect(bad).toEqual([]);
  });

  it('the workspace tool reaches what this lane added: send to the simulation, the rollback bar, the view, the banana, Export', () => {
    for (const k of ['sync'] as const) expect(LINK[k]).toEqual({ kind: 'reach', tool: 'workspace', field: 'action', value: 'send_to_simulation' });
    expect(UI.rollBackTo).toMatchObject({ tool: 'workspace', value: 'roll_back_to' });
    expect(UI.setBodyVisible).toMatchObject({ tool: 'body', field: 'visibility' });
    expect(DOC.redo).toMatchObject({ tool: 'undo', value: 'redo' });
    expect(COMMANDS['file.export-step']).toMatchObject({ tool: 'workspace', value: 'export_step' });
    expect(COMMANDS['scale.banana']).toMatchObject({ tool: 'workspace', value: 'banana_show' });
  });

  it("the sketch and features tools reach what those lanes added: the person's sketch tools, construct, direct, repair and retry, the pattern's options", () => {
    expect(COMMANDS['sketch.trim']).toEqual({ kind: 'reach', tool: 'sketch', field: 'constraints[].kind', value: 'trim' });
    expect(COMMANDS['sketch.pattern-linear']).toMatchObject({ tool: 'sketch', value: 'linear_pattern' });
    expect(COMMANDS['sketch.spline-control']).toMatchObject({ tool: 'sketch', field: 'entities[].kind', value: 'control_spline' });
    expect(COMMANDS['construct.plane']).toMatchObject({ tool: 'construct', field: 'method' });
    expect(COMMANDS['modify.press-pull']).toEqual({ kind: 'reach', tool: 'direct', field: 'kind', value: 'press_pull' });
    expect(COMMANDS['cfd.enclosure']).toMatchObject({ tool: 'direct', value: 'enclosure' });
    expect(DOC.repair).toMatchObject({ tool: 'direct', value: 'repair' });
    expect(DOC.retry).toMatchObject({ tool: 'direct', value: 'retry' });
    expect(FEATURE_FIELDS.pattern_circular.symmetric).toMatchObject({ tool: 'pattern', field: 'options', value: 'symmetric' });
    expect(FEATURE_FIELDS.extrude.face).toMatchObject({ tool: 'extrude', field: 'face' });
  });
});
