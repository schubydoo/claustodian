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
    },
  },
});
