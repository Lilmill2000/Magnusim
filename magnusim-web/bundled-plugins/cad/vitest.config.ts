// Unit tests (tests/**). DOM tests run in jsdom; kernel tests that load the
// real wasm run in Node (// @vitest-environment node at the top of the file).
// '@magnusim/workspace' exists only inside the host frame: tests use the fake.
// SPDX-License-Identifier: GPL-3.0-or-later
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  esbuild: { jsx: 'automatic' },
  resolve: {
    alias: {
      '@magnusim/workspace': fileURLToPath(new URL('./tests/fakes/workspace-sdk.ts', import.meta.url)),
    },
  },
  test: {
    environment: 'jsdom',
    include: ['tests/**/*.test.ts', 'tests/**/*.test.tsx'],
    testTimeout: 30_000,
  },
});
