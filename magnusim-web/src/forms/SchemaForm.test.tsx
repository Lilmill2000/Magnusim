import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { RJSFSchema } from '@rjsf/utils';
import { SchemaForm } from './SchemaForm';

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
});
