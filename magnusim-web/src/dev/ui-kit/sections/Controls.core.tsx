/**
 * Page only (page.tsx): the core's own controls beside their kit twins. The
 * parity gate compares each named part of a pair over a fixed property set
 * and expects no difference.
 *
 * Parts are marked after the first render from one table, on both sides,
 * because neither the core components nor the kit ones take data attributes
 * on their inner elements. A part with data-kit-pseudo="before" is compared
 * with its ::before too: the Toggle switch's "track::before" is the ::before
 * of the element marked "track".
 */
import { useLayoutEffect, useRef, type ReactNode } from 'react';
import { DisabledReason, EmptyState, Field, Hint, NumberUnitInput, Select, Toggle } from '../../../plugin-ui';
import { SciNumberInput } from '../../../forms/SciNumberInput';
import { Group } from './Foundation';
import { CorePair } from './Foundation.core';

type Parts = Record<string, string>;

interface PairParts {
  pair: string;
  core: Parts;
  kit: Parts;
  /** Parts whose ::before is compared as well. */
  before?: string[];
}

const PARTS: PairParts[] = [
  {
    pair: 'DisabledReason/reason',
    core: { root: '.sim-run-hint', msg: '.sim-run-hint-msg' },
    kit: { root: '.mgk-reason', msg: '.mgk-reason-msg' },
  },
  {
    pair: 'DisabledReason/reason-fix',
    core: { root: '.sim-run-hint', msg: '.sim-run-hint-msg', fix: '.sim-fix-go' },
    kit: { root: '.mgk-reason', msg: '.mgk-reason-msg', fix: '.mgk-btn--fix' },
  },
  { pair: 'Hint/muted', core: { root: '.mat-assign-hint' }, kit: { root: '.mgk-hint' } },
  { pair: 'EmptyState/list', core: { root: '.hub-empty' }, kit: { root: '.mgk-empty' } },
  { pair: 'EmptyState/chart', core: { root: '.mon-empty' }, kit: { root: '.mgk-empty' } },
  {
    pair: 'NumberUnitInput/narrow-length',
    core: { root: '.bc-value-row', input: 'input.bc-input', unit: '.bc-unit-label' },
    kit: { root: '.mgk-value-row', input: 'input.mgk-input', unit: '.mgk-unit' },
  },
  {
    pair: 'NumberUnitInput/wide',
    core: { root: '.bc-value-row', input: 'input.bc-input', unit: '.bc-unit-label' },
    kit: { root: '.mgk-value-row', input: 'input.mgk-input', unit: '.mgk-unit' },
  },
  {
    pair: 'NumberUnitInput/fill',
    core: { root: '.bc-value-row', input: 'input.bc-input' },
    kit: { root: '.mgk-value-row', input: 'input.mgk-input' },
  },
  {
    pair: 'Select/default',
    core: { root: 'select.bc-select', option: 'option' },
    kit: { root: 'select.mgk-select', option: 'option.mgk-option' },
  },
  {
    pair: 'Toggle/switch-off',
    core: { root: 'label.switch', input: 'input', track: '.slider' },
    kit: { root: 'label.mgk-switch', input: 'input.mgk-switch-input', track: '.mgk-switch-track' },
    before: ['track'],
  },
  {
    pair: 'Toggle/switch-on',
    core: { root: 'label.switch', input: 'input', track: '.slider' },
    kit: { root: 'label.mgk-switch', input: 'input.mgk-switch-input', track: '.mgk-switch-track' },
    before: ['track'],
  },
  { pair: 'Toggle/pill-off', core: { root: 'button.mesh-toggle' }, kit: { root: 'button.mgk-pill' } },
  { pair: 'Toggle/pill-on', core: { root: 'button.mesh-toggle' }, kit: { root: 'button.mgk-pill' } },
  {
    pair: 'Field/plain',
    core: { root: '.mat-row', k: '.mat-k', label: '.mat-k > label', v: '.mat-v' },
    kit: { root: '.mgk-field', k: '.mgk-field-k', label: '.mgk-field-k > label', v: '.mgk-field-v' },
  },
  {
    pair: 'Field/help',
    core: { root: '.mat-row', k: '.mat-k', label: '.mat-k > label', help: '.mat-k-help', tip: '.mat-k-tip' },
    kit: { root: '.mgk-field', k: '.mgk-field-k', label: '.mgk-field-k > label', help: '.mgk-field-help', tip: '.mgk-field-tip' },
  },
];

function mark(box: Element | null, parts: Parts, before: string[] = []): void {
  if (!box) return;
  for (const [name, selector] of Object.entries(parts)) {
    const el = box.querySelector(selector);
    if (!el) continue;
    el.setAttribute('data-kit-part', name);
    if (before.includes(name)) el.setAttribute('data-kit-pseudo', 'before');
  }
}

const noop = () => {};

/** div.mat-panel-body: 12 px, the panel body colour. */
function PB({ children }: { children: ReactNode }) {
  return <div className="mat-panel-body">{children}</div>;
}

/** div.schema-form: what a schema form's rows sit in. */
function SF({ children }: { children: ReactNode }) {
  return <div className="schema-form">{children}</div>;
}

const HELP = 'Convergence target for the pressure equation.';

export function ControlsCore() {
  const ref = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    const root = ref.current;
    if (!root) return;
    for (const { pair, core, kit, before } of PARTS) {
      mark(root.querySelector(`[data-kit-core-pair="${pair}"]`), core, before);
      mark(root.querySelector(`[data-kit-core-kit="${pair}"]`), kit, before);
    }
  }, []);

  return (
    <div ref={ref} data-kit-section="controls-core">
      <Group title="Controls (core, then kit)">
        <CorePair
          pair="DisabledReason/reason"
          core={
            <PB>
              <div className="mat-assign-hint sim-run-hint" data-run-reason="1">
                <span className="sim-run-hint-msg">Generate a mesh before you run.</span>
              </div>
            </PB>
          }
          kit={
            <PB>
              <DisabledReason reason="Generate a mesh before you run." />
            </PB>
          }
        />
        <CorePair
          pair="DisabledReason/reason-fix"
          core={
            <PB>
              <div className="mat-assign-hint sim-run-hint" data-run-reason="1">
                <span className="sim-run-hint-msg">OpenFOAM was not found in WSL.</span>
                <button type="button" className="sim-fix-go">
                  Open Settings
                </button>
              </div>
            </PB>
          }
          kit={
            <PB>
              <DisabledReason reason="OpenFOAM was not found in WSL." fix={{ label: 'Open Settings', onFix: noop }} />
            </PB>
          }
        />
        <CorePair
          pair="Hint/muted"
          core={
            <PB>
              <p className="mat-assign-hint">Pick faces in the viewport or tree.</p>
            </PB>
          }
          kit={
            <PB>
              <Hint>Pick faces in the viewport or tree.</Hint>
            </PB>
          }
        />
        <CorePair
          pair="EmptyState/list"
          core={
            <PB>
              <ul style={{ listStyle: 'none' }}>
                <li className="hub-empty">No studies yet.</li>
              </ul>
            </PB>
          }
          kit={
            <PB>
              <ul style={{ listStyle: 'none' }}>
                <EmptyState as="li">No studies yet.</EmptyState>
              </ul>
            </PB>
          }
        />
        <CorePair
          pair="EmptyState/chart"
          core={
            <PB>
              <div className="mon-empty">Waiting for the first iteration.</div>
            </PB>
          }
          kit={
            <PB>
              <EmptyState variant="chart">Waiting for the first iteration.</EmptyState>
            </PB>
          }
        />
        <CorePair
          pair="NumberUnitInput/narrow-length"
          core={
            <PB>
              <span className="bc-value-row">
                <SciNumberInput value={25} label="Gap" onCommit={noop} />
                <span className="bc-unit-label">mm</span>
              </span>
            </PB>
          }
          kit={
            <PB>
              <NumberUnitInput label="Gap" quantity="length" valueSi={0.025} onCommitSi={noop} />
            </PB>
          }
        />
        <CorePair
          pair="NumberUnitInput/wide"
          core={
            <PB>
              <span className="bc-value-row">
                <SciNumberInput value={25} label="Gap" className="bc-input mat-wide-input" onCommit={noop} />
                <span className="bc-unit-label">mm</span>
              </span>
            </PB>
          }
          kit={
            <PB>
              <NumberUnitInput label="Gap" quantity="length" width="wide" valueSi={0.025} onCommitSi={noop} />
            </PB>
          }
        />
        <CorePair
          pair="NumberUnitInput/fill"
          core={
            <PB>
              <SF>
                <span className="bc-value-row">
                  <SciNumberInput value={500} label="Iterations" onCommit={noop} />
                </span>
              </SF>
            </PB>
          }
          kit={
            <PB>
              <SF>
                <NumberUnitInput label="Iterations" width="fill" valueSi={500} onCommitSi={noop} />
              </SF>
            </PB>
          }
        />
        <CorePair
          pair="Select/default"
          core={
            <PB>
              <select className="bc-select" aria-label="Pressure unit" value="kPa" onChange={noop}>
                <option value="Pa">Pa</option>
                <option value="kPa">kPa</option>
                <option value="psi">psi</option>
              </select>
            </PB>
          }
          kit={
            <PB>
              <Select
                label="Pressure unit"
                value="kPa"
                options={[
                  { value: 'Pa', label: 'Pa' },
                  { value: 'kPa', label: 'kPa' },
                  { value: 'psi', label: 'psi' },
                ]}
                onChange={noop}
              />
            </PB>
          }
        />
        {[false, true].map((on) => (
          <CorePair
            key={on ? 'on' : 'off'}
            pair={on ? 'Toggle/switch-on' : 'Toggle/switch-off'}
            core={
              <PB>
                <label className="switch">
                  <input type="checkbox" aria-label="Show edges" checked={on} onChange={noop} />
                  <span className="slider" />
                </label>
              </PB>
            }
            kit={
              <PB>
                <Toggle label="Show edges" checked={on} onChange={noop} />
              </PB>
            }
          />
        ))}
        {[false, true].map((on) => (
          <CorePair
            key={on ? 'on' : 'off'}
            pair={on ? 'Toggle/pill-on' : 'Toggle/pill-off'}
            core={
              <PB>
                <button type="button" className={on ? 'mesh-toggle is-on' : 'mesh-toggle'} aria-pressed={on} aria-label="Layers">
                  {on ? 'ON' : 'OFF'}
                </button>
              </PB>
            }
            kit={
              <PB>
                <Toggle label="Layers" variant="pill" checked={on} onChange={noop} />
              </PB>
            }
          />
        ))}
        <CorePair
          pair="Field/plain"
          core={
            <PB>
              <SF>
                <div className="mat-row schema-field">
                  <span className="mat-k">
                    <label htmlFor="kit-core-field-plain">Gap refinement factor</label>
                  </span>
                  <span className="mat-v">1.2</span>
                </div>
              </SF>
            </PB>
          }
          kit={
            <PB>
              <SF>
                <Field label="Gap refinement factor" htmlFor="kit-twin-field-plain">
                  1.2
                </Field>
              </SF>
            </PB>
          }
        />
        <CorePair
          pair="Field/help"
          core={
            <PB>
              <SF>
                <div className="mat-row schema-field">
                  <span className="mat-k" data-help="1">
                    <label htmlFor="kit-core-field-help">Residual p</label>
                    <span
                      className="mat-k-help"
                      tabIndex={0}
                      role="button"
                      aria-label="About Residual p"
                      aria-describedby="kit-core-field-help__help"
                    >
                      ?
                    </span>
                    <span className="mat-k-tip" role="tooltip" id="kit-core-field-help__help">
                      {HELP}
                    </span>
                  </span>
                  <span className="mat-v">1.2</span>
                </div>
              </SF>
            </PB>
          }
          kit={
            <PB>
              <SF>
                <Field label="Residual p" htmlFor="kit-twin-field-help" help={HELP}>
                  1.2
                </Field>
              </SF>
            </PB>
          }
        />
      </Group>
    </div>
  );
}
