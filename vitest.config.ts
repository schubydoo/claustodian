// Copyright 2026 Schuby
// SPDX-License-Identifier: Apache-2.0

import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    passWithNoTests: true,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'text-summary', 'lcov'],
      reportsDirectory: 'coverage',
      include: ['scripts/**/*.ts'],
      exclude: ['scripts/**/*.test.ts'],
      // Enforced floor (the source of truth codecov.yml's project status mirrors).
      // Set below current (~92/80/82/93) with headroom to catch regressions.
      thresholds: {
        statements: 85,
        branches: 70,
        functions: 75,
        lines: 85,
      },
    },
  },
});
