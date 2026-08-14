// Copyright 2026 Schuby
// SPDX-License-Identifier: Apache-2.0

import type { ControlObservation } from './binary-lane.js';
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
  describesFutureState,
  truncateToVersion,
  categorize,
  controlRecordsFor,
  CHANGELOG_SYMBOL_DENYLIST,
  collectChangelogSymbols,
  SYMBOL_DENYLIST,
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

  it('reads an env var from its `NAME=value` assignment form', () => {
    // The changelog documents many env vars this way, e.g. 2.1.233's
    // "set `CLAUDE_CODE_ENABLE_TODO_TOOLS=1` to bring them back". Without the
    // suffix handling these fall to the binary lane and land needs_review.
    const symbols = extractSymbols('set `CLAUDE_CODE_ENABLE_TODO_TOOLS=1` to bring them back');
    expect(symbols).toEqual([{ symbol: 'CLAUDE_CODE_ENABLE_TODO_TOOLS', type: 'env_var' }]);
  });

  it('dedupes an env var named twice in assignment form', () => {
    // Two assignment-form mentions, so without the suffix handling NEITHER is
    // caught (result empty) — this fails red without the fix, unlike a bare +
    // assignment pair where the bare span matches either way.
    const symbols = extractSymbols(
      'Set `OTEL_METRICS_EXPORTER=prometheus` or `OTEL_METRICS_EXPORTER=otlp`.'
    );
    expect(symbols).toEqual([{ symbol: 'OTEL_METRICS_EXPORTER', type: 'env_var' }]);
  });

  it('still denylists an OS/shell var written in assignment form', () => {
    // The suffix handling must not resurrect a denylisted name: `PATH=…` in prose
    // still resolves to PATH, which CHANGELOG_SYMBOL_DENYLIST drops.
    expect(extractSymbols('export `PATH=/usr/bin` before running')).toEqual([]);
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
      'Fixed `EADDRINUSE` and `JSON` parsing; respects `NO_COLOR` and `CLAUDE_CODE_SAFE_MODE`.'
    );
    expect(symbols.map((s) => s.symbol)).toEqual(['NO_COLOR', 'CLAUDE_CODE_SAFE_MODE']);
  });

  it('drops OS/shell env vars Claude Code reads but does not own', () => {
    // Named incidentally in changelog prose, not first-party symbols. The binary
    // lane still observes them and filters at publication (isPublishableBinaryEnv),
    // so this suppression is changelog-only via CHANGELOG_SYMBOL_DENYLIST.
    const symbols = extractSymbols(
      'Now respects `PATH`, `HOME`, `LANG`, `COLUMNS`, `LINES`, `OLDPWD`, `DIRSTACK`, and `XDG_DATA_HOME`.'
    );
    expect(symbols).toEqual([]);
  });

  it('keeps env vars Claude Code genuinely honors (NO_COLOR, OTEL context)', () => {
    // The denylist is targeted, not a sweep of OS-ish names: respected and
    // telemetry-context vars stay first-party symbols.
    const symbols = extractSymbols(
      'Honors `NO_COLOR`, `FORCE_COLOR`, `TRACEPARENT`, `TRACESTATE`.'
    );
    expect(symbols.map((s) => s.symbol)).toEqual([
      'NO_COLOR',
      'FORCE_COLOR',
      'TRACEPARENT',
      'TRACESTATE',
    ]);
  });

  it("drops git's own redirection flags/env-vars named in a bugfix bullet", () => {
    // 2.1.216: git primitives (`--git-dir`, `GIT_DIR`, `GIT_WORK_TREE`) named
    // incidentally in a fix — they belong to git, not Claude Code. `git -C` is
    // safe (the space excludes it from the token patterns).
    const symbols = extractSymbols(
      'Fixed worktree-isolated subagents redirecting git into the shared checkout ' +
        'via `git -C`, `--git-dir`, or `GIT_DIR`/`GIT_WORK_TREE`.'
    );
    expect(symbols).toEqual([]);
  });

  it('scopes the changelog-only suppression, leaving the binary denylist clean', () => {
    // Neither the git primitives nor the OS/shell env vars may leak into the
    // shared SYMBOL_DENYLIST that extract-bundle consults: the binary lane must
    // stay free to OBSERVE a bundle that reads `process.env.X` (it filters them
    // at publication via isPublishableBinaryEnv). Suppressing them there would
    // erase that record with no coverage failure to catch it.
    const changelogOnly = [
      '--git-dir',
      'GIT_DIR',
      'GIT_WORK_TREE',
      'PATH',
      'HOME',
      'LANG',
      'COLUMNS',
      'LINES',
      'OLDPWD',
      'DIRSTACK',
      'XDG_DATA_HOME',
    ];
    // Membership: these particular tokens must be present, so the list is explicit.
    for (const token of changelogOnly) {
      expect(CHANGELOG_SYMBOL_DENYLIST.has(token)).toBe(true);
    }
    // Leakage: iterate the SET itself, so a token added to CHANGELOG_SYMBOL_DENYLIST
    // later cannot escape the check by not being copied into the list above.
    for (const token of CHANGELOG_SYMBOL_DENYLIST) {
      expect(SYMBOL_DENYLIST.has(token)).toBe(false);
    }
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

  it('accepts a description already stripped of its "- " prefix', () => {
    expect(isIntroducingBullet('Added `--foo` flag')).toBe(true);
    expect(isIntroducingBullet('Fixed a crash when using `--foo`')).toBe(false);
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
    expect(
      isSubprocessFlagBullet('- Added `/plugin list` with `--enabled`/`--disabled` filters')
    ).toBe(false);
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

  it('flags a bare example clause opening straight off the word "flags"', () => {
    // 2.1.229 — git/gh flags listed without an "e.g.," lead-in, which wrongly
    // seeded `--force`/`--amend`/`--no-verify` as Claude Code flags.
    const dangerous =
      '- Changed `/commit-push-pr` so git/gh commands with dangerous flags (`--force`, `--amend`, `--no-verify`, etc.) are no longer auto-approved';
    expect(isSubprocessFlagBullet(dangerous)).toBe(true);
    expect([...subprocessFlagExamples(dangerous)].sort()).toEqual([
      '--amend',
      '--force',
      '--no-verify',
    ]);
  });

  it('flags a bare example clause for a non-git subprocess tool', () => {
    // 2.1.214 — docker's own daemon-redirect flags.
    const docker =
      "- Added permission prompts for `docker` commands (including the Podman `docker` shim) carrying daemon-redirect flags (`--url`, `--connection`, `--identity`, and Podman's remote mode) that previously ran without one";
    expect([...subprocessFlagExamples(docker)].sort()).toEqual([
      '--connection',
      '--identity',
      '--url',
    ]);
  });

  it('does not flag a bullet whose only parenthetical is an issue link', () => {
    // 2.1.47 — "git … flag (anthropics/claude-code#25750)". The clause holds no
    // flag token, so the bullet is left to normal extraction.
    const issueLink =
      '- Fixed read-only git commands triggering FSEvents file watcher loops on macOS by adding --no-optional-locks flag (anthropics/claude-code#25750)';
    expect(isSubprocessFlagBullet(issueLink)).toBe(false);
  });

  it('keeps a first-party flag when the bare clause follows an unrelated tool word', () => {
    // No "flag"/"flags" token at all, so the rule never engages. Kept as a cheap
    // negative control, NOT as the over-broadness guard — it passes against the
    // pre-fix regex too, which is what the test below exists to catch.
    const firstParty = '- Added `--git-notes` for git integration (writes a note per commit)';
    expect(isSubprocessFlagBullet(firstParty)).toBe(false);
    const keys = [
      ...collectChangelogSymbols([{ version: '2.1.41', bullets: [firstParty] }]).keys(),
    ];
    expect(keys).toContain('cli_flag:--git-notes');
  });

  it('keeps a first-party flag when the parenthetical is an alias aside, not a list', () => {
    // The arrangement that actually reaches the bare-paren branch: the word "flag"
    // is present, the tool-word match lands INSIDE `--git-notes` because `-` is a
    // non-word character, and a parenthetical follows. With `\b` on the left this
    // suppressed `--no-git-notes` — a first-party flag introduced by the very
    // bullet announcing it.
    const alias = '- Added a `--git-notes` flag (`--no-git-notes` disables it)';
    expect(isSubprocessFlagBullet(alias)).toBe(false);
    const keys = [...collectChangelogSymbols([{ version: '2.1.41', bullets: [alias] }]).keys()];
    expect(keys).toContain('cli_flag:--git-notes');
    expect(keys).toContain('cli_flag:--no-git-notes');
  });

  it('keeps BOTH flags of an alias pair the bullet introduces', () => {
    // One token wider than the case above, and the reason the fix is a lookaround
    // rather than a "looks like a list" threshold: `collectChangelogSymbols` skips
    // by symbol NAME, not position, so a flag named inside AND outside the clause
    // vanished too. A two-flag count cannot tell this from a real example list.
    const pair =
      '- Added a `--git-sign` flag (`--git-sign` enables signing, `--no-git-sign` disables it)';
    expect(isSubprocessFlagBullet(pair)).toBe(false);
    const keys = [...collectChangelogSymbols([{ version: '2.1.41', bullets: [pair] }]).keys()];
    expect(keys).toContain('cli_flag:--git-sign');
    expect(keys).toContain('cli_flag:--no-git-sign');
  });

  it('still suppresses a hyphenated tool name', () => {
    // The boundary is asymmetric on purpose: a lookbehind that also excluded `-`
    // on the RIGHT would stop matching `docker-compose` and `git-lfs`, losing real
    // suppression. Only the left side needs it, since the defect is a tool word
    // sitting inside `--flag-name`.
    const hyphenated =
      '- Added prompts for `docker-compose` commands carrying flags (`--url`, `--connection`)';
    expect(isSubprocessFlagBullet(hyphenated)).toBe(true);
    expect(subprocessFlagExamples(hyphenated).has('--url')).toBe(true);
  });

  it('still suppresses a genuine subprocess clause naming ONE flag', () => {
    // A pin for the direction that must NOT loosen: the tool word is genuine, so
    // the clause is suppressed however few flags it lists. Passes against the old
    // regex too; the alias-aside and alias-pair tests are what bind the change.
    const one = '- Allowed `git log` flags (e.g., `--raw`) in read-only mode';
    expect(isSubprocessFlagBullet(one)).toBe(true);
    expect(subprocessFlagExamples(one).has('--raw')).toBe(true);
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

  it('keeps the earlier changelog observation when the docs min-version is later', () => {
    // Earliest evidence wins in both directions: a doc min-version AFTER the
    // changelog sighting must not push first_seen forward, but it still settles
    // the estimate (the doc anchors the symbol, so the bound is no longer open).
    const laterDocs = docsIndex([
      {
        symbol: '--incident',
        type: 'cli_flag',
        description: 'Incident',
        doc_min_version: '2.1.0',
        doc_page: 'cli-reference',
      },
    ]);
    const r = enrichSymbols(collectChangelogSymbols(blocks), laterDocs, '2.1.0').find(
      (x) => x.symbol === '--incident'
    );
    expect(r).toMatchObject({ first_seen: '2.0.0', confidence: 'high' });
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
      [
        record({
          symbol: '--print',
          first_seen: '2.1.0',
          first_seen_estimated: true,
          confidence: 'medium',
        }),
      ],
      binary([{ symbol: '--print', type: 'cli_flag', first_seen: '0.2.9', last_seen: '2.1.201' }])
    );
    const r = byKey(out).get('cli_flag:--print');
    expect(r).toMatchObject({ first_seen: '0.2.9', confidence: 'high', provenance: 'changelog' });
    expect(r?.first_seen_estimated).toBeUndefined();
  });

  it('publishes an @internal settings key as settings-internal', () => {
    // The category cannot be recomputed from the symbol name, so it has to come
    // from the description timeline. Losing it publishes internal plumbing
    // indistinguishably from user-facing configuration.
    const out = enrichWithBinary(
      [],
      binary([
        {
          symbol: 'skipWorkflowUsageWarning',
          type: 'config_key',
          first_seen: '2.1.180',
          last_seen: '2.1.224',
        },
        { symbol: 'model', type: 'config_key', first_seen: '2.1.180', last_seen: '2.1.224' },
      ]),
      {
        'config_key:skipWorkflowUsageWarning': [
          { from: '2.1.180', description: '@internal Accepted the workflow warning' },
        ],
        'config_key:model': [{ from: '2.1.180', description: 'Override the default model' }],
      }
    );
    expect(byKey(out).get('config_key:skipWorkflowUsageWarning')?.category).toBe(
      'settings-internal'
    );
    expect(byKey(out).get('config_key:model')?.category).toBe('settings');
  });

  it('reads the category from the era in effect at that version, not the newest', () => {
    // disableWorkflows lost its @internal prefix at 2.1.154. A record observed
    // only up to 2.1.153 must still read as internal.
    const eras = {
      'config_key:disableWorkflows': [
        { from: '2.1.152', description: '@internal Disable the Workflows feature' },
        { from: '2.1.154', description: 'Disable the Workflows feature' },
      ],
    };
    const early = enrichWithBinary(
      [],
      binary([
        {
          symbol: 'disableWorkflows',
          type: 'config_key',
          first_seen: '2.1.152',
          last_seen: '2.1.153',
        },
      ]),
      eras
    );
    const late = enrichWithBinary(
      [],
      binary([
        {
          symbol: 'disableWorkflows',
          type: 'config_key',
          first_seen: '2.1.152',
          last_seen: '2.1.224',
        },
      ]),
      eras
    );
    expect(byKey(early).get('config_key:disableWorkflows')?.category).toBe('settings-internal');
    expect(byKey(late).get('config_key:disableWorkflows')?.category).toBe('settings');
  });

  it('falls back to the name-based category when no description timeline is supplied', () => {
    const out = enrichWithBinary(
      [],
      binary([{ symbol: 'model', type: 'config_key', first_seen: '2.1.180', last_seen: '2.1.224' }])
    );
    expect(byKey(out).get('config_key:model')?.category).toBe('settings');
  });

  it('withholds a switch-case-only flag from the published set', () => {
    // Claude Code's own flag, but only ever seen as a `case"--x":` label in a
    // subcommand's argv parser. At 2.1.224 every such flag belongs to
    // `claude self-hosted-runner` or deeper; none is valid on bare `claude`, and a
    // flat record would assert otherwise. Stays in binary-observations.json.
    const out = enrichWithBinary(
      [],
      binary([
        {
          symbol: '--health-port',
          type: 'cli_flag',
          first_seen: '2.1.224',
          last_seen: '2.1.224',
          switch_case_only: true,
        },
      ])
    );
    expect(byKey(out).has('cli_flag:--health-port')).toBe(false);
  });

  it('publishes a switch-case-only flag once containment established its scope', () => {
    // The other half of the rule above. `--sigkill-timeout-sec` is still only ever
    // a `case"--sigkill-timeout-sec":` label, but the parser module's own
    // `Usage: claude self-hosted-runner` banner says whose it is, so it publishes
    // WITH that scope instead of being dropped.
    const out = enrichWithBinary(
      [],
      binary([
        {
          symbol: '--sigkill-timeout-sec',
          type: 'cli_flag',
          first_seen: '2.1.224',
          last_seen: '2.1.226',
          switch_case_only: true,
          scopes: ['self-hosted-runner'],
        },
      ])
    );
    // Deliberately a flag the audit did NOT promote, so this covers the scope gate
    // alone and does not quietly become a test of PROMOTED_BINARY_SYMBOLS.
    expect(byKey(out).get('cli_flag:--sigkill-timeout-sec')).toMatchObject({
      provenance: 'binary',
      status: 'needs_review',
    });
  });

  it('still publishes a binary-only flag that has ordinary evidence', () => {
    // Deliberately a flag the audit has NOT promoted, so this keeps testing the
    // needs_review default rather than quietly becoming a promotion test.
    const out = enrichWithBinary(
      [],
      binary([
        { symbol: '--hard-fail', type: 'cli_flag', first_seen: '2.1.15', last_seen: '2.1.224' },
      ])
    );
    expect(byKey(out).get('cli_flag:--hard-fail')).toMatchObject({
      provenance: 'binary',
      status: 'needs_review',
    });
  });

  it('does not let a switch-case-only observation re-date an existing record', () => {
    // A `self-hosted-runner decode-token` parser accepting --help is no evidence
    // about when the TOP-LEVEL --help appeared.
    const out = enrichWithBinary(
      [
        record({
          symbol: '--help',
          first_seen: '2.1.200',
          first_seen_estimated: true,
          confidence: 'medium',
        }),
      ],
      binary([
        {
          symbol: '--help',
          type: 'cli_flag',
          first_seen: '2.0.29',
          last_seen: '2.1.224',
          switch_case_only: true,
        },
      ])
    );
    expect(byKey(out).get('cli_flag:--help')).toMatchObject({ first_seen: '2.1.200' });
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
      [
        record({
          symbol: '--foo',
          first_seen: '2.0.0',
          first_seen_estimated: true,
          confidence: 'medium',
        }),
      ],
      binary([{ symbol: '--foo', type: 'cli_flag', first_seen: '1.0.0', last_seen: '1.5.0' }])
    );
    // last_seen 1.5.0 is well before the record's world, yet removed_in stays null.
    expect(byKey(out).get('cli_flag:--foo')?.removed_in).toBeNull();
  });

  it('appends a binary-only flag as provenance:binary / needs_review with a null source', () => {
    const out = enrichWithBinary(
      [],
      binary([
        { symbol: '--mcp-debug', type: 'cli_flag', first_seen: '2.1.83', last_seen: '2.1.201' },
      ])
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
      binary([
        {
          symbol: 'CLAUDE_CODE_ENTRYPOINT',
          type: 'env_var',
          first_seen: '0.2.89',
          last_seen: '2.1.201',
        },
      ])
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
      binary([
        { symbol: 'ENABLE_PLUGINS', type: 'env_var', first_seen: '2.1.0', last_seen: '2.1.201' },
      ])
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
        {
          symbol: '--gone',
          type: 'cli_flag',
          first_seen: '1.0.0',
          last_seen: '1.0.4',
          removed_in: '1.0.5',
        },
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
        {
          symbol: '--gone',
          type: 'cli_flag',
          first_seen: '1.0.0',
          last_seen: '1.0.4',
          removed_in: '1.0.5',
        },
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
      [
        record({
          symbol: '--print',
          type: 'cli_flag',
          first_seen: '1.0.0',
          provenance: 'changelog',
        }),
      ],
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
      binary([
        { symbol: '--mcp-debug', type: 'cli_flag', first_seen: '2.1.83', last_seen: '2.1.201' },
      ])
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

  it('attaches curated scopes to a subcommand-only flag in every snapshot', () => {
    const snaps = assembleSnapshots(
      [rec({ symbol: '--sandbox', type: 'cli_flag', first_seen: '1.5.0', category: 'cli' })],
      blocks
    );
    for (const v of ['1.5.0', '2.6.0']) {
      const f = snaps.find((s) => s.version === v)?.symbols.find((x) => x.symbol === '--sandbox');
      expect(f?.scopes).toEqual(['remote-control']);
    }
  });

  it('unions binary-proved scopes with the curated table in the snapshot', () => {
    // Drives assembleSnapshots, not scopesFor: the union has to survive the whole
    // publish path, and a helper-level assertion would not prove the map is
    // actually threaded through withScopes.
    const snaps = assembleSnapshots(
      [rec({ symbol: '--capacity', type: 'cli_flag', first_seen: '1.5.0', category: 'cli' })],
      blocks,
      undefined,
      new Map([['cli_flag:--capacity', { from: '1.5.0', scopes: ['self-hosted-runner'] }]])
    );
    const f = snaps
      .find((s) => s.version === '2.6.0')
      ?.symbols.find((x) => x.symbol === '--capacity');
    expect(f?.scopes).toEqual(['remote-control', 'self-hosted-runner']);
  });

  it('scopes a binary-only flag the curated table never saw', () => {
    const snaps = assembleSnapshots(
      [rec({ symbol: '--min-idle', type: 'cli_flag', first_seen: '1.5.0', category: 'cli' })],
      blocks,
      undefined,
      new Map([
        ['cli_flag:--min-idle', { from: '1.5.0', scopes: ['self-hosted-runner orchestrator'] }],
      ])
    );
    const f = snaps
      .find((s) => s.version === '2.6.0')
      ?.symbols.find((x) => x.symbol === '--min-idle');
    expect(f?.scopes).toEqual(['self-hosted-runner orchestrator']);
  });

  it('keeps the full invocation path in the published snapshot', () => {
    // `claude self-hosted-runner --min-idle` errors with `unknown flag`, so a
    // collapsed `self-hosted-runner` here would ship a claim the binary disproves.
    const snaps = assembleSnapshots(
      [rec({ symbol: '--min-idle', type: 'cli_flag', first_seen: '1.5.0', category: 'cli' })],
      blocks,
      undefined,
      new Map([
        ['cli_flag:--min-idle', { from: '1.5.0', scopes: ['self-hosted-runner orchestrator'] }],
      ])
    );
    const f = snaps
      .find((s) => s.version === '2.6.0')
      ?.symbols.find((x) => x.symbol === '--min-idle');
    expect(f?.scopes).not.toContain('self-hosted-runner');
  });

  it('does not apply a binary scope to snapshots before the binary proved it', () => {
    // Greptile P1 on PR 136, and the same defect class as the config_key category
    // one: a value we KNOW is version-bounded leaking into historical snapshots.
    // `--capacity` exists from 1.5.0 (remote-control, docs) but the runner's
    // parser only appears at 2.4.0 here. The 2.0.0 snapshot must not claim
    // `claude self-hosted-runner --capacity` worked when the subcommand did not
    // exist; the curated remote-control scope still applies throughout.
    const snaps = assembleSnapshots(
      [rec({ symbol: '--capacity', type: 'cli_flag', first_seen: '1.5.0', category: 'cli' })],
      blocks,
      undefined,
      new Map([['cli_flag:--capacity', { from: '2.4.0', scopes: ['self-hosted-runner'] }]])
    );
    const at = (v: string) =>
      snaps.find((s) => s.version === v)?.symbols.find((x) => x.symbol === '--capacity');
    expect(at('1.5.0')?.scopes).toEqual(['remote-control']);
    expect(at('2.0.0')?.scopes).toEqual(['remote-control']);
    // From the proving version onward the union applies.
    expect(at('2.4.0')?.scopes).toEqual(['remote-control', 'self-hosted-runner']);
    expect(at('2.6.0')?.scopes).toEqual(['remote-control', 'self-hosted-runner']);
  });

  it('omits a binary-only scope entirely before its proving version', () => {
    // With nothing curated to fall back on, the field is absent rather than empty.
    const snaps = assembleSnapshots(
      [rec({ symbol: '--min-idle', type: 'cli_flag', first_seen: '1.5.0', category: 'cli' })],
      blocks,
      undefined,
      new Map([
        ['cli_flag:--min-idle', { from: '2.4.0', scopes: ['self-hosted-runner orchestrator'] }],
      ])
    );
    const at = (v: string) =>
      snaps.find((s) => s.version === v)?.symbols.find((x) => x.symbol === '--min-idle');
    expect(at('2.0.0')?.scopes).toBeUndefined();
    expect(at('2.4.0')?.scopes).toEqual(['self-hosted-runner orchestrator']);
  });

  it('leaves a top-level flag and a non-flag symbol unscoped', () => {
    const snaps = assembleSnapshots(
      [
        rec({ symbol: '--help', type: 'cli_flag', first_seen: '1.5.0', category: 'cli' }),
        rec({ symbol: '/plugin', type: 'command', first_seen: '1.5.0', category: 'command' }),
      ],
      blocks
    );
    const at = (sym: string) =>
      snaps.find((s) => s.version === '2.6.0')?.symbols.find((x) => x.symbol === sym);
    expect(at('--help')?.scopes).toBeUndefined();
    expect(at('/plugin')?.scopes).toBeUndefined();
  });

  it('resolves a config key category per version as the @internal marker moves', () => {
    // ONE observation window spanning the edit, which is what the real pipeline
    // produces: disableWorkflows is present 2.1.152 -> 2.1.224 and lost its
    // @internal prefix at 2.1.154. enrichWithBinary can only stamp one category
    // on the record, so without per-version resolution every snapshot would show
    // the tip's value and the versions where it WAS internal would say otherwise.
    const snaps = assembleSnapshots(
      [
        rec({
          symbol: 'disableWorkflows',
          type: 'config_key',
          first_seen: '1.5.0',
          category: 'settings',
          description: 'Disable the Workflows feature',
          provenance: 'binary',
        }),
      ],
      blocks,
      {
        'config_key:disableWorkflows': [
          { from: '1.5.0', description: '@internal Disable the Workflows feature' },
          { from: '2.4.0', description: 'Disable the Workflows feature' },
        ],
      }
    );
    const catAt = (v: string) =>
      snaps.find((s) => s.version === v)?.symbols.find((x) => x.symbol === 'disableWorkflows')
        ?.category;
    expect(catAt('1.5.0')).toBe('settings-internal');
    expect(catAt('2.0.0')).toBe('settings-internal');
    expect(catAt('2.4.0')).toBe('settings');
    expect(catAt('2.6.0')).toBe('settings');
  });

  it('leaves a non-config symbol category untouched by the description timeline', () => {
    const snaps = assembleSnapshots([rec({ category: 'command' })], blocks, {
      'command:/output-style': [{ from: '1.5.0', description: '@internal looks internal' }],
    });
    const cat = snaps
      .find((s) => s.version === '2.6.0')
      ?.symbols.find((x) => x.symbol === '/output-style')?.category;
    expect(cat).toBe('command');
  });

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
    {
      symbol: '--undated',
      type: 'cli_flag',
      description: 'no min-version',
      doc_min_version: null,
      doc_page: 'cli-reference',
    },
  ]);
  const firstSeenOf = (snaps: ReturnType<typeof buildEnrichedSnapshots>, v: string) =>
    snaps.find((s) => s.version === v)?.symbols.find((x) => x.symbol === '--undated')?.first_seen;

  it('freezes at the version first recorded instead of creeping to the newest release', () => {
    // Release 1: newest is 2.1.100 → the undated estimate lands at 2.1.100.
    const run1 = buildEnrichedSnapshots(
      [{ version: '2.1.100', bullets: [] }],
      docs,
      undefined,
      new Map()
    );
    expect(firstSeenOf(run1, '2.1.100')).toBe('2.1.100');

    // Carry that forward as the committed prior, then a new release ships.
    const prior = new Map(
      run1.at(-1)!.symbols.map((s) => [`${s.type}:${s.symbol}`, s.first_seen] as const)
    );
    const run2 = buildEnrichedSnapshots(
      [
        { version: '2.1.100', bullets: [] },
        { version: '2.1.110', bullets: [] },
      ],
      docs,
      undefined,
      prior
    );
    // Frozen at 2.1.100 — NOT floated to 2.1.110 — so it now also appears at 2.1.100.
    expect(firstSeenOf(run2, '2.1.110')).toBe('2.1.100');
    expect(firstSeenOf(run2, '2.1.100')).toBe('2.1.100');
  });
});

describe('assembleSnapshots — per-version descriptions (binary timeline)', () => {
  const cmd = (over: Partial<SymbolRecord>): SymbolRecord => ({
    symbol: '/review',
    type: 'command',
    first_seen: '0.2.9',
    removed_in: null,
    status: 'active',
    provenance: 'changelog',
    confidence: 'high',
    description: 'Run a fast single-pass review',
    description_source: 'docs',
    source_url: null,
    category: 'command',
    ...over,
  });
  const blocks = [
    { version: '0.2.9', bullets: [] },
    { version: '2.1.100', bullets: [] },
    { version: '2.1.205', bullets: [] },
  ];
  const timeline = {
    'command:/review': [
      { from: '0.2.9', description: 'Review a pull request' },
      { from: '2.1.100', description: 'Run a fast single-pass review' },
    ],
  };
  const descOf = (snaps: ReturnType<typeof assembleSnapshots>, v: string) => {
    const r = snaps.find((s) => s.version === v)?.symbols.find((x) => x.symbol === '/review');
    return r ? { description: r.description, source: r.description_source } : undefined;
  };

  it('uses the binary description for a historical snapshot, the curated one for the current era', () => {
    const snaps = assembleSnapshots([cmd({})], blocks, timeline);
    // Historical era (before 2.1.100) → binary text, description_source binary.
    expect(descOf(snaps, '0.2.9')).toEqual({
      description: 'Review a pull request',
      source: 'binary',
    });
    // Current era (>= 2.1.100) → keeps the record's curated docs description.
    expect(descOf(snaps, '2.1.100')).toEqual({
      description: 'Run a fast single-pass review',
      source: 'docs',
    });
    expect(descOf(snaps, '2.1.205')).toEqual({
      description: 'Run a fast single-pass review',
      source: 'docs',
    });
  });

  it('fills a previously-empty description from the binary at every version', () => {
    const snaps = assembleSnapshots(
      [cmd({ description: '', description_source: undefined })],
      blocks,
      timeline
    );
    // No curated text, so the binary description is used in every era (incl. current).
    expect(descOf(snaps, '0.2.9')).toEqual({
      description: 'Review a pull request',
      source: 'binary',
    });
    expect(descOf(snaps, '2.1.205')).toEqual({
      description: 'Run a fast single-pass review',
      source: 'binary',
    });
  });

  it('leaves an empty description untouched when there is no binary timeline for it', () => {
    const snaps = assembleSnapshots(
      [cmd({ symbol: '/nolane', description: '', description_source: undefined })],
      blocks,
      timeline
    );
    const r = snaps.find((s) => s.version === '0.2.9')?.symbols.find((x) => x.symbol === '/nolane');
    expect(r?.description).toBe('');
  });

  it('is a no-op when no binary descriptions are supplied', () => {
    const snaps = assembleSnapshots([cmd({})], blocks);
    expect(descOf(snaps, '0.2.9')).toEqual({
      description: 'Run a fast single-pass review',
      source: 'docs',
    });
  });
});

describe('enrichSymbols — page-declared category', () => {
  const docs = docsIndex([
    {
      symbol: 'diffTool',
      type: 'config_key',
      description: 'Where to show diffs',
      doc_min_version: null,
      doc_page: 'settings',
      category: 'global-config',
    },
    {
      symbol: 'advisorModel',
      type: 'config_key',
      description: 'Model for the advisor tool',
      doc_min_version: null,
      doc_page: 'settings',
    },
  ]);
  const byKey = new Map(
    enrichSymbols(collectChangelogSymbols([{ version: '2.1.0', bullets: [] }]), docs, '2.1.0').map(
      (r) => [r.symbol, r]
    )
  );

  it('carries a page-declared category through to the published record', () => {
    // Drives enrichSymbols, not the parser: the override has to survive the merge.
    // `~/.claude.json` keys are ignored in settings.json, so publishing them as
    // `settings` would assert what the page explicitly denies.
    expect(byKey.get('diffTool')).toMatchObject({
      type: 'config_key',
      provenance: 'docs',
      status: 'active',
      category: 'global-config',
    });
  });

  it('still categorizes a settings.json key by name when the page declares nothing', () => {
    expect(byKey.get('advisorModel')?.category).toBe('settings');
  });
});

describe('assembleSnapshots — flag visibility per version', () => {
  const rec = (over: Partial<SymbolRecord>): SymbolRecord =>
    ({
      symbol: '--teleport',
      type: 'cli_flag',
      first_seen: '1.5.0',
      first_seen_estimated: false,
      removed_in: null,
      status: 'needs_review',
      provenance: 'binary',
      confidence: 'medium',
      description: '',
      source_url: null,
      category: 'cli',
      ...over,
    }) as SymbolRecord;
  const blocks = [
    { version: '1.5.0', bullets: [] },
    { version: '2.0.0', bullets: [] },
    { version: '2.4.0', bullets: [] },
    { version: '2.6.0', bullets: [] },
  ];

  it('reports the visibility that version actually had, not the latest one', () => {
    // --teleport was hidden from `claude --help` for its whole life until 2.1.226
    // made it public. A single record-level category would tell someone asking
    // about an old version today's answer.
    const snaps = assembleSnapshots(
      [rec({})],
      blocks,
      undefined,
      undefined,
      new Map([
        [
          'cli_flag:--teleport',
          [
            { from: '1.5.0', hidden: true },
            { from: '2.4.0', hidden: false },
          ],
        ],
      ])
    );
    const at = (v: string) =>
      snaps.find((s) => s.version === v)?.symbols.find((x) => x.symbol === '--teleport')?.category;
    expect(at('1.5.0')).toBe('cli-internal');
    expect(at('2.0.0')).toBe('cli-internal');
    expect(at('2.4.0')).toBe('cli');
    expect(at('2.6.0')).toBe('cli');
  });

  it('leaves a flag with no visibility timeline alone', () => {
    const snaps = assembleSnapshots(
      [rec({ symbol: '--print' })],
      blocks,
      undefined,
      undefined,
      new Map()
    );
    expect(snaps.at(-1)?.symbols.find((x) => x.symbol === '--print')?.category).toBe('cli');
  });
});

describe('assembleSnapshots — a flag that became hidden later', () => {
  it('reports cli before the flag was hidden, not the tip category', () => {
    // The record is created with the LAST_SEEN category (cli-internal here), so a
    // resolver that returns "whatever the record already has" when not hidden
    // leaks the tip's answer backwards.
    const rec = {
      symbol: '--task-budget',
      type: 'cli_flag',
      first_seen: '1.5.0',
      first_seen_estimated: false,
      removed_in: null,
      status: 'needs_review',
      provenance: 'binary',
      confidence: 'medium',
      description: '',
      source_url: null,
      category: 'cli-internal',
    } as SymbolRecord;
    const snaps = assembleSnapshots(
      [rec],
      [
        { version: '1.5.0', bullets: [] },
        { version: '2.4.0', bullets: [] },
        { version: '2.6.0', bullets: [] },
      ],
      undefined,
      undefined,
      new Map([['cli_flag:--task-budget', [{ from: '2.4.0', hidden: true }]]])
    );
    const at = (v: string) =>
      snaps.find((s) => s.version === v)?.symbols.find((x) => x.symbol === '--task-budget')
        ?.category;
    expect(at('1.5.0')).toBe('cli');
    expect(at('2.4.0')).toBe('cli-internal');
    expect(at('2.6.0')).toBe('cli-internal');
  });
});

describe('describesFutureState', () => {
  const firstSeen = new Map([
    ['cli_flag:--post', '2.1.227'],
    ['command:/code-review', '2.1.147'],
  ]);
  const releases = new Set(['2.1.100', '2.1.147', '2.1.150', '2.1.200', '2.1.223', '2.1.227']);

  it('flags a release later than the snapshot, however it is written', () => {
    // Both spellings occur in the real docs text.
    expect(
      describesFutureState('Before v2.1.223, this was separate.', '2.1.200', firstSeen, releases)
    ).toBe(true);
    expect(describesFutureState('Changed in 2.1.223.', '2.1.200', firstSeen, releases)).toBe(true);
  });

  it('leaves a release at or before the snapshot alone', () => {
    expect(describesFutureState('Added in v2.1.100.', '2.1.200', firstSeen, releases)).toBe(false);
    expect(describesFutureState('Added in v2.1.200.', '2.1.200', firstSeen, releases)).toBe(false);
  });

  it('flags a symbol whose own first_seen is later than the snapshot', () => {
    // `/code-review` at 2.1.150 named `--post`, which the dataset dates to 2.1.227.
    expect(describesFutureState('Pass `--post` to publish.', '2.1.150', firstSeen, releases)).toBe(
      true
    );
    expect(describesFutureState('See `/code-review`.', '2.1.150', firstSeen, releases)).toBe(false);
  });

  it('checks env vars and settings keys, not only flags and commands', () => {
    // `DISABLE_TELEMETRY`'s docs text names `DISABLE_GROWTHBOOK` and was published
    // at 0.2.100. Matching only `--flag` and `/command` left every env-var and
    // settings-key reference unchecked.
    const wide = new Map([
      ['env_var:DISABLE_GROWTHBOOK', '2.1.124'],
      ['config_key:viewMode', '2.1.180'],
      ['config_key:ultracode', '2.1.190'],
    ]);
    expect(describesFutureState('See `DISABLE_GROWTHBOOK`.', '0.2.100', wide, releases)).toBe(true);
    expect(describesFutureState('Set `viewMode` to compact.', '2.1.100', wide, releases)).toBe(
      true
    );
    // A BARE lowercase word is a real key AND an ordinary word, so it abstains:
    // truncating correct prose is the costlier error.
    expect(describesFutureState('Enable `ultracode` mode.', '2.1.100', wide, releases)).toBe(false);
  });

  it('treats a question mark as a sentence end', () => {
    // `?` was added as a terminator but nothing bound it; the suite stayed green
    // with the branch deleted.
    const text = 'Need a list? Since v2.1.223 it also accepts a map.';
    expect(truncateToVersion(text, '2.1.200', firstSeen, new Set(['2.1.200', '2.1.223']))).toBe(
      'Need a list?'
    );
  });

  it('ignores a symbol the dataset does not know', () => {
    // Absence of a record is not evidence the symbol did not exist; guessing here
    // would suppress good text on the strength of a gap in our own data.
    expect(describesFutureState('Pass `--never-recorded`.', '1.0.0', firstSeen, releases)).toBe(
      false
    );
  });
});

describe('truncateToVersion', () => {
  const firstSeen = new Map([['cli_flag:--bg', '2.1.119']]);
  const releases = new Set(['1.0.62', '2.1.100', '2.1.196', '2.1.200', '2.1.300']);

  it('keeps the sentences that name nothing later, and drops the rest', () => {
    const text =
      'Override the API endpoint to route requests through a proxy. ' +
      'As of v2.1.196, tool search is disabled for a non-first-party host.';
    expect(truncateToVersion(text, '1.0.62', firstSeen, releases)).toBe(
      'Override the API endpoint to route requests through a proxy.'
    );
  });

  it('returns empty when the FIRST sentence already names the future', () => {
    // Empty is the honest answer here:
    // no leading sentence avoids naming the future.
    expect(truncateToVersion('Removed in v2.1.300.', '1.0.62', firstSeen, releases)).toBe('');
  });

  it('does not split inside a code span', () => {
    // The period inside the span is followed by WHITESPACE, which is the only
    // arrangement the splitter could get wrong — a period between digits is never
    // a split point anyway, so `2.1.196` alone would not exercise this.
    // With the code-span tracking: one sentence, it names 2.1.300, so nothing is
    // kept. Without it: a split after `a.` keeps the dangling 'Set it to `a.'.
    expect(
      truncateToVersion('Set it to `a. v2.1.300` for the default.', '2.1.196', firstSeen, releases)
    ).toBe('');
  });

  it('ignores a dotted triple that is not a release this dataset has', () => {
    // `terminalProgressBarEnabled` is documented as "Ghostty 1.2.0+, and iTerm2
    // 3.6.6+". Compared as releases those beat every Claude Code version, so a
    // bare-triple rule called correct CURRENT prose anachronistic, at the tip
    // included. Neither triple is a release.
    const text = 'Supported in Ghostty 1.2.0+, and iTerm2 3.6.6+.';
    expect(describesFutureState(text, '2.1.231', firstSeen, releases)).toBe(false);
    // An IPv4 literal yields the match `127.0.0`, which beats every release.
    expect(
      describesFutureState('Bind to 127.0.0.1 for local use.', '1.0.0', firstSeen, releases)
    ).toBe(false);
  });

  it('only treats a correction as one when it is still ahead of the snapshot', () => {
    // Both markers live in the SAME sentence, which is the only arrangement that
    // exercises the comparison: the sentence trips on its forward half (v2.1.300)
    // while its backward half (v2.1.100) is already settled history at 2.1.196, so
    // it corrects nothing there and the prefix survives.
    const text =
      'Accepts a list. Before v2.1.100 it was opt-in, and since v2.1.300 it takes a map.';
    expect(truncateToVersion(text, '2.1.196', firstSeen, releases)).toBe('Accepts a list.');
    // Below v2.1.100 the correction IS still ahead, so nothing survives.
    expect(truncateToVersion(text, '1.0.62', firstSeen, releases)).toBe('');
  });

  it('treats the trailing "X and earlier" form as a correction too', () => {
    // The second capture group of the dated pattern. Reversing the phrasing must not
    // change the outcome.
    expect(
      truncateToVersion(
        'Accepts a list. On v2.1.300 and earlier it was opt-in.',
        '2.1.196',
        firstSeen,
        releases
      )
    ).toBe('');
  });

  it('treats an undated backward phrase as a correction', () => {
    // No version to compare, so it cannot be shown to be settled history. The safe
    // reading is that it still corrects the prefix.
    expect(
      truncateToVersion(
        'Accepts a map. On earlier versions it took v2.1.300 only.',
        '2.1.196',
        firstSeen,
        releases
      )
    ).toBe('');
  });

  it('does not end a sentence on an abbreviation', () => {
    // The future reference sits in the fragment straight after the abbreviation,
    // which is the only arrangement where the split changes the outcome.
    // With the fix: one sentence, it names 2.1.300, so nothing is kept. Without
    // it: a split after `e.g.` keeps the dangling 'Accepts a list, e.g.'.
    const text = 'Accepts a list, e.g. a map since v2.1.300. Older forms still work.';
    expect(truncateToVersion(text, '2.1.100', firstSeen, releases)).toBe('');
  });

  it('leaves text the version fully supports untouched', () => {
    const text = 'Merge a JSON object into every request body.';
    expect(truncateToVersion(text, '1.0.62', firstSeen, releases)).toBe(text);
  });
});

describe('assembleSnapshots — a docs description never backfills onto history', () => {
  // 2.1.223 is in the block list because the guard only recognises a dotted triple
  // that is a release THIS dataset has — otherwise another product's version number
  // reads as a Claude Code release. In production the list is every release.
  const blocks = [
    { version: '2.1.150', bullets: [] },
    { version: '2.1.200', bullets: [] },
    { version: '2.1.223', bullets: [] },
    { version: '2.1.230', bullets: [] },
  ];
  const review = (description: string): SymbolRecord => ({
    symbol: '/review',
    type: 'command',
    first_seen: '2.1.100',
    removed_in: null,
    status: 'active',
    provenance: 'docs',
    confidence: 'high',
    description,
    description_source: 'docs',
    source_url: null,
    category: 'command',
  });
  const at = (snaps: ReturnType<typeof assembleSnapshots>, v: string) =>
    snaps.find((s) => s.version === v)?.symbols.find((x) => x.symbol === '/review');

  it('drops a backward-looking marker AND the prefix it corrects, keeping both at the tip', () => {
    // The live defect: data/versions/2.1.200.json described `/review` with
    // "Before v2.1.223, `/review` was a separate command" — a 2.1.200 snapshot
    // describing 2.1.223, in text that says so.
    //
    // Keeping the prefix would be worse than the defect, not better: "Alias of
    // code-review" is exactly what the removed sentence says was NOT true until
    // 2.1.223, so publishing it alone turns a self-refuting description into a
    // quietly wrong one. Nothing survives; at the tip the whole text does.
    const snaps = assembleSnapshots(
      [review('Alias of code-review. Before v2.1.223, `/review` was a separate command.')],
      blocks
    );
    expect(at(snaps, '2.1.200')?.description).toBe('');
    expect(at(snaps, '2.1.230')?.description).toContain('Before v2.1.223');
  });

  it('keeps the prefix when the marker is FORWARD-looking', () => {
    // Direction is the whole distinction. "As of vX" APPENDS behaviour, so the
    // prefix stood on its own before X and truncating to it is right.
    const snaps = assembleSnapshots(
      [review('Review the current diff. As of v2.1.223, it also accepts a PR number.')],
      blocks
    );
    expect(at(snaps, '2.1.200')?.description).toBe('Review the current diff.');
  });

  it('prefers the era-correct binary text over truncating', () => {
    // Truncation is the last resort. Where the binary observed the symbol at that
    // version, its text is evidence FOR that version and beats a docs remnant.
    const snaps = assembleSnapshots(
      [review('Alias of code-review. Before v2.1.223, it was separate.')],
      blocks,
      {
        'command:/review': [{ from: '2.1.100', description: 'Review a GitHub pull request' }],
      }
    );
    const historical = at(snaps, '2.1.200');
    expect(historical?.description).toBe('Review a GitHub pull request');
    expect(historical?.description_source).toBe('binary');
  });

  it('recognises a release that shipped without a changelog heading', () => {
    // More versions have an extracted binary than have a snapshot. Anthropic ships
    // releases with no changelog entry and the docs cite them, so gating on the
    // changelog alone left `data/versions/2.1.181.json` publishing "From v2.1.182,
    // named shorthand keys are also accepted" — the defect this guard removes.
    const snaps = assembleSnapshots(
      [review('Open the settings interface. From v2.1.226, shorthand keys are accepted.')],
      // 2.1.226 is deliberately NOT a block — it is known only to the binary lane, and
      // it sits BELOW the newest block, which is the real shape: 2.1.182 and 2.1.213
      // are mid-range releases with no changelog heading. Using a version that IS a
      // block would make the `observedVersions` argument inert and the test unfailable.
      [
        { version: '2.1.150', bullets: [] },
        { version: '2.1.200', bullets: [] },
        { version: '2.1.230', bullets: [] },
      ],
      undefined,
      undefined,
      undefined,
      ['2.1.226']
    );
    expect(at(snaps, '2.1.200')?.description).toBe('Open the settings interface.');
  });

  it('never rewrites the newest snapshot, even when a release above it is known', () => {
    // "Nothing changes at the newest version" held only because no release and no
    // `first_seen` happened to exceed it. A docs page can cite a release the
    // changelog has no heading for yet, and that would silently rewrite the one
    // snapshot this change promises to leave alone. Both inputs are clamped now.
    const snaps = assembleSnapshots(
      [review('Review the current diff. As of v2.1.300, it also accepts a PR number.')],
      [
        { version: '2.1.150', bullets: [] },
        { version: '2.1.200', bullets: [] },
      ],
      undefined,
      undefined,
      undefined,
      ['2.1.300'] // known to the binary lane, newer than every snapshot
    );
    expect(at(snaps, '2.1.200')?.description).toBe(
      'Review the current diff. As of v2.1.300, it also accepts a PR number.'
    );
  });

  it('ignores a first_seen above the newest snapshot, not just a release above it', () => {
    // The other half of the same clamp. `enrichWithDocs` stamps a NON-estimated
    // `first_seen` from `doc_min_version`, so a docs page citing a release the
    // changelog has no heading for yet puts a date above the tip into the map — and
    // that would rewrite the newest snapshot, the one promised untouched.
    const snaps = assembleSnapshots(
      [
        review('Rewind the session. Aliases: `/undo`'),
        {
          symbol: '/undo',
          type: 'command',
          first_seen: '2.1.300',
          removed_in: null,
          status: 'active',
          provenance: 'docs',
          confidence: 'high',
          description: 'Undo.',
          source_url: null,
          category: 'command',
        },
      ],
      [
        { version: '2.1.150', bullets: [] },
        { version: '2.1.200', bullets: [] },
      ]
    );
    expect(at(snaps, '2.1.200')?.description).toBe('Rewind the session. Aliases: `/undo`');
  });

  it('does not trust an estimated first_seen as proof a symbol did not exist', () => {
    // `first_seen_estimated` is an upper bound the schema labels unconfirmed.
    // Treating one as evidence made `/rewind` lose its docs text
    // across its whole history because it names `/undo`, whose date is a guess.
    const snaps = assembleSnapshots(
      [
        review('Rewind the session. Aliases: `/undo`'),
        {
          symbol: '/undo',
          type: 'command',
          first_seen: '2.1.230',
          first_seen_estimated: true,
          removed_in: null,
          status: 'active',
          provenance: 'docs',
          confidence: 'medium',
          description: 'Undo.',
          source_url: null,
          category: 'command',
        },
      ],
      blocks
    );
    expect(at(snaps, '2.1.150')?.description).toBe('Rewind the session. Aliases: `/undo`');
  });

  it('drops description_source when truncation leaves nothing', () => {
    // The schema says the field is absent when the description is empty; keeping it
    // asserts "the official docs say this" while saying nothing.
    const snaps = assembleSnapshots([review('From v2.1.223, this behaves differently.')], blocks);
    const historical = at(snaps, '2.1.150');
    expect(historical?.description).toBe('');
    expect(historical?.description_source).toBeUndefined();
  });

  it('leaves a description that names nothing later completely alone', () => {
    const clean = 'Review the current diff.';
    const snaps = assembleSnapshots([review(clean)], blocks);
    for (const v of ['2.1.150', '2.1.200', '2.1.230'])
      expect(at(snaps, v)?.description).toBe(clean);
  });
});

describe('controlRecordsFor', () => {
  const obs = (over: Partial<ControlObservation> = {}): ControlObservation => ({
    symbol: 'hook_callback',
    family: 'control_request',
    first_seen: '2.1.63',
    last_seen: '2.1.226',
    removed_in: null,
    direction_eras: [
      { from: '2.1.63', value: null },
      { from: '2.1.133', value: 'cli_to_host' },
    ],
    description_eras: [{ from: '2.1.63', value: 'Delivers a hook callback.' }],
    evidence_eras: [{ from: '2.1.63', value: 'schema' }],
    admitted_at_first_seen: 'union',
    ...over,
  });

  it('resolves direction at the snapshot version, not from the latest era', () => {
    // The whole reason direction is a timeline. 2.1.132 predates the split the CLI
    // began declaring at 2.1.133, so null is the honest answer there — reading the
    // newest era would backfill an answer that version could not have given.
    expect(controlRecordsFor('2.1.132', [obs()])[0]?.direction).toBeNull();
    expect(controlRecordsFor('2.1.226', [obs()])[0]?.direction).toBe('cli_to_host');
  });

  it('carries family and direction through finalizeRecord', () => {
    // finalizeRecord rebuilds the record field by field, so a field it does not name
    // is dropped with no type error. The schema REQUIRES both on this type.
    const [record] = controlRecordsFor('2.1.226', [obs()]);
    expect(record).toMatchObject({ type: 'control_message', family: 'control_request' });
    expect(Object.keys(record ?? {})).toContain('direction');
  });

  it('marks a union-only admission estimated and caps its confidence', () => {
    const [record] = controlRecordsFor('2.1.226', [obs()]);
    expect(record?.first_seen_estimated).toBe(true);
    expect(record?.confidence).toBe('medium');
  });

  it('omits a subtype before it was first seen and from the version it was removed in', () => {
    const retired = obs({ symbol: 'rewind_code', first_seen: '2.0.43', removed_in: '2.0.63' });
    expect(controlRecordsFor('2.0.42', [retired])).toHaveLength(0);
    expect(controlRecordsFor('2.0.62', [retired])).toHaveLength(1);
    expect(controlRecordsFor('2.0.63', [retired])).toHaveLength(0);
  });

  it('emits records the record contract accepts', () => {
    // The bar that matters: the schema requires family and direction on this type and
    // forbids them elsewhere, so a shape error here fails `npm run validate` across
    // the whole dataset rather than in one test.
    const validate = buildAjv().getSchema('https://claustodian.dev/schema/symbol.schema.json');
    for (const version of ['2.1.63', '2.1.132', '2.1.226']) {
      for (const record of controlRecordsFor(version, [obs()])) {
        expect(validate?.(record), `${version}: ${JSON.stringify(validate?.errors)}`).toBe(true);
      }
    }
  });
});

describe('buildEnrichedSnapshots — control attach', () => {
  const obs = {
    symbol: 'hook_callback',
    family: 'control_request' as const,
    first_seen: '2.0.5',
    last_seen: '2.1.10',
    removed_in: null,
    direction_eras: [{ from: '2.0.5', value: null }],
    description_eras: [{ from: '2.0.5', value: 'Delivers a hook callback.' }],
    evidence_eras: [{ from: '2.0.5', value: 'schema' as const }],
    admitted_at_first_seen: 'both' as const,
  };

  // The env var is load-bearing for the ordering test below: `cli_flag` sorts BEFORE
  // `control_message` and `env_var` AFTER it, so a control record appended at the end
  // is only detectable when a type that outranks it is present.
  const blocks = [
    {
      version: '2.0.5',
      bullets: [
        '- Added `--safe-mode` flag for troubleshooting.',
        '- Added `CLAUDE_CODE_SAFE_MODE` environment variable equivalent.',
      ],
    },
    { version: '2.1.10', bullets: ['- Added `--turbo` flag for faster runs.'] },
  ];
  const docs = docsIndex([]);

  it('merges the records into each snapshot rather than returning them alongside', () => {
    // `controlRecordsFor` is tested directly elsewhere; what is untested without this
    // is the WIRING — that the records reach a snapshot at all.
    const snaps = buildEnrichedSnapshots(blocks, docs, undefined, undefined, undefined, [obs]);
    for (const snap of snaps) {
      const control = snap.symbols.filter((r) => r.type === 'control_message');
      expect(control, `${snap.version} carries no control record`).toHaveLength(1);
      expect(control[0]?.symbol).toBe('hook_callback');
    }
  });

  it('re-sorts the merged list rather than appending the records at the end', () => {
    // Snapshots publish by (type, symbol). Appending would leave the control record
    // after the env var, which sorts after it — so this fails if the sort is dropped.
    const snaps = buildEnrichedSnapshots(blocks, docs, undefined, undefined, undefined, [obs]);
    for (const snap of snaps) {
      const keys = snap.symbols.map((r) => `${r.type}\u0000${r.symbol}`);
      expect(keys, `${snap.version} is not in published order`).toEqual([...keys].sort());
    }
    expect(snaps.some((s) => s.symbols.some((r) => r.type === 'env_var'))).toBe(true);
  });

  it('leaves snapshots untouched when no observation is supplied', () => {
    // The state of the pipeline TODAY: the observation file does not exist yet, so the
    // control argument is absent and nothing about the existing dataset may move.
    const withControl = buildEnrichedSnapshots(blocks, docs, undefined, undefined, undefined, []);
    const without = buildEnrichedSnapshots(blocks, docs);
    expect(withControl).toEqual(without);
  });

  it('omits a subtype from a snapshot older than its first_seen', () => {
    const later = { ...obs, first_seen: '2.1.10' };
    const snaps = buildEnrichedSnapshots(blocks, docs, undefined, undefined, undefined, [later]);
    const at = (v: string) => snaps.find((s) => s.version === v);
    expect(at('2.0.5')?.symbols.some((r) => r.type === 'control_message')).toBe(false);
    expect(at('2.1.10')?.symbols.some((r) => r.type === 'control_message')).toBe(true);
  });
});
