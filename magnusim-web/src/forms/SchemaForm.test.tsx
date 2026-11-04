import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { RJSFSchema } from '@rjsf/utils';
import { SchemaForm } from './SchemaForm';
import { registerFieldWidget } from '../plugin-api';
import { deleteFieldWidget } from '../plugin-api/fieldWidgets';
import type { FieldWidgetProps } from '../plugin-ui';

const schema: RJSFSchema = {
  type: 'object',
  properties: {
    fineness: { type: 'integer', title: 'Fineness', default: 5, minimum: 1, maximum: 10 },
    hex: { type: 'boolean', title: 'Hex element core', default: true },
    hidden: {
      type: 'number',
      title: 'Hidden',
      'x-cfddesk': { depends_on: { hex: false } },
    },
  },
};

describe('SchemaForm', () => {
  afterEach(() => cleanup());
  it('renders number and bool kinds and Done', () => {
    render(<SchemaForm schema={schema} formData={{ fineness: 5, hex: true }} onCommit={() => {}} />);
    expect(screen.getByLabelText('Fineness')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Done' })).toBeInTheDocument();
    expect(screen.queryByLabelText('Hidden')).not.toBeInTheDocument();
  });

  it('hides depends_on fields and commits on change', async () => {
    const onCommit = vi.fn();
    render(<SchemaForm schema={schema} formData={{ fineness: 5, hex: true }} onCommit={onCommit} />);
    fireEvent.change(screen.getAllByLabelText('Fineness')[0], { target: { value: '1' } });
    await new Promise((r) => setTimeout(r, 350));
    expect(onCommit).toHaveBeenCalled();
  });

  it('commitOnBlur: a typed number commits when the field is left (at once), never in the middle of typing', async () => {
    const counts: RJSFSchema = { type: 'object', properties: { end_time: { type: 'integer', title: 'Number of iterations', minimum: 1 } } };
    const onCommit = vi.fn();
    render(<SchemaForm schema={counts} formData={{ end_time: 500 }} onCommit={onCommit} hideFooter commitOnBlur />);
    const box = screen.getByLabelText('Number of iterations') as HTMLInputElement;
    fireEvent.focus(box);
    fireEvent.change(box, { target: { value: '2' } });
    await new Promise((r) => setTimeout(r, 350));
    fireEvent.change(box, { target: { value: '200' } });
    await new Promise((r) => setTimeout(r, 350));
    expect(onCommit).not.toHaveBeenCalled();
    fireEvent.blur(box);
    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(onCommit.mock.calls[0][0].end_time).toBe(200);
    // Without it, a pause in typing commits what is typed so far (0.3 s).
    cleanup();
    const live = vi.fn();
    render(<SchemaForm schema={counts} formData={{ end_time: 500 }} onCommit={live} hideFooter />);
    fireEvent.change(screen.getByLabelText('Number of iterations'), { target: { value: '2' } });
    await new Promise((r) => setTimeout(r, 350));
    expect(live.mock.calls.at(-1)?.[0].end_time).toBe(2);
  });

  it('a temperature field (API 1.8) types in °C or °F with a K/°C/°F picker, and commits K', async () => {
    const thermal: RJSFSchema = {
      type: 'object',
      properties: {
        t_ref: { type: 'number', title: 'Reference temperature', default: 293.15, 'x-cfddesk': { quantity: 'temperature' } },
      },
    };
    const onCommit = vi.fn();
    render(<SchemaForm schema={thermal} formData={{ t_ref: 293.15 }} onCommit={onCommit} />);
    const unit = screen.getByLabelText('Reference temperature unit') as HTMLSelectElement;
    expect([...unit.options].map((o) => o.value)).toEqual(['K', '°C', '°F']);
    expect(unit.value).toBe('°C');
    const box = screen.getAllByLabelText('Reference temperature')[0] as HTMLInputElement;
    expect(box.value).toBe('20');
    fireEvent.change(unit, { target: { value: 'K' } });
    expect((screen.getAllByLabelText('Reference temperature')[0] as HTMLInputElement).value).toBe('293.15');
    fireEvent.change(screen.getAllByLabelText('Reference temperature')[0], { target: { value: '300' } });
    fireEvent.blur(screen.getAllByLabelText('Reference temperature')[0]);
    await new Promise((r) => setTimeout(r, 350));
    expect(onCommit).toHaveBeenCalled();
    expect(onCommit.mock.calls.at(-1)?.[0].t_ref).toBeCloseTo(300, 9);
  });

  it('a temperature field in an imperial project starts on °F', () => {
    window.__CFD_PROJECT_UNITS__ = () => 'imperial';
    try {
      const thermal: RJSFSchema = {
        type: 'object',
        properties: { t: { type: 'number', title: 'Wall temperature', 'x-cfddesk': { quantity: 'temperature' } } },
      };
      render(<SchemaForm schema={thermal} formData={{ t: 373.15 }} onCommit={() => {}} />);
      expect((screen.getByLabelText('Wall temperature unit') as HTMLSelectElement).value).toBe('°F');
      expect((screen.getAllByLabelText('Wall temperature')[0] as HTMLInputElement).value).toBe('212');
    } finally {
      delete window.__CFD_PROJECT_UNITS__;
    }
  });

  it('renders a COARSE-to-FINE slider for the range widget', () => {
    const ranged: RJSFSchema = {
      type: 'object',
      properties: {
        fineness: {
          type: 'integer',
          title: 'Fineness',
          default: 5,
          minimum: 1,
          maximum: 10,
          'x-cfddesk': { widget: 'range' },
        },
      },
    };
    render(<SchemaForm schema={ranged} formData={{ fineness: 5 }} onCommit={() => {}} />);
    const slider = screen.getByLabelText('Fineness') as HTMLInputElement;
    expect(slider.type).toBe('range');
    expect(slider.min).toBe('1');
    expect(slider.max).toBe('10');
    expect(screen.getByText('COARSE')).toBeInTheDocument();
    expect(screen.getByText('FINE')).toBeInTheDocument();
  });

  it('shows a description as hover help and collapses advanced fields', () => {
    const described: RJSFSchema = {
      type: 'object',
      properties: {
        residual_p: {
          type: 'number',
          title: 'Residual p',
          default: 1e-6,
          description: 'Convergence target for the pressure equation.',
        },
        ddt_default: {
          type: 'string',
          title: 'Time scheme',
          default: 'steadyState',
          'x-cfddesk': { advanced: true },
        },
      },
    };
    const { container } = render(
      <SchemaForm schema={described} formData={{}} onCommit={() => {}} />,
    );
    screen.getByText('Residual p');
    const help = screen.getByRole('button', { name: 'About Residual p' });
    expect(screen.getByRole('tooltip', { hidden: true })).toHaveTextContent('Convergence target for the pressure equation.');
    expect(help).toHaveAttribute('aria-describedby', screen.getByRole('tooltip', { hidden: true }).id);
    const details = container.querySelector('details.mesh-advanced');
    expect(details).not.toBeNull();
    expect(details?.querySelector('[data-schema-key="ddt_default"]')).not.toBeNull();
  });

  it('shows tiny numbers in scientific notation', () => {
    const tiny: RJSFSchema = {
      type: 'object',
      properties: {
        residual_u: { type: 'number', title: 'Residual U', default: 1e-6 },
      },
    };
    render(<SchemaForm schema={tiny} formData={{ residual_u: 1e-6 }} onCommit={() => {}} />);
    expect((screen.getByLabelText('Residual U') as HTMLInputElement).value).toBe('1.0000e-6');
  });

  it('uses a field widget registered after the form opened, and falls back when it is removed', () => {
    // Plugin UIs can load after a panel is open. The schema and data objects stay
    // the same throughout, so only the widget registry can rebuild the form.
    const lateSchema: RJSFSchema = {
      type: 'object',
      properties: {
        rate: { type: 'integer', title: 'Rate', default: 2, 'x-cfddesk': { widget: 'late-test.rate' } },
      },
    };
    const data = { rate: 2 };
    function LateRate(p: FieldWidgetProps) {
      return <output data-late-widget="1">{`late ${String(p.value)}`}</output>;
    }
    const { container } = render(<SchemaForm schema={lateSchema} formData={data} onCommit={() => {}} />);
    try {
      expect(container.querySelector('[data-schema-key="rate"] input.bc-input')).not.toBeNull();
      expect(container.querySelector('[data-late-widget]')).toBeNull();

      act(() => registerFieldWidget('late-test.rate', LateRate));
      expect(container.querySelector('[data-schema-key="rate"] [data-late-widget]')).toHaveTextContent('late 2');
      expect(container.querySelector('[data-schema-key="rate"] input.bc-input')).toBeNull();

      act(() => deleteFieldWidget('late-test.rate'));
      expect(container.querySelector('[data-late-widget]')).toBeNull();
      expect(container.querySelector('[data-schema-key="rate"] input.bc-input')).not.toBeNull();
    } finally {
      deleteFieldWidget('late-test.rate');
    }
  });
});

describe('fieldNotes', () => {
  it('a note goes in a line under its field, and only there', () => {
    const schema = {
      type: 'object',
      properties: { a: { type: 'number', title: 'A' }, b: { type: 'number', title: 'B' } },
    } as RJSFSchema;
    const { container } = render(<SchemaForm schema={schema} formData={{ a: 1, b: 2 }} hideFooter onCommit={() => {}} fieldNotes={{ b: <span data-mark="b">Takes effect later</span> }} />);
    const notes = [...container.querySelectorAll('[data-schema-note]')];
    expect(notes.map((n) => [n.getAttribute('data-schema-note'), n.textContent])).toEqual([['b', 'Takes effect later']]);
    expect(notes[0].previousElementSibling?.getAttribute('data-schema-key')).toBe('b');
  });
});

// RH3 (host API 1.9): cautions, Advanced settings' sub-heads, and bounds that apply only to an edit.
describe('RH3: cautions, sub-heads and bounds on an edit', () => {
  const FIRST =
    'First-order schemes are more stable but less accurate. Fix the time step or the mesh first; use first order only to get a run started.';
  const numerics: RJSFSchema = {
    type: 'object',
    properties: {
      momentum_convection: {
        type: 'string',
        title: 'Momentum convection',
        enum: ['first_order', 'second_order'],
        default: 'second_order',
        'x-cfddesk': { group: 'schemes', advanced: true, caution: { first_order: FIRST } },
      },
      relax_turbulence: { type: 'number', title: 'Relaxation turbulence', minimum: 0, maximum: 1, 'x-cfddesk': { group: 'relaxation', advanced: true } },
      p_tolerance: { type: 'number', title: 'p tolerance', default: 1e-7, minimum: 1e-12, maximum: 1e-3, 'x-cfddesk': { group: 'linear_solvers', advanced: true } },
      p_rel_tol: { type: 'number', title: 'p relative tolerance', default: 0.01, minimum: 0, maximum: 0.5, 'x-cfddesk': { group: 'linear_solvers', advanced: true } },
      velocity_limit: { type: 'string', title: 'Velocity limit', enum: ['auto', 'off'], default: 'auto', 'x-cfddesk': { group: 'limiters', advanced: true } },
    },
  };

  it("shows a value's caution under its field, only while that value is chosen", () => {
    const { container, rerender } = render(<SchemaForm schema={numerics} formData={{ momentum_convection: 'second_order' }} onCommit={() => {}} hideFooter />);
    expect(container.querySelector('[data-schema-caution]')).toBeNull();
    rerender(<SchemaForm schema={numerics} formData={{ momentum_convection: 'first_order' }} onCommit={() => {}} hideFooter />);
    expect(container.querySelector('[data-schema-caution="momentum_convection"]')?.textContent).toBe(FIRST);
  });

  it("puts Advanced settings' fields under their sub-heads (Schemes, Linear solvers, Limiters), the others first", () => {
    const { container } = render(<SchemaForm schema={numerics} formData={{}} onCommit={() => {}} hideFooter />);
    const heads = [...container.querySelectorAll('[data-schema-subhead]')].map((h) => h.textContent);
    expect(heads).toEqual(['Schemes', 'Linear solvers', 'Limiters']);
    const order = [...container.querySelectorAll('details.mesh-advanced [data-schema-key], details.mesh-advanced [data-schema-subhead]')].map(
      (e) => e.getAttribute('data-schema-key') || `# ${e.textContent}`,
    );
    expect(order).toEqual(['relax_turbulence', '# Schemes', 'momentum_convection', '# Linear solvers', 'p_tolerance', 'p_rel_tol', '# Limiters', 'velocity_limit']);
    // A form without those groups has no sub-head (the mesh panel's Advanced settings).
    cleanup();
    const plain = render(<SchemaForm schema={schema} formData={{ fineness: 5, hex: true }} onCommit={() => {}} hideFooter />);
    expect(plain.container.querySelector('[data-schema-subhead]')).toBeNull();
  });

  it('boundsOnEdit: a saved value outside its range is shown as used as saved and kept on another edit', async () => {
    const onCommit = vi.fn();
    const { container } = render(<SchemaForm schema={numerics} formData={{ p_tolerance: 0.01, p_rel_tol: 0.01 }} onCommit={onCommit} hideFooter boundsOnEdit />);
    expect(container.querySelector('[data-schema-saved-outside="p_tolerance"]')?.textContent).toBe('Saved as 1e-2, outside 1e-12 to 1e-3. It is used as saved.');
    const rel = screen.getByLabelText('p relative tolerance');
    fireEvent.change(rel, { target: { value: '0.05' } });
    await new Promise((r) => setTimeout(r, 350));
    expect(onCommit).toHaveBeenLastCalledWith(expect.objectContaining({ p_rel_tol: 0.05, p_tolerance: 0.01 }));
  });

  it('boundsOnEdit: an edit outside its range is not saved, and the field says why', async () => {
    const onCommit = vi.fn();
    const { container } = render(<SchemaForm schema={numerics} formData={{ p_tolerance: 1e-7, p_rel_tol: 0.01 }} onCommit={onCommit} hideFooter boundsOnEdit />);
    fireEvent.change(screen.getByLabelText('p relative tolerance'), { target: { value: '0.9' } });
    await new Promise((r) => setTimeout(r, 350));
    expect(onCommit).toHaveBeenLastCalledWith(expect.objectContaining({ p_rel_tol: 0.01 }));
    expect(container.querySelector('[data-schema-refused="p_rel_tol"]')?.textContent).toBe('Not saved: 0.9 is outside 0 to 0.5.');
    fireEvent.change(screen.getByLabelText('p tolerance'), { target: { value: '0.5' } });
    await new Promise((r) => setTimeout(r, 350));
    expect(container.querySelector('[data-schema-refused="p_tolerance"]')?.textContent).toBe('Not saved: 5e-1 is outside 1e-12 to 1e-3.');
    // Back in range: saved, and the words go.
    fireEvent.change(screen.getByLabelText('p relative tolerance'), { target: { value: '0.2' } });
    fireEvent.change(screen.getByLabelText('p tolerance'), { target: { value: '1e-6' } });
    await new Promise((r) => setTimeout(r, 350));
    expect(onCommit).toHaveBeenLastCalledWith(expect.objectContaining({ p_rel_tol: 0.2, p_tolerance: 1e-6 }));
    expect(container.querySelector('[data-schema-refused]')).toBeNull();
  });

  it('a blank-able choice starts on "Not set", not on its first choice', () => {
    const blank: RJSFSchema = {
      type: 'object',
      properties: { grad_limiter: { type: 'string', title: 'Gradient limiter', enum: ['strong', 'light'], default: null, 'x-cfddesk': { optional: true } } as RJSFSchema },
    };
    render(<SchemaForm schema={blank} formData={{ grad_limiter: null }} onCommit={() => {}} hideFooter />);
    const select = screen.getByLabelText('Gradient limiter') as HTMLSelectElement;
    expect(select.selectedOptions[0].textContent).toBe('Not set');
    expect([...select.options].map((o) => o.textContent)).toEqual(['Not set', 'strong', 'light']);
  });

  it('without boundsOnEdit a form commits what is typed, as before', async () => {
    const onCommit = vi.fn();
    render(<SchemaForm schema={numerics} formData={{ p_rel_tol: 0.01 }} onCommit={onCommit} hideFooter />);
    fireEvent.change(screen.getByLabelText('p relative tolerance'), { target: { value: '0.9' } });
    await new Promise((r) => setTimeout(r, 350));
    expect(onCommit).toHaveBeenLastCalledWith(expect.objectContaining({ p_rel_tol: 0.9 }));
  });
});
