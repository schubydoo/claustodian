// Copyright 2026 Schuby
// SPDX-License-Identifier: Apache-2.0

import { readFile, rm } from 'node:fs/promises';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  assertOfficialDocs,
  buildDocsIndex,
  main,
  officialSourcePages,
  parseDocPage,
  splitTableRow,
  symbolFromCell,
} from './fetch-docs.js';

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

  it('unescapes markdown backslash escapes so the literal backslash never surfaces', () => {
    const entry = parseDocPage('env-vars', '| `ANTHROPIC_SMALL_FAST_MODEL` | \\[DEPRECATED] a\\_b |')[0];
    expect(entry?.description).toBe('[DEPRECATED] a_b');
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

describe('main (mocked fetch)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('fetches the pages and writes a docs index', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: true, text: async () => '| `--mock` | A mocked flag |' }))
    );
    const out = '/tmp/claustodian-fetch-docs.test.json';
    await main([out]);
    const index = JSON.parse(await readFile(out, 'utf8'));
    expect(index.symbols.some((s: { symbol: string }) => s.symbol === '--mock')).toBe(true);
    await rm(out, { force: true });
  });

  it('throws on a non-ok response', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: false, status: 404, statusText: 'Not Found' }))
    );
    await expect(main(['/tmp/claustodian-fetch-docs.err.json'])).rejects.toThrow(/Failed to fetch/);
  });
});

describe('splitTableRow', () => {
  const cells = (line: string) =>
    splitTableRow(line)
      .slice(1, -1)
      .map((c) => c.trim());

  it('splits on real column delimiters', () => {
    expect(cells('| a | b | c |')).toEqual(['a', 'b', 'c']);
  });

  it('does not split on an escaped pipe, and unescapes it', () => {
    expect(cells('| a | b \\| c |')).toEqual(['a', 'b | c']);
  });

  it('does not split on a pipe inside an inline-code span', () => {
    expect(cells('| a | uses `model|fallback` here |')).toEqual([
      'a',
      'uses `model|fallback` here',
    ]);
  });
});

describe('parseDocPage — pipe handling', () => {
  it('keeps a description containing escaped pipes intact (not truncated)', () => {
    const entries = parseDocPage('cli-reference', '| `--fmt` | outputs a \\| b \\| c |');
    expect(entries[0]?.description).toBe('outputs a | b | c');
  });

  it('handles an escaped pipe inside the symbol cell', () => {
    const entries = parseDocPage(
      'commands',
      '| `/advisor [model\\|off]` | Enable the advisor tool |'
    );
    expect(entries[0]).toMatchObject({
      symbol: '/advisor',
      description: 'Enable the advisor tool',
    });
  });

  it('keeps a description with an UNescaped pipe inside inline code intact', () => {
    const entries = parseDocPage('cli-reference', '| `--model` | pick `sonnet|opus|fable` model |');
    expect(entries[0]).toMatchObject({
      symbol: '--model',
      description: 'pick `sonnet|opus|fable` model',
    });
  });
});

describe('assertOfficialDocs', () => {
  const official = officialSourcePages();
  const entry = (doc_page: string) => ({
    symbol: '--x',
    type: 'cli_flag' as const,
    description: 'x',
    doc_min_version: null,
    doc_page,
  });

  it('accepts an index with official source_pages and doc_pages', () => {
    expect(() =>
      assertOfficialDocs({
        $generated_by: '',
        source_pages: official,
        symbols: [entry('cli-reference')],
      })
    ).not.toThrow();
  });

  it('rejects an index whose source_pages are not the official docs URLs', () => {
    expect(() =>
      assertOfficialDocs({
        $generated_by: '',
        source_pages: ['https://evil.example/docs.md'],
        symbols: [],
      })
    ).toThrow(/source_pages/);
  });

  it('rejects an entry referencing a non-official doc_page', () => {
    expect(() =>
      assertOfficialDocs({
        $generated_by: '',
        source_pages: official,
        symbols: [entry('not-a-real-page')],
      })
    ).toThrow(/non-official doc_page/);
  });
});
