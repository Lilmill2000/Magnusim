// Unit tests (tests/*.test.ts): geometry, units, the scene file. The GPU solver is
// tested in the browser (e2e/).
// SPDX-License-Identifier: GPL-3.0-or-later
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: { include: ['tests/**/*.test.ts'], environment: 'node' },
});
