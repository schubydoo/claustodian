// Copyright 2026 Schuby
// SPDX-License-Identifier: Apache-2.0

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { load } from 'js-yaml';
import { parse } from 'smol-toml';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { main } from './generate-exports.js';

async function withArgv<T>(args: string[], fn: () => Promise<T>): Promise<T> {
  const originalArgv = process.argv;
  process.argv = ['node', 'generate-exports.ts', ...args];
  try {
    return await fn();
  } finally {
    process.argv = originalArgv;
  }
}

describe('generate-exports main()', () => {
  let tmpDir: string | undefined;
  let logSpy: ReturnType<typeof vi.spyOn>;

  afterEach(async () => {
    logSpy?.mockRestore();
    if (tmpDir) {
      await rm(tmpDir, { recursive: true, force: true });
      tmpDir = undefined;
    }
  });

  it('writes .yaml and .toml siblings for every JSON file under --data, that parse back', async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'claustodian-genexports-'));
    const snapshot = {
      claudeCodeVersion: '1.0.0',
      schemaVersion: '1.0.0',
      symbols: [
        {
          symbol: '--safe-mode',
          type: 'cli_flag',
          first_seen: '1.0.0',
          removed_in: null,
          status: 'active',
          provenance: 'changelog',
          confidence: 'high',
          description: 'Enables safe mode.',
          source_url: null,
          category: 'startup',
        },
      ],
    };
    const jsonPath = join(tmpDir, 'latest.json');
    await writeFile(jsonPath, JSON.stringify(snapshot), 'utf-8');
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    const exitCode = await withArgv(['--data', tmpDir], main);

    expect(exitCode).toBe(0);
    const yamlText = await readFile(join(tmpDir, 'latest.yaml'), 'utf-8');
    const tomlText = await readFile(join(tmpDir, 'latest.toml'), 'utf-8');
    expect(load(yamlText)).toEqual(snapshot);
    expect(
      (parse(tomlText) as { symbols: Array<Record<string, unknown>> }).symbols[0]
    ).not.toHaveProperty('removed_in');
  });

  it('returns 0 and logs "nothing to generate" when --data has no JSON files', async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'claustodian-genexports-'));
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    const exitCode = await withArgv(['--data', tmpDir], main);

    expect(exitCode).toBe(0);
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('nothing to generate'));
  });

  it('rejects when --data is given with no following directory argument', async () => {
    await expect(withArgv(['--data'], main)).rejects.toThrow(
      '--data requires a directory argument'
    );
  });
});
