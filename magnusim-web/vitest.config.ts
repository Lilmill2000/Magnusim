import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  // A plugin UI imports the kit by name (the app serves it the host's kit; tsconfig.src.json maps it too).
  resolve: { alias: { '@magnusim/plugin-ui': fileURLToPath(new URL('./src/plugin-ui/index.ts', import.meta.url)) } },
  test: {
    environment: 'jsdom',
    // Bundled plugins' UI tests run with the core's (their components live in the core's panels).
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx', 'bundled-plugins/*/ui/**/*.test.tsx'],
    setupFiles: ['src/test/setup.ts'],
  },
});
