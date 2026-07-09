// Copyright 2026 Schuby
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from 'vitest';

import { buildAjv, getValidator } from './validate-schema.js';
import { rm, writeFile } from 'node:fs/promises';

import {
  assertCanonicalSourcesForCommittedData,
  assertNonEmptyDocs,
  buildEnrichedSnapshots,
  buildIndex,
  buildSnapshots,
  assembleSnapshots,
  categorize,
  collectChangelogSymbols,
  compareVersionsAsc,
  enrichSymbols,
  enrichWithBinary,
  extractSymbols,
  freezeEstimatedFirstSeen,
  isIntroducingBullet,
  isSubprocessFlagBullet,
  subprocessFlagExamples,
  loadDocsIndex,
  parseChangelog,
} from './scrape-changelog.js';
import type { DocsIndex } from './fetch-docs.js';
import type { SymbolRecord } from './scrape-changelog.js';
import type { BinaryObservation, BinaryObservations } from './binary-lane.js';

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

describe('categorize', () => {
  it('marks flags and commands as Claude Code owned', () => {
    expect(categorize('--safe-mode', 'cli_flag')).toBe('cli');
    expect(categorize('/rename', 'command')).toBe('command');
  });

  it('buckets env vars by ownership/source', () => {
    expect(categorize('CLAUDE_CODE_SAFE_MODE', 'env_var')).toBe('claude-code');
    expect(categorize('ANTHROPIC_API_KEY', 'env_var')).toBe('claude-code');
    expect(categorize('AWS_REGION', 'env_var')).toBe('cloud');
    expect(categorize('GITHUB_ACTIONS', 'env_var')).toBe('ci');
    expect(categorize('CI', 'env_var')).toBe('ci');
    expect(categorize('NODE_OPTIONS', 'env_var')).toBe('runtime');
    expect(categorize('TERM_PROGRAM', 'env_var')).toBe('terminal');
    expect(categorize('OTEL_LOG_LEVEL', 'env_var')).toBe('telemetry');
    expect(categorize('HTTPS_PROXY', 'env_var')).toBe('network');
  });

  it('falls back to "other" for unrecognized env vars', () => {
    expect(categorize('COLUMNS', 'env_var')).toBe('other');
    expect(categorize('HOME', 'env_var')).toBe('other');
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
      category: 'claude-code',
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

const docsIndex = (symbols: DocsIndex['symbols']): DocsIndex => ({
  $generated_by: 'test',
  source_pages: [],
  symbols,
});

describe('isIntroducingBullet', () => {
  it('detects introducing verbs and rejects incidental ones', () => {
    expect(isIntroducingBullet('- Added `--foo` flag')).toBe(true);
    expect(isIntroducingBullet('- New `--bar` option')).toBe(true);
    expect(isIntroducingBullet('- Fixed a crash when using `--foo`')).toBe(false);
    expect(isIntroducingBullet('- Improved `--foo` output')).toBe(false);
  });
});

describe('isSubprocessFlagBullet', () => {
  const gitBullet =
    '- Added support for additional `git log` and `git show` flags in read-only mode (e.g., `--topo-order`, `--cherry-pick`, `--format`, `--raw`)';

  it('flags a bullet that lists a subprocess tool’s own flags as examples', () => {
    expect(isSubprocessFlagBullet(gitBullet)).toBe(true);
  });

  it('does not flag a genuine Claude Code flag bullet', () => {
    expect(isSubprocessFlagBullet('- Added a `--git-notes` flag for git integration')).toBe(false);
    expect(isSubprocessFlagBullet('- Added `/plugin list` with `--enabled`/`--disabled` filters')).toBe(false);
  });

  it('subprocessFlagExamples returns only the flags inside the "(e.g., …)" clause', () => {
    expect([...subprocessFlagExamples(gitBullet)].sort()).toEqual([
      '--cherry-pick',
      '--format',
      '--raw',
      '--topo-order',
    ]);
    // not a subprocess-flag bullet → empty
    expect(subprocessFlagExamples('- Added a `--git-notes` flag for git integration').size).toBe(0);
  });

  it('subprocessFlagExamples collects only cli_flag tokens from the clause', () => {
    // A clause mixing a flag with a non-flag token exercises both branches; only
    // the flag is returned.
    const mixed =
      '- Added support for additional `git` flags (e.g., `--topo-order` via the `/git` helper)';
    expect([...subprocessFlagExamples(mixed)]).toEqual(['--topo-order']);
  });

  it('subprocessFlagExamples stops at the closing paren, ignoring trailing flags', () => {
    const trailing =
      '- Added support for additional `git` flags (e.g., `--topo-order`) and added `--foo`';
    expect([...subprocessFlagExamples(trailing)]).toEqual(['--topo-order']); // not --foo
  });

  it('subprocessFlagExamples handles an unclosed "(e.g., …" clause', () => {
    const unclosed = '- Added `git` flags (e.g., `--topo-order`';
    expect([...subprocessFlagExamples(unclosed)]).toEqual(['--topo-order']);
  });

  it('collectChangelogSymbols keeps a first-party flag that trails the example clause', () => {
    const trailing =
      '- Added support for additional `git` flags (e.g., `--topo-order`) and added `--foo`';
    const keys = [...collectChangelogSymbols([{ version: '2.1.41', bullets: [trailing] }]).keys()];
    expect(keys).toContain('cli_flag:--foo');
    expect(keys).not.toContain('cli_flag:--topo-order');
  });

  it('collectChangelogSymbols drops the git flags but keeps other symbols', () => {
    const blocks = [
      { version: '2.1.30', bullets: [gitBullet, '- Added `--safe-mode` and `CLAUDE_CODE_X`'] },
    ];
    const keys = [...collectChangelogSymbols(blocks).keys()];
    for (const f of ['--topo-order', '--cherry-pick', '--format', '--raw']) {
      expect(keys).not.toContain(`cli_flag:${f}`);
    }
    // a real flag / env var in the same block is unaffected
    expect(keys).toContain('cli_flag:--safe-mode');
    expect(keys).toContain('env_var:CLAUDE_CODE_X');
  });

  it('keeps a real first-party flag that shares a bullet with subprocess example flags', () => {
    const mixed =
      '- Added `--foo` for Claude Code and support for additional `git` flags (e.g., `--topo-order`, `--cherry-pick`)';
    const keys = [...collectChangelogSymbols([{ version: '2.1.40', bullets: [mixed] }]).keys()];
    expect(keys).toContain('cli_flag:--foo'); // outside the (e.g., …) clause → kept
    expect(keys).not.toContain('cli_flag:--topo-order'); // inside → dropped
    expect(keys).not.toContain('cli_flag:--cherry-pick');
  });

  it('drops the phantom `--compact` when written as prose (the /compact command)', () => {
    for (const bullet of [
      '- Fixed `--continue` not resuming after `--compact`',
      '- Improved messaging shown during `--compact`',
    ]) {
      const keys = [...collectChangelogSymbols([{ version: '2.1.72', bullets: [bullet] }]).keys()];
      expect(keys).not.toContain('cli_flag:--compact');
    }
  });

  it('keeps `--compact` when a bullet introduces it, across natural wording', () => {
    for (const bullet of [
      '- Added a `--compact` flag to shrink output',
      '- Now supports `--compact` mode',
      '- Expose `--compact` as a standalone CLI flag',
      '- Make `--compact` available for scripting',
      '- `--compact`: new flag for compact output',
    ]) {
      const keys = [...collectChangelogSymbols([{ version: '2.1.80', bullets: [bullet] }]).keys()];
      expect(keys).toContain('cli_flag:--compact');
    }
  });
});

describe('enrichSymbols', () => {
  const blocks = [
    { version: '2.1.0', bullets: ['- Improved `--incident` behavior'] },
    {
      version: '2.0.0',
      bullets: [
        '- Added `--intro` flag',
        '- Fixed a bug with `--incident`',
        '- Fixed `--anchored`',
        '- Fixed `--nodoc`',
      ],
    },
  ];
  const docs = docsIndex([
    {
      symbol: '--intro',
      type: 'cli_flag',
      description: 'Intro',
      doc_min_version: null,
      doc_page: 'cli-reference',
    },
    {
      symbol: '--incident',
      type: 'cli_flag',
      description: 'Incident',
      doc_min_version: null,
      doc_page: 'cli-reference',
    },
    {
      symbol: '--anchored',
      type: 'cli_flag',
      description: 'Anchored',
      doc_min_version: '1.0.0',
      doc_page: 'cli-reference',
    },
    {
      symbol: '--docsonly',
      type: 'cli_flag',
      description: 'DocsOnly',
      doc_min_version: '2.0.5',
      doc_page: 'cli-reference',
    },
    {
      symbol: '--docsnomin',
      type: 'cli_flag',
      description: 'DocsNoMin',
      doc_min_version: null,
      doc_page: 'cli-reference',
    },
  ]);
  const records = enrichSymbols(collectChangelogSymbols(blocks), docs, '2.1.0');
  const m = new Map(records.map((r) => [r.symbol, r]));

  it('uses the docs description and keeps a high, non-estimated first_seen for an introducing symbol', () => {
    const r = m.get('--intro');
    expect(r).toMatchObject({
      description: 'Intro',
      description_source: 'docs',
      provenance: 'changelog',
      first_seen: '2.0.0',
      confidence: 'high',
    });
    expect(r?.first_seen_estimated).toBeUndefined();
  });

  it('flags an incidental changelog symbol estimated/medium even with a docs description', () => {
    expect(m.get('--incident')).toMatchObject({
      description: 'Incident',
      description_source: 'docs',
      confidence: 'medium',
      first_seen_estimated: true,
      first_seen: '2.0.0',
    });
  });

  it('pulls first_seen earlier from an authoritative docs min-version', () => {
    const r = m.get('--anchored');
    expect(r).toMatchObject({ first_seen: '1.0.0', confidence: 'high' });
    expect(r?.first_seen_estimated).toBeUndefined();
  });

  it('leaves an incidental symbol with no docs an empty description and no source', () => {
    const r = m.get('--nodoc');
    expect(r?.description).toBe('');
    expect(r && 'description_source' in r).toBe(false);
    expect(r).toMatchObject({ confidence: 'medium', first_seen_estimated: true });
  });

  it('adds a docs-only symbol with an authoritative first_seen from its min-version', () => {
    expect(m.get('--docsonly')).toMatchObject({
      provenance: 'docs',
      first_seen: '2.0.5',
      confidence: 'high',
      description_source: 'docs',
    });
  });

  it('adds a docs-only symbol without a min-version as estimated at the latest version', () => {
    expect(m.get('--docsnomin')).toMatchObject({
      provenance: 'docs',
      first_seen: '2.1.0',
      confidence: 'medium',
      first_seen_estimated: true,
    });
  });

  it('places docs-only symbols in snapshots from their first_seen onward', () => {
    const snaps = buildEnrichedSnapshots(blocks, docs);
    const at = (v: string) =>
      snaps.find((s) => s.version === v)?.symbols.map((x) => x.symbol) ?? [];
    expect(at('2.0.0')).not.toContain('--docsonly');
    expect(at('2.1.0')).toContain('--docsonly');
  });
});

describe('enrichWithBinary', () => {
  const record = (over: Partial<SymbolRecord>): SymbolRecord => ({
    symbol: '--x',
    type: 'cli_flag',
    first_seen: '1.0.0',
    removed_in: null,
    status: 'active',
    provenance: 'changelog',
    confidence: 'high',
    description: 'd',
    source_url: 'https://example/u',
    category: 'cli',
    ...over,
  });
  const binary = (
    symbols: Array<Omit<BinaryObservation, 'removed_in'> & { removed_in?: string | null }>
  ): BinaryObservations => ({
    $generated_by: 'scripts/backfill-binary.ts',
    source: 'binary',
    note: '',
    observedVersions: [],
    symbols: symbols.map((s) => ({ removed_in: null, ...s })),
  });
  const byKey = (records: SymbolRecord[]) =>
    new Map(records.map((r) => [`${r.type}:${r.symbol}`, r]));

  it('corrects a shared symbol earlier and clears the estimated flag (confidence high)', () => {
    const out = enrichWithBinary(
      [record({ symbol: '--print', first_seen: '2.1.0', first_seen_estimated: true, confidence: 'medium' })],
      binary([{ symbol: '--print', type: 'cli_flag', first_seen: '0.2.9', last_seen: '2.1.201' }])
    );
    const r = byKey(out).get('cli_flag:--print');
    expect(r).toMatchObject({ first_seen: '0.2.9', confidence: 'high', provenance: 'changelog' });
    expect(r?.first_seen_estimated).toBeUndefined();
  });

  it('does not touch first_seen when the binary observed the symbol no earlier', () => {
    const input = [record({ symbol: '--foo', first_seen: '1.0.0' })];
    const out = enrichWithBinary(
      input,
      binary([{ symbol: '--foo', type: 'cli_flag', first_seen: '2.0.0', last_seen: '2.1.0' }])
    );
    expect(byKey(out).get('cli_flag:--foo')?.first_seen).toBe('1.0.0');
  });

  it('never sets removed_in from the binary lane', () => {
    const out = enrichWithBinary(
      [record({ symbol: '--foo', first_seen: '2.0.0', first_seen_estimated: true, confidence: 'medium' })],
      binary([{ symbol: '--foo', type: 'cli_flag', first_seen: '1.0.0', last_seen: '1.5.0' }])
    );
    // last_seen 1.5.0 is well before the record's world, yet removed_in stays null.
    expect(byKey(out).get('cli_flag:--foo')?.removed_in).toBeNull();
  });

  it('appends a binary-only flag as provenance:binary / needs_review with a null source', () => {
    const out = enrichWithBinary(
      [],
      binary([{ symbol: '--mcp-debug', type: 'cli_flag', first_seen: '2.1.83', last_seen: '2.1.201' }])
    );
    expect(byKey(out).get('cli_flag:--mcp-debug')).toEqual({
      symbol: '--mcp-debug',
      type: 'cli_flag',
      first_seen: '2.1.83',
      removed_in: null,
      status: 'needs_review',
      provenance: 'binary',
      confidence: 'medium',
      description: '',
      source_url: null,
      category: 'cli',
    });
  });

  it('appends a binary-only command', () => {
    const out = enrichWithBinary(
      [],
      binary([{ symbol: '/bashes', type: 'command', first_seen: '2.1.0', last_seen: '2.1.201' }])
    );
    expect(byKey(out).get('command:/bashes')).toMatchObject({
      provenance: 'binary',
      status: 'needs_review',
      source_url: null,
    });
  });

  it('appends a first-party (CLAUDE_-prefixed) binary-only env var', () => {
    const out = enrichWithBinary(
      [],
      binary([{ symbol: 'CLAUDE_CODE_ENTRYPOINT', type: 'env_var', first_seen: '0.2.89', last_seen: '2.1.201' }])
    );
    expect(byKey(out).get('env_var:CLAUDE_CODE_ENTRYPOINT')).toMatchObject({
      provenance: 'binary',
      status: 'needs_review',
      category: 'claude-code',
      first_seen: '0.2.89',
    });
  });

  it('recategorizes a promote-cc env var to claude-code and publishes it', () => {
    const out = enrichWithBinary(
      [],
      binary([{ symbol: 'ENABLE_PLUGINS', type: 'env_var', first_seen: '2.1.0', last_seen: '2.1.201' }])
    );
    expect(byKey(out).get('env_var:ENABLE_PLUGINS')).toMatchObject({
      provenance: 'binary',
      category: 'claude-code',
    });
  });

  it('leaves an external env var (CC merely reads) unpublished', () => {
    const out = enrichWithBinary(
      [],
      binary([
        { symbol: 'PATH', type: 'env_var', first_seen: '0.2.9', last_seen: '2.1.201' },
        { symbol: 'ALIYUN_REGION_ID', type: 'env_var', first_seen: '1.0.0', last_seen: '2.1.201' },
      ])
    );
    expect(out).toEqual([]);
  });

  it('carries a conservative removed_in onto a binary-only addition', () => {
    const out = enrichWithBinary(
      [],
      binary([
        { symbol: '--gone', type: 'cli_flag', first_seen: '1.0.0', last_seen: '1.0.4', removed_in: '1.0.5' },
      ])
    );
    expect(byKey(out).get('cli_flag:--gone')?.removed_in).toBe('1.0.5');
  });

  it('drops a removed binary symbol from snapshots at and after its removed_in', () => {
    const blocks = [
      { version: '1.0.0', bullets: [] },
      { version: '1.0.5', bullets: [] },
      { version: '1.0.9', bullets: [] },
    ];
    const snaps = buildEnrichedSnapshots(
      blocks,
      docsIndex([]),
      binary([
        { symbol: '--gone', type: 'cli_flag', first_seen: '1.0.0', last_seen: '1.0.4', removed_in: '1.0.5' },
      ])
    );
    const at = (v: string) =>
      snaps.find((s) => s.version === v)?.symbols.map((x) => x.symbol) ?? [];
    expect(at('1.0.0')).toContain('--gone');
    expect(at('1.0.5')).not.toContain('--gone');
    expect(at('1.0.9')).not.toContain('--gone');
  });

  it('does not re-add a symbol another lane already published', () => {
    const out = enrichWithBinary(
      [record({ symbol: '--print', type: 'cli_flag', first_seen: '1.0.0', provenance: 'changelog' })],
      binary([{ symbol: '--print', type: 'cli_flag', first_seen: '1.0.0', last_seen: '2.1.201' }])
    );
    expect(out.filter((r) => r.symbol === '--print')).toHaveLength(1);
    expect(out[0]?.provenance).toBe('changelog');
  });

  it('promotes an audited binary-only command to active with a binary-sourced description', () => {
    const out = enrichWithBinary(
      [],
      binary([{ symbol: '/design', type: 'command', first_seen: '2.1.181', last_seen: '2.1.201' }])
    );
    expect(byKey(out).get('command:/design')).toMatchObject({
      status: 'active',
      provenance: 'binary',
      confidence: 'high',
      description: 'Grant or revoke Claude agent access to your Design projects',
      description_source: 'binary',
      source_url: null,
    });
  });

  it('promotes an audited binary-only flag to active with a help-sourced description', () => {
    const out = enrichWithBinary(
      [],
      binary([{ symbol: '--cwd', type: 'cli_flag', first_seen: '0.2.9', last_seen: '2.1.201' }])
    );
    expect(byKey(out).get('cli_flag:--cwd')).toMatchObject({
      status: 'active',
      provenance: 'binary',
      confidence: 'high',
      description_source: 'help',
    });
  });

  it('leaves an un-audited binary-only symbol at needs_review with no description', () => {
    const out = enrichWithBinary(
      [],
      binary([{ symbol: '--mcp-debug', type: 'cli_flag', first_seen: '2.1.83', last_seen: '2.1.201' }])
    );
    expect(byKey(out).get('cli_flag:--mcp-debug')).toMatchObject({
      status: 'needs_review',
      description: '',
    });
    expect(byKey(out).get('cli_flag:--mcp-debug')?.description_source).toBeUndefined();
  });
});

describe('loadDocsIndex', () => {
  it('throws when the docs index is absent (committed + required, never silently empty)', async () => {
    await expect(loadDocsIndex('/tmp/claustodian-no-such-docs.json')).rejects.toThrow();
  });

  it('throws on a malformed docs file instead of silently degrading', async () => {
    const path = '/tmp/claustodian-bad-docs.json';
    await writeFile(path, '{ not valid json', 'utf8');
    await expect(loadDocsIndex(path)).rejects.toThrow();
    await rm(path, { force: true });
  });
});

describe('assertNonEmptyDocs', () => {
  const empty: DocsIndex = { $generated_by: '', source_pages: [], symbols: [] };
  const nonEmpty: DocsIndex = {
    $generated_by: '',
    source_pages: [],
    symbols: [
      { symbol: '--x', type: 'cli_flag', description: 'x', doc_min_version: null, doc_page: 'p' },
    ],
  };

  it('throws on a valid-but-empty docs index', () => {
    expect(() => assertNonEmptyDocs(empty, 'data/docs.json')).toThrow(/0 symbols/);
  });

  it('passes for a populated docs index', () => {
    expect(() => assertNonEmptyDocs(nonEmpty, 'data/docs.json')).not.toThrow();
  });
});

describe('assertCanonicalSourcesForCommittedData', () => {
  it('refuses --changelog for the committed dir under any spelling (data, data/, ./data)', () => {
    for (const spelling of ['data', 'data/', './data', './data/']) {
      expect(() => assertCanonicalSourcesForCommittedData(spelling, '/tmp/local.md')).toThrow(
        /committed data\/ directory/
      );
    }
  });

  it('allows --changelog when writing to a scratch --out (as the CLI tests do)', () => {
    expect(() => assertCanonicalSourcesForCommittedData('/tmp/out', '/tmp/local.md')).not.toThrow();
  });

  it('allows the official fetch (no --changelog) into the committed directory', () => {
    expect(() => assertCanonicalSourcesForCommittedData('data', undefined)).not.toThrow();
  });
});

describe('assembleSnapshots — per-version deprecation status', () => {
  const rec = (over: Partial<SymbolRecord>): SymbolRecord => ({
    symbol: '/output-style',
    type: 'command',
    first_seen: '1.0.0',
    removed_in: null,
    status: 'active',
    provenance: 'changelog',
    confidence: 'high',
    description: 'd',
    source_url: null,
    category: 'command',
    ...over,
  });
  const blocks = [
    { version: '1.5.0', bullets: [] },
    { version: '2.0.0', bullets: [] },
    { version: '2.4.0', bullets: [] },
    { version: '2.6.0', bullets: [] },
  ];
  const statusAt = (snaps: ReturnType<typeof assembleSnapshots>, v: string, sym: string) =>
    snaps.find((s) => s.version === v)?.symbols.find((x) => x.symbol === sym)?.status;

  it('reads active before deprecated_in and deprecated at/after (still present)', () => {
    const snaps = assembleSnapshots([rec({ deprecated_in: '2.0.0' })], blocks);
    expect(statusAt(snaps, '1.5.0', '/output-style')).toBe('active');
    expect(statusAt(snaps, '2.0.0', '/output-style')).toBe('deprecated');
    expect(statusAt(snaps, '2.6.0', '/output-style')).toBe('deprecated');
  });

  it('does not mutate the shared record (earlier snapshot stays active)', () => {
    const input = rec({ deprecated_in: '2.0.0' });
    assembleSnapshots([input], blocks);
    expect(input.status).toBe('active');
  });

  it('composes with removal: active -> deprecated -> absent', () => {
    const snaps = assembleSnapshots([rec({ deprecated_in: '2.0.0', removed_in: '2.4.0' })], blocks);
    expect(statusAt(snaps, '1.5.0', '/output-style')).toBe('active');
    expect(statusAt(snaps, '2.0.0', '/output-style')).toBe('deprecated');
    expect(statusAt(snaps, '2.4.0', '/output-style')).toBeUndefined();
    expect(statusAt(snaps, '2.6.0', '/output-style')).toBeUndefined();
  });

  it('leaves a non-active status untouched (never re-flags needs_review)', () => {
    const snaps = assembleSnapshots(
      [rec({ symbol: 'X_ENV', type: 'env_var', status: 'needs_review', deprecated_in: '2.0.0' })],
      blocks
    );
    expect(statusAt(snaps, '2.6.0', 'X_ENV')).toBe('needs_review');
  });
});

describe('freezeEstimatedFirstSeen', () => {
  const rec = (over: Partial<SymbolRecord>): SymbolRecord => ({
    symbol: '--any',
    type: 'cli_flag',
    first_seen: '2.1.205',
    first_seen_estimated: true,
    removed_in: null,
    status: 'active',
    provenance: 'docs',
    confidence: 'medium',
    description: 'd',
    source_url: null,
    category: 'cli',
    ...over,
  });

  it('pulls a floating estimate back to the earlier prior first_seen', () => {
    const [r] = freezeEstimatedFirstSeen(
      [rec({ first_seen: '2.1.205' })],
      new Map([['cli_flag:--any', '2.1.150']])
    );
    expect(r?.first_seen).toBe('2.1.150');
    expect(r?.first_seen_estimated).toBe(true);
  });

  it('never touches an anchored (non-estimated) symbol, even with an earlier prior', () => {
    const [r] = freezeEstimatedFirstSeen(
      [rec({ first_seen: '0.2.33', first_seen_estimated: undefined })],
      new Map([['cli_flag:--any', '0.2.9']])
    );
    expect(r?.first_seen).toBe('0.2.33');
  });

  it('keeps latestVersion when there is no prior entry (first sighting freezes here)', () => {
    const [r] = freezeEstimatedFirstSeen([rec({ first_seen: '2.1.205' })], new Map());
    expect(r?.first_seen).toBe('2.1.205');
  });

  it('never pushes an estimate later than its current value', () => {
    const [r] = freezeEstimatedFirstSeen(
      [rec({ first_seen: '2.1.100' })],
      new Map([['cli_flag:--any', '2.1.150']])
    );
    expect(r?.first_seen).toBe('2.1.100');
  });
});

describe('estimate does not float across a release bump', () => {
  // A docs-only symbol with no min-version and no binary evidence.
  const docs = docsIndex([
    { symbol: '--undated', type: 'cli_flag', description: 'no min-version', doc_min_version: null, doc_page: 'cli-reference' },
  ]);
  const firstSeenOf = (snaps: ReturnType<typeof buildEnrichedSnapshots>, v: string) =>
    snaps.find((s) => s.version === v)?.symbols.find((x) => x.symbol === '--undated')?.first_seen;

  it('freezes at the version first recorded instead of creeping to the newest release', () => {
    // Release 1: newest is 2.1.100 → the undated estimate lands at 2.1.100.
    const run1 = buildEnrichedSnapshots([{ version: '2.1.100', bullets: [] }], docs, undefined, new Map());
    expect(firstSeenOf(run1, '2.1.100')).toBe('2.1.100');

    // Carry that forward as the committed prior, then a new release ships.
    const prior = new Map(
      run1.at(-1)!.symbols.map((s) => [`${s.type}:${s.symbol}`, s.first_seen] as const)
    );
    const run2 = buildEnrichedSnapshots(
      [{ version: '2.1.100', bullets: [] }, { version: '2.1.110', bullets: [] }],
      docs,
      undefined,
      prior
    );
    // Frozen at 2.1.100 — NOT floated to 2.1.110 — so it now also appears at 2.1.100.
    expect(firstSeenOf(run2, '2.1.110')).toBe('2.1.100');
    expect(firstSeenOf(run2, '2.1.100')).toBe('2.1.100');
  });
});
