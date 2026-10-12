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
