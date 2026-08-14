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
      // worker/ is included so the Cloudflare Worker is measured like everything
      // else. Without it the codecov component for the Worker would report no
      // data at all, which reads as "nothing to see" rather than "not measured".
      include: ['scripts/**/*.ts', 'worker/**/*.js'],
      exclude: ['scripts/**/*.test.ts', 'worker/**/*.test.js'],
      // Enforced floor (the source of truth codecov.yml's project status mirrors).
      // Actual coverage is 100 on every metric; the floor stays below it so a
      // future PR with a legitimately hard-to-cover line degrades gracefully
      // instead of failing CI outright.
      thresholds: {
        statements: 95,
        branches: 90,
        functions: 95,
        lines: 95,
      },
    },
  },
});
