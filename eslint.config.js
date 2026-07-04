// Copyright 2026 Schuby
// SPDX-License-Identifier: Apache-2.0

// @ts-check
import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      'dist/**',
      'node_modules/**',
      'scratch/**',
      '.claude/**',
      'data/**/*.yaml',
      'data/**/*.toml',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.ts'],
  }
);
