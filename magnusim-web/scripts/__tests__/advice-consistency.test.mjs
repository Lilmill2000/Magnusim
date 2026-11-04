// RH1 (spec 3.15, 3.16): one advice text for Max Courant and the outer correctors
// (magnusim_sdk.numerics_advice, scripts/generated/numerics-advice.json). Guide rule 2 holds
// ADVICE.max_co.rule; the registry's Max Courant and outer corrector descriptions (Incompressible
// Flow and Heat Transfer) start with their rules and Max Courant has no cap (A1); the
// Incompressible Flow tooltips come from those descriptions (no literal in the UI file); no
// advice, description, tooltip, warning or guide says a higher Courant number is faster.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const WEB = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const { cfdGuideText, adviceTable } = await import('../server/assistant/cfdGuide.ts');
const FASTER = /faster|speeds? up/i;

describe('one advice text (A1: Max Courant warned about, never capped)', () => {
  const ADVICE = adviceTable();
  const registry = JSON.parse(readFileSync(join(WEB, 'scripts', 'generated', 'registry.json'), 'utf8'));
  const fields = (key) =>
    registry.analysis
      .filter((a) => /^(incompressible|heat_transfer)_transient$/.test(a.key))
      .map((a) => [a.key, a.control_schema.properties[key]]);

  it("guide rule 2 holds the Max Courant rule; the registry's descriptions start with their rules; Max Courant has no max", () => {
    const rule2 = cfdGuideText().split('\n').find((l) => l.startsWith('2. '));
    assert.ok(rule2.includes(ADVICE.max_co.rule), rule2);
    for (const [key, f] of fields('max_co')) {
      assert.ok(f.description.startsWith(ADVICE.max_co.rule), `${key}: ${f.description}`);
      assert.equal(f.maximum, undefined, `${key}: Max Courant has no cap`);
    }
    for (const [key, f] of fields('n_outer_correctors')) assert.ok(f.description.startsWith(ADVICE.n_outer_correctors.rule), `${key}: ${f.description}`);
    for (const [k, a] of Object.entries(ADVICE)) assert.ok(a.rule.length <= 160, `${k}: ${a.rule.length}`);
  });

  it('the Incompressible Flow tooltips are the schema descriptions, with no literal in the UI file', () => {
    const ui = readFileSync(join(WEB, 'bundled-plugins', 'incompressible_flow', 'ui', 'RunSettings.tsx'), 'utf8');
    assert.match(ui, /label="Max Courant number"\s+title=\{describe\('max_co'\)\}/);
    assert.match(ui, /label="Outer correctors"\s+title=\{describe\('n_outer_correctors'\)\}/);
    for (const a of Object.values(ADVICE)) {
      assert.ok(!ui.includes(a.rule) && !ui.includes(a.more), 'an advice literal in the UI file');
    }
    assert.doesNotMatch(ui, /runs faster|allow a higher Courant number/);
  });

  // RH3 (spec 5.6): one advice source for every numerics and run setting it covers.
  it('every numerics or control description of Incompressible Flow and Heat Transfer starts with its ADVICE rule, and every RH3 key has one', () => {
    const rows = registry.analysis.filter((a) => /^(incompressible|heat_transfer)_(steady|transient)$/.test(a.key));
    assert.equal(rows.length, 4);
    const seen = new Set();
    for (const a of rows) {
      for (const schema of [a.numerics_schema, a.control_schema]) {
        for (const [key, f] of Object.entries(schema.properties || {})) {
          if (!ADVICE[key]) continue;
          seen.add(key);
          assert.ok(f.description.startsWith(ADVICE[key].rule + ' '), `${a.key}.${key}: ${f.description}`);
        }
      }
    }
    const RH3 = ['grad_limiter', 'momentum_convection', 'turbulence_convection', 'energy_convection', 'non_orth_correction', 'p_tolerance', 'p_rel_tol', 'p_max_iter', 'eq_tolerance', 'eq_rel_tol', 'eq_max_iter', 'relax_turbulence', 'velocity_limit', 'velocity_limit_max', 'outer_relax_p', 'outer_relax_eq', 'outer_tolerance'];
    for (const key of [...RH3, 'max_co', 'n_outer_correctors']) assert.ok(seen.has(key), `${key}: no registry field carries its advice`);
  });

  it('no Incompressible Flow or Heat Transfer UI file holds an advice text: tooltips are the schema descriptions', () => {
    for (const plugin of ['incompressible_flow', 'heat_transfer']) {
      const dir = join(WEB, 'bundled-plugins', plugin, 'ui');
      for (const name of readdirSync(dir).filter((n) => /\.tsx?$/.test(n) && !/\.test\./.test(n))) {
        const ui = readFileSync(join(dir, name), 'utf8');
        for (const [key, a] of Object.entries(ADVICE)) {
          assert.ok(!ui.includes(a.rule) && !ui.includes(a.more), `${plugin}/ui/${name} holds ADVICE.${key}`);
        }
      }
    }
  });

  it('nothing says a higher Courant number is faster', () => {
    const texts = [cfdGuideText(), ...Object.values(ADVICE).flatMap((a) => [a.rule, a.more])];
    for (const key of ['max_co', 'n_outer_correctors']) for (const [, f] of fields(key)) texts.push(f.description);
    texts.push(readFileSync(join(WEB, 'bundled-plugins', 'incompressible_flow', 'ui', 'transient.ts'), 'utf8'));
    for (const t of texts) assert.doesNotMatch(t, FASTER, t.slice(0, 120));
  });
});
