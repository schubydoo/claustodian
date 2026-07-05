// Copyright 2026 Schuby
// SPDX-License-Identifier: Apache-2.0

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { main } from './diff-snapshots.js';
import type { SymbolRecord } from './scrape-changelog.js';

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
  process.argv = ['node', 'diff-snapshots.ts', ...args];
  try {
    return await fn();
  } finally {
    process.argv = originalArgv;
  }
}

describe('diff-snapshots main()', () => {
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

  it('returns 0 and prints a summary when both snapshot files parse', async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'claustodian-diff-'));
    const prevPath = join(tmpDir, 'prev.json');
    const nextPath = join(tmpDir, 'next.json');
    await writeFile(
      prevPath,
      JSON.stringify({
        symbols: [makeSymbol({ symbol: '--foo' }), makeSymbol({ symbol: '--gone' })],
      }),
      'utf-8'
    );
    await writeFile(
      nextPath,
      JSON.stringify({
        symbols: [
          makeSymbol({ symbol: '--foo', status: 'deprecated' }),
          makeSymbol({ symbol: '--bar' }),
        ],
      }),
      'utf-8'
    );
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    const exitCode = await withArgv([prevPath, nextPath], main);

    expect(exitCode).toBe(0);
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('added:   1'));
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('removed: 1'));
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('changed: 1'));
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('Removed symbols'));
  });

  it('returns 1 and prints usage when fewer than two paths are given', async () => {
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const exitCode = await withArgv(['/only/one/path.json'], main);

    expect(exitCode).toBe(1);
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('Usage:'));
  });

  it('returns 1 when a snapshot file is missing or fails to parse', async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'claustodian-diff-'));
    const prevPath = join(tmpDir, 'prev.json');
    const badPath = join(tmpDir, 'not-json.json');
    await writeFile(
      prevPath,
      JSON.stringify({ symbols: [makeSymbol({ symbol: '--foo' })] }),
      'utf-8'
    );
    await writeFile(badPath, '{ not valid json', 'utf-8');
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const exitCode = await withArgv([prevPath, badPath], main);

    expect(exitCode).toBe(1);
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('Failed to read/parse snapshot file')
    );
  });

  it('returns 1 when a snapshot file does not look like a snapshot (missing symbols array)', async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'claustodian-diff-'));
    const prevPath = join(tmpDir, 'prev.json');
    const wrongShapePath = join(tmpDir, 'wrong.json');
    await writeFile(
      prevPath,
      JSON.stringify({ symbols: [makeSymbol({ symbol: '--foo' })] }),
      'utf-8'
    );
    await writeFile(wrongShapePath, JSON.stringify({ notSymbols: [] }), 'utf-8');
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const exitCode = await withArgv([prevPath, wrongShapePath], main);

    expect(exitCode).toBe(1);
  });
});
