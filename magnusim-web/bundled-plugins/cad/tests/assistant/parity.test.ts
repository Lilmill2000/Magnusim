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
// And the other way (Daniel: "anything the AI has I should have"): every field of every Assistant
// tool and every value of its enums (schemas.ts) has a row in AI_TOOLS naming the person's path to
// it, and every such row names a command the booted app registers, a method of the person's
// controls, a field of a feature type that has a panel, or says in words where (place) or why it
// is no person's action (own).
// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it, vi } from 'vitest';
import { CAD_TOOLS, SKETCH_ENTITY_KINDS } from '../../src/assistant/schemas';
import { keybindsFor } from '../../src/app/keybinds';
import { AI_TOOLS, command, COMMANDS, DOC, FEATURE_FIELDS, KEYBINDS, LINK, PARITY_TABLES, PERSON_SKETCH_KINDS, RAILS, SKETCH_CONSTRAINTS, sketchKindsWithoutPersonTool, TOOLBAR, UI, VIEWPORT, type PersonPath, type Reach } from '../../src/assistant/parity';
import { hasPanel } from '../../src/ui/controller';
import { DIMENSION_KINDS, RELATION_KINDS } from '../../src/sketch/model';
import { railsFor } from '../../src/ui/left-rails';
import { toolbarPrefs } from '../../src/ui/toolbar-layout';
import { uiFor } from '../../src/ui/controller';
import type { AppServices } from '../../src/types/app';
import { bootApp, problem, schemaKeys, type Node } from './parity-lib';

// three's WebGLRenderer needs WebGL, which jsdom lacks (the viewport's table is checked by type).
vi.mock('../../src/viewport/viewport', () => ({
  createViewport: () => ({ state: { get: () => ({ ready: true }), subscribe: () => () => {} }, dispose() {} }),
}));
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let booted: Promise<AppServices> | null = null;
/** The app, booted once for the file. */
function boot(): Promise<AppServices> {
  booted ??= bootApp();
  return booted;
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
      ['keybinds', keybindsFor(services), KEYBINDS],
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

  it("the other way: every Assistant tool's field and enum value has a person's path, and every path is there in the booted app", async () => {
    const services = await boot();
    const missing: string[] = [];
    const stale: string[] = [];
    for (const t of CAD_TOOLS) {
      const rows = AI_TOOLS[t.name];
      if (!rows) {
        missing.push(`tool ${t.name}`);
        continue;
      }
      const keys = schemaKeys(t.inputSchema as unknown as Node);
      for (const k of keys) if (!rows[k]) missing.push(`${t.name} ${k}`);
      for (const k of Object.keys(rows)) if (!keys.includes(k)) stale.push(`${t.name} ${k}: no such field or value in schemas.ts`);
    }
    for (const name of Object.keys(AI_TOOLS)) if (!CAD_TOOLS.some((t) => t.name === name)) stale.push(`${name}: no such tool`);
    expect(missing, 'an Assistant capability with no person path').toEqual([]);
    expect(stale).toEqual([]);
    // Each path is there: the command registered, the control's method on its object, the panel field on a type with a panel.
    const controls: Record<string, object> = { ui: uiFor(services), doc: services.doc, rails: railsFor(services), toolbar: toolbarPrefs(services), keybinds: keybindsFor(services), link: services.apis.get().link ?? {}, viewport: VIEWPORT };
    const bad: string[] = [];
    const check = (where: string, p: PersonPath) => {
      if (p.kind === 'command') {
        if (!services.commands.get(p.id)) bad.push(`${where}: command ${p.id} is not registered`);
      } else if (p.kind === 'control') {
        if (!(p.method in controls[p.table])) bad.push(`${where}: ${p.table}.${p.method} is not a control method`);
      } else if (p.kind === 'panel') {
        const fields = (FEATURE_FIELDS as unknown as Record<string, Record<string, Reach>>)[p.type];
        if (!fields?.[p.field]) bad.push(`${where}: ${p.type} has no field ${p.field}`);
        if (!hasPanel(services, p.type)) bad.push(`${where}: ${p.type} has no panel`);
      } else if (p.kind === 'place') {
        if (!p.where.trim()) bad.push(`${where}: a place with no words`);
      } else if (!p.why.trim()) bad.push(`${where}: own with no reason`);
    };
    for (const [tool, rows] of Object.entries(AI_TOOLS)) for (const [k, p] of Object.entries(rows)) check(`${tool} ${k}`, p);
    expect(bad).toEqual([]);
    // Review 10: the toolbar's width and rows each have their own row both ways, and the person's
    // controls for them are there in the booted app (the line at a group's right, the bottom edge).
    expect(TOOLBAR.setWidth).toEqual({ kind: 'reach', tool: 'workspace', field: 'action', value: 'toolbar_width' });
    expect(TOOLBAR.setRows).toEqual({ kind: 'reach', tool: 'workspace', field: 'action', value: 'toolbar_rows' });
    expect(AI_TOOLS.workspace['action=toolbar_width']).toEqual({ kind: 'control', table: 'toolbar', method: 'setWidth' });
    expect(AI_TOOLS.workspace['action=toolbar_rows']).toEqual({ kind: 'control', table: 'toolbar', method: 'setRows' });
    expect(document.querySelectorAll('[data-cad-toolbar] [data-tb-resize]').length, "the lines at the groups' right").toBeGreaterThan(3);
    expect(document.querySelectorAll('[data-cad-toolbar] [data-tb-rows-handle]').length, "the toolbar's bottom edge").toBe(1);
    const all = Object.values(AI_TOOLS).flatMap((r) => Object.values(r));
    const n = (k: PersonPath['kind']) => all.filter((p) => p.kind === k).length;
    console.log(`[parity] the other way: ${all.length} rows: ${n('command')} commands, ${n('control')} controls, ${n('panel')} panel fields, ${n('place')} places, ${n('own')} the Assistant's own`);
  });

  it("the person has what was the Assistant's alone: Hole, body colour, history order, Back isometric, Find, Picture, Measure's bodies, points and sections, parameter comments, a Delete of several", () => {
    expect(AI_TOOLS.hole.face).toEqual({ kind: 'command', id: 'solid.hole' });
    expect(AI_TOOLS.body.color).toEqual({ kind: 'control', table: 'ui', method: 'setBodyColor' });
    expect(AI_TOOLS.edit_feature.move).toEqual({ kind: 'control', table: 'ui', method: 'moveFeature' });
    expect(AI_TOOLS.view['views=iso_back']).toEqual({ kind: 'command', id: 'file.picture' });
    expect(AI_TOOLS.workspace['action=standard_view']).toEqual({ kind: 'command', id: 'view.iso_back' });
    expect(AI_TOOLS.find.query).toEqual({ kind: 'command', id: 'inspect.find' });
    expect(AI_TOOLS.measure.section).toEqual({ kind: 'command', id: 'inspect.measure' });
    expect(AI_TOOLS.set_params['set[].comment']).toEqual({ kind: 'command', id: 'modify.parameters' });
    expect(AI_TOOLS.delete.features).toEqual({ kind: 'control', table: 'ui', method: 'deleteFeatures' });
    expect(COMMANDS['solid.hole']).toMatchObject({ tool: 'hole' });
    expect(UI.moveFeature).toMatchObject({ tool: 'edit_feature', field: 'move' });
    expect(DOC.joinSteps).toMatchObject({ tool: 'delete' });
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
    // Delete body (Daniel 2026-10-28), both ways: the body menu's Delete and the Delete key, and direct's delete_body.
    expect(UI.deleteBodies).toEqual({ kind: 'reach', tool: 'direct', field: 'kind', value: 'delete_body' });
    expect(FEATURE_FIELDS.delete_body.bodies).toEqual({ kind: 'reach', tool: 'direct', field: 'bodies' });
    expect(AI_TOOLS.direct['kind=delete_body']).toEqual({ kind: 'control', table: 'ui', method: 'deleteBodies' });
  });

  it('the other way (Daniel: parity both ways): every sketch entity kind the Assistant draws has a person sketch tool, a registered command, that draws it', async () => {
    const services = await boot();
    const tools = new Set(services.commands.all().map((c) => c.activeWhen?.sketchTool).filter((t): t is string => !!t));
    expect(sketchKindsWithoutPersonTool(SKETCH_ENTITY_KINDS, tools)).toEqual([]);
    expect(Object.keys(PERSON_SKETCH_KINDS).sort()).toEqual([...SKETCH_ENTITY_KINDS].sort());
    // The helper fails a kind with no tool, or with a tool the person has no command for.
    expect(sketchKindsWithoutPersonTool(['slot', 'no_such_kind'], tools)).toEqual(['no_such_kind']);
    expect(sketchKindsWithoutPersonTool(['slot', 'arc_slot'], new Set(['slot-center']))).toEqual(['arc_slot']);
  });

  it("both reverse checks agree: each sketch kind's AI_TOOLS row is the command that selects the person's tool PERSON_SKETCH_KINDS names", async () => {
    const services = await boot();
    const toolOf = (id: string) => services.commands.get(id)?.activeWhen?.sketchTool;
    const disagree = SKETCH_ENTITY_KINDS.flatMap((k) => {
      const row = AI_TOOLS.sketch[`entities[].kind=${k}`];
      if (row?.kind !== 'command') return [`${k}: no command row`];
      return toolOf(row.id) === PERSON_SKETCH_KINDS[k] ? [] : [`${k}: ${row.id} selects ${toolOf(row.id)}, PERSON_SKETCH_KINDS names ${PERSON_SKETCH_KINDS[k]}`];
    });
    expect(disagree).toEqual([]);
    // The shape and ellipse kinds reach their own tools, not the line and arc tools that stood in for them.
    expect(AI_TOOLS.sketch['entities[].kind=slot']).toEqual(command('sketch.slot'));
    expect(AI_TOOLS.sketch['entities[].kind=polygon']).toEqual(command('sketch.polygon'));
    expect(AI_TOOLS.sketch['entities[].kind=sector']).toEqual(command('sketch.sector'));
    expect(AI_TOOLS.sketch['entities[].kind=conic']).toEqual(command('sketch.conic'));
  });
});
