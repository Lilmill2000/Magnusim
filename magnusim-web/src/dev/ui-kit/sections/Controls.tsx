/**
 * The dev sheet's Controls section: NumberUnitInput, Select, Toggle, Field,
 * Hint, DisabledReason, EmptyState, Icon and the unit helpers. It renders
 * through the `kit` prop (kit types only), so page and frame run the same code.
 */
import { useLayoutEffect, useRef } from 'react';
import { Group, Specimen, type SectionProps } from './Foundation';

/**
 * Hover and focus targets that sit inside a kit component, which takes no data
 * attributes there. They are marked after the first render, from outside the
 * specimen boxes, so the boxes hold kit markup only.
 */
const TARGETS: ReadonlyArray<[specimen: string, selector: string]> = [
  ['NumberUnitInput/narrow-length', 'input.mgk-input'],
  ['Select/default', 'select.mgk-select'],
  ['Toggle/switch-off', 'input.mgk-switch-input'],
  ['Toggle/pill-off', 'button.mgk-pill'],
  ['Toggle/pill-on', 'button.mgk-pill'],
  ['Field/help', '.mgk-field-help'],
  ['DisabledReason/reason-fix', 'button.mgk-btn--fix'],
];

const ROW = { overflowWrap: 'anywhere' } as const;

function show(out: unknown): string {
  return typeof out === 'number' ? String(out) : JSON.stringify(out);
}

/** One row of a units specimen: the call and what it gives. */
function Row({ call, out }: { call: string; out: unknown }) {
  return (
    <div style={ROW}>
      {call} → {show(out)}
    </div>
  );
}

const noop = () => {};

const UNIT_OPTIONS = [
  { value: 'Pa', label: 'Pa' },
  { value: 'kPa', label: 'kPa' },
  { value: 'psi', label: 'psi' },
  { value: 'bar', label: 'bar (not here)', disabled: true },
];

export function ControlsSection({ kit, side }: SectionProps) {
  const { NumberUnitInput, Select, Toggle, Field, Hint, DisabledReason, EmptyState, Icon } = kit;
  const ref = useRef<HTMLDivElement>(null);
  const id = (name: string) => `kit-${side}-${name}`;

  useLayoutEffect(() => {
    const root = ref.current;
    if (!root) return;
    for (const [specimen, selector] of TARGETS) {
      root.querySelector(`[data-kit-specimen="${specimen}"] ${selector}`)?.setAttribute('data-kit-target', '1');
    }
  }, []);

  return (
    <div ref={ref} data-kit-section="controls">
      <Group title="NumberUnitInput">
        <Specimen name="NumberUnitInput/narrow-length" covers="NumberUnitInput" focus>
          <NumberUnitInput label="Gap" quantity="length" units="metric" valueSi={0.025} onCommitSi={noop} />
        </Specimen>
        <Specimen name="NumberUnitInput/wide" covers="NumberUnitInput">
          <NumberUnitInput label="Inlet speed" quantity="velocity" width="wide" valueSi={1.5} onCommitSi={noop} />
        </Specimen>
        <Specimen name="NumberUnitInput/fill" covers="NumberUnitInput" note="fill: the width a schema form gives its number fields.">
          <NumberUnitInput label="Outlet pressure" quantity="pressure" width="fill" valueSi={101325} onCommitSi={noop} />
        </Specimen>
        <Specimen name="NumberUnitInput/no-unit" covers="NumberUnitInput">
          <NumberUnitInput label="Iterations" valueSi={500} onCommitSi={noop} />
        </Specimen>
        <Specimen name="NumberUnitInput/disabled" covers="NumberUnitInput">
          <NumberUnitInput label="Gap (locked)" quantity="length" valueSi={0.025} disabled onCommitSi={noop} />
        </Specimen>
      </Group>

      <Group title="Select">
        <Specimen name="Select/default" covers="Select" focus>
          <Select label="Pressure unit" value="kPa" options={UNIT_OPTIONS} onChange={noop} />
        </Specimen>
        <Specimen name="Select/disabled" covers="Select">
          <Select label="Pressure unit (locked)" value="Pa" options={UNIT_OPTIONS} onChange={noop} disabled />
        </Specimen>
      </Group>

      <Group title="Toggle">
        <Specimen name="Toggle/switch-off" covers="Toggle" focus>
          <Toggle label="Show edges" checked={false} onChange={noop} />
        </Specimen>
        <Specimen name="Toggle/switch-on" covers="Toggle">
          <Toggle label="Show edges (on)" checked onChange={noop} />
        </Specimen>
        <Specimen name="Toggle/switch-disabled" covers="Toggle" note="Disabled is kit-only: the core switch has no disabled look.">
          <Toggle label="Show edges (locked)" checked={false} onChange={noop} disabled />
        </Specimen>
        <Specimen name="Toggle/pill-off" covers="Toggle" hover focus>
          <Toggle label="Automatic boundary layers" variant="pill" checked={false} onChange={noop} />
        </Specimen>
        <Specimen name="Toggle/pill-on" covers="Toggle" hover>
          <Toggle label="Physics-based meshing" variant="pill" checked onChange={noop} />
        </Specimen>
      </Group>

      <Group title="Field">
        <Specimen name="Field/plain" covers="Field">
          <Field label="Small feature suppression" htmlFor={id('field-plain')}>
            <NumberUnitInput id={id('field-plain')} label="Small feature suppression" quantity="length" width="fill" valueSi={0.0005} onCommitSi={noop} />
          </Field>
        </Specimen>
        <Specimen name="Field/help" covers="Field" hover focus>
          <Field label="Residual p" htmlFor={id('field-help')} help="Convergence target for the pressure equation.">
            <NumberUnitInput id={id('field-help')} label="Residual p" width="fill" valueSi={1e-6} onCommitSi={noop} />
          </Field>
        </Specimen>
      </Group>

      <Group title="Hint">
        <Specimen name="Hint/muted" covers="Hint">
          <Hint>Pick faces in the viewport or tree.</Hint>
        </Specimen>
        <Specimen name="Hint/warning" covers="Hint" note="No core pair: the core colours a span inside the hint, not the hint.">
          <Hint tone="warning">A transient run this long writes a lot of data.</Hint>
        </Specimen>
        <Specimen name="Hint/danger" covers="Hint" note="No core pair: the core colours a span inside the hint, not the hint.">
          <Hint tone="danger">This value must be above zero.</Hint>
        </Specimen>
      </Group>

      <Group title="DisabledReason">
        <Specimen name="DisabledReason/reason" covers="DisabledReason">
          <DisabledReason reason="Generate a mesh before you run." />
        </Specimen>
        <Specimen name="DisabledReason/reason-fix" covers="DisabledReason" hover focus>
          <DisabledReason reason="OpenFOAM was not found in WSL." fix={{ label: 'Open Settings', onFix: noop }} />
        </Specimen>
      </Group>

      <Group title="EmptyState">
        <Specimen name="EmptyState/list" covers="EmptyState">
          <EmptyState>No studies yet.</EmptyState>
        </Specimen>
        <Specimen name="EmptyState/chart" covers="EmptyState">
          <EmptyState variant="chart">Waiting for the first iteration.</EmptyState>
        </Specimen>
      </Group>

      <Group title="Icon">
        <Specimen name="Icon/pencil" covers="Icon" note="No core pair for icons: the core draws each one inline in its component.">
          <Icon name="pencil" />
        </Specimen>
        <Specimen name="Icon/trash" covers="Icon">
          <Icon name="trash" size={13} />
        </Specimen>
        <Specimen name="Icon/back" covers="Icon">
          <Icon name="back" size={14} />
        </Specimen>
        <Specimen name="Icon/document" covers="Icon">
          <Icon name="document" title="Study" />
        </Specimen>
        <Specimen name="Icon/path" covers="Icon">
          <Icon path="M4 5h16v14H4z M4 9h16" size={18} stroke={1.7} />
        </Specimen>
      </Group>

      <Group title="Units">
        <Specimen name="Units/fieldUnit" covers="fieldUnit">
          <Row call="fieldUnit('length', 'metric')" out={kit.fieldUnit('length', 'metric')} />
          <Row call="fieldUnit('length', 'imperial')" out={kit.fieldUnit('length', 'imperial')} />
          <Row call="fieldUnit('pressure', 'imperial')" out={kit.fieldUnit('pressure', 'imperial')} />
        </Specimen>
        <Specimen name="Units/fieldQuantity" covers="fieldQuantity">
          <Row
            call="fieldQuantity({ 'x-cfddesk': { quantity: 'velocity' } })"
            out={kit.fieldQuantity({ 'x-cfddesk': { quantity: 'velocity' } })}
          />
          <Row call="fieldQuantity({ type: 'number' })" out={kit.fieldQuantity({ type: 'number' })} />
        </Specimen>
        <Specimen name="Units/toSi" covers="toSi">
          <Row call="toSi('length', 25, 'mm')" out={kit.toSi('length', 25, 'mm')} />
          <Row call="toSi('temperature', 32, '°F')" out={kit.toSi('temperature', 32, '°F')} />
        </Specimen>
        <Specimen name="Units/fromSi" covers="fromSi">
          <Row call="fromSi('length', 0.0254, 'in')" out={kit.fromSi('length', 0.0254, 'in')} />
          <Row call="fromSi('temperature', 273.15, '°C')" out={kit.fromSi('temperature', 273.15, '°C')} />
        </Specimen>
        <Specimen name="Units/convertQuantity" covers="convertQuantity">
          <Row call="convertQuantity('length', 25.4, 'mm', 'in')" out={kit.convertQuantity('length', 25.4, 'mm', 'in')} />
        </Specimen>
        <Specimen name="Units/preferredUnit" covers="preferredUnit">
          <Row call="preferredUnit('velocity', false)" out={kit.preferredUnit('velocity', false)} />
          <Row call="preferredUnit('velocity', true)" out={kit.preferredUnit('velocity', true)} />
        </Specimen>
        <Specimen name="Units/resolveUnit" covers="resolveUnit">
          <Row call="resolveUnit('kinematic_viscosity', 'm2/s')" out={kit.resolveUnit('kinematic_viscosity', 'm2/s')} />
          <Row call="resolveUnit('pressure', 'KPA')" out={kit.resolveUnit('pressure', 'KPA')} />
        </Specimen>
        <Specimen name="Units/unitLabels" covers="unitLabels">
          <Row call="unitLabels('pressure')" out={kit.unitLabels('pressure')} />
        </Specimen>
        <Specimen name="Units/siUnitLabel" covers="siUnitLabel">
          <Row call="siUnitLabel('pressure')" out={kit.siUnitLabel('pressure')} />
          <Row call="siUnitLabel('specific_energy')" out={kit.siUnitLabel('specific_energy')} />
        </Specimen>
        <Specimen name="Units/UNITS" covers="UNITS">
          <Row call="UNITS.length" out={kit.UNITS.length} />
          <Row call="Object.isFrozen(UNITS.length)" out={Object.isFrozen(kit.UNITS.length)} />
        </Specimen>
        <Specimen name="Units/IMPERIAL_DEFAULT" covers="IMPERIAL_DEFAULT">
          <Row call="IMPERIAL_DEFAULT" out={kit.IMPERIAL_DEFAULT} />
        </Specimen>
        <Specimen name="Units/SI_DEFAULT" covers="SI_DEFAULT">
          <Row call="SI_DEFAULT" out={kit.SI_DEFAULT} />
        </Specimen>
      </Group>
    </div>
  );
}
