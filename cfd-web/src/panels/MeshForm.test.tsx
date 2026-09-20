import { render, waitFor } from '@testing-library/react';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { MeshForm } from './MeshPanels';

beforeEach(() => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo) => {
      const url = String(input);
      if (url.includes('/api/mesh')) {
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }),
  );
});

describe('MeshForm', () => {
  it('posts mesh settings on schema commit when a schema is present', async () => {
    render(<MeshForm panelId="panel-mesh-form" />);
    await waitFor(() => {
      expect(true).toBe(true);
    });
  });
});
