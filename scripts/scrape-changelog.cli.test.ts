// Copyright 2026 Schuby
// SPDX-License-Identifier: Apache-2.0

import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { buildAjv, getValidator } from './validate-schema.js';
import {
  controlRegressionRefusal,
  main,
  priorDatasetHasControlRecords,
} from './scrape-changelog.js';

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
          {
            symbol: '--undated',
            type: 'cli_flag',
            first_seen: '2.1.9',
            removed_in: null,
            status: 'active',
            provenance: 'docs',
            confidence: 'medium',
            description: '',
            source_url: null,
            category: 'cli',
            first_seen_estimated: true,
          },
          {
            symbol: '--anchored',
            type: 'cli_flag',
            first_seen: '2.1.9',
            removed_in: null,
            status: 'active',
            provenance: 'changelog',
            confidence: 'high',
            description: '',
            source_url: null,
            category: 'cli',
          },
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

  it('tolerates a prior latest.json with no symbols array (empty freeze map)', async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'claustodian-scrape-'));
    const changelogPath = join(tmpDir, 'CHANGELOG.md');
    const outDir = join(tmpDir, 'out');
    await mkdir(outDir, { recursive: true });
    await writeFile(changelogPath, FIXTURE_CHANGELOG, 'utf-8');
    // Valid JSON, but no `symbols` key — exercises the `?? []` fallback.
    await writeFile(join(outDir, 'latest.json'), '{}', 'utf-8');
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    const exitCode = await withArgv(['--changelog', changelogPath, '--out', outDir], main);
    expect(exitCode).toBe(0);
  });

  it('refuses to scrape when a prior dataset published control records and the file is gone', async () => {
    // The regression guard firing end to end, not just the helper. The prior latest.json
    // published a control_message record; the committed data/control-observations.json is
    // absent (it is opt-in and not committed on this branch), so regenerating now would
    // drop every control record. main must throw rather than silently ship the removal.
    tmpDir = await mkdtemp(join(tmpdir(), 'claustodian-scrape-'));
    const changelogPath = join(tmpDir, 'CHANGELOG.md');
    const outDir = join(tmpDir, 'out');
    await mkdir(outDir, { recursive: true });
    await writeFile(changelogPath, FIXTURE_CHANGELOG, 'utf-8');
    await writeFile(
      join(outDir, 'latest.json'),
      JSON.stringify({
        claudeCodeVersion: '2.1.9',
        schemaVersion: 1,
        symbols: [
          {
            symbol: 'hook_callback',
            type: 'control_message',
            family: 'control_request',
            direction: null,
            first_seen: '2.1.63',
            removed_in: null,
            status: 'active',
            provenance: 'binary',
            confidence: 'medium',
            description: '',
            source_url: null,
            category: 'control-protocol',
            first_seen_estimated: true,
          },
        ],
      }),
      'utf-8'
    );
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await expect(withArgv(['--changelog', changelogPath, '--out', outDir], main)).rejects.toThrow(
      /is (missing|empty), but the previous dataset published control_message/
    );
  });
});

describe('priorDatasetHasControlRecords', () => {
  let dir: string;

  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  const write = async (body: unknown): Promise<string> => {
    dir = await mkdtemp(join(tmpdir(), 'claustodian-prior-'));
    const path = join(dir, 'latest.json');
    await writeFile(path, typeof body === 'string' ? body : JSON.stringify(body), 'utf-8');
    return path;
  };

  it('sees a control record whose first_seen is ANCHORED, not only an estimated one', async () => {
    // The defect this function exists to avoid. The guard used to read the freeze map,
    // which keeps only `first_seen_estimated: true` records — so an anchored control
    // record answered "no", and a later archive fill that turns a union admission into
    // `both` would silently disarm the guard by dating the record exactly.
    const path = await write({
      symbols: [
        { type: 'control_message', symbol: 'hook_callback', first_seen: '2.1.63' },
        { type: 'cli_flag', symbol: '--print', first_seen: '1.0.0', first_seen_estimated: true },
      ],
    });
    expect(await priorDatasetHasControlRecords(path)).toBe(true);
  });

  it('answers no when the prior dataset published no control record', async () => {
    const path = await write({
      symbols: [{ type: 'cli_flag', symbol: '--print', first_seen: '1.0.0' }],
    });
    expect(await priorDatasetHasControlRecords(path)).toBe(false);
  });

  it('answers no for a fresh output directory, which has published nothing', async () => {
    dir = await mkdtemp(join(tmpdir(), 'claustodian-prior-'));
    expect(await priorDatasetHasControlRecords(join(dir, 'latest.json'))).toBe(false);
  });

  it('warns rather than throwing when the prior snapshot is malformed', async () => {
    // The freeze must never fail the scrape that would replace a corrupt snapshot, and
    // this reader inherits that. The warning is the part under test: degrading is
    // tolerated, degrading SILENTLY is not.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const path = await write('{ not valid json');
    expect(await priorDatasetHasControlRecords(path)).toBe(false);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('regression guard'));
    warn.mockRestore();
  });
});

describe('controlRegressionRefusal', () => {
  const some = [{ symbol: 'hook_callback' }] as never;
  const none = [] as never;

  it('refuses when the observation file is missing and the prior dataset had records', () => {
    expect(controlRegressionRefusal({ present: false, observations: none }, true)).toContain(
      'missing'
    );
  });

  it('refuses an EMPTY observation file, which drops the records just as silently', () => {
    // `present` is true, so a presence-only check passes here and every control record
    // disappears with no error. This is the arm that check would miss.
    expect(controlRegressionRefusal({ present: true, observations: none }, true)).toContain(
      'empty'
    );
  });

  it('allows the legitimate first run — no prior records, so nothing can be lost', () => {
    expect(controlRegressionRefusal({ present: false, observations: none }, false)).toBeNull();
  });

  it('allows the steady state', () => {
    expect(controlRegressionRefusal({ present: true, observations: some }, true)).toBeNull();
  });
});
