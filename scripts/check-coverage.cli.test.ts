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

  it('ignores unknown args and a trailing --dataset, falling back to the default dataset path', async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'claustodian-checkcov-'));
    const changelogPath = join(tmpDir, 'CHANGELOG.md');
    // This test runs against the repo's real data/latest.json, so the fixture
    // symbols must be names that can never appear in it — the shared fixture's
    // plausible-looking flags would couple the exit code to future dataset
    // regenerations.
    await writeFile(
      changelogPath,
      '# Changelog\n\n## 2.1.10\n\n- Added `--claustodian-test-fixture` flag.\n',
      'utf-8'
    );
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    // 'stray' matches no flag, and the trailing --dataset has no value, so the
    // default data/latest.json (the repo's own) must be used.
    const exitCode = await withArgv(['stray', '--changelog', changelogPath, '--dataset'], main);

    expect(exitCode).toBe(1);
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('data/latest.json'));
  });

  it('falls back to fetching the changelog when a trailing --changelog has no value', async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'claustodian-checkcov-'));
    const datasetPath = join(tmpDir, 'dataset.json');
    await writeFile(
      datasetPath,
      JSON.stringify({ symbols: [makeSymbol({ symbol: '--safe-mode', type: 'cli_flag' })] }),
      'utf-8'
    );
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const realFetch = globalThis.fetch;
    const fetchSpy = vi.fn(
      async () => new Response(FIXTURE_CHANGELOG, { status: 200 })
    ) as unknown as typeof fetch;
    globalThis.fetch = fetchSpy;
    try {
      const exitCode = await withArgv(['--dataset', datasetPath, '--changelog'], main);
      expect(exitCode).toBe(1);
      expect(fetchSpy).toHaveBeenCalled();
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it('stringifies a non-Error throw when reporting a load failure', async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'claustodian-checkcov-'));
    const changelogPath = join(tmpDir, 'CHANGELOG.md');
    const datasetPath = join(tmpDir, 'dataset.json');
    await writeFile(changelogPath, FIXTURE_CHANGELOG, 'utf-8');
    await writeFile(datasetPath, JSON.stringify({ symbols: [] }), 'utf-8');
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const parseSpy = vi.spyOn(JSON, 'parse').mockImplementationOnce(() => {
      throw 'dataset parse blew up as a plain string';
    });
    try {
      const exitCode = await withArgv(
        ['--changelog', changelogPath, '--dataset', datasetPath],
        main
      );
      expect(exitCode).toBe(1);
      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining('dataset parse blew up as a plain string')
      );
    } finally {
      parseSpy.mockRestore();
    }
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
