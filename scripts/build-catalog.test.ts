// Copyright 2026 Schuby
// SPDX-License-Identifier: Apache-2.0

import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { buildCatalog, main, type CatalogEntry } from './build-catalog.js';

/** A minimal version snapshot. */
function snap(
  claudeCodeVersion: string,
  symbols: Array<Record<string, unknown> & { symbol: string; type: string }>
) {
  return { claudeCodeVersion, symbols };
}

describe('buildCatalog', () => {
  it('unions symbols across snapshots and keeps each symbol newest occurrence', () => {
    const cat = buildCatalog([
      snap('1.0.0', [{ symbol: '/x', type: 'command', description: 'old' }]),
      snap('1.0.2', [{ symbol: '/x', type: 'command', description: 'new' }]),
    ]);
    expect(cat).toEqual([{ symbol: '/x', type: 'command', description: 'new', last_seen: '1.0.2' }]);
  });

  it('processes oldest-first regardless of input order (last_seen is the newest)', () => {
    const cat = buildCatalog([
      snap('2.1.10', [{ symbol: '/x', type: 'command', description: 'v10' }]),
      snap('2.1.9', [{ symbol: '/x', type: 'command', description: 'v9' }]),
    ]);
    // 2.1.10 > 2.1.9 numerically, so v10 wins and last_seen is 2.1.10.
    expect(cat[0]).toMatchObject({ description: 'v10', last_seen: '2.1.10' });
  });

  it('retains a removed symbol with its lifecycle and last living version', () => {
    // Present 2.1.97–2.1.145, then gone; the last occurrence carries removed_in.
    const cat = buildCatalog([
      snap('2.1.97', [{ symbol: '/dream', type: 'command', first_seen: '2.1.97', removed_in: null }]),
      snap('2.1.145', [
        { symbol: '/dream', type: 'command', first_seen: '2.1.97', removed_in: '2.1.146' },
      ]),
      snap('2.1.146', [{ symbol: '--keep', type: 'cli_flag', first_seen: '2.1.146' }]),
    ]);
    const dream = cat.find((e) => e.symbol === '/dream') as CatalogEntry;
    expect(dream).toMatchObject({ first_seen: '2.1.97', removed_in: '2.1.146', last_seen: '2.1.145' });
    // --keep, absent from the older snapshots, is still in the catalog.
    expect(cat.some((e) => e.symbol === '--keep')).toBe(true);
  });

  it('sorts entries by type then symbol', () => {
    const cat = buildCatalog([
      snap('1.0.0', [
        { symbol: 'ZED', type: 'env_var' },
        { symbol: '/b', type: 'command' },
        { symbol: '--a', type: 'cli_flag' },
        { symbol: '/a', type: 'command' },
      ]),
    ]);
    expect(cat.map((e) => `${e.type}:${e.symbol}`)).toEqual([
      'cli_flag:--a',
      'command:/a',
      'command:/b',
      'env_var:ZED',
    ]);
  });
});

describe('build-catalog main()', () => {
  let dir: string | undefined;
  let logSpy: ReturnType<typeof vi.spyOn>;

  afterEach(async () => {
    logSpy?.mockRestore();
    if (dir) {
      await rm(dir, { recursive: true, force: true });
      dir = undefined;
    }
  });

  it('builds <dir>/catalog.json from <dir>/versions/*.json', async () => {
    dir = await mkdtemp(join(tmpdir(), 'claustodian-catalog-'));
    await mkdir(join(dir, 'versions'));
    await writeFile(
      join(dir, 'versions', '1.0.0.json'),
      JSON.stringify(snap('1.0.0', [{ symbol: '/x', type: 'command', description: 'old' }])),
      'utf-8'
    );
    await writeFile(
      join(dir, 'versions', '1.0.1.json'),
      JSON.stringify(snap('1.0.1', [{ symbol: '/x', type: 'command', description: 'new' }])),
      'utf-8'
    );
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    const code = await main(['--data', dir]);

    expect(code).toBe(0);
    const out = JSON.parse(await readFile(join(dir, 'catalog.json'), 'utf-8')) as {
      $generated_by: string;
      symbols: CatalogEntry[];
    };
    expect(out.$generated_by).toBe('scripts/build-catalog.ts');
    expect(out.symbols).toEqual([
      { symbol: '/x', type: 'command', description: 'new', last_seen: '1.0.1' },
    ]);
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('Built 1 catalog entries'));
  });

  it('is a no-op when there are no version snapshots', async () => {
    dir = await mkdtemp(join(tmpdir(), 'claustodian-catalog-empty-'));
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const code = await main(['--data', dir]);
    expect(code).toBe(0);
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('nothing to build'));
  });

  it('errors when --data is passed without a path', async () => {
    await expect(main(['--data'])).rejects.toThrow(/--data requires a path/);
  });
});
