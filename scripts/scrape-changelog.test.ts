// Copyright 2026 Schuby
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from 'vitest';

import { buildAjv, getValidator } from './validate-schema.js';
import {
  buildIndex,
  buildSnapshots,
  compareVersionsAsc,
  extractSymbols,
  parseChangelog,
} from './scrape-changelog.js';

/**
 * A small fixture changelog, newest-first (matching upstream's real
 * ordering), with three versions:
 *   - 2.1.10 (newest): introduces `--turbo` and re-mentions `/compact`
 *   - 2.1.9  (middle): introduces `/compact` and `OTEL_LOG_LEVEL`
 *   - 2.0.5  (oldest): introduces `--safe-mode` and `CLAUDE_CODE_SAFE_MODE`
 *
 * `--turbo` is introduced in the *newest* version, so it must be absent from
 * the two older snapshots. `--safe-mode` is introduced in the *oldest*
 * version, so it must be present in every snapshot including the newest.
 * `/compact` is mentioned in both 2.1.9 and 2.1.10; its first_seen must stay
 * pinned to 2.1.9 (the oldest mention), and its description must stay the
 * one captured at 2.1.9, not get overwritten by the 2.1.10 re-mention.
 */
const FIXTURE_CHANGELOG = `# Changelog

This preamble line should be ignored, along with everything else before the
first version heading.

- This bullet is also part of the preamble and must be ignored.

## 2.1.10

- Added \`--turbo\` flag for faster runs.
- Changed \`/compact\` to preserve pinned messages (again).

## 2.1.9

- Fixed \`/compact\` command truncating output.
- Added \`OTEL_LOG_LEVEL\` to control telemetry verbosity.

## 2.0.5

- Added \`--safe-mode\` flag for troubleshooting.
- Added \`CLAUDE_CODE_SAFE_MODE\` environment variable equivalent.
`;

describe('parseChangelog', () => {
  it('splits versions in file order and ignores preamble', () => {
    const blocks = parseChangelog(FIXTURE_CHANGELOG);
    expect(blocks.map((b) => b.version)).toEqual(['2.1.10', '2.1.9', '2.0.5']);
  });

  it('collects bullet lines (with leading "- ") for each version', () => {
    const blocks = parseChangelog(FIXTURE_CHANGELOG);
    expect(blocks[0]?.bullets).toEqual([
      '- Added `--turbo` flag for faster runs.',
      '- Changed `/compact` to preserve pinned messages (again).',
    ]);
    expect(blocks[2]?.bullets).toEqual([
      '- Added `--safe-mode` flag for troubleshooting.',
      '- Added `CLAUDE_CODE_SAFE_MODE` environment variable equivalent.',
    ]);
  });

  it('ignores preamble bullets that appear before the first heading', () => {
    const blocks = parseChangelog(FIXTURE_CHANGELOG);
    const allBullets = blocks.flatMap((b) => b.bullets);
    expect(allBullets.some((b) => b.includes('preamble'))).toBe(false);
  });

  it('returns no blocks for a changelog with no version headings', () => {
    expect(parseChangelog('# Just a title\n\n- a bullet\n')).toEqual([]);
  });
});

describe('extractSymbols', () => {
  it('finds cli_flag, command, and env_var tokens', () => {
    const symbols = extractSymbols(
      'Added `--safe-mode` and `/compact` alongside `CLAUDE_CODE_SAFE_MODE`.'
    );
    expect(symbols).toEqual([
      { symbol: '--safe-mode', type: 'cli_flag' },
      { symbol: '/compact', type: 'command' },
      { symbol: 'CLAUDE_CODE_SAFE_MODE', type: 'env_var' },
    ]);
  });

  it('dedupes repeated tokens, keeping first appearance only', () => {
    const symbols = extractSymbols('Uses `--turbo` twice: `--turbo` and `--turbo` again.');
    expect(symbols).toEqual([{ symbol: '--turbo', type: 'cli_flag' }]);
  });

  it('orders results by first appearance across all three patterns', () => {
    const symbols = extractSymbols('First `/compact`, then `--turbo`, then `OTEL_LOG_LEVEL`.');
    expect(symbols.map((s) => s.symbol)).toEqual(['/compact', '--turbo', 'OTEL_LOG_LEVEL']);
  });

  it('returns an empty array when no tokens are present', () => {
    expect(extractSymbols('Nothing to see here.')).toEqual([]);
  });

  it('filters denylisted false positives (errno codes, acronyms) but keeps real vars', () => {
    const symbols = extractSymbols(
      'Fixed `EADDRINUSE` and `JSON` parsing; respects `HOME` and `CLAUDE_CODE_SAFE_MODE`.'
    );
    expect(symbols.map((s) => s.symbol)).toEqual(['HOME', 'CLAUDE_CODE_SAFE_MODE']);
  });
});

describe('buildSnapshots', () => {
  const blocks = parseChangelog(FIXTURE_CHANGELOG);
  const snapshots = buildSnapshots(blocks);

  function snapshotFor(version: string) {
    const snapshot = snapshots.find((s) => s.version === version);
    if (!snapshot) {
      throw new Error(`No snapshot built for ${version}`);
    }
    return snapshot;
  }

  function symbolIn(version: string, symbol: string) {
    return snapshotFor(version).symbols.find((s) => s.symbol === symbol);
  }

  it('produces one snapshot per version', () => {
    expect(snapshots.map((s) => s.version).sort()).toEqual(['2.0.5', '2.1.10', '2.1.9'].sort());
  });

  it('a symbol introduced in the oldest version has that first_seen and appears in every later snapshot', () => {
    expect(symbolIn('2.0.5', '--safe-mode')?.first_seen).toBe('2.0.5');
    expect(symbolIn('2.1.9', '--safe-mode')?.first_seen).toBe('2.0.5');
    expect(symbolIn('2.1.10', '--safe-mode')?.first_seen).toBe('2.0.5');
  });

  it('a symbol introduced later does not appear in earlier snapshots', () => {
    expect(symbolIn('2.0.5', '--turbo')).toBeUndefined();
    expect(symbolIn('2.1.9', '--turbo')).toBeUndefined();
    expect(symbolIn('2.1.10', '--turbo')?.first_seen).toBe('2.1.10');
  });

  it('first_seen is the oldest version a symbol appears in, even when mentioned again later', () => {
    const compactInLatest = symbolIn('2.1.10', '/compact');
    expect(compactInLatest?.first_seen).toBe('2.1.9');
    // description should reflect the bullet from the *first* (oldest) mention,
    // not the re-mention in the newest version.
    expect(compactInLatest?.description).toBe('Fixed `/compact` command truncating output.');
  });

  it('sets the expected static fields for changelog-sourced records', () => {
    const record = symbolIn('2.0.5', 'CLAUDE_CODE_SAFE_MODE');
    expect(record).toMatchObject({
      type: 'env_var',
      removed_in: null,
      status: 'active',
      provenance: 'changelog',
      confidence: 'high',
      source_url: 'https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md',
      category: 'uncategorized',
    });
  });

  it('produces records that all validate against the symbol schema', () => {
    const ajv = buildAjv();
    const validate = getValidator(ajv, 'symbol');

    for (const snapshot of snapshots) {
      for (const record of snapshot.symbols) {
        const valid = validate(record);
        expect(valid, JSON.stringify(validate.errors)).toBe(true);
      }
    }
  });
});

describe('numeric version ordering', () => {
  it('compareVersionsAsc treats 2.1.9 as less than 2.1.10 (not string order)', () => {
    expect(compareVersionsAsc('2.1.9', '2.1.10')).toBeLessThan(0);
    expect(compareVersionsAsc('2.1.10', '2.1.9')).toBeGreaterThan(0);
    expect(compareVersionsAsc('2.1.9', '2.1.9')).toBe(0);
  });

  it('buildIndex sorts versions descending numerically, not lexicographically', () => {
    const index = buildIndex([
      { version: '2.1.9', symbols: [] },
      { version: '2.1.10', symbols: [] },
      { version: '2.0.64', symbols: [] },
    ]);
    expect(index.versions).toEqual(['2.1.10', '2.1.9', '2.0.64']);
    expect(index.latest).toBe('2.1.10');
    expect(index.schemaVersion).toBe('1.0.0');
  });
});
