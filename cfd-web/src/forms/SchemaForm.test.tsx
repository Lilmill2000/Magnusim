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
});
