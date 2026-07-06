// Copyright 2026 Schuby
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from 'vitest';
import { buildDocsIndex, parseDocPage, symbolFromCell } from './fetch-docs.js';

describe('symbolFromCell', () => {
  it('recognizes a CLI flag', () => {
    expect(symbolFromCell('`--continue`')).toEqual({ symbol: '--continue', type: 'cli_flag' });
  });

  it('recognizes a slash command, stripping its argument', () => {
    expect(symbolFromCell('`/add-dir <path>`')).toEqual({ symbol: '/add-dir', type: 'command' });
  });

  it('recognizes an environment variable', () => {
    expect(symbolFromCell('`ANTHROPIC_API_KEY`')).toEqual({
      symbol: 'ANTHROPIC_API_KEY',
      type: 'env_var',
    });
  });

  it('prefers a flag over an env-looking token in the same cell', () => {
    expect(symbolFromCell('`--model` overrides `ANTHROPIC_MODEL`')).toEqual({
      symbol: '--model',
      type: 'cli_flag',
    });
  });

  it('skips generic OS env vars (denylist)', () => {
    expect(symbolFromCell('`PATH`')).toBeNull();
  });

  it('returns null for a `claude subcommand` row and for prose', () => {
    expect(symbolFromCell('`claude auth login`')).toBeNull();
    expect(symbolFromCell('Start interactive session')).toBeNull();
  });
});

describe('parseDocPage', () => {
  const md = [
    '# CLI flags',
    '',
    '| Flag | Description |',
    '| :--- | :--- |',
    '| `--continue` | Load the most recent conversation in the current directory |',
    '| `--advisor` | {/* min-version: 2.1.98 */}Enable the advisor tool. Requires Claude Code v2.1.98 or later |',
    '| `claude gateway` | Start the gateway. Available in Claude Code v2.1.195 and later |',
    '| not-a-row | just prose |',
  ].join('\n');

  it('extracts symbol + description from table rows, skipping separators and prose', () => {
    const entries = parseDocPage('cli-reference', md);
    const flags = entries.filter((e) => e.type === 'cli_flag');
    expect(flags.map((e) => e.symbol)).toEqual(['--continue', '--advisor']);
  });

  it('captures a min-version and strips MDX comments from the description', () => {
    const advisor = parseDocPage('cli-reference', md).find((e) => e.symbol === '--advisor');
    expect(advisor?.doc_min_version).toBe('2.1.98');
    expect(advisor?.description).toBe(
      'Enable the advisor tool. Requires Claude Code v2.1.98 or later'
    );
    expect(advisor?.description).not.toContain('min-version');
  });

  it('strips markdown links to their text', () => {
    const md2 = '| `--xray` | See [the docs](/en/foo) for details |';
    const entry = parseDocPage('p', md2)[0];
    expect(entry?.description).toBe('See the docs for details');
  });
});

describe('buildDocsIndex', () => {
  it('dedupes by type:symbol (first page wins) and sorts by type then symbol', () => {
    const pages = [
      { page: 'cli-reference', markdown: '| `--zebra` | first def |\n| `--alpha` | alpha flag |' },
      {
        page: 'commands',
        markdown: '| `--zebra` | second def (ignored) |\n| `/cmd` | the command |',
      },
    ];
    const index = buildDocsIndex(pages);
    expect(index.symbols.map((s) => `${s.type}:${s.symbol}`)).toEqual([
      'cli_flag:--alpha',
      'cli_flag:--zebra',
      'command:/cmd',
    ]);
    const zebra = index.symbols.find((s) => s.symbol === '--zebra');
    expect(zebra?.description).toBe('first def');
    expect(zebra?.doc_page).toBe('cli-reference');
  });

  it('backfills a missing min-version from a later page', () => {
    const pages = [
      { page: 'cli-reference', markdown: '| `--xray` | no version here |' },
      { page: 'commands', markdown: '| `--xray` | {/* min-version: 2.1.50 */}later mention |' },
    ];
    const index = buildDocsIndex(pages);
    expect(index.symbols[0]?.doc_min_version).toBe('2.1.50');
    expect(index.symbols[0]?.description).toBe('no version here');
  });
});
