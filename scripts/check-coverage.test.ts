// Copyright 2026 Schuby
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from 'vitest';

import { findMissingCoverage } from './check-coverage.js';
import type { SymbolRecord } from './scrape-changelog.js';

const FAKE_CHANGELOG = `# Changelog

## 2.1.10

- Added \`--turbo\` flag for faster runs.
- Added \`CLAUDE_CODE_TURBO\` environment variable to control it.

## 2.0.5

- Added \`--safe-mode\` flag for troubleshooting.
- Added \`/rename\` command to name the current session.
`;

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

describe('findMissingCoverage', () => {
  it('returns [] when the dataset covers every symbol extracted from the changelog', () => {
    const dataset: SymbolRecord[] = [
      makeSymbol({ symbol: '--safe-mode', type: 'cli_flag' }),
      makeSymbol({ symbol: '--turbo', type: 'cli_flag' }),
      makeSymbol({ symbol: 'CLAUDE_CODE_TURBO', type: 'env_var' }),
      makeSymbol({ symbol: '/rename', type: 'command' }),
    ];

    expect(findMissingCoverage(FAKE_CHANGELOG, dataset)).toEqual([]);
  });

  it('returns exactly the one symbol missing from an otherwise-complete dataset', () => {
    const dataset: SymbolRecord[] = [
      makeSymbol({ symbol: '--safe-mode', type: 'cli_flag' }),
      makeSymbol({ symbol: '--turbo', type: 'cli_flag' }),
      makeSymbol({ symbol: '/rename', type: 'command' }),
      // CLAUDE_CODE_TURBO deliberately omitted.
    ];

    expect(findMissingCoverage(FAKE_CHANGELOG, dataset)).toEqual([
      { symbol: 'CLAUDE_CODE_TURBO', type: 'env_var' },
    ]);
  });

  it('returns an empty array for an empty changelog regardless of dataset contents', () => {
    expect(findMissingCoverage('# Changelog\n', [])).toEqual([]);
  });

  it('excludes a confirmed removal (mentioned in its "Removed" bullet but vanished from latest)', () => {
    // /vim is in CONFIRMED_REMOVALS: the changelog names it, but the removal lane
    // dropped it from latest.json, so it must NOT be reported as missing coverage.
    const changelog = '# Changelog\n\n## 2.1.92\n\n- Removed `/vim` command\n';
    expect(findMissingCoverage(changelog, [])).toEqual([]);
  });

  it('dedupes a symbol mentioned in multiple bullets/versions into a single missing entry', () => {
    const changelogWithRepeat = `## 2.1.11

- Fixed \`--turbo\` regression.

## 2.1.10

- Added \`--turbo\` flag for faster runs.
`;
    expect(findMissingCoverage(changelogWithRepeat, [])).toEqual([
      { symbol: '--turbo', type: 'cli_flag' },
    ]);
  });

  it('does not demand symbols the scraper legitimately excludes (subprocess/phantom flags)', () => {
    // The gate must agree with collectChangelogSymbols: a subprocess tool's own
    // example flags and the phantom `--compact` are never expected in the dataset.
    const changelog = `## 2.1.30

- Added support for additional \`git log\` flags in read-only mode (e.g., \`--topo-order\`, \`--cherry-pick\`)

## 2.1.72

- Fixed \`--continue\` not resuming after \`--compact\`
`;
    // Dataset intentionally lacks the git flags and --compact, but has --continue.
    const dataset: SymbolRecord[] = [makeSymbol({ symbol: '--continue', type: 'cli_flag' })];
    expect(findMissingCoverage(changelog, dataset)).toEqual([]);
  });
});
