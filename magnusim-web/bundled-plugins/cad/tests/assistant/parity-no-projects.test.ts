// Parity in Magnusim CAD (Daniel 2026-10-28: "there shouldn't be a 'leave body out of simulation'
// option, because there's no simulation in the standalone Magnusim CAD"; 2026-10-29: hide every
// project and simulation item there). The app booted with the host's welcome flag projectLinks
// false: parityFor(false) holds both ways against the tools this page offers there (cadToolsFor:
// the body tool without its simulation field, the workspace tool without send_to_simulation, the
// direct tool without the enclosure kind and its fields), the person's "Include in simulation"
// control, the send to the simulation and the Enclosure command are NO_PROJECTS (nobody has them
// there), an Enclosure's inputs are ENCLOSURE_KEPT_WHY (kept as made in Magnusim), and every other
// row is as in Magnusim (tests/assistant/parity.test.ts). Absent, the flag means Magnusim:
// parityFor(true) is the Magnusim tables themselves.
// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it, vi } from 'vitest';
import { keybindsFor } from '../../src/app/keybinds';
import { AI_TOOLS, auto, COMMANDS, DOC, ENCLOSURE_KEPT_WHY, NO_PROJECTS, PARITY_TABLES, parityFor, UI, VIEWPORT, type PersonPath } from '../../src/assistant/parity';
import { CAD_TOOLS, cadToolsFor } from '../../src/assistant/schemas';
import { CHECK_CONTROLS } from '../../src/features/check/controls';
import { SECTION_CONTROLS } from '../../src/features/section/controls';
import type { AppServices } from '../../src/types/app';
import { hasPanel, uiFor } from '../../src/ui/controller';
import { railsFor } from '../../src/ui/left-rails';
import { toolbarPrefs } from '../../src/ui/toolbar-layout';
import { bootApp, problem, schemaKeys, type Node } from './parity-lib';

// three's WebGLRenderer needs WebGL, which jsdom lacks.
vi.mock('../../src/viewport/viewport', () => ({
  createViewport: () => ({ state: { get: () => ({ ready: true }), subscribe: () => () => {} }, dispose() {} }),
}));
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let booted: Promise<AppServices> | null = null;
const boot = (): Promise<AppServices> => (booted ??= bootApp({ projectLinks: false }));

const TOOLS = cadToolsFor({ projectLinks: false });
const { tables, aiTools } = parityFor(false);

describe('parity in Magnusim CAD (projectLinks false: no projects, no simulation)', () => {
  it('absent means Magnusim: parityFor(true) is the Magnusim tables, and the tools are CAD_TOOLS', () => {
    expect(parityFor(true)).toEqual({ tables: PARITY_TABLES, aiTools: AI_TOOLS });
    expect(cadToolsFor({ projectLinks: true })).toBe(CAD_TOOLS);
    expect(UI.setBodyInSimulation).toMatchObject({ kind: 'reach', tool: 'body', field: 'simulation', projects: true });
    expect(DOC.setBodyInSimulation).toMatchObject({ kind: 'reach', tool: 'body', field: 'simulation', projects: true });
  });

  it("the person's simulation toggle is no one's there; every other row is Magnusim's, and every row names a tool and field this page offers", async () => {
    const services = await boot();
    expect(services.bridge.projectLinks()).toBe(false);
    expect(tables.ui.setBodyInSimulation).toEqual(NO_PROJECTS);
    expect(tables.doc.setBodyInSimulation).toEqual(NO_PROJECTS);
    expect(tables.commands['cfd.enclosure']).toEqual(NO_PROJECTS);
    expect(tables.link.sync).toEqual(NO_PROJECTS);
    expect(tables['feature enclosure'].padding).toEqual(auto(ENCLOSURE_KEPT_WHY));
    // Only the project-only rows differ.
    const changed = Object.entries(tables).flatMap(([name, t]) => Object.entries(t).filter(([k, r]) => r !== PARITY_TABLES[name][k]).map(([k]) => `${name}.${k}`));
    expect(changed.sort()).toEqual([
      'commands.cfd.enclosure',
      'doc.bodiesAtEnd',
      'doc.setBodyInSimulation',
      'feature enclosure.axis',
      'feature enclosure.bodies',
      'feature enclosure.distance',
      'feature enclosure.padding',
      'feature enclosure.percent',
      'feature enclosure.shape',
      'feature enclosure.sides',
      'link.last',
      'link.sync',
      'ui.setBodyInSimulation',
    ]);
    // Neither the person nor the Assistant has the Enclosure command there.
    expect(services.commands.get('cfd.enclosure')).toBeUndefined();
    // Every registered command and control method still has a row.
    const missing: string[] = [];
    for (const c of services.commands.all()) if (!COMMANDS[c.id]) missing.push(`command ${c.id}`);
    const methods: [string, object][] = [
      ['ui', uiFor(services)],
      ['doc', services.doc],
      ['rails', railsFor(services)],
      ['toolbar', toolbarPrefs(services)],
      ['keybinds', keybindsFor(services)],
      ['link', services.apis.get().link ?? {}],
    ];
    for (const [name, obj] of methods) for (const k of Object.keys(obj)) if (!tables[name]?.[k]) missing.push(`${name}.${k}`);
    expect(missing).toEqual([]);
    const bad = Object.entries(tables).flatMap(([name, t]) => Object.entries(t).map(([k, r]) => ({ k: `${name} ${k}`, why: problem(r, TOOLS) }))).filter((x) => x.why);
    expect(bad).toEqual([]);
  });

  it('the app as the host starts it shows no CFD PREP, has no Enclosure command or key, and the Assistant is offered the tools without them', async () => {
    const services = await boot();
    expect(document.querySelector('[data-cad-toolbar] .tb-group-label')).not.toBeNull();
    expect([...document.querySelectorAll('[data-cad-toolbar] .tb-group-label')].map((g) => g.textContent)).not.toContain('CFD PREP');
    expect(document.querySelector('[data-command="cfd.enclosure"]')).toBeNull();
    expect(keybindsFor(services).entries().map((e) => e.id)).not.toContain('cfd.enclosure');
    expect(keybindsFor(services).entries().length).toBeGreaterThan(50);
    expect(services.commands.get('scale.banana')?.hint).toBe("Show a banana for scale. It's not part of the model");
  });

  it("the other way: every field and value of the tools offered there has a person's path in the booted app, and none is left over", async () => {
    const services = await boot();
    const body = TOOLS.find((t) => t.name === 'body')!;
    expect(schemaKeys(body.inputSchema as unknown as Node)).toEqual(['body', 'rename_to', 'color', 'visibility=keep', 'visibility=show', 'visibility=hide']);
    const missing: string[] = [];
    const stale: string[] = [];
    for (const t of TOOLS) {
      const rows = aiTools[t.name];
      if (!rows) {
        missing.push(`tool ${t.name}`);
        continue;
      }
      const keys = schemaKeys(t.inputSchema as unknown as Node);
      for (const k of keys) if (!rows[k]) missing.push(`${t.name} ${k}`);
      for (const k of Object.keys(rows)) if (!keys.includes(k)) stale.push(`${t.name} ${k}`);
    }
    expect(missing).toEqual([]);
    expect(stale).toEqual([]);
    const controls: Record<string, object> = { ui: uiFor(services), doc: services.doc, rails: railsFor(services), toolbar: toolbarPrefs(services), keybinds: keybindsFor(services), link: services.apis.get().link ?? {}, viewport: VIEWPORT, check: CHECK_CONTROLS, section: SECTION_CONTROLS };
    const bad: string[] = [];
    const check = (where: string, p: PersonPath) => {
      if (p.kind === 'command' && !services.commands.get(p.id)) bad.push(`${where}: command ${p.id} is not registered`);
      if (p.kind === 'control' && !(p.method in controls[p.table])) bad.push(`${where}: ${p.table}.${p.method} is not a control method`);
      if (p.kind === 'panel' && !hasPanel(services, p.type)) bad.push(`${where}: ${p.type} has no panel`);
    };
    for (const [tool, rows] of Object.entries(aiTools)) for (const [k, p] of Object.entries(rows)) check(`${tool} ${k}`, p);
    expect(bad).toEqual([]);
    // The simulation rows, the send and the Enclosure's are Magnusim's alone.
    expect(Object.keys(AI_TOOLS.body).filter((k) => !(k in aiTools.body))).toEqual(['simulation=keep', 'simulation=include', 'simulation=exclude']);
    expect(Object.keys(AI_TOOLS.workspace).filter((k) => !(k in aiTools.workspace))).toEqual(['action=send_to_simulation']);
    expect(Object.keys(AI_TOOLS.direct).filter((k) => !(k in aiTools.direct))).toEqual([
      'kind=enclosure',
      'shape=box',
      'shape=cylinder_x',
      'shape=cylinder_y',
      'shape=cylinder_z',
      'padding=zero',
      'padding=percent',
      'padding=fixed',
      'sides[].side=+x',
      'sides[].side=-x',
      'sides[].side=+y',
      'sides[].side=-y',
      'sides[].side=+z',
      'sides[].side=-z',
      'sides[].side=radius',
      'sides[].side=top',
      'sides[].side=bottom',
      'sides[].value',
    ]);
  });
});
