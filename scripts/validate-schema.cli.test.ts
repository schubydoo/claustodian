// Copyright 2026 Schuby
// SPDX-License-Identifier: Apache-2.0

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { main } from './validate-schema.js';

function validSymbol(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    symbol: '--safe-mode',
    type: 'cli_flag',
    first_seen: '2.1.201',
    removed_in: null,
    status: 'active',
    provenance: 'changelog',
    confidence: 'high',
    description: 'Enables safe mode.',
    source_url: 'https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md',
    category: 'startup',
    ...overrides,
  };
}

function validSnapshot(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    claudeCodeVersion: '2.1.201',
    schemaVersion: '1.0.0',
    symbols: [validSymbol()],
    ...overrides,
  };
}

function validIndex(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: '1.0.0',
    latest: '2.1.201',
    versions: ['2.1.201'],
    ...overrides,
  };
}

async function withArgv<T>(args: string[], fn: () => Promise<T>): Promise<T> {
  const originalArgv = process.argv;
  process.argv = ['node', 'validate-schema.ts', ...args];
  try {
    return await fn();
  } finally {
    process.argv = originalArgv;
  }
}

describe('validate-schema main()', () => {
  let tmpDir: string | undefined;
  let logSpy: ReturnType<typeof vi.spyOn>;

  afterEach(async () => {
    logSpy?.mockRestore();
    if (tmpDir) {
      await rm(tmpDir, { recursive: true, force: true });
      tmpDir = undefined;
    }
  });

  it('returns 0 when every matched file validates', async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'claustodian-validate-'));
    await writeFile(join(tmpDir, 'latest.json'), JSON.stringify(validSnapshot()), 'utf-8');
    await writeFile(join(tmpDir, 'index.json'), JSON.stringify(validIndex()), 'utf-8');
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    const exitCode = await withArgv([`${tmpDir}/*.json`], main);

    expect(exitCode).toBe(0);
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('PASS'));
  });

  it('returns 1 when a matched file fails validation', async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'claustodian-validate-'));
    const badSnapshot = validSnapshot();
    delete (badSnapshot as { schemaVersion?: unknown }).schemaVersion;
    await writeFile(join(tmpDir, 'latest.json'), JSON.stringify(badSnapshot), 'utf-8');
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    const exitCode = await withArgv([`${tmpDir}/*.json`], main);

    expect(exitCode).toBe(1);
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('FAIL'));
  });

  it('returns 0 and logs a notice when the pattern matches nothing', async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'claustodian-validate-'));
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    const exitCode = await withArgv([`${tmpDir}/*.json`], main);

    expect(exitCode).toBe(0);
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('nothing to validate'));
  });

  it('returns 1 and reports a parse error for invalid JSON', async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'claustodian-validate-'));
    await writeFile(join(tmpDir, 'latest.json'), '{ not valid json', 'utf-8');
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    const exitCode = await withArgv([`${tmpDir}/*.json`], main);

    expect(exitCode).toBe(1);
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('could not read/parse file'));
  });

  it('skips files with no matching schema route and still returns 0', async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'claustodian-validate-'));
    await writeFile(join(tmpDir, 'random.json'), JSON.stringify({ anything: true }), 'utf-8');
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    const exitCode = await withArgv([`${tmpDir}/*.json`], main);

    expect(exitCode).toBe(0);
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('SKIP'));
  });

  it('defaults to "data/**/*.json" when no pattern args are given', async () => {
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    const exitCode = await withArgv([], main);

    // Exercises the committed, already-valid data/ files (read-only).
    expect(exitCode).toBe(0);
  });
});
