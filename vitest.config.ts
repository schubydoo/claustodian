// Copyright 2026 Schuby
// SPDX-License-Identifier: Apache-2.0

import { configDefaults, defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    passWithNoTests: true,
    // Only this checkout's own suite should run. Exclude `.claude/` so a linked
    // git worktree (e.g. `.claude/worktrees/*`, which carries its own copy of
    // `scripts/**/*.test.ts`) isn't discovered and double-counted locally.
    exclude: [...configDefaults.exclude, '.claude/**'],
    // In CI, also emit a JUnit report alongside the console output so
    // codecov/test-results-action can upload it for Test Analytics (flaky/
    // failed-test tracking). Kept CI-only to avoid a stray file locally,
    // especially in watch mode. See .github/workflows/{validate-pr,coverage}.yml.
    reporters: process.env.CI
      ? ['default', ['junit', { outputFile: 'test-report.junit.xml' }]]
      : ['default'],
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
