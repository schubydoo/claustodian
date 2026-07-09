// Copyright 2026 Schuby
// SPDX-License-Identifier: Apache-2.0

import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { buildAjv, getValidator } from './validate-schema.js';
import { main } from './scrape-changelog.js';

const FIXTURE_CHANGELOG = `# Changelog

## 2.1.10

- Added \`--turbo\` flag for faster runs.

## 2.0.5

- Added \`--safe-mode\` flag for troubleshooting.
- Added \`CLAUDE_CODE_SAFE_MODE\` environment variable equivalent.
`;

const NO_VERSIONS_CHANGELOG = '# Changelog\n\nNothing to see here.\n';

async function withArgv<T>(args: string[], fn: () => Promise<T>): Promise<T> {
  const originalArgv = process.argv;
  process.argv = ['node', 'scrape-changelog.ts', ...args];
  try {
    return await fn();
  } finally {
    process.argv = originalArgv;
  }
}

describe('scrape-changelog main()', () => {
  let tmpDir: string | undefined;
  let logSpy: ReturnType<typeof vi.spyOn>;

  afterEach(async () => {
    logSpy?.mockRestore();
    if (tmpDir) {
      await rm(tmpDir, { recursive: true, force: true });
      tmpDir = undefined;
    }
  });

  it('writes index.json, latest.json, and per-version files with --all, and returns 0', async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'claustodian-scrape-'));
    const changelogPath = join(tmpDir, 'CHANGELOG.md');
    const outDir = join(tmpDir, 'out');
    await writeFile(changelogPath, FIXTURE_CHANGELOG, 'utf-8');
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    const exitCode = await withArgv(['--changelog', changelogPath, '--out', outDir, '--all'], main);

    expect(exitCode).toBe(0);

    const index = JSON.parse(await readFile(join(outDir, 'index.json'), 'utf-8')) as {
      versions: string[];
      latest: string;
    };
    expect(index.latest).toBe('2.1.10');
    expect(index.versions).toEqual(['2.1.10', '2.0.5']);

    const latest = JSON.parse(await readFile(join(outDir, 'latest.json'), 'utf-8')) as {
      symbols: unknown[];
    };
    expect(latest.symbols.length).toBeGreaterThan(0);

    const version1 = JSON.parse(
      await readFile(join(outDir, 'versions', '2.0.5.json'), 'utf-8')
    ) as {
      symbols: unknown[];
    };
    const version2 = JSON.parse(
      await readFile(join(outDir, 'versions', '2.1.10.json'), 'utf-8')
    ) as {
      symbols: unknown[];
    };
    expect(version1.symbols.length).toBeGreaterThan(0);
    expect(version2.symbols.length).toBeGreaterThan(0);

    // Every written record should validate against the symbol schema.
    const ajv = buildAjv();
    const validate = getValidator(ajv, 'symbol');
    for (const record of latest.symbols as Record<string, unknown>[]) {
      expect(validate(record), JSON.stringify(validate.errors)).toBe(true);
    }
  });

  it('without --all, writes only index.json and latest.json (no versions dir)', async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'claustodian-scrape-'));
    const changelogPath = join(tmpDir, 'CHANGELOG.md');
    const outDir = join(tmpDir, 'out');
    await writeFile(changelogPath, FIXTURE_CHANGELOG, 'utf-8');
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    const exitCode = await withArgv(['--changelog', changelogPath, '--out', outDir], main);

    expect(exitCode).toBe(0);
    await expect(readFile(join(outDir, 'index.json'), 'utf-8')).resolves.toBeTruthy();
    await expect(readFile(join(outDir, 'latest.json'), 'utf-8')).resolves.toBeTruthy();
    await expect(readFile(join(outDir, 'versions', '2.0.5.json'), 'utf-8')).rejects.toThrow();
  });

  it('writes no latest.json when the changelog has no version headings', async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'claustodian-scrape-'));
    const changelogPath = join(tmpDir, 'CHANGELOG.md');
    const outDir = join(tmpDir, 'out');
    await writeFile(changelogPath, NO_VERSIONS_CHANGELOG, 'utf-8');
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    const exitCode = await withArgv(['--changelog', changelogPath, '--out', outDir], main);

    expect(exitCode).toBe(0);
    const index = JSON.parse(await readFile(join(outDir, 'index.json'), 'utf-8')) as {
      versions: string[];
      latest: string;
    };
    expect(index.versions).toEqual([]);
    expect(index.latest).toBe('');
    await expect(readFile(join(outDir, 'latest.json'), 'utf-8')).rejects.toThrow();
  });

  it('errors on a bare --out (no path) instead of silently regenerating committed data/', async () => {
    await expect(withArgv(['--out'], main)).rejects.toThrow('--out requires a path');
  });

  it('errors on a bare --changelog (no path)', async () => {
    await expect(withArgv(['--changelog'], main)).rejects.toThrow('--changelog requires a path');
  });

  it('reads a prior latest.json in the out dir to freeze estimates (runs clean)', async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'claustodian-scrape-'));
    const changelogPath = join(tmpDir, 'CHANGELOG.md');
    const outDir = join(tmpDir, 'out');
    await mkdir(outDir, { recursive: true });
    await writeFile(changelogPath, FIXTURE_CHANGELOG, 'utf-8');
    // A valid prior snapshot at the output location — loadPriorFirstSeen parses it
    // and builds the freeze map (its symbols may or may not overlap this run).
    await writeFile(
      join(outDir, 'latest.json'),
      JSON.stringify({
        claudeCodeVersion: '2.1.9',
        schemaVersion: 1,
        symbols: [
          // one estimated (goes into the freeze map) and one anchored (excluded).
          { symbol: '--undated', type: 'cli_flag', first_seen: '2.1.9', removed_in: null, status: 'active', provenance: 'docs', confidence: 'medium', description: '', source_url: null, category: 'cli', first_seen_estimated: true },
          { symbol: '--anchored', type: 'cli_flag', first_seen: '2.1.9', removed_in: null, status: 'active', provenance: 'changelog', confidence: 'high', description: '', source_url: null, category: 'cli' },
        ],
      }),
      'utf-8'
    );
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    const exitCode = await withArgv(['--changelog', changelogPath, '--out', outDir], main);
    expect(exitCode).toBe(0);
    await expect(readFile(join(outDir, 'latest.json'), 'utf-8')).resolves.toBeTruthy();
  });

  it('degrades gracefully when the prior latest.json is malformed (no freeze, no crash)', async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'claustodian-scrape-'));
    const changelogPath = join(tmpDir, 'CHANGELOG.md');
    const outDir = join(tmpDir, 'out');
    await mkdir(outDir, { recursive: true });
    await writeFile(changelogPath, FIXTURE_CHANGELOG, 'utf-8');
    await writeFile(join(outDir, 'latest.json'), '{ not valid json', 'utf-8');
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    const exitCode = await withArgv(['--changelog', changelogPath, '--out', outDir], main);
    expect(exitCode).toBe(0);
  });
});
