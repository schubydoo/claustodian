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

/**
 * Writes a docs index and binary observations that corroborate `symbols` and nothing
 * else, and returns the arguments that point main() at them. Without it main() reads the
 * real data/ files, so which fixture symbols count as withheld would depend on live data.
 * Each file carries one unrelated entry, because main() refuses an empty one.
 */
async function evidenceArgs(
  dir: string,
  symbols: Array<{ symbol: string; type: string }>
): Promise<string[]> {
  const docsPath = join(dir, 'docs.json');
  const binaryPath = join(dir, 'binary-observations.json');
  const filler = { symbol: '--claustodian-unrelated', type: 'cli_flag' };
  await writeFile(docsPath, JSON.stringify({ symbols: [filler] }), 'utf-8');
  await writeFile(
    binaryPath,
    JSON.stringify({
      $generated_by: 'scripts/backfill-binary.ts',
      source: 'binary',
      symbols: [...symbols, filler],
    }),
    'utf-8'
  );
  return ['--docs', docsPath, '--binary', binaryPath];
}

const FIXTURE_SYMBOLS = [
  { symbol: '--turbo', type: 'cli_flag' },
  { symbol: 'CLAUDE_CODE_TURBO', type: 'env_var' },
  { symbol: '--safe-mode', type: 'cli_flag' },
  { symbol: '--claustodian-test-fixture', type: 'cli_flag' },
];

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

    const exitCode = await main([
      '--changelog',
      changelogPath,
      '--dataset',
      datasetPath,
      ...(await evidenceArgs(tmpDir, FIXTURE_SYMBOLS)),
    ]);

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

    const exitCode = await main([
      '--changelog',
      changelogPath,
      '--dataset',
      datasetPath,
      ...(await evidenceArgs(tmpDir, FIXTURE_SYMBOLS)),
    ]);

    expect(exitCode).toBe(1);
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('First missing symbol'));
  });

  it('returns 1 and logs an error when the dataset file cannot be loaded', async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'claustodian-checkcov-'));
    const changelogPath = join(tmpDir, 'CHANGELOG.md');
    await writeFile(changelogPath, FIXTURE_CHANGELOG, 'utf-8');
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const exitCode = await main([
      '--changelog',
      changelogPath,
      '--dataset',
      join(tmpDir, 'does-not-exist.json'),
    ]);

    expect(exitCode).toBe(1);
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('Failed to load changelog/dataset')
    );
  });

  it('ignores an unrecognized positional argument', async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'claustodian-checkcov-'));
    const changelogPath = join(tmpDir, 'CHANGELOG.md');
    const datasetPath = join(tmpDir, 'dataset.json');
    // Fixture symbol that can never appear in the dataset, so the exit code is
    // deterministic regardless of the real data.
    await writeFile(
      changelogPath,
      '# Changelog\n\n## 2.1.10\n\n- Added `--claustodian-test-fixture` flag.\n',
      'utf-8'
    );
    await writeFile(datasetPath, JSON.stringify({ symbols: [] }), 'utf-8');
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    // 'stray' matches no flag and is a positional, not a valueless option, so it
    // is skipped rather than throwing.
    const exitCode = await main([
      'stray',
      '--changelog',
      changelogPath,
      '--dataset',
      datasetPath,
      ...(await evidenceArgs(tmpDir, FIXTURE_SYMBOLS)),
    ]);

    expect(exitCode).toBe(1);
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('First missing symbol'));
  });

  it('throws when a trailing --dataset has no value', async () => {
    await expect(main(['--dataset'])).rejects.toThrow('--dataset requires a path argument');
  });

  it('throws when a trailing --changelog has no value', async () => {
    // The valueless flag fails loudly rather than falling through to fetching the
    // changelog from the network — matching generate-exports, which throws
    // '--data requires a directory argument' for the same mistake.
    await expect(main(['--changelog'])).rejects.toThrow('--changelog requires a path argument');
  });

  it('throws when a flag value is itself another flag', async () => {
    // `--changelog --dataset x` must not swallow --dataset as the changelog path;
    // a flag-shaped value is rejected the same as a missing one.
    await expect(main(['--changelog', '--dataset', 'x.json'])).rejects.toThrow(
      '--changelog requires a path argument'
    );
  });

  it('uses data/latest.json when --dataset is omitted', async () => {
    // Pins the datasetPath default: a never-matching fixture symbol keeps the
    // exit code deterministic while --dataset is absent, so the default path is
    // what gets read and named.
    tmpDir = await mkdtemp(join(tmpdir(), 'claustodian-checkcov-'));
    const changelogPath = join(tmpDir, 'CHANGELOG.md');
    await writeFile(
      changelogPath,
      '# Changelog\n\n## 2.1.10\n\n- Added `--claustodian-test-fixture` flag.\n',
      'utf-8'
    );
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    const exitCode = await main([
      '--changelog',
      changelogPath,
      ...(await evidenceArgs(tmpDir, FIXTURE_SYMBOLS)),
    ]);

    expect(exitCode).toBe(1);
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('data/latest.json'));
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('First missing symbol'));
  });

  it('fetches the changelog from the network when --changelog is omitted', async () => {
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
      const exitCode = await main([
        '--dataset',
        datasetPath,
        ...(await evidenceArgs(tmpDir, FIXTURE_SYMBOLS)),
      ]);
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
    await writeFile(
      datasetPath,
      JSON.stringify({ symbols: [], __marker: 'poison-parse' }),
      'utf-8'
    );
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    // Conditional on the file's own content rather than call ordering, so an
    // unrelated JSON.parse inside main() cannot absorb the throw.
    const realParse = JSON.parse.bind(JSON);
    const parseSpy = vi.spyOn(JSON, 'parse').mockImplementation((text, reviver) => {
      if (typeof text === 'string' && text.includes('poison-parse')) {
        throw 'dataset parse blew up as a plain string';
      }
      return realParse(text, reviver);
    });
    try {
      const exitCode = await main(['--changelog', changelogPath, '--dataset', datasetPath]);
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

    const exitCode = await main(['--changelog', changelogPath, '--dataset', datasetPath]);

    expect(exitCode).toBe(1);
  });

  it('does not report a symbol that only the changelog supports', async () => {
    // The scrape withholds `--turbo` and `CLAUDE_CODE_TURBO` (no binary or docs
    // evidence), so their absence from the dataset is not a gap.
    tmpDir = await mkdtemp(join(tmpdir(), 'claustodian-checkcov-'));
    const changelogPath = join(tmpDir, 'CHANGELOG.md');
    const datasetPath = join(tmpDir, 'dataset.json');
    await writeFile(changelogPath, FIXTURE_CHANGELOG, 'utf-8');
    await writeFile(
      datasetPath,
      JSON.stringify({ symbols: [makeSymbol({ symbol: '--safe-mode', type: 'cli_flag' })] }),
      'utf-8'
    );
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const evidence = await evidenceArgs(tmpDir, [{ symbol: '--safe-mode', type: 'cli_flag' }]);

    const exitCode = await main([
      '--changelog',
      changelogPath,
      '--dataset',
      datasetPath,
      ...evidence,
    ]);

    expect(exitCode).toBe(0);
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('0 changelog symbol'));
  });

  it('prints the withheld symbols first named after --withheld-since', async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'claustodian-checkcov-'));
    const changelogPath = join(tmpDir, 'CHANGELOG.md');
    const datasetPath = join(tmpDir, 'dataset.json');
    await writeFile(changelogPath, FIXTURE_CHANGELOG, 'utf-8');
    await writeFile(datasetPath, JSON.stringify({ symbols: [] }), 'utf-8');
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    // Nothing corroborates any fixture symbol, so all three are withheld. Only the
    // two that 2.1.10 introduces are newer than 2.0.5.
    const evidence = await evidenceArgs(tmpDir, []);

    const exitCode = await main([
      '--changelog',
      changelogPath,
      '--dataset',
      datasetPath,
      ...evidence,
      '--withheld-since',
      '2.0.5',
    ]);

    expect(exitCode).toBe(0);
    expect(logSpy).toHaveBeenCalledWith('--turbo CLAUDE_CODE_TURBO');
  });

  it('refuses an empty binary observations file', async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'claustodian-checkcov-'));
    const changelogPath = join(tmpDir, 'CHANGELOG.md');
    const datasetPath = join(tmpDir, 'dataset.json');
    await writeFile(changelogPath, FIXTURE_CHANGELOG, 'utf-8');
    await writeFile(datasetPath, JSON.stringify({ symbols: [] }), 'utf-8');
    const evidence = await evidenceArgs(tmpDir, []);
    await writeFile(
      join(tmpDir, 'binary-observations.json'),
      JSON.stringify({
        $generated_by: 'scripts/backfill-binary.ts',
        source: 'binary',
        symbols: [],
      }),
      'utf-8'
    );
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const exitCode = await main([
      '--changelog',
      changelogPath,
      '--dataset',
      datasetPath,
      ...evidence,
    ]);

    expect(exitCode).toBe(1);
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('has 0 symbols'));
  });

  it('names a version, not a path, when --withheld-since has no value', async () => {
    await expect(main(['--withheld-since'])).rejects.toThrow(
      '--withheld-since requires a version argument'
    );
  });

  it('throws when a trailing --binary has no value', async () => {
    await expect(main(['--binary'])).rejects.toThrow('--binary requires a path argument');
  });

  it('leaves out a withheld name from a release newer than the dataset', async () => {
    // check-coverage fetches the changelog again. A release published after the scrape
    // is not in the dataset, so its names are not this run's to report.
    tmpDir = await mkdtemp(join(tmpdir(), 'claustodian-checkcov-'));
    const changelogPath = join(tmpDir, 'CHANGELOG.md');
    const datasetPath = join(tmpDir, 'dataset.json');
    await writeFile(changelogPath, FIXTURE_CHANGELOG, 'utf-8');
    await writeFile(
      datasetPath,
      JSON.stringify({ claudeCodeVersion: '2.0.5', symbols: [] }),
      'utf-8'
    );
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    const exitCode = await main([
      '--changelog',
      changelogPath,
      '--dataset',
      datasetPath,
      ...(await evidenceArgs(tmpDir, [])),
      '--withheld-since',
      '2.0.4',
    ]);

    expect(exitCode).toBe(0);
    expect(logSpy).toHaveBeenCalledWith('--safe-mode');
  });
});
