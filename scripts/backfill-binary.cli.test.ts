// Copyright 2026 Schuby
// SPDX-License-Identifier: Apache-2.0

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { main } from './backfill-binary.js';
import type { BinaryObservations } from './binary-lane.js';

describe('backfill-binary main()', () => {
  let cacheDir: string | undefined;
  let logSpy: ReturnType<typeof vi.spyOn>;

  afterEach(async () => {
    logSpy?.mockRestore();
    if (cacheDir) {
      await rm(cacheDir, { recursive: true, force: true });
      cacheDir = undefined;
    }
  });

  it('distils a cache directory into an observations file (skipping _-prefixed files)', async () => {
    cacheDir = await mkdtemp(join(tmpdir(), 'claustodian-backfill-'));
    await writeFile(
      join(cacheDir, '1.0.0.json'),
      JSON.stringify({ version: '1.0.0', symbols: [{ symbol: '--foo', type: 'cli_flag' }] }),
      'utf-8'
    );
    await writeFile(
      join(cacheDir, '1.0.1.json'),
      JSON.stringify({ version: '1.0.1', symbols: [{ symbol: '--foo', type: 'cli_flag' }] }),
      'utf-8'
    );
    // A non-version artifact (e.g. a verify report) must be ignored, not parsed as a cache file.
    await writeFile(join(cacheDir, '_verify-report.json'), JSON.stringify({ ok: true }), 'utf-8');
    const outPath = join(cacheDir, 'binary-observations.json');
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    const exitCode = await main(['--cache', cacheDir, '--out', outPath]);

    expect(exitCode).toBe(0);
    const out = JSON.parse(await readFile(outPath, 'utf-8')) as BinaryObservations;
    expect(out.$generated_by).toBe('scripts/backfill-binary.ts');
    expect(out.observedVersions).toEqual(['1.0.1', '1.0.0']);
    expect(out.symbols).toEqual([
      { symbol: '--foo', type: 'cli_flag', first_seen: '1.0.0', last_seen: '1.0.1', removed_in: null },
    ]);
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('Distilled 1 binary symbol(s)'));
  });

  it('rejects with actionable guidance when the cache directory has no cache files', async () => {
    cacheDir = await mkdtemp(join(tmpdir(), 'claustodian-backfill-empty-'));
    await expect(main(['--cache', cacheDir, '--out', join(cacheDir, 'out.json')])).rejects.toThrow(
      /No cache files/
    );
  });
});
