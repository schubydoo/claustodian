// Copyright 2026 Schuby
// SPDX-License-Identifier: Apache-2.0

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { main } from './check-coverage.js';
import type { SymbolRecord } from './scrape-changelog.js';

const FIXTURE_CHANGELOG = `# Changelog

## 2.1.10

- Added \`--turbo\` flag for faster runs.
- Added \`CLAUDE_CODE_TURBO\` environment variable to control it.

## 2.0.5

- Added \`--safe-mode\` flag for troubleshooting.
`;

function makeSymbol(overrides: Partial<SymbolRecord> = {}): SymbolRecord {
  return {
    symbol: '--safe-mode',
    type: 'cli_flag',
    first_seen: '2.0.5',
    removed_in: null,
    status: 'active',
    provenance: 'changelog',
    confidence: 'high',
    description: 'Starts Claude Code with troubleshooting mode.',
    source_url: 'https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md',
    category: 'startup',
    ...overrides,
  };
}

async function withArgv<T>(args: string[], fn: () => Promise<T>): Promise<T> {
  const originalArgv = process.argv;
  process.argv = ['node', 'check-coverage.ts', ...args];
  try {
    return await fn();
  } finally {
    process.argv = originalArgv;
  }
}

describe('check-coverage main()', () => {
  let tmpDir: string | undefined;
  let logSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;

  afterEach(async () => {
    logSpy?.mockRestore();
    errorSpy?.mockRestore();
    if (tmpDir) {
      await rm(tmpDir, { recursive: true, force: true });
      tmpDir = undefined;
    }
  });

  it('returns 0 when the dataset covers every changelog symbol', async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'claustodian-checkcov-'));
    const changelogPath = join(tmpDir, 'CHANGELOG.md');
    const datasetPath = join(tmpDir, 'dataset.json');
    await writeFile(changelogPath, FIXTURE_CHANGELOG, 'utf-8');
    await writeFile(
      datasetPath,
      JSON.stringify({
        symbols: [
          makeSymbol({ symbol: '--turbo', type: 'cli_flag' }),
          makeSymbol({ symbol: 'CLAUDE_CODE_TURBO', type: 'env_var' }),
          makeSymbol({ symbol: '--safe-mode', type: 'cli_flag' }),
        ],
      }),
      'utf-8'
    );
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    const exitCode = await withArgv(['--changelog', changelogPath, '--dataset', datasetPath], main);

    expect(exitCode).toBe(0);
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('0 changelog symbol'));
  });

  it('returns 1 and lists the missing symbol(s) when the dataset is incomplete', async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'claustodian-checkcov-'));
    const changelogPath = join(tmpDir, 'CHANGELOG.md');
    const datasetPath = join(tmpDir, 'dataset.json');
    await writeFile(changelogPath, FIXTURE_CHANGELOG, 'utf-8');
    await writeFile(
      datasetPath,
      JSON.stringify({
        symbols: [makeSymbol({ symbol: '--safe-mode', type: 'cli_flag' })],
      }),
      'utf-8'
    );
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    const exitCode = await withArgv(['--changelog', changelogPath, '--dataset', datasetPath], main);

    expect(exitCode).toBe(1);
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('First missing symbol'));
  });

  it('returns 1 and logs an error when the dataset file cannot be loaded', async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'claustodian-checkcov-'));
    const changelogPath = join(tmpDir, 'CHANGELOG.md');
    await writeFile(changelogPath, FIXTURE_CHANGELOG, 'utf-8');
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const exitCode = await withArgv(
      ['--changelog', changelogPath, '--dataset', join(tmpDir, 'does-not-exist.json')],
      main
    );

    expect(exitCode).toBe(1);
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('Failed to load changelog/dataset')
    );
  });

  it('returns 1 when the dataset file does not look like a snapshot (missing symbols array)', async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'claustodian-checkcov-'));
    const changelogPath = join(tmpDir, 'CHANGELOG.md');
    const datasetPath = join(tmpDir, 'dataset.json');
    await writeFile(changelogPath, FIXTURE_CHANGELOG, 'utf-8');
    await writeFile(datasetPath, JSON.stringify({ notSymbols: [] }), 'utf-8');
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const exitCode = await withArgv(['--changelog', changelogPath, '--dataset', datasetPath], main);

    expect(exitCode).toBe(1);
  });
});
