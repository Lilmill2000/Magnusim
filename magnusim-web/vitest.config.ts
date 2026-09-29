import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    // Bundled plugins' UI tests run with the core's (their components live in the core's panels).
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx', 'bundled-plugins/*/ui/**/*.test.tsx'],
    setupFiles: ['src/test/setup.ts'],
  },
});
